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
 *
 * Everything here is keyed by *tariff*, not by user. Agile prices differ by
 * distribution region, so two people in different regions have genuinely
 * different prices, while everyone in the same region shares one copy.
 */

import type { DayCoverage, DaySummary, PricePeriod, StoredPricePeriod } from '@octoprice/core';
import {
  FALLBACK_AGILE_PRODUCT_CODE,
  buildTariffCode,
  describeDayCoverage,
  endOfLondonDay,
  expectedPeriodCount,
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

export interface TariffGroup {
  tariff: TariffSelection;
  /** Everyone on this tariff. */
  userIds: string[];
}

export interface RefreshResult {
  date: PricingDate;
  tariff: TariffSelection;
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
  /** When set, product discovery is skipped. */
  forcedProductCode?: string | undefined;
  defaultRegion?: RegionCode;
  now?: () => Date;
}

export class PriceService {
  private readonly store: Store;
  private readonly client: OctopusClient;
  private readonly logger: Logger;
  private readonly forcedProductCode: string | undefined;
  private readonly defaultRegion: RegionCode;
  private readonly now: () => Date;

  constructor(options: PriceServiceOptions) {
    this.store = options.store;
    this.client = options.client;
    this.logger = options.logger;
    this.forcedProductCode = options.forcedProductCode;
    this.defaultRegion = options.defaultRegion ?? 'C';
    this.now = options.now ?? (() => new Date());
  }

  /** The product and tariff a particular person is on. */
  async tariff(userId: string): Promise<TariffSelection> {
    const settings = await this.store.getSettings(userId);
    return this.tariffFrom(settings.region, settings.productCode);
  }

  private tariffFrom(region: string, productCode: string | undefined): TariffSelection {
    const resolvedRegion = isRegionCode(region) ? region : this.defaultRegion;
    const resolvedProduct = this.forcedProductCode ?? productCode ?? FALLBACK_AGILE_PRODUCT_CODE;
    return {
      productCode: resolvedProduct,
      tariffCode: buildTariffCode(resolvedProduct, resolvedRegion),
      region: resolvedRegion,
    };
  }

  /**
   * Every distinct tariff anyone is using.
   *
   * The poller fetches one copy per tariff rather than one per person, so a
   * household all in the same region costs exactly one request - while
   * someone in a different region still gets their own prices.
   */
  async distinctTariffs(): Promise<TariffSelection[]> {
    return (await this.tariffGroups()).map((group) => group.tariff);
  }

  /**
   * Everyone, grouped by the tariff they are on.
   *
   * This is the shape the poller wants: fetch once per tariff, then notify
   * each person who is on it.
   */
  async tariffGroups(): Promise<TariffGroup[]> {
    const settings = await this.store.listAllSettings();
    const groups = new Map<string, TariffGroup>();

    for (const entry of settings) {
      const tariff = this.tariffFrom(entry.region, entry.productCode);
      const existing = groups.get(tariff.tariffCode);
      if (existing) existing.userIds.push(entry.userId);
      else groups.set(tariff.tariffCode, { tariff, userIds: [entry.userId] });
    }
    return [...groups.values()];
  }

  /**
   * Asks Octopus which Agile import product is current and records it.
   *
   * Failure is not fatal: DESIGN.md section 3 prefers discovery over a
   * hard-coded product, but a stored or fallback code keeps the app working
   * when the products endpoint is unreachable.
   */
  async discoverProduct(): Promise<void> {
    if (this.forcedProductCode) return;

    try {
      const discovered = await this.client.findCurrentAgileProduct(this.now());
      if (!discovered) return;

      // The current Agile product is the same for everyone, so a discovery
      // applies to every person rather than only whoever triggered it.
      for (const settings of await this.store.listAllSettings()) {
        if (settings.productCode !== discovered) {
          await this.store.updateSettings(settings.userId, { productCode: discovered });
        }
      }
      this.logger.info('Updated Agile product from discovery', {
        event: LOG_EVENTS.productDiscovered,
        productCode: discovered,
      });
    } catch (error) {
      this.logger.warn('Agile product discovery failed, keeping stored product', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    }
  }

  /** Prices already stored for a London day on a given tariff. */
  async storedDay(date: PricingDate, tariffCode: string): Promise<PricePeriod[]> {
    return this.store.getPrices(tariffCode, startOfLondonDay(date), endOfLondonDay(date));
  }

  /**
   * Stores confirmed historical prices without changing publication state or
   * dispatching alerts. Used only by the isolated forecast-history backfill.
   */
  async backfillHistory(from: Date, to: Date, tariff: TariffSelection): Promise<number> {
    const fetched = await this.client.getUnitRates({
      productCode: tariff.productCode,
      tariffCode: tariff.tariffCode,
      periodFrom: from,
      periodTo: to,
    });
    if (fetched.length === 0) return 0;

    const retrievedAt = this.now().toISOString();
    return this.store.upsertPrices(
      fetched.map((period) => ({
        ...period,
        tariffCode: tariff.tariffCode,
        region: tariff.region,
        retrievedAt,
      })),
    );
  }

  /** Whether a usable day has been recorded for a tariff. */
  async isRetrieved(date: PricingDate, tariffCode: string): Promise<boolean> {
    return (await this.store.getState(this.retrievedKey(date, tariffCode))) !== null;
  }

  private retrievedKey(date: PricingDate, tariffCode: string): string {
    // Keyed by tariff as well as date: one region being published says
    // nothing about another.
    return `${STATE_KEYS.retrievedDatePrefix}${tariffCode}:${date}`;
  }

  /**
   * Fetches a London day from Octopus for one tariff, stores it, and reports
   * how much of it has arrived.
   *
   * The request window is the local day converted to UTC, so a 23-hour or
   * 25-hour day asks for exactly the periods it should have.
   */
  async refresh(date: PricingDate, tariff: TariffSelection): Promise<RefreshResult> {
    const { productCode, tariffCode, region } = tariff;
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
        tariffCode,
        count: rows.length,
      });
    }

    // Read back from the store so coverage reflects everything held for the
    // day, not just what this request happened to return.
    const periods = await this.storedDay(date, tariffCode);
    const coverage = describeDayCoverage(periods, date);
    const missingCount = missingPeriodStarts(periods, date).length;

    if (coverage.publishable) {
      // "Retrieved" means the day has arrived in a useful state and the
      // five-minute publication poll can stop. It deliberately does not wait
      // for completeness, because Octopus delivers the final period or two
      // later - often not until the following day's batch - and waiting for
      // that meant the day was never dispatched at all.
      await this.store.setState(this.retrievedKey(date, tariffCode), this.now().toISOString());
      await this.store.setState(STATE_KEYS.lastSuccessfulRetrievalAt, this.now().toISOString());
      this.logger.info('Pricing day published', {
        event: LOG_EVENTS.priceDataComplete,
        date,
        tariffCode,
        periods: periods.length,
        expected: coverage.expectedPeriodCount,
        complete: coverage.complete,
      });
    } else {
      this.logger.info('Pricing day not yet usable', {
        event: LOG_EVENTS.priceDataNotReady,
        date,
        tariffCode,
        have: periods.length,
        expected: coverage.expectedPeriodCount,
        leading: coverage.leadingPeriodCount,
        missing: missingCount,
      });
    }

    return {
      date,
      tariff,
      complete: coverage.complete,
      publishable: coverage.publishable,
      coverage,
      periods,
      summary: summariseDay(periods, date),
      missingCount,
    };
  }

  /**
   * Refreshes today and tomorrow for every tariff in use.
   *
   * Used at startup so a freshly started server has something to show
   * immediately rather than waiting for the next polling window.
   */
  async refreshCurrentDays(): Promise<RefreshResult[]> {
    const today = londonDateOf(this.now());
    const tomorrow = londonDateOf(endOfLondonDay(today));
    const results: RefreshResult[] = [];

    for (const tariff of await this.distinctTariffs()) {
      for (const date of [today, tomorrow]) {
        try {
          results.push(await this.refresh(date, tariff));
        } catch (error) {
          this.logger.error('Startup price refresh failed', {
            event: LOG_EVENTS.octopusApiError,
            date,
            tariffCode: tariff.tariffCode,
            ...describeError(error),
          });
        }
      }
    }
    return results;
  }
}
