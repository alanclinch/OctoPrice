/**
 * Cheapest continuous window calculator.
 *
 * Answers questions such as "what is the cheapest continuous three hours
 * tomorrow?", which is what makes the app useful for EV charging, dishwashers
 * and battery charging.
 *
 * Windows are only formed from contiguous periods, so a gap in the data can
 * never produce a window that silently spans missing prices.
 */

import type { PeriodRun, PricePeriod } from './types.ts';
import { buildRun, splitIntoContiguousRuns } from './prices.ts';

const HALF_HOUR_MINUTES = 30;

/** Converts a duration in minutes to a whole number of half-hour periods. */
export function periodsForDuration(durationMinutes: number): number {
  if (durationMinutes <= 0) throw new Error('Duration must be positive');
  if (durationMinutes % HALF_HOUR_MINUTES !== 0) {
    throw new Error('Duration must be a whole number of half-hour periods');
  }
  return durationMinutes / HALF_HOUR_MINUTES;
}

/**
 * Every continuous window of the requested length, cheapest first.
 * Ties are broken by the earlier start time.
 */
export function rankWindows(
  periods: readonly PricePeriod[],
  durationMinutes: number,
  limit = Number.POSITIVE_INFINITY,
): PeriodRun[] {
  const windowSize = periodsForDuration(durationMinutes);
  const windows: PeriodRun[] = [];

  for (const run of splitIntoContiguousRuns(periods)) {
    if (run.length < windowSize) continue;
    for (let start = 0; start + windowSize <= run.length; start += 1) {
      windows.push(buildRun(run.slice(start, start + windowSize)));
    }
  }

  windows.sort(
    (a, b) => a.averagePence - b.averagePence || Date.parse(a.startUtc) - Date.parse(b.startUtc),
  );

  return Number.isFinite(limit) ? windows.slice(0, limit) : windows;
}

/**
 * The single cheapest continuous window of the requested length, or null when
 * the data does not contain enough consecutive periods.
 */
export function findCheapestWindow(
  periods: readonly PricePeriod[],
  durationMinutes: number,
): PeriodRun | null {
  return rankWindows(periods, durationMinutes, 1)[0] ?? null;
}

/**
 * The cheapest window that has not already started.
 * Useful on the dashboard, where a window in the past is no help.
 */
export function findCheapestUpcomingWindow(
  periods: readonly PricePeriod[],
  durationMinutes: number,
  now: Date,
): PeriodRun | null {
  const upcoming = periods.filter((period) => Date.parse(period.validFrom) >= now.getTime());
  return findCheapestWindow(upcoming, durationMinutes);
}

/** The most expensive continuous window, for "avoid this stretch" advice. */
export function findMostExpensiveWindow(
  periods: readonly PricePeriod[],
  durationMinutes: number,
): PeriodRun | null {
  const windows = rankWindows(periods, durationMinutes);
  return windows[windows.length - 1] ?? null;
}
