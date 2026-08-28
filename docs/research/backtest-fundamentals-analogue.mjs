/**
 * Leakage-safe walk-forward experiment for `fundamentals-analogue-v2`.
 *
 * This is deliberately a research script, not production inference. It asks
 * whether tomorrow-specific grid forecasts can improve the shipped seasonal
 * baseline before database tables or UI behaviour are built around the idea.
 *
 * Inputs and vintages:
 *   - Octopus region-C confirmed Agile prices.
 *   - Elexon's earliest published national-demand and transmission-wind
 *     forecasts for each target period. Those vintages are always available
 *     before the fixed 14:00 Europe/London issue cut-off used here.
 *   - NESO embedded-wind and embedded-solar archive rows, selecting the last
 *     `Forecast_Datetime` no later than that same cut-off. `TIME_GMT` is the
 *     period end, so the shared, tested conversion subtracts 30 minutes.
 *
 * Model selection uses the earlier tuning block. The winning configuration is
 * then scored once on the later holdout block. Do not choose parameters from
 * the holdout result.
 *
 * Run from the repository root:
 *   node docs/research/backtest-fundamentals-analogue.mjs
 */

import {
  addDays,
  endOfLondonDay,
  fitRegionalPriceTransform,
  forecastAnaloguePrices,
  forecastSeasonalPrices,
  londonDayPeriodStarts,
  normalisePeriods,
  periodsForLondonDay,
  startOfLondonDay,
} from '../../packages/core/src/index.ts';
import { nesoArchivePeriodStart } from '../../apps/server/src/forecast/collectors.ts';

const PRODUCT = 'AGILE-24-10-01';
const TARIFF = `E-1R-${PRODUCT}-C`;
const PRICE_FETCH_FROM = '2026-04-01';
const FEATURE_FROM = '2026-05-01';
const SCORE_FROM = '2026-05-29';
const TUNE_TO = '2026-07-15';
const SCORE_TO = '2026-08-27';
const HISTORY_DAYS = 28;
const ANALOGUE_LOOKBACK_DAYS = 90;
const ISSUE_LOCAL_HOUR = 14;
const MIN_ANALOGUES = 3;
const ELEXON_API = 'https://data.elexon.co.uk/bmrs/api/v1';
const NESO_API = 'https://api.neso.energy/api/3/action';
const NESO_RESOURCES = [
  'd6375700-69c2-4c25-8bde-883a205d742e',
  '31861619-0b86-47ba-bac2-d008a760af54',
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.status === 429 && attempt < attempts) {
        await sleep(attempt * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 500);
    }
  }
  throw lastError;
}

function dates(from, toExclusive) {
  const result = [];
  for (let date = from; date < toExclusive; date = addDays(date, 1)) result.push(date);
  return result;
}

function chunks(from, toExclusive, daysPerChunk) {
  const result = [];
  for (let start = from; start < toExclusive; start = addDays(start, daysPerChunk)) {
    const end = addDays(start, daysPerChunk);
    result.push([start, end < toExclusive ? end : toExclusive]);
  }
  return result;
}

async function fetchPrices() {
  const params = new URLSearchParams({
    period_from: startOfLondonDay(PRICE_FETCH_FROM).toISOString(),
    period_to: startOfLondonDay(SCORE_TO).toISOString(),
    page_size: '1500',
  });
  let url =
    `https://api.octopus.energy/v1/products/${PRODUCT}` +
    `/electricity-tariffs/${TARIFF}/standard-unit-rates/?${params}`;
  const periods = [];

  while (url) {
    const body = await getJson(url);
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

async function fetchElexonEarliest(path) {
  const rows = [];
  for (const [from, to] of chunks(addDays(FEATURE_FROM, -1), addDays(SCORE_TO, 1), 28)) {
    const params = new URLSearchParams({
      from: startOfLondonDay(from).toISOString(),
      to: startOfLondonDay(to).toISOString(),
    });
    const batch = await getJson(`${ELEXON_API}${path}?${params}`);
    if (!Array.isArray(batch)) throw new Error(`Unexpected Elexon response for ${path}`);
    rows.push(...batch);
  }
  return rows;
}

async function fetchNesoEmbedded() {
  const byStart = new Map();
  for (const resource of NESO_RESOURCES) {
    for (const [from, to] of chunks(FEATURE_FROM, SCORE_TO, 28)) {
      // The whole experiment is inside British Summer Time. Fourteen hundred
      // local on D-1 is 13:00Z, eleven hours before target-day UTC midnight.
      const sql = `SELECT DISTINCT ON ("DATE_GMT", "TIME_GMT")
        "DATE_GMT", "TIME_GMT", "EMBEDDED_WIND_FORECAST",
        "EMBEDDED_SOLAR_FORECAST", "Forecast_Datetime"
        FROM "${resource}"
        WHERE "DATE_GMT" >= '${from}' AND "DATE_GMT" < '${to}'
          AND "Forecast_Datetime" <= date_trunc('day', "DATE_GMT") - interval '11 hours'
        ORDER BY "DATE_GMT", "TIME_GMT", "Forecast_Datetime" DESC
        LIMIT 5000`;
      const body = await getJson(`${NESO_API}/datastore_search_sql?sql=${encodeURIComponent(sql)}`);
      if (!body.success || !Array.isArray(body.result?.records)) {
        throw new Error(`Unexpected NESO response for ${resource}`);
      }
      for (const row of body.result.records) {
        const start = nesoArchivePeriodStart(row.DATE_GMT, row.TIME_GMT);
        const issuedAt = Date.parse(`${row.Forecast_Datetime}Z`);
        const wind = Number(row.EMBEDDED_WIND_FORECAST);
        const solar = Number(row.EMBEDDED_SOLAR_FORECAST);
        if (
          !start ||
          !Number.isFinite(issuedAt) ||
          !Number.isFinite(wind) ||
          !Number.isFinite(solar)
        ) {
          continue;
        }
        const previous = byStart.get(start);
        if (!previous || issuedAt > previous.issuedAt) {
          byStart.set(start, { embeddedWind: wind, solar, issuedAt });
        }
      }
    }
  }
  return byStart;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapElexonDemand(rows) {
  const byStart = new Map();
  for (const row of rows) {
    const start = typeof row.startTime === 'string' ? new Date(row.startTime).toISOString() : null;
    const demand = finiteNumber(row.nationalDemand);
    const published = typeof row.publishTime === 'string' ? Date.parse(row.publishTime) : NaN;
    if (!start || demand === null || !Number.isFinite(published)) continue;
    const previous = byStart.get(start);
    if (!previous || published < previous.published)
      byStart.set(start, { value: demand, published });
  }
  return byStart;
}

function mapElexonWind(rows) {
  const byStart = new Map();
  for (const row of rows) {
    const start = typeof row.startTime === 'string' ? new Date(row.startTime).toISOString() : null;
    const generation = finiteNumber(row.generation);
    const published = typeof row.publishTime === 'string' ? Date.parse(row.publishTime) : NaN;
    if (!start || generation === null || !Number.isFinite(published)) continue;
    const previous = byStart.get(start);
    if (!previous || published < previous.published) {
      byStart.set(start, { value: generation, published });
    }
  }
  return byStart;
}

function interpolatedWind(byStart, at) {
  const exact = byStart.get(at.toISOString());
  if (exact) return exact;
  const before = byStart.get(new Date(at.getTime() - 30 * 60 * 1000).toISOString());
  const after = byStart.get(new Date(at.getTime() + 30 * 60 * 1000).toISOString());
  return before && after
    ? {
        value: (before.value + after.value) / 2,
        published: Math.max(before.published, after.published),
      }
    : null;
}

function buildFeatureDays(demandByStart, windByStart, embeddedByStart) {
  const result = new Map();
  for (const date of dates(FEATURE_FROM, SCORE_TO)) {
    const curve = [];
    let valid = true;
    // This experiment is wholly in BST. Target-day local midnight is 23:00Z;
    // 14:00 local on D-1 is ten hours before that instant.
    const issueCutoff = startOfLondonDay(date).getTime() - 10 * 60 * 60 * 1000;
    for (const at of londonDayPeriodStarts(date)) {
      const demandForecast = demandByStart.get(at.toISOString());
      const transmissionWind = interpolatedWind(windByStart, at);
      const embedded = embeddedByStart.get(at.toISOString());
      if (
        !demandForecast ||
        !transmissionWind ||
        !embedded ||
        demandForecast.published > issueCutoff ||
        transmissionWind.published > issueCutoff ||
        embedded.issuedAt > issueCutoff
      ) {
        valid = false;
        break;
      }
      curve.push({
        demand: demandForecast.value,
        transmissionWind: transmissionWind.value,
        embeddedWind: embedded.embeddedWind,
        solar: embedded.solar,
        // NDF already reflects embedded generation suppressing transmission
        // demand. Subtract only transmission-connected wind here; subtracting
        // embedded wind and solar again would double-count their effect.
        residualDemand: demandForecast.value - transmissionWind.value,
      });
    }
    if (valid && curve.length === londonDayPeriodStarts(date).length) result.set(date, curve);
  }
  return result;
}

function buildBaselines(allPrices) {
  const transform = fitRegionalPriceTransform(allPrices, allPrices, true);
  if (!transform) throw new Error('Could not create identity regional transform');
  const result = new Map();

  for (const date of dates(FEATURE_FROM, SCORE_TO)) {
    const issueDate = addDays(date, -1);
    const predictionTime = new Date(endOfLondonDay(issueDate).getTime() - 1);
    const historyFrom = startOfLondonDay(addDays(issueDate, -HISTORY_DAYS)).getTime();
    const history = allPrices.filter((period) => {
      const at = Date.parse(period.validFrom);
      return at >= historyFrom && Date.parse(period.validTo) <= predictionTime.getTime();
    });
    const forecast = forecastSeasonalPrices({
      history,
      targets: londonDayPeriodStarts(date),
      transform,
      now: predictionTime,
    });
    const actual = periodsForLondonDay(allPrices, date);
    if (forecast.length !== actual.length || actual.length === 0) continue;
    const actualByStart = new Map(actual.map((period) => [period.validFrom, period.valueIncVat]));
    const estimates = forecast.map((period) => period.valueIncVat);
    const actuals = forecast.map((period) => actualByStart.get(period.validFrom));
    if (actuals.some((value) => value === undefined)) continue;
    result.set(date, { estimates, actuals });
  }
  return result;
}

const FEATURE_SETS = {
  'residual-demand': (point) => [point.residualDemand],
  components: (point) => [point.demand, point.transmissionWind, point.embeddedWind, point.solar],
  'components-plus-residual': (point) => [
    point.demand,
    point.transmissionWind,
    point.embeddedWind,
    point.solar,
    point.residualDemand,
  ],
};

function featureScales(candidateCurves, select) {
  const columns = [];
  for (const curve of candidateCurves) {
    for (const point of curve) {
      const values = select(point);
      values.forEach((value, index) => (columns[index] ??= []).push(value));
    }
  }
  return columns.map((values) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.max(Math.sqrt(variance), 1);
  });
}

function curveDistance(target, candidate, select, scales) {
  let squared = 0;
  let count = 0;
  for (let index = 0; index < target.length; index += 1) {
    const targetValues = select(target[index]);
    const candidateValues = select(candidate[index]);
    for (let feature = 0; feature < targetValues.length; feature += 1) {
      squared += ((targetValues[feature] - candidateValues[feature]) / scales[feature]) ** 2;
      count += 1;
    }
  }
  return Math.sqrt(squared / count);
}

function weightedMedian(entries) {
  const sorted = [...entries].sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= total / 2) return entry.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

function prepareAnalogueInput(date, featureDays, baselines) {
  const targetCurve = featureDays.get(date);
  const target = baselines.get(date);
  if (!targetCurve || !target) return null;
  const candidates = dates(addDays(date, -ANALOGUE_LOOKBACK_DAYS), date)
    .filter((candidate) => featureDays.has(candidate) && baselines.has(candidate))
    .map((candidate) => ({
      date: candidate,
      ageDays: Math.round(
        (startOfLondonDay(date).getTime() - startOfLondonDay(candidate).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
      curve: featureDays.get(candidate),
      ...baselines.get(candidate),
    }));
  return { targetCurve, targetBaseline: target.estimates, candidates };
}

function forecastPreparedAnalogue(input, configuration) {
  const select = FEATURE_SETS[configuration.featureSet];
  if (input.candidates.length < Math.max(configuration.k, MIN_ANALOGUES)) return null;
  // The selected single-feature residual-demand model does not need a scale:
  // dividing every candidate distance by the same positive value changes
  // neither rank nor inverse-distance relative weights. Avoiding that full
  // second pass matters inside the Worker's 10 ms CPU allowance. Multi-feature
  // experiments still require per-feature standardisation.
  const scales =
    configuration.featureSet === 'residual-demand'
      ? [1]
      : featureScales(
          input.candidates.map((candidate) => candidate.curve),
          select,
        );
  const ranked = input.candidates
    .map((candidate) => {
      const rawDistance = curveDistance(input.targetCurve, candidate.curve, select, scales);
      return {
        ...candidate,
        distance: rawDistance * (1 + candidate.ageDays / 365),
      };
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, configuration.k);

  return input.targetBaseline.map((baseline, index) => {
    const residuals = ranked.map((analogue) => ({
      value: analogue.actuals[index] - analogue.estimates[index],
      weight: Math.exp(-analogue.ageDays / 180) / Math.max(analogue.distance, 0.05),
    }));
    return baseline + configuration.shrinkage * weightedMedian(residuals);
  });
}

function forecastAnalogue(date, configuration, featureDays, baselines) {
  const input = prepareAnalogueInput(date, featureDays, baselines);
  return input ? forecastPreparedAnalogue(input, configuration) : null;
}

function coreAnalogueInput(input) {
  return {
    targetBaseline: input.targetBaseline,
    targetResidualDemand: input.targetCurve.map((point) => point.residualDemand),
    candidates: input.candidates.map((candidate) => ({
      ageDays: candidate.ageDays,
      residualDemand: candidate.curve.map((point) => point.residualDemand),
      baseline: candidate.estimates,
      actual: candidate.actuals,
    })),
  };
}

function forecastSelectedAnalogue(date, configuration, featureDays, baselines) {
  const input = prepareAnalogueInput(date, featureDays, baselines);
  if (!input || configuration.featureSet !== 'residual-demand') return null;
  return forecastAnaloguePrices({
    ...coreAnalogueInput(input),
    neighbours: configuration.k,
    shrinkage: configuration.shrinkage,
  });
}

function cheapestWindow(values, periods = 6) {
  let best = { index: -1, average: Number.POSITIVE_INFINITY };
  for (let index = 0; index + periods <= values.length; index += 1) {
    const average =
      values.slice(index, index + periods).reduce((sum, value) => sum + value, 0) / periods;
    if (average < best.average) best = { index, average };
  }
  return best;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.round((sorted.length - 1) * fraction)];
}

function scoreDates(scoreDates, predict, baselines) {
  const absoluteErrors = [];
  const signedErrors = [];
  const regrets = [];
  const startErrors = [];
  let exact = 0;
  let within60 = 0;
  let days = 0;

  for (const date of scoreDates) {
    const baseline = baselines.get(date);
    const estimates = predict(date);
    if (!baseline || !estimates || estimates.length !== baseline.actuals.length) continue;
    days += 1;
    for (let index = 0; index < estimates.length; index += 1) {
      const error = estimates[index] - baseline.actuals[index];
      absoluteErrors.push(Math.abs(error));
      signedErrors.push(error);
    }
    const predictedWindow = cheapestWindow(estimates);
    const actualWindow = cheapestWindow(baseline.actuals);
    const chosenActualAverage =
      baseline.actuals
        .slice(predictedWindow.index, predictedWindow.index + 6)
        .reduce((sum, value) => sum + value, 0) / 6;
    regrets.push(chosenActualAverage - actualWindow.average);
    const startError = Math.abs(predictedWindow.index - actualWindow.index) * 30;
    startErrors.push(startError);
    if (startError === 0) exact += 1;
    if (startError <= 60) within60 += 1;
  }
  if (days === 0) return null;
  return {
    days,
    periods: absoluteErrors.length,
    maePence: absoluteErrors.reduce((sum, value) => sum + value, 0) / absoluteErrors.length,
    biasPence: signedErrors.reduce((sum, value) => sum + value, 0) / signedErrors.length,
    cheapest3hRegretPencePerKwh: regrets.reduce((sum, value) => sum + value, 0) / days,
    medianStartErrorMinutes: percentile(startErrors, 0.5),
    within60Minutes: within60 / days,
    exactStart: exact / days,
  };
}

function configurationKey(configuration) {
  return `${configuration.featureSet}:k${configuration.k}:s${configuration.shrinkage}`;
}

function benchmarkInference(date, configuration, featureDays, baselines) {
  const input = prepareAnalogueInput(date, featureDays, baselines);
  if (!input) throw new Error(`Could not prepare benchmark input for ${date}`);
  const prepared = coreAnalogueInput(input);
  for (let index = 0; index < 30; index += 1) {
    forecastAnaloguePrices({
      ...prepared,
      neighbours: configuration.k,
      shrinkage: configuration.shrinkage,
    });
  }
  const durations = [];
  for (let index = 0; index < 500; index += 1) {
    const started = performance.now();
    forecastAnaloguePrices({
      ...prepared,
      neighbours: configuration.k,
      shrinkage: configuration.shrinkage,
    });
    durations.push(performance.now() - started);
  }
  return {
    iterations: durations.length,
    medianMilliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95),
  };
}

function compactDayRowBytes(featureDays, baselines) {
  const bytes = [];
  for (const [date, curve] of featureDays) {
    const baseline = baselines.get(date);
    if (!baseline) continue;
    bytes.push(
      Buffer.byteLength(
        JSON.stringify({
          date,
          curve: curve.map((point) => [
            point.demand,
            point.transmissionWind,
            point.embeddedWind,
            point.solar,
          ]),
          baseline: baseline.estimates,
          actual: baseline.actuals,
        }),
      ),
    );
  }
  const average = bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
  return {
    measuredRows: bytes.length,
    averageBytesPerPreparedDay: average,
    estimatedBytesFor90Days: Math.ceil(average * 90),
  };
}

function better(left, right) {
  if (!right) return true;
  const regretDifference = left.cheapest3hRegretPencePerKwh - right.cheapest3hRegretPencePerKwh;
  if (Math.abs(regretDifference) > 0.01) return regretDifference < 0;
  const timingDifference = left.within60Minutes - right.within60Minutes;
  if (Math.abs(timingDifference) > 0.001) return timingDifference > 0;
  return left.maePence < right.maePence;
}

const [allPrices, demandRows, windRows, embeddedByStart] = await Promise.all([
  fetchPrices(),
  fetchElexonEarliest('/forecast/demand/day-ahead/earliest/stream'),
  fetchElexonEarliest('/forecast/generation/wind/earliest/stream'),
  fetchNesoEmbedded(),
]);

const demandByStart = mapElexonDemand(demandRows);
const windByStart = mapElexonWind(windRows);
const featureDays = buildFeatureDays(demandByStart, windByStart, embeddedByStart);
const baselines = buildBaselines(allPrices);
const tuningDates = dates(SCORE_FROM, TUNE_TO);
const holdoutDates = dates(TUNE_TO, SCORE_TO);
const configurations = Object.keys(FEATURE_SETS).flatMap((featureSet) =>
  [3, 5, 8, 12].flatMap((k) => [0.5, 0.75, 1].map((shrinkage) => ({ featureSet, k, shrinkage }))),
);

const baselineTuning = scoreDates(tuningDates, (date) => baselines.get(date)?.estimates, baselines);
const baselineHoldout = scoreDates(
  holdoutDates,
  (date) => baselines.get(date)?.estimates,
  baselines,
);
let winner = null;
for (const configuration of configurations) {
  const metrics = scoreDates(
    tuningDates,
    (date) => forecastAnalogue(date, configuration, featureDays, baselines),
    baselines,
  );
  if (metrics && better(metrics, winner?.metrics)) winner = { configuration, metrics };
}
if (!winner) throw new Error('No analogue configuration produced a tuning result');

const analogueHoldout = scoreDates(
  holdoutDates,
  (date) => forecastSelectedAnalogue(date, winner.configuration, featureDays, baselines),
  baselines,
);
const allScoreDates = dates(SCORE_FROM, SCORE_TO);
const fixedConfigurationAllDays = scoreDates(
  allScoreDates,
  (date) => forecastSelectedAnalogue(date, winner.configuration, featureDays, baselines),
  baselines,
);
const benchmarkDate = addDays(SCORE_TO, -1);
const inferenceBenchmark = benchmarkInference(
  benchmarkDate,
  winner.configuration,
  featureDays,
  baselines,
);

console.log(
  JSON.stringify(
    {
      product: PRODUCT,
      tariff: TARIFF,
      issueCutoff: `${String(ISSUE_LOCAL_HOUR).padStart(2, '0')}:00 Europe/London on D-1`,
      inputs: {
        confirmedPricePeriods: allPrices.length,
        earliestDemandRows: demandRows.length,
        earliestTransmissionWindRows: windRows.length,
        embeddedForecastPeriods: embeddedByStart.size,
        completeFeatureDays: featureDays.size,
      },
      ranges: {
        featureFrom: FEATURE_FROM,
        tuning: [SCORE_FROM, TUNE_TO],
        holdout: [TUNE_TO, SCORE_TO],
      },
      baseline: { tuning: baselineTuning, holdout: baselineHoldout },
      selectedOnTuningOnly: {
        configuration: winner.configuration,
        key: configurationKey(winner.configuration),
        tuning: winner.metrics,
        holdout: analogueHoldout,
        allDaysDescriptiveOnly: fixedConfigurationAllDays,
      },
      resourceBudget: {
        proposedMaximumPreparedRowsRead: 100,
        proposedMaximumPreparedPayloadBytes: 512 * 1024,
        proposedMaximumIncrementalCpuP95Milliseconds: 3,
        proposedMaximumTotalForecastCpuP95Milliseconds: 8,
        prototypeInference: { date: benchmarkDate, ...inferenceBenchmark },
        preparedDayStorage: compactDayRowBytes(featureDays, baselines),
      },
    },
    null,
    2,
  ),
);
