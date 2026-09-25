/** Display-only AgilePredict cache. Network access is confined to the forecast Cron. */

import {
  AGILEPREDICT_MODEL,
  addDays,
  isRegionCode,
  londonDateOf,
  londonDateAndMinutes,
  londonDayPeriodStarts,
  startOfLondonDay,
  type ForecastPricePeriod,
  type RegionCode,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import type { PriceService } from '../prices/service.ts';
import { COLLECTOR_USER_AGENT } from './collectors.ts';
import { parseAgilePredict } from './competitor.ts';

const CACHE_PREFIX = 'forecast_agilepredict_cache:';
const ATTEMPT_PREFIX = 'forecast_agilepredict_attempt:';
export const AGILEPREDICT_REFRESH_MS = 60 * 60 * 1000;
export const AGILEPREDICT_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const ISSUE_MAX_AGE_MS = 18 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

export interface AgilePredictForecast {
  model: typeof AGILEPREDICT_MODEL;
  source: typeof AGILEPREDICT_MODEL;
  referenceRegion: RegionCode;
  historyDays: 0;
  issuedAt: string;
  periods: ForecastPricePeriod[];
  unavailableReason: null;
}

interface CachedForecast {
  version: 1;
  region: RegionCode;
  fetchedAt: string;
  forecast: AgilePredictForecast;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCache(value: string): CachedForecast | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRegionCode(raw.region)) return null;
  if (typeof raw.fetchedAt !== 'string' || !isRecord(raw.forecast)) return null;
  const forecast = raw.forecast;
  if (
    forecast.model !== AGILEPREDICT_MODEL ||
    forecast.source !== AGILEPREDICT_MODEL ||
    forecast.referenceRegion !== raw.region ||
    typeof forecast.issuedAt !== 'string' ||
    !Array.isArray(forecast.periods) ||
    forecast.periods.length === 0
  )
    return null;
  let previousEnd = -Infinity;
  for (const period of forecast.periods) {
    if (!isRecord(period) || period.model !== AGILEPREDICT_MODEL) return null;
    if (typeof period.validFrom !== 'string' || typeof period.validTo !== 'string') return null;
    const from = Date.parse(period.validFrom);
    const to = Date.parse(period.validTo);
    if (!Number.isFinite(from) || to - from !== HALF_HOUR_MS || from < previousEnd) return null;
    if (
      typeof period.valueIncVat !== 'number' ||
      !Number.isFinite(period.valueIncVat) ||
      typeof period.lowerIncVat !== 'number' ||
      !Number.isFinite(period.lowerIncVat) ||
      typeof period.upperIncVat !== 'number' ||
      !Number.isFinite(period.upperIncVat) ||
      period.lowerIncVat > period.upperIncVat
    )
      return null;
    previousEnd = to;
  }
  return raw as unknown as CachedForecast;
}

/** A stale, malformed or mismatched provider cache is never displayed. */
export async function readAgilePredictForecastCache(options: {
  store: Store;
  region: RegionCode;
  now: Date;
}): Promise<AgilePredictForecast | null> {
  const raw = await options.store.getState(`${CACHE_PREFIX}${options.region}`);
  const cached = raw ? parseCache(raw) : null;
  if (!cached || cached.region !== options.region) return null;
  const fetched = Date.parse(cached.fetchedAt);
  const issued = Date.parse(cached.forecast.issuedAt);
  const now = options.now.getTime();
  if (
    !Number.isFinite(fetched) ||
    !Number.isFinite(issued) ||
    fetched > now + 60_000 ||
    issued > fetched + 60_000 ||
    now - fetched > AGILEPREDICT_CACHE_MAX_AGE_MS ||
    now - issued > ISSUE_MAX_AGE_MS
  )
    return null;
  const periods = cached.forecast.periods.filter((period) => Date.parse(period.validTo) > now);
  return periods.length > 0 ? { ...cached.forecast, periods } : null;
}

/** At most one due active region per Cron turn; failures wait for the next cadence. */
export async function refreshOneAgilePredictForecast(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<string | null> {
  try {
    const tariffs = await options.priceService.distinctTariffs();
    const regions = [...new Set(tariffs.map((tariff) => tariff.region))].sort();
    for (const region of regions) {
      const attemptKey = `${ATTEMPT_PREFIX}${region}`;
      const lastAttempt = await options.store.getState(attemptKey);
      const last = lastAttempt ? Date.parse(lastAttempt) : NaN;
      if (Number.isFinite(last) && options.now.getTime() - last < AGILEPREDICT_REFRESH_MS) continue;
      await options.store.setState(attemptKey, options.now.toISOString());
      try {
        const url = `https://agilepredict.com/api/${region}/?days=4&forecast_count=1&high_low=True`;
        const response = await (options.fetchFn ?? fetch)(url, {
          headers: { Accept: 'application/json', 'User-Agent': COLLECTOR_USER_AGENT },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`AgilePredict returned HTTP ${response.status}`);
        const [issue] = parseAgilePredict(await response.json()).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        if (!issue) throw new Error('AgilePredict returned no valid issue');
        const issued = Date.parse(issue.createdAt);
        if (
          issued > options.now.getTime() + 60_000 ||
          options.now.getTime() - issued > ISSUE_MAX_AGE_MS
        ) {
          throw new Error('AgilePredict issue is stale or in the future');
        }
        const today = londonDateOf(options.now);
        const confirmed = await Promise.all(
          tariffs
            .filter((tariff) => tariff.region === region)
            .map((tariff) =>
              options.store.getPrices(
                tariff.tariffCode,
                startOfLondonDay(today),
                startOfLondonDay(addDays(today, 5)),
              ),
            ),
        );
        const confirmedStarts = new Set(confirmed.flat().map((period) => period.validFrom));
        const tomorrowStarts = londonDayPeriodStarts(addDays(today, 1)).map((at) =>
          at.toISOString(),
        );
        const tomorrowConfirmed = tomorrowStarts.filter((start) =>
          confirmedStarts.has(start),
        ).length;
        // After the publication window begins, the provider may replace its
        // estimates with official actuals before our own Octopus poll completes.
        // Never cache that ambiguous vintage as a forecast.
        if (
          tomorrowConfirmed < tomorrowStarts.length &&
          (tomorrowConfirmed > 0 || londonDateAndMinutes(options.now).minutes >= 16 * 60)
        ) {
          throw new Error('Waiting for complete official tomorrow prices');
        }
        const periods: ForecastPricePeriod[] = [];
        for (const [validFrom, valueIncVat] of issue.values) {
          const from = Date.parse(validFrom);
          if (from < options.now.getTime() || confirmedStarts.has(validFrom)) continue;
          const range = issue.ranges.get(validFrom);
          if (!range) throw new Error('AgilePredict omitted a forecast range');
          periods.push({
            validFrom,
            validTo: new Date(from + HALF_HOUR_MS).toISOString(),
            valueIncVat,
            lowerIncVat: range.low,
            upperIncVat: range.high,
            sampleCount: 0,
            model: AGILEPREDICT_MODEL,
          });
        }
        periods.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
        if (
          periods.length < 24 ||
          periods.some(
            (period, index) => index > 0 && period.validFrom !== periods[index - 1]?.validTo,
          )
        )
          throw new Error('AgilePredict returned incomplete future periods');
        const forecast: AgilePredictForecast = {
          model: AGILEPREDICT_MODEL,
          source: AGILEPREDICT_MODEL,
          referenceRegion: region,
          historyDays: 0,
          issuedAt: issue.createdAt,
          periods,
          unavailableReason: null,
        };
        await options.store.setState(
          `${CACHE_PREFIX}${region}`,
          JSON.stringify({
            version: 1,
            region,
            fetchedAt: options.now.toISOString(),
            forecast,
          } satisfies CachedForecast),
        );
        options.logger.info('Cached AgilePredict forecast', {
          region,
          issuedAt: issue.createdAt,
          periods: periods.length,
        });
      } catch (error) {
        options.logger.warn('AgilePredict forecast refresh failed', {
          region,
          ...describeError(error),
        });
      }
      return region;
    }
  } catch (error) {
    options.logger.warn('Could not schedule AgilePredict forecast refresh', describeError(error));
  }
  return null;
}
