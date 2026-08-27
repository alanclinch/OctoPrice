/**
 * CPU regression check for the overview forecast's pure calculation.
 *
 * Run from the repository root:
 *   node docs/research/benchmark-seasonal-baseline.mjs
 */

import { performance } from 'node:perf_hooks';
import {
  addDays,
  fitRegionalPriceTransform,
  forecastSeasonalPrices,
  londonDayPeriodStarts,
  prepareForecastHistory,
} from '../../packages/core/src/index.ts';
import {
  FORECAST_HISTORY_DAYS,
  readBaselineForecastCache,
} from '../../apps/server/src/forecast/baseline.ts';

const FIRST_DAY = '2026-06-01';
const NOW = new Date('2026-08-27T20:00:00.000Z');

function period(at, valueIncVat) {
  return {
    validFrom: at.toISOString(),
    validTo: new Date(at.getTime() + 30 * 60 * 1000).toISOString(),
    valueIncVat,
    valueExcVat: valueIncVat / 1.05,
  };
}

function histories(days) {
  const reference = [];
  const target = [];
  for (let day = 0; day < days; day += 1) {
    for (const [slot, at] of londonDayPeriodStarts(addDays(FIRST_DAY, day)).entries()) {
      const value = 12 + Math.sin(slot / 4) * 7 + (day % 7);
      reference.push(period(at, value));
      const localHour = slot / 2;
      target.push(period(at, value * (localHour >= 16 && localHour < 19 ? 1.2 : 1.1) + 0.5));
    }
  }
  return { reference, target };
}

const targets = [...londonDayPeriodStarts('2026-08-28'), ...londonDayPeriodStarts('2026-08-29')];

function measure(days) {
  const { reference, target } = histories(days);
  const samples = [];
  for (let run = 0; run < 25; run += 1) {
    const started = performance.now();
    const prepared = prepareForecastHistory(reference);
    const transform = fitRegionalPriceTransform(reference, target, false, prepared);
    if (!transform) throw new Error('Synthetic regional transform failed');
    forecastSeasonalPrices({
      history: reference,
      preparedHistory: prepared,
      targets,
      transform,
      now: NOW,
    });
    if (run >= 5) samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return {
    historyPeriods: reference.length,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
  };
}

const normal = measure(28);
const doubled = measure(56);
const ratio = doubled.medianMs / normal.medianMs;
if (ratio > 3) throw new Error(`Forecast scaling regressed: doubling history took ${ratio}x`);

const { reference, target } = histories(28);
const prepared = prepareForecastHistory(reference);
const transform = fitRegionalPriceTransform(reference, target, false, prepared);
if (!transform) throw new Error('Synthetic regional transform failed');
const periods = forecastSeasonalPrices({
  history: reference,
  preparedHistory: prepared,
  targets,
  transform,
  now: NOW,
});
const tariff = {
  productCode: 'AGILE-24-10-01',
  tariffCode: 'E-1R-AGILE-24-10-01-N',
  region: 'N',
};
const cachedValue = JSON.stringify({
  version: 1,
  tariffCode: tariff.tariffCode,
  generatedAt: NOW.toISOString(),
  forecast: {
    model: 'seasonal-naive-v1',
    referenceRegion: 'C',
    historyDays: FORECAST_HISTORY_DAYS,
    periods,
    unavailableReason: null,
  },
});
const cacheSamples = [];
for (let run = 0; run < 1050; run += 1) {
  const started = performance.now();
  const result = await readBaselineForecastCache({
    store: { getState: async () => cachedValue },
    tariff,
    now: NOW,
  });
  if (result.periods.length !== periods.length) throw new Error('Cached forecast was rejected');
  if (run >= 50) cacheSamples.push(performance.now() - started);
}
cacheSamples.sort((a, b) => a - b);
const cacheRead = {
  periods: periods.length,
  medianMs: cacheSamples[Math.floor(cacheSamples.length / 2)],
  p95Ms: cacheSamples[Math.floor(cacheSamples.length * 0.95)],
};

console.log(JSON.stringify({ normal, doubled, medianScalingRatio: ratio, cacheRead }, null, 2));
