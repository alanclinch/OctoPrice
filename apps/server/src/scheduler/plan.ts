/**
 * Polling schedule decisions.
 *
 * Kept pure and separate from the timer so the awkward cases - a restart at
 * 03:00, a restart at 20:00 with prices already in hand, the cutoff passing
 * with nothing published - can be tested without waiting for wall-clock time.
 *
 * The shape of the schedule comes from DESIGN.md section 5.2: start looking
 * at 16:05 London time, retry every five minutes, give up at 22:15, and stop
 * as soon as a complete day has been retrieved.
 */

import {
  addDays,
  londonDateOf,
  londonWallClockToUtc,
  parseClockTime,
  parsePricingDate,
  type PricingDate,
} from '@octoprice/core';

export interface PollWindow {
  /** London-local `HH:mm` at which to start looking. */
  start: string;
  /** London-local `HH:mm` after which to give up for the day. */
  cutoff: string;
  intervalMinutes: number;
}

export type PollReason = 'already-retrieved' | 'before-window' | 'in-window' | 'after-cutoff';

export interface PollPlan {
  /** The pricing day being waited for: the day after the current London day. */
  targetDate: PricingDate;
  /** Whether to call Octopus right now. */
  shouldCheckNow: boolean;
  /** When the poller should wake up next. */
  nextRunAt: Date;
  reason: PollReason;
}

/** The UTC instant of a London-local `HH:mm` on a given London date. */
export function londonTimeOnDate(date: PricingDate, clockTime: string): Date {
  const { year, month, day } = parsePricingDate(date);
  const minutes = parseClockTime(clockTime);
  return londonWallClockToUtc(year, month, day, Math.floor(minutes / 60), minutes % 60);
}

/**
 * Decides what the poller should do at `now`.
 *
 * `isRetrieved` reports whether a complete dataset for a pricing date has
 * already been stored. Consulting persisted state rather than in-memory state
 * is what makes a restart safe: a server that comes back up at 20:00 having
 * already fetched tomorrow will wait rather than re-fetch and re-notify.
 */
export function planPoll(
  now: Date,
  window: PollWindow,
  isRetrieved: (date: PricingDate) => boolean,
): PollPlan {
  const today = londonDateOf(now);
  const targetDate = addDays(today, 1);

  const windowStart = londonTimeOnDate(today, window.start);
  const windowCutoff = londonTimeOnDate(today, window.cutoff);
  const tomorrowStart = londonTimeOnDate(targetDate, window.start);

  if (isRetrieved(targetDate)) {
    return {
      targetDate,
      shouldCheckNow: false,
      nextRunAt: tomorrowStart,
      reason: 'already-retrieved',
    };
  }

  if (now.getTime() < windowStart.getTime()) {
    return { targetDate, shouldCheckNow: false, nextRunAt: windowStart, reason: 'before-window' };
  }

  if (now.getTime() >= windowCutoff.getTime()) {
    // Octopus never published in time. Stop for today and pick the target up
    // again tomorrow, when it will be "today" and fetched as a normal refresh.
    return { targetDate, shouldCheckNow: false, nextRunAt: tomorrowStart, reason: 'after-cutoff' };
  }

  const nextAttempt = new Date(now.getTime() + window.intervalMinutes * 60_000);
  return {
    targetDate,
    shouldCheckNow: true,
    // Never schedule past the cutoff; the plan recomputed then will move on.
    nextRunAt: nextAttempt.getTime() > windowCutoff.getTime() ? windowCutoff : nextAttempt,
    reason: 'in-window',
  };
}
