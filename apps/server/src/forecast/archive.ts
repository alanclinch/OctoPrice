/**
 * The forecasting input archive.
 *
 * Runs the collectors on a slow schedule and writes what they return, without
 * ever replacing an earlier observation. This is the first piece of
 * forecasting to be built because it is the only one that gets worse by
 * waiting: the Carbon Intensity API cannot be asked what it said last week,
 * so any day not collected is a day that cannot be validated honestly.
 *
 * It produces no forecasts and changes nothing a user sees. That is
 * deliberate - it should be possible to run this for weeks, decide the
 * forecasting idea is not worth pursuing, and have lost nothing but a few
 * thousand rows.
 *
 * ## It must not be able to break anything
 *
 * Forecasting is an enhancement (DESIGN.md, and section 4.7 of
 * docs/forecasting.md). This module therefore never throws to its caller,
 * never touches the price tables, and never reports a pricing day as
 * retrieved. The worst it can do is log a warning and archive nothing.
 *
 * Isolation is about *scheduling* as well as exceptions, which an earlier
 * version got wrong: it handed the archive to `Promise.all` alongside the
 * price poller and called it "last", when in fact all three started at once
 * and shared one 10 ms CPU budget. `runScheduledJobs` below makes the
 * ordering real.
 */

import type { NewForecastInput, Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import {
  collectCarbonIntensity,
  type CollectedInput,
  type CollectorOptions,
} from './collectors.ts';

/** State key prefix holding the last successful collection, per source. */
const LAST_RUN_PREFIX = 'forecast_archive_last_run:';

/**
 * How often to collect. Slow on purpose: the Carbon Intensity terms warn of
 * rate limiting, the forecasts being archived only update a few times a day,
 * and a denser archive would cost rows without adding information.
 */
export const DEFAULT_INTERVAL_MINUTES = 180;

export interface SourceCollector {
  name: string;
  collect: (options: CollectorOptions) => Promise<CollectedInput[]>;
}

/**
 * Sources are scheduled and retried independently, so one failing does not
 * suppress retries for another. Only one remains: NESO publishes its own
 * forecast vintages, so archiving it here was duplicating a better record
 * (see `collectors.ts`).
 */
export const COLLECTORS: readonly SourceCollector[] = [
  { name: 'carbon_intensity', collect: collectCarbonIntensity },
];

export interface ArchiveOptions {
  store: Store;
  logger: Logger;
  now?: () => Date;
  intervalMinutes?: number;
  fetchFn?: typeof fetch;
  horizonHours?: number;
  collectors?: readonly SourceCollector[];
  /**
   * Days of history to keep. A free D1 database is capped at 500 MB, and this
   * Carbon-only archive measures 292.8 bytes of column payload at roughly 770
   * rows a day, so it cannot be kept forever without a plan.
   */
  retentionDays?: number;
}

export const DEFAULT_RETENTION_DAYS = 180;

export interface SourceResult {
  source: string;
  /** False when the interval has not elapsed for this source. */
  ran: boolean;
  stored: number;
  reason?: string;
}

export interface ArchiveResult {
  /** True when at least one source was due and attempted. */
  ran: boolean;
  stored: number;
  /** Rows removed by the retention policy. */
  pruned: number;
  perSource: SourceResult[];
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
 * Collects and stores one vintage per due source.
 *
 * Returns what happened rather than throwing, so callers can log without
 * having to handle failure. A source only records a run once its rows are
 * stored, so a failure is retried on the next invocation instead of waiting
 * out the interval.
 */
export async function runArchive(options: ArchiveOptions): Promise<ArchiveResult> {
  const { store, logger } = options;
  const now = (options.now ?? (() => new Date()))();
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const collectors = options.collectors ?? COLLECTORS;

  const collectorOptions: CollectorOptions = {
    logger,
    now: () => now,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.horizonHours !== undefined ? { horizonHours: options.horizonHours } : {}),
  };

  const perSource: SourceResult[] = [];

  for (const collector of collectors) {
    const key = `${LAST_RUN_PREFIX}${collector.name}`;
    try {
      const lastRun = await store.getState(key);
      if (!isDue(lastRun, now, intervalMinutes)) {
        perSource.push({ source: collector.name, ran: false, stored: 0, reason: 'not due' });
        continue;
      }

      const collected = await collector.collect(collectorOptions);
      if (collected.length === 0) {
        // Do not record a run: the next invocation should try again rather
        // than wait out the interval on the strength of an empty response.
        logger.warn('Forecast collector returned nothing', { source: collector.name });
        perSource.push({
          source: collector.name,
          ran: true,
          stored: 0,
          reason: 'nothing collected',
        });
        continue;
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
      await store.setState(key, collectedAt);
      perSource.push({ source: collector.name, ran: true, stored });
      logger.info('Archived forecasting inputs', { source: collector.name, stored });
    } catch (error) {
      // Deliberately swallowed, and deliberately without recording a run, so
      // this source is retried rather than skipped for the whole interval.
      logger.error('Forecast collector failed', {
        source: collector.name,
        ...describeError(error),
      });
      perSource.push({ source: collector.name, ran: true, stored: 0, reason: 'failed' });
    }
  }

  const stored = perSource.reduce((sum, result) => sum + result.stored, 0);

  // Prune only after a successful write, so a failing archive does not spend
  // its invocation deleting history it is no longer replacing.
  let pruned = 0;
  if (stored > 0) {
    try {
      const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const before = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
      pruned = await store.pruneForecastInputsBefore(before);
      if (pruned > 0) logger.info('Pruned expired forecasting inputs', { pruned, retentionDays });
    } catch (error) {
      // Never fatal: a full archive is a problem for later, not a reason to
      // fail the run that is collecting today's irreplaceable vintage.
      logger.warn('Could not prune forecasting inputs', { ...describeError(error) });
    }
  }

  return {
    ran: perSource.some((result) => result.ran),
    stored,
    pruned,
    perSource,
  };
}

export interface ScheduledJobs {
  /** The price poller's own scheduled work. Must complete first. */
  core: () => Promise<unknown>;
  /** The optional archive. Skipped entirely when not enabled. */
  archive?: (() => Promise<unknown>) | undefined;
  /** Optional forecast work, also isolated behind all confirmed-price work. */
  forecast?: (() => Promise<unknown>) | undefined;
}

/**
 * Runs the scheduled work in a real order.
 *
 * Confirmed prices and alerts finish before the archive starts, so the
 * optional work cannot compete with them for the invocation's CPU. The
 * archive's own failures are already contained, but this is belt and braces:
 * even a pathological archive cannot delay the part that matters.
 */
export async function runScheduledJobs(jobs: ScheduledJobs): Promise<void> {
  await jobs.core();
  if (jobs.archive) await jobs.archive();
  if (jobs.forecast) await jobs.forecast();
}

/** Freshness of the archive, for the status page. */
export async function archiveStatus(
  store: Store,
  sources: readonly string[] = COLLECTORS.map((collector) => collector.name),
): Promise<{ source: string; lastCollectedAt: string | null }[]> {
  return Promise.all(
    sources.map(async (source) => ({
      source,
      lastCollectedAt: await store.lastForecastInputAt(source),
    })),
  );
}
