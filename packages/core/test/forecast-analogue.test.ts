import { describe, expect, it } from 'vitest';

import {
  ANALOGUE_FORECAST_MODEL,
  ANALOGUE_NEIGHBOURS,
  ANALOGUE_SHRINKAGE,
  forecastAnaloguePrices,
  type PreparedAnalogueDay,
} from '../src/forecast-analogue.ts';

function day(
  residualDemand: readonly number[],
  residual: readonly number[],
  ageDays: number,
): PreparedAnalogueDay {
  const baseline = residual.map(() => 20);
  return {
    ageDays,
    residualDemand,
    baseline,
    actual: residual.map((value, index) => (baseline[index] as number) + value),
  };
}

describe('fundamentals analogue forecasting', () => {
  it('keeps the reviewed model identity and parameters explicit', () => {
    expect(ANALOGUE_FORECAST_MODEL).toBe('fundamentals-analogue-v2');
    expect(ANALOGUE_NEIGHBOURS).toBe(12);
    expect(ANALOGUE_SHRINKAGE).toBe(0.75);
  });

  it('applies the weighted median per-period residual from the nearest days', () => {
    const candidates = [
      day([10, 20], [-4, 8], 1),
      day([11, 21], [-2, 6], 2),
      day([12, 22], [-3, 7], 3),
      day([100, 100], [40, 40], 1),
    ];
    const result = forecastAnaloguePrices({
      targetBaseline: [30, 30],
      targetResidualDemand: [10, 20],
      candidates,
      neighbours: 3,
      shrinkage: 0.75,
    });

    expect(result).toEqual([27, 36]);
  });

  it('returns no estimate when there are too few complete analogue days', () => {
    expect(
      forecastAnaloguePrices({
        targetBaseline: [20, 20],
        targetResidualDemand: [100, 100],
        candidates: [day([100, 100], [1, 1], 1), day([100, 100], [2, 2], 2)],
        neighbours: 3,
      }),
    ).toBeNull();
  });

  it('rejects malformed target curves and skips malformed candidates', () => {
    const complete = [day([10, 20], [1, 1], 1), day([10, 20], [1, 1], 2), day([10, 20], [1, 1], 3)];
    expect(
      forecastAnaloguePrices({
        targetBaseline: [20, 20],
        targetResidualDemand: [10],
        candidates: complete,
        neighbours: 3,
      }),
    ).toBeNull();

    expect(
      forecastAnaloguePrices({
        targetBaseline: [20, 20],
        targetResidualDemand: [10, 20],
        candidates: [...complete.slice(0, 2), { ...complete[2], residualDemand: [Number.NaN, 20] }],
        neighbours: 3,
      }),
    ).toBeNull();
  });
});
