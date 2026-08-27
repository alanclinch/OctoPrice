/**
 * Collectors for forecasting inputs that cannot be reconstructed later.
 *
 * Elexon and Open-Meteo can be asked what they said at a past time, so their
 * history can be fetched whenever it is needed. NESO and the Carbon Intensity
 * API cannot: their responses carry no issue time and no history endpoint.
 * For those, the archive *is* the record, and it only exists from the moment
 * collection starts.
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
import { LOG_EVENTS, describeError } from '../logger.ts';

/**
 * Identifies this application, as the Carbon Intensity terms require. It is
 * also simply good manners on a free public API.
 */
export const COLLECTOR_USER_AGENT =
  'OctoPrice/0.1 (+https://github.com/alanclinch/OctoPrice) forecasting-input-archive';

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
  /**
   * How far ahead to keep observations. NESO publishes 14 days, but storing
   * all of it every run is mostly redundant - the far-out periods barely move
   * - and multiplies the archive for no benefit at a 72-hour horizon.
   */
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

/** NESO's 14-day embedded wind and solar forecast. */
const NESO_EMBEDDED_RESOURCE = 'db6c038f-98af-4570-ab60-24d71ebd0ae5';

interface NesoRecord {
  DATE_GMT?: unknown;
  TIME_GMT?: unknown;
  SETTLEMENT_DATE?: unknown;
  SETTLEMENT_PERIOD?: unknown;
  EMBEDDED_WIND_FORECAST?: unknown;
  EMBEDDED_SOLAR_FORECAST?: unknown;
  EMBEDDED_WIND_CAPACITY?: unknown;
  EMBEDDED_SOLAR_CAPACITY?: unknown;
}

/**
 * Embedded (distribution-connected) wind and solar, which do not appear in
 * transmission-level generation figures but do suppress demand and therefore
 * price.
 */
export async function collectNesoEmbedded(
  options: CollectorOptions,
  // NESO publishes 14 days; asking for all of it means parsing ~160 KB to
  // keep the ~144 half-hours inside the horizon, and CPU is the scarce
  // resource in a Worker. Four days of settlement periods is ample cover.
  limit = 200,
): Promise<CollectedInput[]> {
  const url =
    `https://api.neso.energy/api/3/action/datastore_search` +
    `?resource_id=${NESO_EMBEDDED_RESOURCE}&limit=${limit}`;
  const body = (await getJson(url, options)) as {
    result?: { records?: NesoRecord[] };
  };

  const collected: CollectedInput[] = [];
  for (const record of body.result?.records ?? []) {
    const targetStart = toIso(record.DATE_GMT);
    if (!targetStart) continue;

    const payload: Record<string, number | string> = {};
    const numbers: [string, unknown][] = [
      ['embeddedWind', record.EMBEDDED_WIND_FORECAST],
      ['embeddedSolar', record.EMBEDDED_SOLAR_FORECAST],
      ['embeddedWindCapacity', record.EMBEDDED_WIND_CAPACITY],
      ['embeddedSolarCapacity', record.EMBEDDED_SOLAR_CAPACITY],
    ];
    for (const [key, value] of numbers) {
      const numeric = typeof value === 'string' ? Number(value) : value;
      if (typeof numeric === 'number' && Number.isFinite(numeric)) payload[key] = numeric;
    }
    if (Object.keys(payload).length === 0) continue;

    collected.push({
      source: 'neso_embedded',
      targetStart,
      issuedAt: null,
      payload,
    });
  }
  return withinHorizon(collected, options);
}

/**
 * Runs every collector, keeping whatever succeeds.
 *
 * A source being down must not lose the others, and must never surface as an
 * error: forecasting is an enhancement and cannot be allowed to fail anything
 * else. Failures are logged and the run continues.
 */
export async function collectAll(options: CollectorOptions): Promise<CollectedInput[]> {
  const collectors: [string, () => Promise<CollectedInput[]>][] = [
    ['carbon_intensity', () => collectCarbonIntensity(options)],
    ['neso_embedded', () => collectNesoEmbedded(options)],
  ];

  const collected: CollectedInput[] = [];
  for (const [name, run] of collectors) {
    try {
      const rows = await run();
      collected.push(...rows);
      options.logger.debug('Collected forecasting inputs', { source: name, count: rows.length });
    } catch (error) {
      options.logger.warn('Forecasting input collector failed', {
        event: LOG_EVENTS.octopusApiError,
        source: name,
        ...describeError(error),
      });
    }
  }
  return collected;
}
