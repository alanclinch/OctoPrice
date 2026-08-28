/**
 * Deliberately simple Agile price forecasting.
 *
 * The baseline predicts one reference region from recent confirmed values at
 * the same London-local half-hour on the same kind of day (weekday/weekend).
 * Other regions are exact fitted transforms of that reference series. There
 * is no I/O and no clock read here: callers supply history, targets and now.
 */

import type { PricePeriod } from './types.ts';
import {
  HALF_HOUR_MS,
  addDays,
  londonDateAndMinutes,
  londonDateOf,
  startOfLondonDay,
  type PricingDate,
} from './time.ts';
import { roundPence, sortPeriods } from './prices.ts';

export const FORECAST_MODEL = 'seasonal-naive-v1';
export const FORECAST_REFERENCE_REGION = 'C';
export const MIN_FORECAST_SAMPLES = 3;
export const MAX_FORECAST_SAMPLES = 8;
export const MIN_TRANSFORM_SAMPLES = 48;
export const MIN_TRANSFORM_R_SQUARED = 0.9999;

export interface ForecastPricePeriod {
  validFrom: string;
  validTo: string;
  valueIncVat: number;
  /** Empirical low/high values from the recent matching observations. */
  lowerIncVat: number;
  upperIncVat: number;
  sampleCount: number;
  model: typeof FORECAST_MODEL;
}

export interface LinearTransform {
  slope: number;
  intercept: number;
  sampleCount: number;
  rSquared: number;
}

export interface RegionalPriceTransform {
  offPeak: LinearTransform;
  peak: LinearTransform;
}

export interface ForecastHistoryPeriod {
  period: PricePeriod;
  minutes: number;
  weekend: boolean;
  peak: boolean;
}

function isWeekend(date: PricingDate): boolean {
  const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new Error('Cannot take a percentile of zero values');
  const index = Math.round((sorted.length - 1) * fraction);
  return sorted[index] as number;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function isPeak(period: Pick<PricePeriod, 'validFrom'>): boolean {
  const { minutes } = londonDateAndMinutes(new Date(period.validFrom));
  return minutes >= 16 * 60 && minutes < 19 * 60;
}

/** Classifies confirmed history once so fitting and forecasting can share it. */
export function prepareForecastHistory(history: readonly PricePeriod[]): ForecastHistoryPeriod[] {
  const confirmed = sortPeriods(history);
  const first = confirmed[0];
  if (!first) return [];

  // Price history is aligned to settlement periods. Resolve London once per
  // local day, then derive each slot from its UTC index. This preserves the
  // skipped/repeated clock-change hour without an ICU format for every row.
  let date = londonDateOf(new Date(first.validFrom));
  let dayStart = startOfLondonDay(date).getTime();
  let nextDayStart = startOfLondonDay(addDays(date, 1)).getTime();
  const prepared: ForecastHistoryPeriod[] = [];

  for (const period of confirmed) {
    const at = Date.parse(period.validFrom);
    while (at >= nextDayStart) {
      date = addDays(date, 1);
      dayStart = nextDayStart;
      nextDayStart = startOfLondonDay(addDays(date, 1)).getTime();
    }

    const index = Math.round((at - dayStart) / HALF_HOUR_MS);
    const periodCount = Math.round((nextDayStart - dayStart) / HALF_HOUR_MS);
    const aligned = at >= dayStart && index >= 0 && index < periodCount;
    let minutes: number;
    if (!aligned) {
      minutes = londonDateAndMinutes(new Date(at)).minutes;
    } else if (periodCount === 46 && index >= 2) {
      minutes = (index + 2) * 30;
    } else if (periodCount === 50 && index >= 4) {
      minutes = (index - 2) * 30;
    } else {
      minutes = index * 30;
    }

    prepared.push({
      period,
      minutes,
      weekend: isWeekend(date),
      peak: minutes >= 16 * 60 && minutes < 19 * 60,
    });
  }
  return prepared;
}

function identityTransform(sampleCount: number): RegionalPriceTransform {
  const identity: LinearTransform = { slope: 1, intercept: 0, sampleCount, rSquared: 1 };
  return { offPeak: identity, peak: identity };
}

function fitLine(pairs: readonly { x: number; y: number }[]): LinearTransform | null {
  if (pairs.length < MIN_TRANSFORM_SAMPLES) return null;

  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length;
  const covariance = pairs.reduce((sum, pair) => sum + (pair.x - meanX) * (pair.y - meanY), 0);
  const varianceX = pairs.reduce((sum, pair) => sum + (pair.x - meanX) ** 2, 0);
  if (varianceX <= Number.EPSILON) return null;

  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  const residual = pairs.reduce(
    (sum, pair) => sum + (pair.y - (slope * pair.x + intercept)) ** 2,
    0,
  );
  const total = pairs.reduce((sum, pair) => sum + (pair.y - meanY) ** 2, 0);
  const rSquared =
    total <= Number.EPSILON ? (residual <= Number.EPSILON ? 1 : 0) : 1 - residual / total;

  if (slope <= 0 || rSquared < MIN_TRANSFORM_R_SQUARED) return null;
  return { slope, intercept, sampleCount: pairs.length, rSquared };
}

/**
 * Fits the exact peak/off-peak relationship between a reference and a target
 * region. Returns null when the relationship no longer passes its health
 * check; a missing forecast is safer than silently using stale coefficients.
 */
export function fitRegionalPriceTransform(
  reference: readonly PricePeriod[],
  target: readonly PricePeriod[],
  sameRegion = false,
  preparedReference?: readonly ForecastHistoryPeriod[],
): RegionalPriceTransform | null {
  if (sameRegion) return identityTransform(reference.length);

  const targetByStart = new Map(target.map((period) => [period.validFrom, period]));
  const peak: { x: number; y: number }[] = [];
  const offPeak: { x: number; y: number }[] = [];

  const classified = preparedReference ?? prepareForecastHistory(reference);
  for (const { period: referencePeriod, peak: isPeakPeriod } of classified) {
    const targetPeriod = targetByStart.get(referencePeriod.validFrom);
    if (!targetPeriod) continue;
    const pair = { x: referencePeriod.valueIncVat, y: targetPeriod.valueIncVat };
    (isPeakPeriod ? peak : offPeak).push(pair);
  }

  const fittedPeak = fitLine(peak);
  const fittedOffPeak = fitLine(offPeak);
  return fittedPeak && fittedOffPeak ? { peak: fittedPeak, offPeak: fittedOffPeak } : null;
}

function applyTransform(value: number, transform: LinearTransform): number {
  return roundPence(value * transform.slope + transform.intercept, 2);
}

/** Maps an aligned reference-region curve into another Agile region. */
export function applyRegionalPriceTransform(
  values: readonly number[],
  targets: readonly Date[],
  transform: RegionalPriceTransform,
): number[] | null {
  if (
    values.length === 0 ||
    values.length !== targets.length ||
    !values.every(Number.isFinite) ||
    !targets.every((target) => Number.isFinite(target.getTime()))
  ) {
    return null;
  }
  return values.map((value, index) => {
    const target = targets[index] as Date;
    return applyTransform(
      value,
      isPeak({ validFrom: target.toISOString() }) ? transform.peak : transform.offPeak,
    );
  });
}

/**
 * Forecasts target half-hours from recent confirmed reference-region prices.
 * The returned range is descriptive (recent P20-P80 values), not a calibrated
 * confidence interval. Targets at or before `now` are never forecast.
 */
export function forecastSeasonalPrices(options: {
  history: readonly PricePeriod[];
  preparedHistory?: readonly ForecastHistoryPeriod[];
  targets: readonly Date[];
  transform: RegionalPriceTransform;
  now: Date;
}): ForecastPricePeriod[] {
  const history = options.preparedHistory ?? prepareForecastHistory(options.history);

  // Classify every historical period once. The previous implementation did
  // this inside the target loop, turning 28 days x 96 targets into roughly
  // 258,000 ICU date formats on every overview request.
  const buckets = new Map<string, number[]>();
  for (const item of history) {
    const key = `${item.weekend ? 1 : 0}:${item.minutes}`;
    const values = buckets.get(key) ?? [];
    values.push(item.period.valueIncVat);
    if (values.length > MAX_FORECAST_SAMPLES) values.shift();
    buckets.set(key, values);
  }

  return options.targets.flatMap((target): ForecastPricePeriod[] => {
    if (target.getTime() <= options.now.getTime()) return [];
    const local = londonDateAndMinutes(target);
    const key = `${isWeekend(local.date) ? 1 : 0}:${local.minutes}`;
    const samples = [...(buckets.get(key) ?? [])].sort((a, b) => a - b);

    if (samples.length < MIN_FORECAST_SAMPLES) return [];

    const transform = isPeak({ validFrom: target.toISOString() })
      ? options.transform.peak
      : options.transform.offPeak;
    const estimate = applyTransform(median(samples), transform);
    const lower = applyTransform(percentile(samples, 0.2), transform);
    const upper = applyTransform(percentile(samples, 0.8), transform);

    return [
      {
        validFrom: target.toISOString(),
        validTo: new Date(target.getTime() + HALF_HOUR_MS).toISOString(),
        valueIncVat: estimate,
        lowerIncVat: Math.min(lower, upper),
        upperIncVat: Math.max(lower, upper),
        sampleCount: samples.length,
        model: FORECAST_MODEL,
      },
    ];
  });
}
