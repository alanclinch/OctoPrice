/**
 * Fundamentals-conditioned correction for the seasonal Agile baseline.
 *
 * I/O, feature collection and day preparation live outside core. This module
 * receives compact, aligned curves and only performs analogue selection plus
 * weighted residual correction. Missing or malformed input returns no
 * forecast rather than weakening the confirmed-price boundary.
 */

export const ANALOGUE_FORECAST_MODEL = 'fundamentals-analogue-v2';
export const ANALOGUE_NEIGHBOURS = 12;
export const ANALOGUE_SHRINKAGE = 0.75;
export const MIN_ANALOGUE_DAYS = 3;

export interface PreparedAnalogueDay {
  /** Positive whole-day distance between this day and the target day. */
  ageDays: number;
  /** Demand minus transmission-connected wind for each aligned period. */
  residualDemand: readonly number[];
  /** Seasonal baseline that was available when this historical day was forecast. */
  baseline: readonly number[];
  /** Confirmed region-C prices for the historical day. */
  actual: readonly number[];
}

export interface AnalogueForecastInput {
  targetBaseline: readonly number[];
  targetResidualDemand: readonly number[];
  candidates: readonly PreparedAnalogueDay[];
  neighbours?: number;
  shrinkage?: number;
}

interface RankedDay extends PreparedAnalogueDay {
  distance: number;
}

const DISTANCE_FLOOR_FRACTION = 1e-6;

function validCurve(curve: readonly number[], expectedLength: number): boolean {
  return curve.length === expectedLength && curve.every(Number.isFinite);
}

function curveDistance(target: readonly number[], candidate: readonly number[]): number {
  let squared = 0;
  for (let index = 0; index < target.length; index += 1) {
    squared += ((target[index] as number) - (candidate[index] as number)) ** 2;
  }
  return Math.sqrt(squared / target.length);
}

function weightedMedian(entries: readonly { value: number; weight: number }[]): number {
  const sorted = [...entries].sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= total / 2) return entry.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

/**
 * Corrects a seasonal baseline using per-period errors from system-condition
 * analogue days. The selected single feature needs no standardisation:
 * dividing every distance by one positive constant changes neither ranking
 * nor inverse-distance relative weights.
 */
export function forecastAnaloguePrices(input: AnalogueForecastInput): number[] | null {
  const periodCount = input.targetBaseline.length;
  const neighbours = input.neighbours ?? ANALOGUE_NEIGHBOURS;
  const shrinkage = input.shrinkage ?? ANALOGUE_SHRINKAGE;
  if (
    periodCount === 0 ||
    !validCurve(input.targetBaseline, periodCount) ||
    !validCurve(input.targetResidualDemand, periodCount) ||
    !Number.isInteger(neighbours) ||
    neighbours < MIN_ANALOGUE_DAYS ||
    !Number.isFinite(shrinkage) ||
    shrinkage < 0 ||
    shrinkage > 1
  ) {
    return null;
  }

  const candidates = input.candidates.filter(
    (candidate) =>
      Number.isInteger(candidate.ageDays) &&
      candidate.ageDays > 0 &&
      validCurve(candidate.residualDemand, periodCount) &&
      validCurve(candidate.baseline, periodCount) &&
      validCurve(candidate.actual, periodCount),
  );
  if (candidates.length < neighbours) return null;

  const rankedAll: RankedDay[] = candidates
    .map((candidate) => ({
      ...candidate,
      distance:
        curveDistance(input.targetResidualDemand, candidate.residualDemand) *
        (1 + candidate.ageDays / 365),
    }))
    .sort((left, right) => left.distance - right.distance);
  const medianDistance = rankedAll[Math.floor(rankedAll.length / 2)]?.distance ?? 0;
  const distanceFloor = Math.max(medianDistance * DISTANCE_FLOOR_FRACTION, Number.EPSILON);
  const ranked = rankedAll.slice(0, neighbours);

  return input.targetBaseline.map((baseline, period) => {
    const correction = weightedMedian(
      ranked.map((analogue) => ({
        value: (analogue.actual[period] as number) - (analogue.baseline[period] as number),
        weight: Math.exp(-analogue.ageDays / 180) / Math.max(analogue.distance, distanceFloor),
      })),
    );
    return baseline + shrinkage * correction;
  });
}
