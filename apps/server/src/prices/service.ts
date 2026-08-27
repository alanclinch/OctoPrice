/**
 * Price retrieval and storage.
 *
 * Sits between the Octopus client and the store, and is the only place that
 * decides whether a pricing day counts as "published".
 *
 * Two separate questions are answered, and conflating them was a real bug:
 *
 *  - `complete` - every expected period is present and contiguous (46, 48 or
 *    50 of them depending on daylight saving). This governs what the
 *    interface claims about a day.
 *  - `publishable` - enough of the day has arrived to be worth telling the
 *    user about. This governs notification.
 *
 * Octopus does not deliver a whole local day at once: the afternoon batch
 * covers the day up to roughly 23:00 local, and the remainder lands later,
 * usually with the following day's batch. Gating notification on completeness
 * therefore meant no notification was ever sent at all.
 */

import type { DayCoverage, DaySummary, PricePeriod, StoredPricePeriod } from '@octoprice/core';
import {
  FALLBACK_AGILE_PRODUCT_CODE,
  buildTariffCode,
  endOfLondonDay,
  expectedPeriodCount,
  describeDayCoverage,
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
  /** True when every expected period is stored. Governs what the UI claims. */
  complete: boolean;
  /** True when enough of the day has arrived to notify on it. */
  publishable: boolean;
  coverage: DayCoverage;
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
  async tariff(): Promise<TariffSelection> {
    const settings = await this.store.getSettings(this.userId);
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
      if (discovered && discovered !== (await this.store.getSettings(this.userId)).productCode) {
        await this.store.updateSettings(this.userId, { productCode: discovered });
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
    return (await this.tariff()).productCode;
  }

  /** Prices already stored for a London day. */
  async storedDay(date: PricingDate): Promise<PricePeriod[]> {
    const { tariffCode } = await this.tariff();
    return this.store.getPrices(tariffCode, startOfLondonDay(date), endOfLondonDay(date));
  }

  /** Whether a complete day has been recorded as retrieved. */
  async isRetrieved(date: PricingDate): Promise<boolean> {
    return (await this.store.getState(`${STATE_KEYS.retrievedDatePrefix}${date}`)) !== null;
  }

  private async markRetrieved(date: PricingDate): Promise<void> {
    await this.store.setState(`${STATE_KEYS.retrievedDatePrefix}${date}`, this.now().toISOString());
  }

  /**
   * Fetches a London day from Octopus, stores it, and reports whether the day
   * is now complete.
   *
   * The request window is the local day converted to UTC, so a 23-hour or
   * 25-hour day asks for exactly the periods it should have.
   */
  async refresh(date: PricingDate): Promise<RefreshResult> {
    const { productCode, tariffCode, region } = await this.tariff();
    const from = startOfLondonDay(date);
    const to = endOfLondonDay(date);

    this.logger.info('Checking Octopus for prices', {
      event: LOG_EVENTS.priceCheckStarted,
      date,
      tariffCode,
      expectedPeriods: expectedPeriodCount(date),
    });
    await this.store.setState(STATE_KEYS.lastCheckStartedAt, this.now().toISOString());

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
      await this.store.upsertPrices(rows);
      this.logger.debug('Stored price periods', {
        event: LOG_EVENTS.priceDataStored,
        date,
        count: rows.length,
      });
    }

    // Read back from the store so coverage reflects everything held for the
    // day, not just what this request happened to return.
    const periods = await this.storedDay(date);
    const coverage = describeDayCoverage(periods, date);
    const missingCount = missingPeriodStarts(periods, date).length;

    if (coverage.publishable) {
      // "Retrieved" means the day has arrived in a useful state and the
      // five-minute publication poll can stop. It deliberately does not wait
      // for completeness, because Octopus delivers the final period or two
      // later - often not until the following day's batch - and waiting for
      // that meant the day was never dispatched at all.
      await this.markRetrieved(date);
      await this.store.setState(STATE_KEYS.lastSuccessfulRetrievalAt, this.now().toISOString());
      this.logger.info('Pricing day published', {
        event: LOG_EVENTS.priceDataComplete,
        date,
        periods: periods.length,
        expected: coverage.expectedPeriodCount,
        complete: coverage.complete,
        coveredUntil: coverage.coveredUntil,
      });
    } else {
      this.logger.info('Pricing day not yet usable', {
        event: LOG_EVENTS.priceDataNotReady,
        date,
        have: periods.length,
        expected: coverage.expectedPeriodCount,
        leading: coverage.leadingPeriodCount,
        missing: missingCount,
      });
    }

    return {
      date,
      complete: coverage.complete,
      publishable: coverage.publishable,
      coverage,
      periods,
      summary: summariseDay(periods, date),
      missingCount,
    };
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
