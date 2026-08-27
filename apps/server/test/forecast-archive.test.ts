/**
 * The forecasting input archive.
 *
 * Two things matter here and nothing else does yet: that observations are
 * preserved rather than replaced (otherwise back-tests silently train on
 * revised data), and that the whole subsystem is incapable of breaking
 * confirmed prices.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/db/sqlite.ts';
import {
  DEFAULT_INTERVAL_MINUTES,
  archiveStatus,
  isDue,
  runArchive,
} from '../src/forecast/archive.ts';
import {
  COLLECTOR_USER_AGENT,
  collectCarbonIntensity,
  collectNesoEmbedded,
} from '../src/forecast/collectors.ts';
import { silentLogger } from './helpers.ts';

const NOW = new Date('2026-08-27T12:00:00Z');

/** A Carbon Intensity response shaped like the real one. */
function intensityBody(periods: number, base: Date = NOW) {
  return {
    data: Array.from({ length: periods }, (_, index) => {
      const from = new Date(base.getTime() + index * 30 * 60 * 1000);
      return {
        from: `${from.toISOString().slice(0, 16)}Z`,
        intensity: { forecast: 100 + index, actual: null, index: 'moderate' },
      };
    }),
  };
}

function mixBody(periods: number, base: Date = NOW) {
  return {
    data: Array.from({ length: periods }, (_, index) => {
      const from = new Date(base.getTime() + index * 30 * 60 * 1000);
      return {
        from: `${from.toISOString().slice(0, 16)}Z`,
        generationmix: [
          { fuel: 'gas', perc: 30 + index },
          { fuel: 'wind', perc: 40 },
          { fuel: 'solar', perc: 5 },
        ],
      };
    }),
  };
}

function nesoBody(records: number, base: Date = NOW) {
  return {
    result: {
      records: Array.from({ length: records }, (_, index) => ({
        DATE_GMT: new Date(base.getTime() + index * 30 * 60 * 1000).toISOString(),
        SETTLEMENT_PERIOD: (index % 48) + 1,
        EMBEDDED_WIND_FORECAST: 1000 + index,
        EMBEDDED_SOLAR_FORECAST: 500,
      })),
    },
  };
}

/** Routes by hostname and path fragment, and records the headers sent. */
function fakeFetch(handlers: Record<string, unknown>, seen: RequestInit[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init) seen.push(init);
    const key = Object.keys(handlers).find((fragment) => url.includes(fragment));
    if (!key) return new Response('{}', { status: 404 });
    const value = handlers[key];
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeStore(): SqliteStore {
  return new SqliteStore({ file: ':memory:', defaultRegion: 'C' });
}

describe('collection scheduling', () => {
  it('runs when it has never run', () => {
    expect(isDue(null, NOW, DEFAULT_INTERVAL_MINUTES)).toBe(true);
  });

  it('waits until the interval has elapsed', () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(isDue(recent, NOW, 180)).toBe(false);
  });

  it('runs once the interval has elapsed', () => {
    const old = new Date(NOW.getTime() - 4 * 60 * 60 * 1000).toISOString();
    expect(isDue(old, NOW, 180)).toBe(true);
  });

  it('runs rather than stalls if the stored time is unreadable', () => {
    expect(isDue('not a date', NOW, 180)).toBe(true);
  });
});

describe('collectors', () => {
  it('identifies the application, as the Carbon Intensity terms require', async () => {
    const seen: RequestInit[] = [];
    await collectCarbonIntensity({
      logger: silentLogger(),
      now: () => NOW,
      fetchFn: fakeFetch({ '/intensity/': intensityBody(4), '/generation/': mixBody(4) }, seen),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      const headers = request.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe(COLLECTOR_USER_AGENT);
    }
  });

  it('merges intensity and generation mix onto the same period', async () => {
    const rows = await collectCarbonIntensity({
      logger: silentLogger(),
      now: () => NOW,
      fetchFn: fakeFetch({ '/intensity/': intensityBody(2), '/generation/': mixBody(2) }),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toMatchObject({
      intensityForecast: 100,
      'mix.gas': 30,
      'mix.wind': 40,
    });
    // The API publishes no issue time, which is the entire reason for this archive.
    expect(rows[0]?.issuedAt).toBeNull();
  });

  it('keeps intensity when the generation mix call fails', async () => {
    const rows = await collectCarbonIntensity({
      logger: silentLogger(),
      now: () => NOW,
      fetchFn: fakeFetch({
        '/intensity/': intensityBody(3),
        '/generation/': new Error('mix endpoint down'),
      }),
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]?.payload.intensityForecast).toBe(100);
    expect(rows[0]?.payload['mix.gas']).toBeUndefined();
  });

  it('discards observations beyond the forecast horizon', async () => {
    // 14 days of NESO records, of which only the first 72 hours are wanted.
    const rows = await collectNesoEmbedded({
      logger: silentLogger(),
      now: () => NOW,
      horizonHours: 72,
      fetchFn: fakeFetch({ neso: nesoBody(672) }),
    });

    expect(rows.length).toBeLessThanOrEqual(146);
    for (const row of rows) {
      expect(Date.parse(row.targetStart)).toBeLessThanOrEqual(NOW.getTime() + 72 * 3600 * 1000);
    }
  });
});

describe('archiving', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  const options = (now: Date, handlers: Record<string, unknown>) => ({
    store,
    logger: silentLogger(),
    now: () => now,
    fetchFn: fakeFetch(handlers),
  });

  const healthyAt = (base: Date) => ({
    '/intensity/': intensityBody(4, base),
    '/generation/': mixBody(4, base),
    neso: nesoBody(4, base),
  });
  const healthy = healthyAt(NOW);

  it('stores what it collects', async () => {
    const result = await runArchive(options(NOW, healthy));
    expect(result.ran).toBe(true);
    expect(result.stored).toBeGreaterThan(0);
    expect(await store.countForecastInputs()).toBe(result.stored);
  });

  it('never replaces an earlier observation of the same period', async () => {
    // This is the whole point: the difference between two vintages is the
    // revision a back-test must not be allowed to see.
    await runArchive(options(NOW, healthy));
    const afterFirst = await store.countForecastInputs();

    const later = new Date(NOW.getTime() + 4 * 3600 * 1000);
    await runArchive(options(later, healthyAt(later)));

    expect(await store.countForecastInputs()).toBeGreaterThan(afterFirst);
  });

  it('does not collect again before the interval has elapsed', async () => {
    await runArchive(options(NOW, healthy));
    const afterFirst = await store.countForecastInputs();

    const soon = new Date(NOW.getTime() + 10 * 60 * 1000);
    const result = await runArchive(options(soon, healthy));

    expect(result.ran).toBe(false);
    expect(await store.countForecastInputs()).toBe(afterFirst);
  });

  it('does not record a run when every collector fails, so it retries', async () => {
    const broken = {
      '/intensity/': new Error('down'),
      '/generation/': new Error('down'),
      neso: new Error('down'),
    };
    const result = await runArchive(options(NOW, broken));

    expect(result.stored).toBe(0);
    expect(await store.countForecastInputs()).toBe(0);

    // The next invocation tries again rather than waiting out the interval
    // on the strength of a failure.
    const soon = new Date(NOW.getTime() + 60 * 1000);
    const retry = await runArchive(options(soon, healthy));
    expect(retry.stored).toBeGreaterThan(0);
  });

  it('keeps one source when another is down', async () => {
    const partial = {
      '/intensity/': intensityBody(4),
      '/generation/': mixBody(4),
      neso: new Error('down'),
    };
    const result = await runArchive(options(NOW, partial));

    expect(result.stored).toBeGreaterThan(0);
    expect(await store.lastForecastInputAt('carbon_intensity')).not.toBeNull();
    expect(await store.lastForecastInputAt('neso_embedded')).toBeNull();
  });

  it('reports staleness per source', async () => {
    await runArchive(options(NOW, healthy));
    const status = await archiveStatus(store);

    expect(status.find((s) => s.source === 'carbon_intensity')?.lastCollectedAt).toBe(
      NOW.toISOString(),
    );
  });
});

describe('it cannot break anything else', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('never throws, whatever the network does', async () => {
    const exploding = (async () => {
      throw new TypeError('network on fire');
    }) as typeof fetch;

    await expect(
      runArchive({ store, logger: silentLogger(), now: () => NOW, fetchFn: exploding }),
    ).resolves.toMatchObject({ stored: 0 });
  });

  it('never throws when the database rejects the write', async () => {
    const brokenStore = {
      getState: async () => null,
      appendForecastInputs: async () => {
        throw new Error('database unavailable');
      },
      setState: async () => {},
    } as unknown as SqliteStore;

    await expect(
      runArchive({
        store: brokenStore,
        logger: silentLogger(),
        now: () => NOW,
        fetchFn: fakeFetch({
          intensity: intensityBody(2),
          generation: mixBody(2),
          neso: nesoBody(2),
        }),
      }),
    ).resolves.toMatchObject({ reason: 'failed' });
  });

  it('leaves the price tables untouched', async () => {
    await runArchive({
      store,
      logger: silentLogger(),
      now: () => NOW,
      fetchFn: fakeFetch({
        '/intensity/': intensityBody(4),
        '/generation/': mixBody(4),
        neso: nesoBody(4),
      }),
    });

    expect(store.countPrices()).toBe(0);
    // And nothing has claimed a pricing day as retrieved.
    expect(store.getState('retrieved_date:E-1R-AGILE-24-10-01-C:2026-08-28')).toBeNull();
  });
});
