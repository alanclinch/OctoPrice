/**
 * Price normalisation and analysis.
 *
 * Octopus returns half-hour unit rates newest-first, sometimes across several
 * pages, and occasionally repeats a period between requests. Everything here
 * works on a normalised list: sorted oldest-first, one entry per `validFrom`.
 */

import type { DaySummary, PeriodRun, PricePeriod } from './types.ts';
import {
  HALF_HOUR_MS,
  endOfLondonDay,
  expectedPeriodCount,
  londonDateOf,
  startOfLondonDay,
  type PricingDate,
} from './time.ts';

/** Rounds to a fixed number of decimal places, avoiding float display noise. */
export function roundPence(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const startMs = (period: PricePeriod): number => Date.parse(period.validFrom);
const endMs = (period: PricePeriod): number => Date.parse(period.validTo);

/** Sorts oldest-first. Does not mutate the input. */
export function sortPeriods<T extends PricePeriod>(periods: readonly T[]): T[] {
  return [...periods].sort((a, b) => startMs(a) - startMs(b));
}

/**
 * Removes duplicate periods, keyed on `validFrom`.
 *
 * Later entries win, so merging a fresh API response over stored data picks up
 * any corrections Octopus has published.
 */
export function dedupePeriods<T extends PricePeriod>(periods: readonly T[]): T[] {
  const byStart = new Map<number, T>();
  for (const period of periods) {
    byStart.set(startMs(period), period);
  }
  return sortPeriods([...byStart.values()]);
}

/** Sorts and de-duplicates in one step. */
export function normalisePeriods<T extends PricePeriod>(periods: readonly T[]): T[] {
  return dedupePeriods(periods);
}

/** Filters to the periods starting inside a London calendar day. */
export function periodsForLondonDay<T extends PricePeriod>(
  periods: readonly T[],
  date: PricingDate,
): T[] {
  const from = startOfLondonDay(date).getTime();
  const to = endOfLondonDay(date).getTime();
  return sortPeriods(periods.filter((p) => startMs(p) >= from && startMs(p) < to));
}

/** Groups periods by the London day they start in. */
export function groupByLondonDay<T extends PricePeriod>(
  periods: readonly T[],
): Map<PricingDate, T[]> {
  const groups = new Map<PricingDate, T[]>();
  for (const period of sortPeriods(periods)) {
    const date = londonDateOf(new Date(period.validFrom));
    const existing = groups.get(date);
    if (existing) existing.push(period);
    else groups.set(date, [period]);
  }
  return groups;
}

/** True when two periods are back-to-back with no gap. */
export function isContiguous(a: PricePeriod, b: PricePeriod): boolean {
  return endMs(a) === startMs(b);
}

/**
 * Splits a list into maximal runs of contiguous periods.
 * A gap in the data starts a new run, so runs never span missing periods.
 */
export function splitIntoContiguousRuns<T extends PricePeriod>(periods: readonly T[]): T[][] {
  const sorted = sortPeriods(periods);
  const runs: T[][] = [];
  let current: T[] = [];
  for (const period of sorted) {
    const previous = current[current.length - 1];
    if (previous && !isContiguous(previous, period)) {
      runs.push(current);
      current = [];
    }
    current.push(period);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Whether a day holds every period it should.
 *
 * A day is complete when it has the expected number of periods (46, 48 or 50
 * depending on daylight saving), they are contiguous, and they span local
 * midnight to local midnight. Partial data must never be treated as published.
 */
export function isDayComplete(periods: readonly PricePeriod[], date: PricingDate): boolean {
  const dayPeriods = periodsForLondonDay(periods, date);
  const expected = expectedPeriodCount(date);
  if (dayPeriods.length !== expected) return false;

  const first = dayPeriods[0];
  const last = dayPeriods[dayPeriods.length - 1];
  if (!first || !last) return false;
  if (startMs(first) !== startOfLondonDay(date).getTime()) return false;
  if (endMs(last) !== endOfLondonDay(date).getTime()) return false;

  return splitIntoContiguousRuns(dayPeriods).length === 1;
}

/** Lists the period starts a day is missing, oldest-first. */
export function missingPeriodStarts(periods: readonly PricePeriod[], date: PricingDate): string[] {
  const present = new Set(periodsForLondonDay(periods, date).map(startMs));
  const start = startOfLondonDay(date).getTime();
  const count = expectedPeriodCount(date);
  const missing: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = start + i * HALF_HOUR_MS;
    if (!present.has(at)) missing.push(new Date(at).toISOString());
  }
  return missing;
}

/** Builds the aggregate description of a run of periods. */
export function buildRun(periods: readonly PricePeriod[]): PeriodRun {
  const sorted = sortPeriods(periods);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error('Cannot build a run from zero periods');

  const values = sorted.map((p) => p.valueIncVat);
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    startUtc: first.validFrom,
    endUtc: last.validTo,
    periodCount: sorted.length,
    durationMinutes: Math.round((endMs(last) - startMs(first)) / 60000),
    averagePence: roundPence(total / values.length),
    minPence: roundPence(Math.min(...values)),
    maxPence: roundPence(Math.max(...values)),
  };
}

/** Summarises a pricing day. Returns null when there is no data for it. */
export function summariseDay(
  periods: readonly PricePeriod[],
  date: PricingDate,
): DaySummary | null {
  const dayPeriods = periodsForLondonDay(periods, date);
  if (dayPeriods.length === 0) return null;

  let cheapest = dayPeriods[0] as PricePeriod;
  let mostExpensive = dayPeriods[0] as PricePeriod;
  let total = 0;
  let negativeCount = 0;

  for (const period of dayPeriods) {
    total += period.valueIncVat;
    if (period.valueIncVat < cheapest.valueIncVat) cheapest = period;
    if (period.valueIncVat > mostExpensive.valueIncVat) mostExpensive = period;
    if (period.valueIncVat < 0) negativeCount += 1;
  }

  return {
    date,
    periodCount: dayPeriods.length,
    expectedPeriodCount: expectedPeriodCount(date),
    complete: isDayComplete(dayPeriods, date),
    minPence: roundPence(cheapest.valueIncVat),
    maxPence: roundPence(mostExpensive.valueIncVat),
    averagePence: roundPence(total / dayPeriods.length),
    negativeCount,
    cheapest,
    mostExpensive,
  };
}

/** The period covering `now`, or null when there is no price for it. */
export function findPeriodAt<T extends PricePeriod>(periods: readonly T[], now: Date): T | null {
  const at = now.getTime();
  return periods.find((p) => startMs(p) <= at && endMs(p) > at) ?? null;
}

/** The first period starting after `now`, or null. */
export function findNextPeriod<T extends PricePeriod>(periods: readonly T[], now: Date): T | null {
  const at = now.getTime();
  return sortPeriods(periods).find((p) => startMs(p) > at) ?? null;
}

/** Periods that have not yet finished, oldest-first. */
export function remainingPeriods<T extends PricePeriod>(periods: readonly T[], now: Date): T[] {
  const at = now.getTime();
  return sortPeriods(periods).filter((p) => endMs(p) > at);
}

/** The `count` cheapest periods, cheapest first. */
export function cheapestPeriods<T extends PricePeriod>(periods: readonly T[], count: number): T[] {
  return [...periods].sort((a, b) => a.valueIncVat - b.valueIncVat).slice(0, Math.max(0, count));
}
