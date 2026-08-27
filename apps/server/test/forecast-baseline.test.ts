import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  buildTariffCode,
  londonDateOf,
  londonDayPeriodStarts,
  roundPence,
  type StoredPricePeriod,
} from '@octoprice/core';
import { SqliteStore } from '../src/db/sqlite.ts';
import { OctopusClient } from '../src/octopus/client.ts';
import { PriceService, type TariffSelection } from '../src/prices/service.ts';
import {
  FORECAST_CACHE_MAX_AGE_MS,
  FORECAST_BACKGROUND_CRON,
  FORECAST_HISTORY_DAYS,
  buildBaselineForecast,
  readBaselineForecastCache,
  refreshOneBaselineForecast,
  isForecastBackgroundCron,
  runForecastBackgroundJob,
  runForecastHistoryBackfill,
} from '../src/forecast/baseline.ts';
import { makeRateRecords, ratesResponse, silentLogger } from './helpers.ts';

const NOW = new Date('2026-01-15T17:00:00.000Z');
const PRODUCT = 'AGILE-24-10-01';

it('recognises only the staggered forecast Cron', () => {
  expect(isForecastBackgroundCron(FORECAST_BACKGROUND_CRON)).toBe(true);
  expect(isForecastBackgroundCron('*/5 * * * *')).toBe(false);
});

function historyRates(date: string): ReturnType<typeof makeRateRecords> {
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  return makeRateRecords(
    date,
    londonDayPeriodStarts(date).map((_, index) => (weekend ? 5 : 10) + index / 10),
  );
}

function storedHistory(region: 'C' | 'N', scale = 1, intercept = 0): StoredPricePeriod[] {
  const today = londonDateOf(NOW);
  const tariffCode = buildTariffCode(PRODUCT, region);
  return Array.from({ length: FORECAST_HISTORY_DAYS }, (_, day) => {
    const date = addDays(today, day - FORECAST_HISTORY_DAYS);
    const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    return londonDayPeriodStarts(date).map((at, index) => {
      const base = (weekend ? 5 : 10) + index / 10 + day / 20;
      const valueIncVat = roundPence(base * scale + intercept, 4);
      return {
        tariffCode,
        region,
        validFrom: at.toISOString(),
        validTo: new Date(at.getTime() + 30 * 60 * 1000).toISOString(),
        valueIncVat,
        valueExcVat: roundPence(valueIncVat / 1.05, 4),
        retrievedAt: NOW.toISOString(),
      };
    });
  }).flat();
}

describe('forecast history backfill', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ file: ':memory:', defaultRegion: 'C' });
  });

  afterEach(() => store.close());

  it('fetches one reference-region day per invocation and then catches up', async () => {
    await store.getSettings('default');
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls += 1;
      const from = new URL(String(input)).searchParams.get('period_from');
      const date = londonDateOf(new Date(from as string));
      return new Response(JSON.stringify(ratesResponse(historyRates(date))), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const priceService = new PriceService({
      store,
      client: new OctopusClient({ logger: silentLogger(), fetchFn }),
      logger: silentLogger(),
      forcedProductCode: PRODUCT,
      now: () => NOW,
    });

    const first = await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });
    for (let index = 1; index < FORECAST_HISTORY_DAYS; index += 1) {
      await runForecastHistoryBackfill({
        store,
        priceService,
        logger: silentLogger(),
        now: () => NOW,
      });
    }
    const complete = await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(first).toMatchObject({ ran: true, tariffs: 1 });
    expect(first.stored).toBe(48);
    expect(complete).toEqual({ ran: false, stored: 0, tariffs: 0 });
    expect(calls).toBe(FORECAST_HISTORY_DAYS);
  });

  it('does not mark an empty response successful, so the next cron retries', async () => {
    await store.getSettings('default');
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify(ratesResponse([])), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const priceService = new PriceService({
      store,
      client: new OctopusClient({ logger: silentLogger(), fetchFn }),
      logger: silentLogger(),
      forcedProductCode: PRODUCT,
      now: () => NOW,
    });

    await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });
    await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(calls).toBe(2);
  });

  it('retries a historical day that was returned incomplete', async () => {
    await store.getSettings('default');
    let calls = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls += 1;
      const from = new URL(String(input)).searchParams.get('period_from');
      const date = londonDateOf(new Date(from as string));
      return new Response(JSON.stringify(ratesResponse(historyRates(date).slice(0, 47))), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const priceService = new PriceService({
      store,
      client: new OctopusClient({ logger: silentLogger(), fetchFn }),
      logger: silentLogger(),
      forcedProductCode: PRODUCT,
      now: () => NOW,
    });

    const first = await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });
    await runForecastHistoryBackfill({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(first).toMatchObject({ ran: true, tariffs: 0 });
    expect(calls).toBe(2);
  });
});

describe('baseline forecast assembly', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ file: ':memory:', defaultRegion: 'C' });
  });

  afterEach(() => store.close());

  it('forecasts one reference region and maps another through fitted prices', async () => {
    await store.upsertPrices(storedHistory('C'));
    await store.upsertPrices(storedHistory('N', 1.05, 0.2));
    const tariff: TariffSelection = {
      productCode: PRODUCT,
      tariffCode: buildTariffCode(PRODUCT, 'N'),
      region: 'N',
    };

    const forecast = await buildBaselineForecast({ store, tariff, now: NOW });

    expect(forecast.unavailableReason).toBeNull();
    expect(forecast.periods).toHaveLength(96);
    expect(forecast.periods[0]?.valueIncVat).toBeGreaterThan(5);
    expect(forecast.periods[0]?.sampleCount).toBeGreaterThanOrEqual(3);
  });

  it('never returns an estimate for a period with a confirmed price', async () => {
    await store.upsertPrices(storedHistory('C'));
    const tomorrow = addDays(londonDateOf(NOW), 1);
    const confirmedStart = londonDayPeriodStarts(tomorrow)[0] as Date;
    await store.upsertPrices([
      {
        tariffCode: buildTariffCode(PRODUCT, 'C'),
        region: 'C',
        validFrom: confirmedStart.toISOString(),
        validTo: new Date(confirmedStart.getTime() + 30 * 60 * 1000).toISOString(),
        valueIncVat: 99,
        valueExcVat: 94.2857,
        retrievedAt: NOW.toISOString(),
      },
    ]);
    const tariff: TariffSelection = {
      productCode: PRODUCT,
      tariffCode: buildTariffCode(PRODUCT, 'C'),
      region: 'C',
    };

    const forecast = await buildBaselineForecast({ store, tariff, now: NOW });

    expect(forecast.periods).toHaveLength(95);
    expect(
      forecast.periods.some((period) => period.validFrom === confirmedStart.toISOString()),
    ).toBe(false);
  });

  it('returns no forecast when history has not been backfilled', async () => {
    const tariff: TariffSelection = {
      productCode: PRODUCT,
      tariffCode: buildTariffCode(PRODUCT, 'C'),
      region: 'C',
    };

    await expect(buildBaselineForecast({ store, tariff, now: NOW })).resolves.toMatchObject({
      periods: [],
      unavailableReason: 'insufficient-history',
    });
  });

  it('persists one prepared forecast for cheap overview reads', async () => {
    await store.getSettings('default');
    await store.upsertPrices(storedHistory('C'));
    const priceService = new PriceService({
      store,
      client: new OctopusClient({ logger: silentLogger() }),
      logger: silentLogger(),
      forcedProductCode: PRODUCT,
      now: () => NOW,
    });
    const tariff = await priceService.tariff('default');

    await expect(
      refreshOneBaselineForecast({
        store,
        priceService,
        logger: silentLogger(),
        now: () => NOW,
      }),
    ).resolves.toEqual({ ran: true, tariffCode: tariff.tariffCode });

    const cached = await readBaselineForecastCache({ store, tariff, now: NOW });
    expect(cached.unavailableReason).toBeNull();
    expect(cached.periods).toHaveLength(96);
  });

  it('refreshes the cache only after the incremental backfill is caught up', async () => {
    await store.getSettings('default');
    await store.upsertPrices(storedHistory('C'));
    const priceService = new PriceService({
      store,
      client: new OctopusClient({ logger: silentLogger() }),
      logger: silentLogger(),
      forcedProductCode: PRODUCT,
      now: () => NOW,
    });
    const tariff = await priceService.tariff('default');
    await store.setState(`forecast_history_cursor:${tariff.tariffCode}`, londonDateOf(NOW));

    await runForecastBackgroundJob({
      store,
      priceService,
      logger: silentLogger(),
      now: () => NOW,
    });

    await expect(readBaselineForecastCache({ store, tariff, now: NOW })).resolves.toMatchObject({
      unavailableReason: null,
    });
  });

  it('refuses malformed, expired or previous-day cache entries', async () => {
    await store.getSettings('default');
    const tariff: TariffSelection = {
      productCode: PRODUCT,
      tariffCode: buildTariffCode(PRODUCT, 'C'),
      region: 'C',
    };
    const key = `forecast_baseline_cache:${tariff.tariffCode}`;

    await store.setState(key, '{broken');
    await expect(readBaselineForecastCache({ store, tariff, now: NOW })).resolves.toMatchObject({
      periods: [],
      unavailableReason: 'insufficient-history',
    });

    await store.setState(
      key,
      JSON.stringify({
        version: 1,
        tariffCode: tariff.tariffCode,
        generatedAt: new Date(NOW.getTime() - FORECAST_CACHE_MAX_AGE_MS - 1).toISOString(),
        forecast: {
          model: 'seasonal-naive-v1',
          referenceRegion: 'C',
          historyDays: FORECAST_HISTORY_DAYS,
          periods: [],
          unavailableReason: 'insufficient-history',
        },
      }),
    );
    await expect(readBaselineForecastCache({ store, tariff, now: NOW })).resolves.toMatchObject({
      periods: [],
      unavailableReason: 'insufficient-history',
    });
  });
});
