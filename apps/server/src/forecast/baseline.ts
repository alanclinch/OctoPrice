/**
 * Seasonal-naive forecast orchestration.
 *
 * Network history backfill and forecast calculation run on their own Cron.
 * API requests only read a prepared cache; they never wait on Octopus or
 * calculate an estimate. Any missing input yields no forecast rather than a
 * degraded one.
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
  prepareForecastHistory,
  startOfLondonDay,
  type ForecastPricePeriod,
  type PricingDate,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import type { PriceService, TariffSelection } from '../prices/service.ts';

export const FORECAST_HISTORY_DAYS = 28;
const BACKFILL_STATE_PREFIX = 'forecast_history_cursor:';
const BACKFILL_ATTEMPT_STATE_PREFIX = 'forecast_history_attempt:';
const FORECAST_CACHE_PREFIX = 'forecast_baseline_cache:';
const FORECAST_CACHE_CURSOR = 'forecast_baseline_cache_cursor';
export const FORECAST_BACKFILL_MAX_ATTEMPTS = 3;
export const FORECAST_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ForecastBackfillResult {
  ran: boolean;
  stored: number;
  tariffs: number;
}

interface ForecastBackfillTask {
  tariff: TariffSelection;
  date: PricingDate;
  key: string;
}

async function recordBackfillFailure(
  options: { store: Store; logger: Logger },
  task: ForecastBackfillTask,
): Promise<boolean> {
  const attemptKey = `${BACKFILL_ATTEMPT_STATE_PREFIX}${task.tariff.tariffCode}`;

  try {
    const value = await options.store.getState(attemptKey);
    let previousAttempts = 0;
    if (value) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'date' in parsed &&
          parsed.date === task.date &&
          'attempts' in parsed &&
          typeof parsed.attempts === 'number' &&
          Number.isInteger(parsed.attempts) &&
          parsed.attempts >= 0
        ) {
          previousAttempts = parsed.attempts;
        }
      } catch {
        // A malformed counter is safely replaced below.
      }
    }

    const attempts = previousAttempts + 1;
    await options.store.setState(attemptKey, JSON.stringify({ date: task.date, attempts }));
    if (attempts < FORECAST_BACKFILL_MAX_ATTEMPTS) return false;

    await options.store.setState(task.key, addDays(task.date, 1));
    options.logger.warn('Skipping unavailable forecast history day after repeated attempts', {
      tariffCode: task.tariff.tariffCode,
      date: task.date,
      attempts,
    });
    return true;
  } catch (error) {
    options.logger.error('Could not record forecast history backfill attempt', {
      tariffCode: task.tariff.tariffCode,
      date: task.date,
      ...describeError(error),
    });
    return false;
  }
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

  const candidates: ForecastBackfillTask[] = [];
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
      const advanced = await recordBackfillFailure(options, task);
      return { ran: true, stored: 0, tariffs: advanced ? 1 : 0 };
    }

    const refreshed = await options.priceService.storedDay(task.date, task.tariff.tariffCode);
    if (!isDayComplete(refreshed, task.date)) {
      options.logger.warn('Forecast history day remains incomplete', {
        tariffCode: task.tariff.tariffCode,
        date: task.date,
        periods: refreshed.length,
      });
      const advanced = await recordBackfillFailure(options, task);
      return { ran: true, stored, tariffs: advanced ? 1 : 0 };
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
    const advanced = await recordBackfillFailure(options, task);
    return { ran: true, stored: 0, tariffs: advanced ? 1 : 0 };
  }
}

export interface BaselineForecast {
  model: typeof FORECAST_MODEL;
  referenceRegion: typeof FORECAST_REFERENCE_REGION;
  historyDays: number;
  periods: ForecastPricePeriod[];
  unavailableReason:
    'disabled' | 'failed' | 'stale' | 'insufficient-history' | 'regional-transform-failed' | null;
}

interface CachedBaselineForecast {
  version: 1;
  tariffCode: string;
  generatedAt: string;
  forecast: BaselineForecast;
}

export function unavailableBaselineForecast(
  reason: Exclude<BaselineForecast['unavailableReason'], null>,
): BaselineForecast {
  return {
    model: FORECAST_MODEL,
    referenceRegion: FORECAST_REFERENCE_REGION,
    historyDays: FORECAST_HISTORY_DAYS,
    periods: [],
    unavailableReason: reason,
  };
}

function cacheKey(tariffCode: string): string {
  return `${FORECAST_CACHE_PREFIX}${tariffCode}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCachedForecast(value: string): CachedBaselineForecast | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.tariffCode !== 'string') {
    return null;
  }
  if (typeof parsed.generatedAt !== 'string' || !isRecord(parsed.forecast)) return null;
  const forecast = parsed.forecast;
  if (
    forecast.model !== FORECAST_MODEL ||
    forecast.referenceRegion !== FORECAST_REFERENCE_REGION ||
    forecast.historyDays !== FORECAST_HISTORY_DAYS ||
    !Array.isArray(forecast.periods) ||
    !forecast.periods.every(
      (period) =>
        isRecord(period) &&
        typeof period.validFrom === 'string' &&
        typeof period.validTo === 'string' &&
        typeof period.valueIncVat === 'number' &&
        typeof period.lowerIncVat === 'number' &&
        typeof period.upperIncVat === 'number' &&
        typeof period.sampleCount === 'number' &&
        period.model === FORECAST_MODEL,
    ) ||
    ![null, 'insufficient-history', 'regional-transform-failed'].includes(
      forecast.unavailableReason as null | string,
    )
  ) {
    return null;
  }
  return parsed as unknown as CachedBaselineForecast;
}

/** Reads a recent same-day estimate prepared by the forecast-only Cron. */
export async function readBaselineForecastCache(options: {
  store: Store;
  tariff: TariffSelection;
  now: Date;
}): Promise<BaselineForecast> {
  const value = await options.store.getState(cacheKey(options.tariff.tariffCode));
  if (!value) return unavailableBaselineForecast('insufficient-history');
  const cached = parseCachedForecast(value);
  if (!cached) return unavailableBaselineForecast('failed');
  const generatedAt = Date.parse(cached.generatedAt);
  if (!Number.isFinite(generatedAt) || cached.tariffCode !== options.tariff.tariffCode) {
    return unavailableBaselineForecast('failed');
  }
  if (
    londonDateOf(new Date(generatedAt)) !== londonDateOf(options.now) ||
    generatedAt > options.now.getTime() + 60_000 ||
    options.now.getTime() - generatedAt > FORECAST_CACHE_MAX_AGE_MS
  ) {
    return unavailableBaselineForecast('stale');
  }
  return cached.forecast;
}

/** Calculates and stores one active tariff per forecast-only Cron invocation. */
export async function refreshOneBaselineForecast(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now?: () => Date;
}): Promise<{ ran: boolean; tariffCode: string | null }> {
  const tariffs = (await options.priceService.distinctTariffs()).sort((a, b) =>
    a.tariffCode.localeCompare(b.tariffCode),
  );
  if (tariffs.length === 0) return { ran: false, tariffCode: null };

  const previous = await options.store.getState(FORECAST_CACHE_CURSOR);
  const index = previous ? tariffs.findIndex((tariff) => tariff.tariffCode === previous) : -1;
  const tariff = tariffs[(index + 1) % tariffs.length] as TariffSelection;
  const now = (options.now ?? (() => new Date()))();

  try {
    const forecast = await buildBaselineForecast({ store: options.store, tariff, now });
    const cached: CachedBaselineForecast = {
      version: 1,
      tariffCode: tariff.tariffCode,
      generatedAt: now.toISOString(),
      forecast,
    };
    await options.store.setState(cacheKey(tariff.tariffCode), JSON.stringify(cached));
    await options.store.setState(FORECAST_CACHE_CURSOR, tariff.tariffCode);
    return { ran: true, tariffCode: tariff.tariffCode };
  } catch (error) {
    options.logger.warn('Forecast cache refresh failed', {
      tariffCode: tariff.tariffCode,
      ...describeError(error),
    });
    return { ran: false, tariffCode: tariff.tariffCode };
  }
}

/** Backfills first; once history is complete, refreshes one cached forecast. */
export async function runForecastBackgroundJob(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now?: () => Date;
}): Promise<void> {
  const backfill = await runForecastHistoryBackfill(options);
  if (!backfill.ran) await refreshOneBaselineForecast(options);
}

/** Builds two days of estimates from stored confirmed prices only. */
export async function buildBaselineForecast(options: {
  store: Store;
  tariff: TariffSelection;
  now: Date;
}): Promise<BaselineForecast> {
  const today = londonDateOf(options.now);
  const historyFrom = startOfLondonDay(addDays(today, -FORECAST_HISTORY_DAYS));
  // Today's official prices are already stored and are the freshest matching
  // observations available, including slots later than the current time.
  const historyTo = endOfLondonDay(today);
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
    return unavailableBaselineForecast('insufficient-history');
  }

  const preparedHistory = prepareForecastHistory(referenceHistory);
  const transform = fitRegionalPriceTransform(
    referenceHistory,
    targetHistory,
    options.tariff.region === FORECAST_REFERENCE_REGION,
    preparedHistory,
  );
  if (!transform) {
    return unavailableBaselineForecast(
      options.tariff.region === FORECAST_REFERENCE_REGION
        ? 'insufficient-history'
        : 'regional-transform-failed',
    );
  }

  const confirmedStarts = new Set(confirmed.map((period) => period.validFrom));
  const targets = [
    ...londonDayPeriodStarts(firstTarget),
    ...londonDayPeriodStarts(lastTarget),
  ].filter((target) => !confirmedStarts.has(target.toISOString()));
  const periods = forecastSeasonalPrices({
    history: referenceHistory,
    preparedHistory,
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
