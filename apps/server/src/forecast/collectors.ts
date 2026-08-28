/**
 * Collectors for forecasting inputs that cannot be reconstructed later.
 *
 * Only the Carbon Intensity API is collected. Elexon, Open-Meteo and NESO all
 * publish their own forecast vintages, so their history can be fetched when it
 * is needed; Carbon Intensity does not, so for that one the archive *is* the
 * record and it only exists from the moment collection starts.
 *
 * These functions fetch and shape. They do not store, decide when to run, or
 * know about the database, so they can be tested against recorded payloads.
 *
 * ## Terms of use
 *
 * The Carbon Intensity API is CC BY 4.0 with additional terms that place real
 * obligations on this application, all of which are honoured here or in the
 * places noted:
 *
 *  - **Identity must not be concealed.** Every request sends a descriptive
 *    User-Agent naming the application and its source repository.
 *  - **Rate limited, with blocking for heavy callers.** Collection runs a few
 *    times a day, not continuously, and asks for one window per run.
 *  - **Must not substantially replace NESO's core experience.** It is used as
 *    a forecasting feature and as optional context inside a price app.
 *  - **Attribution.** Anything derived from it that reaches a user carries
 *    credit to the National Energy System Operator (see the UI work).
 *  - **May be withdrawn without notice, as-is, no warranty.** Failure is
 *    logged and abandoned; nothing else depends on it.
 */

import type { Logger } from '../logger.ts';
import { describeError } from '../logger.ts';

/**
 * Identifies this application, as the Carbon Intensity terms require. It is
 * also simply good manners on a free public API.
 */
export const COLLECTOR_USER_AGENT =
  'OctoAgileAdvisor/0.1 (+https://github.com/alanclinch/OctoPrice) forecasting-input-archive';

/** One observation about one settlement period, as collected. */
export interface CollectedInput {
  source: string;
  /** Settlement period the observation is about, ISO 8601 UTC. */
  targetStart: string;
  /** The source's own publish time, when it gives one. */
  issuedAt: string | null;
  /** Source-shaped values. Stored as JSON. */
  payload: Record<string, number | string>;
}

export interface CollectorOptions {
  fetchFn?: typeof fetch;
  logger: Logger;
  /** Injected so tests do not depend on the real clock. */
  now?: () => Date;
  timeoutMs?: number;
  /** How far ahead to keep observations. */
  horizonHours?: number;
}

const DEFAULT_HORIZON_HOURS = 72;

/** Keeps observations inside the forecast horizon, with a little slack behind. */
function withinHorizon(rows: CollectedInput[], options: CollectorOptions): CollectedInput[] {
  const now = (options.now ?? (() => new Date()))().getTime();
  const from = now - 2 * 3600 * 1000;
  const to = now + (options.horizonHours ?? DEFAULT_HORIZON_HOURS) * 3600 * 1000;
  return rows.filter((row) => {
    const at = Date.parse(row.targetStart);
    return at >= from && at <= to;
  });
}

async function getJson(url: string, options: CollectorOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // Required by the Carbon Intensity terms; harmless elsewhere.
        'User-Agent': COLLECTOR_USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const isoMinute = (date: Date): string => `${date.toISOString().slice(0, 16)}Z`;

/** Normalises the API's `2026-08-27T11:30Z` form to a full ISO instant. */
function toIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

interface CarbonIntensityPeriod {
  from?: unknown;
  intensity?: { forecast?: unknown; actual?: unknown; index?: unknown };
  generationmix?: { fuel?: unknown; perc?: unknown }[];
}

/**
 * National carbon intensity and generation mix, 48 hours ahead.
 *
 * The *national* series is deliberate. Agile's regional differences are a
 * fixed retail transform of one GB-wide series, so a regional carbon mix
 * carries no regional price signal - see `docs/forecasting.md` section 3.
 */
export async function collectCarbonIntensity(options: CollectorOptions): Promise<CollectedInput[]> {
  const now = (options.now ?? (() => new Date()))();
  const url = `https://api.carbonintensity.org.uk/intensity/${isoMinute(now)}/fw48h`;
  const mixUrl = `https://api.carbonintensity.org.uk/generation/${isoMinute(now)}/${isoMinute(
    new Date(now.getTime() + 48 * 3600 * 1000),
  )}`;

  const [intensityBody, mixBody] = await Promise.all([
    getJson(url, options),
    // The mix endpoint is a separate call; a failure of one should not lose
    // the other, so they are settled independently below.
    getJson(mixUrl, options).catch((error: unknown) => {
      options.logger.warn('Carbon Intensity generation mix unavailable', {
        ...describeError(error),
      });
      return null;
    }),
  ]);

  const byPeriod = new Map<string, Record<string, number | string>>();

  for (const period of (intensityBody as { data?: CarbonIntensityPeriod[] })?.data ?? []) {
    const targetStart = toIso(period.from);
    if (!targetStart) continue;
    const forecast = period.intensity?.forecast;
    const entry: Record<string, number | string> = {};
    if (typeof forecast === 'number') entry.intensityForecast = forecast;
    if (typeof period.intensity?.index === 'string') entry.intensityIndex = period.intensity.index;
    byPeriod.set(targetStart, entry);
  }

  for (const period of (mixBody as { data?: CarbonIntensityPeriod[] } | null)?.data ?? []) {
    const targetStart = toIso(period.from);
    if (!targetStart) continue;
    const entry = byPeriod.get(targetStart) ?? {};
    for (const item of period.generationmix ?? []) {
      if (typeof item.fuel === 'string' && typeof item.perc === 'number') {
        entry[`mix.${item.fuel}`] = item.perc;
      }
    }
    byPeriod.set(targetStart, entry);
  }

  return withinHorizon(
    [...byPeriod.entries()]
      .filter(([, payload]) => Object.keys(payload).length > 0)
      .map(([targetStart, payload]) => ({
        source: 'carbon_intensity',
        targetStart,
        // The API publishes no issue time, which is precisely why this
        // archive has to exist. Collection time is the best vintage available.
        issuedAt: null,
        payload,
      })),
    options,
  );
}

/**
 * NESO's embedded wind and solar forecast is **not** collected live.
 *
 * The archive existed on the premise that NESO cannot be asked what it said
 * in the past. That premise was wrong. NESO publishes annual half-hourly
 * forecast archives carrying a real `Forecast_Datetime` for every issue of
 * every 0-14 day forecast - resource `31861619-0b86-47ba-bac2-d008a760af54`
 * for June to December 2026, about 1.13 million rows, and current to within
 * an hour when checked.
 *
 * That archive is better than anything collected here in every respect: it
 * has a genuine issue time rather than our collection time standing in for
 * one, it can be back-filled for periods before this application existed, and
 * it costs us no storage. Collecting the rolling feed as well would archive a
 * worse copy of data that is already archived.
 *
 * Carbon Intensity has no equivalent, which is why it is still collected.
 *
 * ## The period timestamp, which has been wrong twice
 *
 * `TIME_GMT` is the settlement period **end**, not its start. In the archive
 * `DATE_GMT` is the same instant as a full UTC timestamp. Settlement period
 * 27 on 12 June 2026 appears as `DATE_GMT: 2026-06-12T12:30:00`; British
 * Summer Time makes SP27 13:00-13:30 local, which is 12:00-12:30 UTC, so the
 * period *starts* at 12:00.
 *
 * A first version read the date alone and put every period at midnight. The
 * correction combined date and time but kept the end instant, leaving every
 * row half an hour late. Hence this function and its tests: whoever writes
 * the back-test reader should not have to discover it a third time.
 */
export function nesoArchivePeriodStart(dateGmt: unknown, timeGmt: unknown): string | null {
  if (typeof dateGmt !== 'string' || typeof timeGmt !== 'string') return null;

  // Only the *date* part of DATE_GMT is used. It is rendered inconsistently -
  // sometimes midnight, sometimes carrying the period time - whereas TIME_GMT
  // is consistently the period end.
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateGmt);
  const time = /^(\d{1,2}):(\d{2})/.exec(timeGmt);
  if (!date || !time) return null;

  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 24 || minute > 59) return null;

  const end = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hour, minute);
  // The published instant is the period *end*; we record period starts. A
  // period ending at 00:00 therefore starts at 23:30 the previous day.
  return new Date(end - 30 * 60 * 1000).toISOString();
}
