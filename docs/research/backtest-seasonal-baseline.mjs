/**
 * Reproduces the accuracy figures for the implemented seasonal-naive baseline.
 *
 * Fixed inputs make successive runs comparable:
 *   product  AGILE-24-10-01
 *   tariff   E-1R-AGILE-24-10-01-C (London, the reference region)
 *   history  2026-06-01 through 2026-08-26
 *   scored   2026-07-01 through 2026-08-26
 *
 * Run from the repository root:
 *   node docs/research/backtest-seasonal-baseline.mjs
 */

import {
  addDays,
  fitRegionalPriceTransform,
  forecastSeasonalPrices,
  londonDayPeriodStarts,
  normalisePeriods,
  periodsForLondonDay,
  startOfLondonDay,
} from '../../packages/core/src/index.ts';

const PRODUCT = 'AGILE-24-10-01';
const TARIFF = `E-1R-${PRODUCT}-C`;
const FETCH_FROM = '2026-06-01';
const FETCH_TO = '2026-08-27';
const SCORE_FROM = '2026-07-01';
const SCORE_TO = '2026-08-27';
const HISTORY_DAYS = 28;

async function fetchPrices() {
  const params = new URLSearchParams({
    period_from: startOfLondonDay(FETCH_FROM).toISOString(),
    period_to: startOfLondonDay(FETCH_TO).toISOString(),
    page_size: '1500',
  });
  let url =
    `https://api.octopus.energy/v1/products/${PRODUCT}` +
    `/electricity-tariffs/${TARIFF}/standard-unit-rates/?${params}`;
  const periods = [];

  while (url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Octopus returned ${response.status} for ${url}`);
    const body = await response.json();
    for (const row of body.results ?? []) {
      if (!row.valid_from || !row.valid_to || typeof row.value_inc_vat !== 'number') continue;
      periods.push({
        validFrom: new Date(row.valid_from).toISOString(),
        validTo: new Date(row.valid_to).toISOString(),
        valueIncVat: row.value_inc_vat,
        valueExcVat: row.value_exc_vat,
      });
    }
    url = body.next;
  }
  return normalisePeriods(periods);
}

function dates(from, toExclusive) {
  const result = [];
  for (let date = from; date < toExclusive; date = addDays(date, 1)) result.push(date);
  return result;
}

function eventCounts(scored, predicate) {
  let predicted = 0;
  let actual = 0;
  let truePositive = 0;
  for (const row of scored) {
    const predictedEvent = predicate(row.estimate);
    const actualEvent = predicate(row.actual);
    if (predictedEvent) predicted += 1;
    if (actualEvent) actual += 1;
    if (predictedEvent && actualEvent) truePositive += 1;
  }
  return {
    actual,
    predicted,
    precision: predicted === 0 ? null : truePositive / predicted,
    recall: actual === 0 ? null : truePositive / actual,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

const all = await fetchPrices();
const transform = fitRegionalPriceTransform(all, all, true);
const scored = [];
let skippedDays = 0;

for (const date of dates(SCORE_FROM, SCORE_TO)) {
  const actual = periodsForLondonDay(all, date);
  const historyFrom = startOfLondonDay(addDays(date, -HISTORY_DAYS)).getTime();
  const predictionTime = new Date(startOfLondonDay(date).getTime() - 1);
  const history = all.filter((period) => {
    const at = Date.parse(period.validFrom);
    return at >= historyFrom && Date.parse(period.validTo) <= predictionTime.getTime();
  });
  const forecast = forecastSeasonalPrices({
    history,
    targets: londonDayPeriodStarts(date),
    transform,
    now: predictionTime,
  });
  const actualByStart = new Map(actual.map((period) => [period.validFrom, period.valueIncVat]));

  if (forecast.length !== actual.length || actual.length === 0) {
    skippedDays += 1;
    continue;
  }
  for (const estimate of forecast) {
    const actualValue = actualByStart.get(estimate.validFrom);
    if (actualValue === undefined) continue;
    scored.push({
      estimate: estimate.valueIncVat,
      lower: estimate.lowerIncVat,
      upper: estimate.upperIncVat,
      actual: actualValue,
    });
  }
}

if (scored.length === 0) throw new Error('No periods were available to score');
const absoluteErrors = scored.map((row) => Math.abs(row.estimate - row.actual));
const signedErrors = scored.map((row) => row.estimate - row.actual);
const covered = scored.filter((row) => row.actual >= row.lower && row.actual <= row.upper).length;

console.log(
  JSON.stringify(
    {
      product: PRODUCT,
      tariff: TARIFF,
      fetchedPeriods: all.length,
      scoredPeriods: scored.length,
      skippedDays,
      maePence: absoluteErrors.reduce((sum, value) => sum + value, 0) / scored.length,
      medianAbsoluteErrorPence: percentile(absoluteErrors, 0.5),
      p90AbsoluteErrorPence: percentile(absoluteErrors, 0.9),
      meanBiasPence: signedErrors.reduce((sum, value) => sum + value, 0) / scored.length,
      recentRangeCoverage: covered / scored.length,
      cheapBelow10p: eventCounts(scored, (value) => value < 10),
      negative: eventCounts(scored, (value) => value < 0),
    },
    null,
    2,
  ),
);
