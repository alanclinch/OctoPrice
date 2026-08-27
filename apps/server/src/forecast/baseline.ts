/**
 * Seasonal-naive forecast orchestration.
 *
 * Network history backfill runs only after the confirmed-price cron work. API
 * requests perform database reads and pure calculations; they never wait on
 * Octopus. Any missing input yields no forecast rather than a degraded one.
 */

import {
  FORECAST_MODEL,
  FORECAST_REFERENCE_REGION,
  addDays,
  buildTariffCode,
  endOfLondonDay,
  fitRegionalPriceTransform,
  forecastSeasonalPrices,
  isDayComplete,
  londonDateOf,
  londonDayPeriodStarts,
  startOfLondonDay,
  type ForecastPricePeriod,
  type PricingDate,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import type { PriceService, TariffSelection } from '../prices/service.ts';

export const FORECAST_HISTORY_DAYS = 28;
const BACKFILL_STATE_PREFIX = 'forecast_history_cursor:';

export interface ForecastBackfillResult {
  ran: boolean;
  stored: number;
  tariffs: number;
}

function referenceTariff(productCode: string): TariffSelection {
  return {
    productCode,
    region: FORECAST_REFERENCE_REGION,
    tariffCode: buildTariffCode(productCode, FORECAST_REFERENCE_REGION),
  };
}

/**
 * Incrementally backfills a rolling set of official confirmed prices.
 *
 * One tariff-day (at most 50 periods) is processed per cron invocation. This
 * deliberately avoids attempting ~1,350 D1 writes at once on the free tier.
 * Reference region C is always included; active user regions supply the
 * overlap from which exact regional transforms are fitted.
 */
export async function runForecastHistoryBackfill(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now?: () => Date;
}): Promise<ForecastBackfillResult> {
  const now = (options.now ?? (() => new Date()))();
  const today = londonDateOf(now);
  const oldest = addDays(today, -FORECAST_HISTORY_DAYS);
  const active = await options.priceService.distinctTariffs();
  const tariffs = new Map<string, TariffSelection>();

  for (const tariff of active) {
    tariffs.set(tariff.tariffCode, tariff);
    const reference = referenceTariff(tariff.productCode);
    tariffs.set(reference.tariffCode, reference);
  }

  const candidates: { tariff: TariffSelection; date: PricingDate; key: string }[] = [];
  for (const tariff of tariffs.values()) {
    const key = `${BACKFILL_STATE_PREFIX}${tariff.tariffCode}`;
    const cursor = await options.store.getState(key);
    const date = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor) && cursor > oldest ? cursor : oldest;
    if (date < today) candidates.push({ tariff, date, key });
  }

  candidates.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.tariff.tariffCode.localeCompare(b.tariff.tariffCode),
  );
  const task = candidates[0];
  if (!task) return { ran: false, stored: 0, tariffs: 0 };

  try {
    const existing = await options.priceService.storedDay(task.date, task.tariff.tariffCode);
    if (isDayComplete(existing, task.date)) {
      await options.store.setState(task.key, addDays(task.date, 1));
      return { ran: true, stored: 0, tariffs: 1 };
    }

    const from = startOfLondonDay(task.date);
    const to = endOfLondonDay(task.date);
    const stored = await options.priceService.backfillHistory(from, to, task.tariff);
    if (stored === 0) {
      options.logger.warn('Forecast history backfill returned nothing', {
        tariffCode: task.tariff.tariffCode,
        date: task.date,
      });
      return { ran: true, stored: 0, tariffs: 0 };
    }

    const refreshed = await options.priceService.storedDay(task.date, task.tariff.tariffCode);
    if (!isDayComplete(refreshed, task.date)) {
      options.logger.warn('Forecast history day remains incomplete', {
        tariffCode: task.tariff.tariffCode,
        date: task.date,
        periods: refreshed.length,
      });
      return { ran: true, stored, tariffs: 0 };
    }

    await options.store.setState(task.key, addDays(task.date, 1));
    options.logger.info('Backfilled confirmed prices for forecasting', {
      tariffCode: task.tariff.tariffCode,
      date: task.date,
      stored,
    });
    return { ran: true, stored, tariffs: 1 };
  } catch (error) {
    options.logger.error('Forecast history backfill failed', {
      tariffCode: task.tariff.tariffCode,
      date: task.date,
      ...describeError(error),
    });
    return { ran: true, stored: 0, tariffs: 0 };
  }
}

export interface BaselineForecast {
  model: typeof FORECAST_MODEL;
  referenceRegion: typeof FORECAST_REFERENCE_REGION;
  historyDays: number;
  periods: ForecastPricePeriod[];
  unavailableReason: 'insufficient-history' | 'regional-transform-failed' | null;
}

/** Builds two days of estimates from stored confirmed prices only. */
export async function buildBaselineForecast(options: {
  store: Store;
  tariff: TariffSelection;
  now: Date;
}): Promise<BaselineForecast> {
  const today = londonDateOf(options.now);
  const historyFrom = startOfLondonDay(addDays(today, -FORECAST_HISTORY_DAYS));
  const historyTo = startOfLondonDay(today);
  const firstTarget: PricingDate = addDays(today, 1);
  const lastTarget: PricingDate = addDays(today, 2);
  const reference = referenceTariff(options.tariff.productCode);

  const [referenceHistory, targetHistory, confirmed] = await Promise.all([
    options.store.getPrices(reference.tariffCode, historyFrom, historyTo),
    options.tariff.region === FORECAST_REFERENCE_REGION
      ? Promise.resolve([])
      : options.store.getPrices(options.tariff.tariffCode, historyFrom, historyTo),
    options.store.getPrices(
      options.tariff.tariffCode,
      startOfLondonDay(firstTarget),
      endOfLondonDay(lastTarget),
    ),
  ]);

  if (referenceHistory.length === 0) {
    return {
      model: FORECAST_MODEL,
      referenceRegion: FORECAST_REFERENCE_REGION,
      historyDays: FORECAST_HISTORY_DAYS,
      periods: [],
      unavailableReason: 'insufficient-history',
    };
  }

  const transform = fitRegionalPriceTransform(
    referenceHistory,
    targetHistory,
    options.tariff.region === FORECAST_REFERENCE_REGION,
  );
  if (!transform) {
    return {
      model: FORECAST_MODEL,
      referenceRegion: FORECAST_REFERENCE_REGION,
      historyDays: FORECAST_HISTORY_DAYS,
      periods: [],
      unavailableReason:
        options.tariff.region === FORECAST_REFERENCE_REGION
          ? 'insufficient-history'
          : 'regional-transform-failed',
    };
  }

  const confirmedStarts = new Set(confirmed.map((period) => period.validFrom));
  const targets = [
    ...londonDayPeriodStarts(firstTarget),
    ...londonDayPeriodStarts(lastTarget),
  ].filter((target) => !confirmedStarts.has(target.toISOString()));
  const periods = forecastSeasonalPrices({
    history: referenceHistory,
    targets,
    transform,
    now: options.now,
  });

  return {
    model: FORECAST_MODEL,
    referenceRegion: FORECAST_REFERENCE_REGION,
    historyDays: FORECAST_HISTORY_DAYS,
    periods,
    unavailableReason: periods.length === 0 ? 'insufficient-history' : null,
  };
}
