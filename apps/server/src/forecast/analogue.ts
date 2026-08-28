/**
 * Prepared-day and shadow-run orchestration for fundamentals-analogue-v2.
 *
 * Nothing in this module is read by the public API. It incrementally prepares
 * compact reference-region days, records paired v1/v2 forecast vintages and
 * scores them after confirmed prices arrive. Missing inputs produce no v2 run.
 */

import {
  ANALOGUE_FORECAST_MODEL,
  FORECAST_MODEL,
  FORECAST_REFERENCE_REGION,
  addDays,
  buildTariffCode,
  endOfLondonDay,
  fitRegionalPriceTransform,
  forecastAnaloguePrices,
  forecastSeasonalPrices,
  isDayComplete,
  londonDateAndMinutes,
  londonDateOf,
  londonDayPeriodStarts,
  startOfLondonDay,
  type PricingDate,
} from '@octoprice/core';
import type { ForecastRunEvaluation, PreparedForecastDay, Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import type { PriceService, TariffSelection } from '../prices/service.ts';

const ELEXON_API = 'https://data.elexon.co.uk/bmrs/api/v1';
const ANALOGUE_PRICE_HISTORY_DAYS = 118;
export const ANALOGUE_CANDIDATE_DAYS = 90;
const ANALOGUE_PRICE_CURSOR_PREFIX = 'forecast_analogue_price_cursor:';
const ANALOGUE_PRICE_ATTEMPT_PREFIX = 'forecast_analogue_price_attempt:';
const ANALOGUE_DAY_CURSOR_PREFIX = 'forecast_analogue_day_cursor:';
const ANALOGUE_DAY_ATTEMPT_PREFIX = 'forecast_analogue_day_attempt:';
const MAX_PERMANENT_ATTEMPTS = 3;

export interface AnalogueShadowStatus {
  referenceTariffCode: string;
  historyThrough: PricingDate | null;
  preparedThrough: PricingDate | null;
  preparedDays: number;
  requiredPreparedDays: number;
  runs: ForecastRunEvaluation[];
}

interface ElexonDemandRow {
  publishTime?: unknown;
  startTime?: unknown;
  nationalDemand?: unknown;
}

interface ElexonWindRow {
  publishTime?: unknown;
  startTime?: unknown;
  generation?: unknown;
}

interface ForecastValue {
  value: number;
  publishedAt: string;
}

export interface ResidualDemandForecast {
  values: number[];
  inputVintages: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || !value.every(isRecord)) return null;
  return value;
}

async function fetchRows(
  path: string,
  date: PricingDate,
  fetchFn: typeof fetch,
  extendToMinutes = 0,
): Promise<Record<string, unknown>[]> {
  const nextDay = startOfLondonDay(addDays(date, 1));
  const params = new URLSearchParams({
    from: startOfLondonDay(date).toISOString(),
    to: new Date(nextDay.getTime() + extendToMinutes * 60 * 1000).toISOString(),
  });
  const response = await fetchFn(`${ELEXON_API}${path}?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Elexon returned ${response.status} for ${path}`);
  const rows = asRows(await response.json());
  if (!rows) throw new Error(`Elexon returned malformed rows for ${path}`);
  return rows;
}

/** The 14:00 Europe/London issue instant on the day before `date`. */
export function analogueIssueCutoff(date: PricingDate): Date {
  const issueDate = addDays(date, -1);
  const result = londonDayPeriodStarts(issueDate).find(
    (period) => londonDateAndMinutes(period).minutes === 14 * 60,
  );
  if (!result) throw new Error(`Could not resolve analogue issue cut-off for ${date}`);
  return result;
}

function addEarliest(
  target: Map<string, ForecastValue>,
  start: unknown,
  value: unknown,
  publishedAt: unknown,
  cutoff: Date,
): void {
  if (typeof start !== 'string' || typeof publishedAt !== 'string' || typeof value !== 'number') {
    return;
  }
  const startAt = Date.parse(start);
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(published) || published > cutoff.getTime()) {
    return;
  }
  const key = new Date(startAt).toISOString();
  const existing = target.get(key);
  if (!existing || published < Date.parse(existing.publishedAt)) {
    target.set(key, { value, publishedAt: new Date(published).toISOString() });
  }
}

function interpolatedWind(
  byStart: ReadonlyMap<string, ForecastValue>,
  at: Date,
): ForecastValue | null {
  const exact = byStart.get(at.toISOString());
  if (exact) return exact;
  const before = byStart.get(new Date(at.getTime() - 30 * 60 * 1000).toISOString());
  const after = byStart.get(new Date(at.getTime() + 30 * 60 * 1000).toISOString());
  if (!before || !after) return null;
  return {
    value: (before.value + after.value) / 2,
    publishedAt:
      Date.parse(before.publishedAt) >= Date.parse(after.publishedAt)
        ? before.publishedAt
        : after.publishedAt,
  };
}

/** Fetches only the feature selected by the holdout: NDF minus transmission wind. */
export async function collectResidualDemandForecast(options: {
  date: PricingDate;
  cutoff?: Date;
  fetchFn?: typeof fetch;
}): Promise<ResidualDemandForecast | null> {
  const cutoff = options.cutoff ?? analogueIssueCutoff(options.date);
  const fetchFn = options.fetchFn ?? fetch;
  const [demandRows, windRows] = await Promise.all([
    fetchRows('/forecast/demand/day-ahead/earliest/stream', options.date, fetchFn),
    // The final 23:30 period needs the next midnight point for interpolation.
    fetchRows('/forecast/generation/wind/earliest/stream', options.date, fetchFn, 60),
  ]);
  const demand = new Map<string, ForecastValue>();
  const wind = new Map<string, ForecastValue>();
  for (const raw of demandRows) {
    const row = raw as ElexonDemandRow;
    addEarliest(demand, row.startTime, row.nationalDemand, row.publishTime, cutoff);
  }
  for (const raw of windRows) {
    const row = raw as ElexonWindRow;
    addEarliest(wind, row.startTime, row.generation, row.publishTime, cutoff);
  }

  const values: number[] = [];
  const vintages = new Set<string>();
  for (const at of londonDayPeriodStarts(options.date)) {
    const demandPoint = demand.get(at.toISOString());
    const windPoint = interpolatedWind(wind, at);
    if (!demandPoint || !windPoint) return null;
    values.push(demandPoint.value - windPoint.value);
    vintages.add(demandPoint.publishedAt);
    vintages.add(windPoint.publishedAt);
  }
  return { values, inputVintages: [...vintages].sort() };
}

function referenceTariff(productCode: string): TariffSelection {
  return {
    productCode,
    region: FORECAST_REFERENCE_REGION,
    tariffCode: buildTariffCode(productCode, FORECAST_REFERENCE_REGION),
  };
}

function completedCursorDate(value: string | null): PricingDate | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return addDays(value as PricingDate, -1);
}

/** Owner diagnostics for the private shadow pipeline; no calculation or fetch. */
export async function readAnalogueShadowStatus(
  store: Store,
  productCode: string,
): Promise<AnalogueShadowStatus> {
  const tariff = referenceTariff(productCode);
  const [priceCursor, dayCursor, preparedDays, runs] = await Promise.all([
    store.getState(`${ANALOGUE_PRICE_CURSOR_PREFIX}${tariff.tariffCode}`),
    store.getState(`${ANALOGUE_DAY_CURSOR_PREFIX}${tariff.tariffCode}`),
    store.countPreparedForecastDays(tariff.tariffCode),
    store.listForecastRuns(tariff.tariffCode, 20),
  ]);
  return {
    referenceTariffCode: tariff.tariffCode,
    historyThrough: completedCursorDate(priceCursor),
    preparedThrough: completedCursorDate(dayCursor),
    preparedDays: Math.min(preparedDays, ANALOGUE_CANDIDATE_DAYS),
    requiredPreparedDays: ANALOGUE_CANDIDATE_DAYS,
    runs,
  };
}

async function buildReferenceBaselineDay(options: {
  store: Store;
  tariff: TariffSelection;
  date: PricingDate;
}): Promise<{ baseline: number[]; actual: number[] | null } | null> {
  const issueDate = addDays(options.date, -1);
  const history = await options.store.getPrices(
    options.tariff.tariffCode,
    startOfLondonDay(addDays(issueDate, -28)),
    endOfLondonDay(issueDate),
  );
  const transform = fitRegionalPriceTransform(history, history, true);
  if (!transform) return null;
  const targets = londonDayPeriodStarts(options.date);
  const periods = forecastSeasonalPrices({
    history,
    targets,
    transform,
    now: analogueIssueCutoff(options.date),
  });
  if (periods.length !== targets.length) return null;

  const confirmed = await options.store.getPrices(
    options.tariff.tariffCode,
    startOfLondonDay(options.date),
    endOfLondonDay(options.date),
  );
  const actual = isDayComplete(confirmed, options.date)
    ? new Map(confirmed.map((period) => [period.validFrom, period.valueIncVat]))
    : null;
  return {
    baseline: periods.map((period) => period.valueIncVat),
    actual: actual ? targets.map((target) => actual.get(target.toISOString()) as number) : null,
  };
}

async function recordPermanentAttempt(options: {
  store: Store;
  key: string;
  cursorKey: string;
  date: PricingDate;
}): Promise<void> {
  const previous = Number(await options.store.getState(options.key));
  const attempts = Number.isInteger(previous) && previous >= 0 ? previous + 1 : 1;
  if (attempts >= MAX_PERMANENT_ATTEMPTS) {
    await options.store.setState(options.cursorKey, addDays(options.date, 1));
    await options.store.setState(options.key, '0');
  } else {
    await options.store.setState(options.key, String(attempts));
  }
}

/** Extends only region C far enough to reconstruct 90 historical residuals. */
export async function runAnaloguePriceBackfill(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
}): Promise<boolean> {
  const today = londonDateOf(options.now);
  const oldest = addDays(today, -ANALOGUE_PRICE_HISTORY_DAYS);
  const products = [
    ...new Set((await options.priceService.distinctTariffs()).map((tariff) => tariff.productCode)),
  ].sort();
  for (const productCode of products) {
    const tariff = referenceTariff(productCode);
    const cursorKey = `${ANALOGUE_PRICE_CURSOR_PREFIX}${tariff.tariffCode}`;
    const storedCursor = await options.store.getState(cursorKey);
    const date =
      storedCursor && /^\d{4}-\d{2}-\d{2}$/.test(storedCursor) && storedCursor > oldest
        ? (storedCursor as PricingDate)
        : oldest;
    if (date >= today) continue;
    const existing = await options.priceService.storedDay(date, tariff.tariffCode);
    if (isDayComplete(existing, date)) {
      await options.store.setState(cursorKey, addDays(date, 1));
      return true;
    }
    try {
      const stored = await options.priceService.backfillHistory(
        startOfLondonDay(date),
        endOfLondonDay(date),
        tariff,
      );
      const refreshed = await options.priceService.storedDay(date, tariff.tariffCode);
      if (stored > 0 && isDayComplete(refreshed, date)) {
        await options.store.setState(cursorKey, addDays(date, 1));
        await options.store.setState(`${ANALOGUE_PRICE_ATTEMPT_PREFIX}${tariff.tariffCode}`, '0');
      } else {
        await recordPermanentAttempt({
          store: options.store,
          key: `${ANALOGUE_PRICE_ATTEMPT_PREFIX}${tariff.tariffCode}`,
          cursorKey,
          date,
        });
      }
    } catch (error) {
      // A network failure is transient and must not consume the permanent skip budget.
      options.logger.warn('Analogue price history backfill failed', {
        tariffCode: tariff.tariffCode,
        date,
        ...describeError(error),
      });
    }
    return true;
  }
  return false;
}

export async function prepareOneHistoricalAnalogueDay(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const today = londonDateOf(options.now);
  const oldest = addDays(today, -ANALOGUE_CANDIDATE_DAYS);
  const products = [
    ...new Set((await options.priceService.distinctTariffs()).map((tariff) => tariff.productCode)),
  ].sort();
  for (const productCode of products) {
    const tariff = referenceTariff(productCode);
    const cursorKey = `${ANALOGUE_DAY_CURSOR_PREFIX}${tariff.tariffCode}`;
    const storedCursor = await options.store.getState(cursorKey);
    const date =
      storedCursor && /^\d{4}-\d{2}-\d{2}$/.test(storedCursor) && storedCursor > oldest
        ? (storedCursor as PricingDate)
        : oldest;
    if (date >= today) continue;
    try {
      const [features, prices] = await Promise.all([
        collectResidualDemandForecast({ date, fetchFn: options.fetchFn }),
        buildReferenceBaselineDay({ store: options.store, tariff, date }),
      ]);
      if (!features || !prices?.actual) {
        await recordPermanentAttempt({
          store: options.store,
          key: `${ANALOGUE_DAY_ATTEMPT_PREFIX}${tariff.tariffCode}`,
          cursorKey,
          date,
        });
        return true;
      }
      const day: PreparedForecastDay = {
        tariffCode: tariff.tariffCode,
        date,
        issueCutoff: analogueIssueCutoff(date).toISOString(),
        residualDemand: features.values,
        baselinePrices: prices.baseline,
        actualPrices: prices.actual,
        inputVintages: features.inputVintages,
        preparedAt: options.now.toISOString(),
      };
      await options.store.upsertPreparedForecastDay(day);
      await options.store.setState(cursorKey, addDays(date, 1));
      await options.store.setState(`${ANALOGUE_DAY_ATTEMPT_PREFIX}${tariff.tariffCode}`, '0');
      options.logger.info('Prepared fundamentals analogue history day', { date });
    } catch (error) {
      options.logger.warn('Could not prepare fundamentals analogue history day', {
        date,
        ...describeError(error),
      });
    }
    return true;
  }
  return false;
}

function cheapestWindow(
  values: readonly number[],
  periods = 6,
): { index: number; average: number } {
  let best = { index: -1, average: Number.POSITIVE_INFINITY };
  for (let index = 0; index + periods <= values.length; index += 1) {
    const average =
      values.slice(index, index + periods).reduce((sum, value) => sum + value, 0) / periods;
    if (average < best.average) best = { index, average };
  }
  return best;
}

async function scoreOneShadowRun(options: { store: Store; now: Date }): Promise<boolean> {
  const today = londonDateOf(options.now);
  const [run] = await options.store.listUnscoredForecastRuns(today, 1);
  if (!run) return false;
  const actualPeriods = await options.store.getPrices(
    run.tariffCode,
    startOfLondonDay(run.targetDate as PricingDate),
    endOfLondonDay(run.targetDate as PricingDate),
  );
  if (!isDayComplete(actualPeriods, run.targetDate as PricingDate)) return false;
  const actual = actualPeriods.map((period) => period.valueIncVat);
  if (actual.length !== run.periods.length) return false;
  const mae =
    run.periods.reduce(
      (sum, value, index) => sum + Math.abs(value - (actual[index] as number)),
      0,
    ) / actual.length;
  const predictedWindow = cheapestWindow(run.periods);
  const actualWindow = cheapestWindow(actual);
  const chosenActual =
    actual
      .slice(predictedWindow.index, predictedWindow.index + 6)
      .reduce((sum, value) => sum + value, 0) / 6;
  const startError = Math.abs(predictedWindow.index - actualWindow.index) * 30;
  await options.store.scoreForecastRun(run.id, {
    scoredAt: options.now.toISOString(),
    maePence: mae,
    cheapest3hRegret: chosenActual - actualWindow.average,
    within60Minutes: startError <= 60,
  });
  return true;
}

export async function generateTomorrowShadowRuns(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const today = londonDateOf(options.now);
  const targetDate = addDays(today, 1);
  const cutoff = analogueIssueCutoff(targetDate);
  if (options.now < cutoff) return scoreOneShadowRun(options);
  const tariffs = await options.priceService.distinctTariffs();
  const productCode = tariffs[0]?.productCode;
  if (!productCode) return false;
  const tariff = referenceTariff(productCode);

  try {
    const [features, prices, candidates] = await Promise.all([
      collectResidualDemandForecast({
        date: targetDate,
        cutoff,
        fetchFn: options.fetchFn,
      }),
      buildReferenceBaselineDay({ store: options.store, tariff, date: targetDate }),
      options.store.listPreparedForecastDays(
        tariff.tariffCode,
        addDays(targetDate, -ANALOGUE_CANDIDATE_DAYS),
        targetDate,
      ),
    ]);
    if (!features || !prices || candidates.length > 100) return false;
    const complete = candidates.filter(
      (day) => day.baselinePrices !== null && day.actualPrices !== null,
    );
    const v2 = forecastAnaloguePrices({
      targetBaseline: prices.baseline,
      targetResidualDemand: features.values,
      candidates: complete.map((day) => ({
        ageDays: Math.round(
          (startOfLondonDay(targetDate).getTime() -
            startOfLondonDay(day.date as PricingDate).getTime()) /
            (24 * 60 * 60 * 1000),
        ),
        residualDemand: day.residualDemand,
        baseline: day.baselinePrices as number[],
        actual: day.actualPrices as number[],
      })),
    });
    if (!v2) return false;
    await options.store.upsertPreparedForecastDay({
      tariffCode: tariff.tariffCode,
      date: targetDate,
      issueCutoff: cutoff.toISOString(),
      residualDemand: features.values,
      baselinePrices: prices.baseline,
      actualPrices: null,
      inputVintages: features.inputVintages,
      preparedAt: options.now.toISOString(),
    });
    const runBase = {
      tariffCode: tariff.tariffCode,
      targetDate,
      generatedAt: options.now.toISOString(),
      issueCutoff: cutoff.toISOString(),
      inputVintages: features.inputVintages,
    };
    const [storedV1, storedV2] = await Promise.all([
      options.store.insertForecastRun({
        ...runBase,
        model: FORECAST_MODEL,
        periods: prices.baseline,
      }),
      options.store.insertForecastRun({
        ...runBase,
        model: ANALOGUE_FORECAST_MODEL,
        periods: v2,
      }),
    ]);
    await scoreOneShadowRun(options);
    if (storedV1 || storedV2) {
      options.logger.info('Recorded paired forecast shadow runs', {
        targetDate,
        storedV1,
        storedV2,
      });
    }
    return storedV1 || storedV2;
  } catch (error) {
    options.logger.warn('Forecast shadow generation failed', {
      targetDate,
      ...describeError(error),
    });
    return false;
  }
}

/** Performs at most one bounded backfill/preparation unit per shadow turn. */
export async function runAnalogueShadowWork(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<void> {
  if (await runAnaloguePriceBackfill(options)) return;
  if (await prepareOneHistoricalAnalogueDay(options)) return;
  await generateTomorrowShadowRuns(options);
}
