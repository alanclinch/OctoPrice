/**
 * Deliberately simple Agile price forecasting.
 *
 * The baseline predicts one reference region from recent confirmed values at
 * the same London-local half-hour on the same kind of day (weekday/weekend).
 * Other regions are exact fitted transforms of that reference series. There
 * is no I/O and no clock read here: callers supply history, targets and now.
 */

import type { PricePeriod } from './types.ts';
import { HALF_HOUR_MS, londonDateOf, londonMinutesOfDay, type PricingDate } from './time.ts';
import { roundPence, sortPeriods } from './prices.ts';

export const FORECAST_MODEL = 'seasonal-naive-v1';
export const FORECAST_REFERENCE_REGION = 'C';
export const MIN_FORECAST_SAMPLES = 3;
export const MAX_FORECAST_SAMPLES = 8;
export const MIN_TRANSFORM_SAMPLES = 48;
export const MIN_TRANSFORM_R_SQUARED = 0.9999;

export interface ForecastPricePeriod extends PricePeriod {
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
  const minutes = londonMinutesOfDay(new Date(period.validFrom));
  return minutes >= 16 * 60 && minutes < 19 * 60;
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
): RegionalPriceTransform | null {
  if (sameRegion) return identityTransform(reference.length);

  const targetByStart = new Map(target.map((period) => [period.validFrom, period]));
  const peak: { x: number; y: number }[] = [];
  const offPeak: { x: number; y: number }[] = [];

  for (const referencePeriod of reference) {
    const targetPeriod = targetByStart.get(referencePeriod.validFrom);
    if (!targetPeriod) continue;
    const pair = { x: referencePeriod.valueIncVat, y: targetPeriod.valueIncVat };
    (isPeak(referencePeriod) ? peak : offPeak).push(pair);
  }

  const fittedPeak = fitLine(peak);
  const fittedOffPeak = fitLine(offPeak);
  return fittedPeak && fittedOffPeak ? { peak: fittedPeak, offPeak: fittedOffPeak } : null;
}

function applyTransform(value: number, transform: LinearTransform): number {
  return roundPence(value * transform.slope + transform.intercept, 2);
}

/**
 * Forecasts target half-hours from recent confirmed reference-region prices.
 * The returned range is descriptive (recent P20-P80 values), not a calibrated
 * confidence interval. Targets at or before `now` are never forecast.
 */
export function forecastSeasonalPrices(options: {
  history: readonly PricePeriod[];
  targets: readonly Date[];
  transform: RegionalPriceTransform;
  now: Date;
}): ForecastPricePeriod[] {
  const history = sortPeriods(options.history).filter(
    (period) => Date.parse(period.validTo) <= options.now.getTime(),
  );

  return options.targets.flatMap((target): ForecastPricePeriod[] => {
    if (target.getTime() <= options.now.getTime()) return [];
    const targetDate = londonDateOf(target);
    const targetMinutes = londonMinutesOfDay(target);
    const targetWeekend = isWeekend(targetDate);

    const samples = history
      .filter((period) => {
        const from = new Date(period.validFrom);
        return (
          londonMinutesOfDay(from) === targetMinutes &&
          isWeekend(londonDateOf(from)) === targetWeekend
        );
      })
      .slice(-MAX_FORECAST_SAMPLES)
      .map((period) => period.valueIncVat)
      .sort((a, b) => a - b);

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
        valueExcVat: roundPence(estimate / 1.05, 2),
        lowerIncVat: Math.min(lower, upper),
        upperIncVat: Math.max(lower, upper),
        sampleCount: samples.length,
        model: FORECAST_MODEL,
      },
    ];
  });
}
