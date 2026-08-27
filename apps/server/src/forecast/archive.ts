/**
 * The forecasting input archive.
 *
 * Runs the collectors on a slow schedule and writes what they return, without
 * ever replacing an earlier observation. This is the first piece of
 * forecasting to be built because it is the only one that gets worse by
 * waiting: NESO and the Carbon Intensity API cannot be asked what they said
 * last week, so any day not collected is a day that can never be used to
 * validate a model honestly.
 *
 * It produces no forecasts and changes nothing a user sees. That is
 * deliberate - it should be possible to run this for weeks, decide the
 * forecasting idea is not worth pursuing, and have lost nothing but a few
 * hundred rows a day.
 *
 * ## It must not be able to break anything
 *
 * Forecasting is an enhancement (DESIGN.md, and section 4.7 of
 * docs/forecasting.md). This module therefore never throws to its caller,
 * never touches the price tables, and never reports a pricing day as
 * retrieved. The worst it can do is log a warning and archive nothing.
 */

import type { NewForecastInput, Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import { collectAll, type CollectorOptions } from './collectors.ts';

/** State key holding the last time a collection run completed. */
const LAST_RUN_KEY = 'forecast_archive_last_run';

/**
 * How often to collect. Slow on purpose: the Carbon Intensity terms warn of
 * rate limiting, the forecasts being archived only update a few times a day,
 * and a denser archive would cost rows without adding information.
 */
export const DEFAULT_INTERVAL_MINUTES = 180;

export interface ArchiveOptions {
  store: Store;
  logger: Logger;
  now?: () => Date;
  intervalMinutes?: number;
  fetchFn?: typeof fetch;
  horizonHours?: number;
}

export interface ArchiveResult {
  /** False when the interval has not elapsed, so nothing was fetched. */
  ran: boolean;
  collected: number;
  stored: number;
  reason?: string;
}

/**
 * Decides whether enough time has passed, without needing a timer.
 *
 * The Worker cron fires every five minutes for other reasons; this keeps the
 * archive to its own much slower cadence regardless of how often it is asked.
 */
export function isDue(lastRunIso: string | null, now: Date, intervalMinutes: number): boolean {
  if (!lastRunIso) return true;
  const last = Date.parse(lastRunIso);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMinutes * 60_000;
}

/**
 * Collects and stores one vintage, if due.
 *
 * Returns what happened rather than throwing, so callers can log without
 * having to handle failure.
 */
export async function runArchive(options: ArchiveOptions): Promise<ArchiveResult> {
  const { store, logger } = options;
  const now = (options.now ?? (() => new Date()))();
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;

  try {
    const lastRun = await store.getState(LAST_RUN_KEY);
    if (!isDue(lastRun, now, intervalMinutes)) {
      return { ran: false, collected: 0, stored: 0, reason: 'not due' };
    }

    const collectorOptions: CollectorOptions = {
      logger,
      now: () => now,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.horizonHours !== undefined ? { horizonHours: options.horizonHours } : {}),
    };

    const collected = await collectAll(collectorOptions);

    if (collected.length === 0) {
      // Every collector failed, or all of them returned nothing useful. Do
      // not record a run: the next invocation should try again rather than
      // wait out the interval on the strength of a failure.
      logger.warn('Forecast archive collected nothing', {});
      return { ran: true, collected: 0, stored: 0, reason: 'nothing collected' };
    }

    const collectedAt = now.toISOString();
    const rows: NewForecastInput[] = collected.map((input) => ({
      source: input.source,
      targetStart: input.targetStart,
      issuedAt: input.issuedAt,
      collectedAt,
      payload: input.payload,
    }));

    const stored = await store.appendForecastInputs(rows);
    await store.setState(LAST_RUN_KEY, collectedAt);

    logger.info('Archived forecasting inputs', {
      stored,
      sources: [...new Set(rows.map((row) => row.source))].join(','),
    });

    return { ran: true, collected: collected.length, stored };
  } catch (error) {
    // Deliberately swallowed. Nothing downstream of this may fail because a
    // weather or grid feed was unavailable.
    logger.error('Forecast archive failed', { ...describeError(error) });
    return { ran: true, collected: 0, stored: 0, reason: 'failed' };
  }
}

/** Freshness of the archive, for the status page. */
export async function archiveStatus(
  store: Store,
  sources: readonly string[] = ['carbon_intensity', 'neso_embedded'],
): Promise<{ source: string; lastCollectedAt: string | null }[]> {
  return Promise.all(
    sources.map(async (source) => ({
      source,
      lastCollectedAt: await store.lastForecastInputAt(source),
    })),
  );
}
