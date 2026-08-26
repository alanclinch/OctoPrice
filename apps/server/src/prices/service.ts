/**
 * Price retrieval and storage.
 *
 * Sits between the Octopus client and the store, and is the only place that
 * decides whether a pricing day counts as "published". That decision is
 * deliberately strict: a day is published only when every expected period is
 * present and contiguous (46, 48 or 50 of them depending on daylight saving).
 * Partial data must never trigger the daily notification.
 */

import type { DaySummary, PricePeriod, StoredPricePeriod } from '@octoprice/core';
import {
  FALLBACK_AGILE_PRODUCT_CODE,
  buildTariffCode,
  endOfLondonDay,
  expectedPeriodCount,
  isDayComplete,
  isRegionCode,
  londonDateOf,
  missingPeriodStarts,
  startOfLondonDay,
  summariseDay,
  type PricingDate,
  type RegionCode,
} from '@octoprice/core';
import type { OctopusClient } from '../octopus/client.ts';
import type { Store } from '../db/store.ts';
import { STATE_KEYS } from '../db/store.ts';
import { LOG_EVENTS, describeError, type Logger } from '../logger.ts';

export interface TariffSelection {
  productCode: string;
  tariffCode: string;
  region: RegionCode;
}

export interface RefreshResult {
  date: PricingDate;
  /** True when a full day is now stored. */
  complete: boolean;
  periods: PricePeriod[];
  summary: DaySummary | null;
  /** How many periods are still missing, for logging. */
  missingCount: number;
}

export interface PriceServiceOptions {
  store: Store;
  client: OctopusClient;
  logger: Logger;
  userId: string;
  /** When set, product discovery is skipped. */
  forcedProductCode?: string | undefined;
  now?: () => Date;
}

export class PriceService {
  private readonly store: Store;
  private readonly client: OctopusClient;
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly forcedProductCode: string | undefined;
  private readonly now: () => Date;

  constructor(options: PriceServiceOptions) {
    this.store = options.store;
    this.client = options.client;
    this.logger = options.logger;
    this.userId = options.userId;
    this.forcedProductCode = options.forcedProductCode;
    this.now = options.now ?? (() => new Date());
  }

  /** The product and tariff currently in use, from settings. */
  tariff(): TariffSelection {
    const settings = this.store.getSettings(this.userId);
    const region = isRegionCode(settings.region) ? settings.region : 'C';
    const productCode =
      this.forcedProductCode ?? settings.productCode ?? FALLBACK_AGILE_PRODUCT_CODE;
    return { productCode, tariffCode: buildTariffCode(productCode, region), region };
  }

  /**
   * Asks Octopus which Agile import product is current and records it.
   *
   * Failure is not fatal: DESIGN.md section 3 prefers discovery over a
   * hard-coded product, but a stored or fallback code keeps the app working
   * when the products endpoint is unreachable.
   */
  async discoverProduct(): Promise<string> {
    if (this.forcedProductCode) return this.forcedProductCode;

    try {
      const discovered = await this.client.findCurrentAgileProduct(this.now());
      if (discovered && discovered !== this.store.getSettings(this.userId).productCode) {
        this.store.updateSettings(this.userId, { productCode: discovered });
        this.logger.info('Updated Agile product from discovery', {
          event: LOG_EVENTS.productDiscovered,
          productCode: discovered,
        });
      }
      if (discovered) return discovered;
    } catch (error) {
      this.logger.warn('Agile product discovery failed, keeping stored product', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    }
    return this.tariff().productCode;
  }

  /** Prices already stored for a London day. */
  storedDay(date: PricingDate): PricePeriod[] {
    const { tariffCode } = this.tariff();
    return this.store.getPrices(tariffCode, startOfLondonDay(date), endOfLondonDay(date));
  }

  /** Whether a complete day has been recorded as retrieved. */
  isRetrieved(date: PricingDate): boolean {
    return this.store.getState(`${STATE_KEYS.retrievedDatePrefix}${date}`) !== null;
  }

  private markRetrieved(date: PricingDate): void {
    this.store.setState(`${STATE_KEYS.retrievedDatePrefix}${date}`, this.now().toISOString());
  }

  /**
   * Fetches a London day from Octopus, stores it, and reports whether the day
   * is now complete.
   *
   * The request window is the local day converted to UTC, so a 23-hour or
   * 25-hour day asks for exactly the periods it should have.
   */
  async refresh(date: PricingDate): Promise<RefreshResult> {
    const { productCode, tariffCode, region } = this.tariff();
    const from = startOfLondonDay(date);
    const to = endOfLondonDay(date);

    this.logger.info('Checking Octopus for prices', {
      event: LOG_EVENTS.priceCheckStarted,
      date,
      tariffCode,
      expectedPeriods: expectedPeriodCount(date),
    });
    this.store.setState(STATE_KEYS.lastCheckStartedAt, this.now().toISOString());

    const fetched = await this.client.getUnitRates({
      productCode,
      tariffCode,
      periodFrom: from,
      periodTo: to,
    });

    if (fetched.length > 0) {
      const retrievedAt = this.now().toISOString();
      const rows: StoredPricePeriod[] = fetched.map((period) => ({
        ...period,
        tariffCode,
        region,
        retrievedAt,
      }));
      this.store.upsertPrices(rows);
      this.logger.debug('Stored price periods', {
        event: LOG_EVENTS.priceDataStored,
        date,
        count: rows.length,
      });
    }

    // Read back from the store so completeness reflects everything held for
    // the day, not just what this request happened to return.
    const periods = this.storedDay(date);
    const complete = isDayComplete(periods, date);
    const missingCount = missingPeriodStarts(periods, date).length;

    if (complete) {
      this.markRetrieved(date);
      this.store.setState(STATE_KEYS.lastSuccessfulRetrievalAt, this.now().toISOString());
      this.logger.info('Complete pricing day retrieved', {
        event: LOG_EVENTS.priceDataComplete,
        date,
        periods: periods.length,
      });
    } else {
      this.logger.info('Pricing day not yet complete', {
        event: LOG_EVENTS.priceDataNotReady,
        date,
        have: periods.length,
        expected: expectedPeriodCount(date),
        missing: missingCount,
      });
    }

    return { date, complete, periods, summary: summariseDay(periods, date), missingCount };
  }

  /**
   * Refreshes today and, if it has been published, tomorrow.
   *
   * Used at startup so a freshly started server has something to show
   * immediately rather than waiting for the next polling window.
   */
  async refreshCurrentDays(): Promise<RefreshResult[]> {
    const today = londonDateOf(this.now());
    const results: RefreshResult[] = [];

    for (const date of [today, this.tomorrowOf(today)]) {
      try {
        results.push(await this.refresh(date));
      } catch (error) {
        this.logger.error('Startup price refresh failed', {
          event: LOG_EVENTS.octopusApiError,
          date,
          ...describeError(error),
        });
      }
    }
    return results;
  }

  private tomorrowOf(date: PricingDate): PricingDate {
    const start = endOfLondonDay(date);
    return londonDateOf(start);
  }
}
