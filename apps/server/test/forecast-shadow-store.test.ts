import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from '../src/db/sqlite.ts';

describe('forecast shadow persistence', () => {
  const tariffCode = 'E-1R-AGILE-24-10-01-C';
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ file: ':memory:', defaultRegion: 'C' });
  });

  afterEach(() => {
    store.close();
  });

  it('upserts compact prepared days and reads a bounded date range', () => {
    store.upsertPreparedForecastDay({
      tariffCode,
      date: '2026-08-28',
      issueCutoff: '2026-08-27T13:00:00.000Z',
      residualDemand: [10, 20],
      baselinePrices: [25, 26],
      actualPrices: [24, 28],
      inputVintages: ['2026-08-26T07:45:00.000Z'],
      preparedAt: '2026-08-28T14:00:00.000Z',
    });
    store.upsertPreparedForecastDay({
      tariffCode,
      date: '2026-08-28',
      issueCutoff: '2026-08-27T13:00:00.000Z',
      residualDemand: [11, 21],
      baselinePrices: [25, 26],
      actualPrices: [24, 28],
      inputVintages: ['2026-08-26T08:00:00.000Z'],
      preparedAt: '2026-08-28T15:00:00.000Z',
    });
    store.upsertPreparedForecastDay({
      tariffCode: 'E-1R-AGILE-NEXT-C',
      date: '2026-08-28',
      issueCutoff: '2026-08-27T13:00:00.000Z',
      residualDemand: [99, 99],
      baselinePrices: [25, 26],
      actualPrices: [24, 28],
      inputVintages: [],
      preparedAt: '2026-08-28T15:00:00.000Z',
    });

    expect(store.listPreparedForecastDays(tariffCode, '2026-08-28', '2026-08-29')).toEqual([
      expect.objectContaining({
        date: '2026-08-28',
        tariffCode,
        residualDemand: [11, 21],
        inputVintages: ['2026-08-26T08:00:00.000Z'],
      }),
    ]);
    expect(store.listPreparedForecastDays(tariffCode, '2026-08-29', '2026-08-30')).toEqual([]);
    expect(store.countPreparedForecastDays(tariffCode)).toBe(1);
    expect(store.countPreparedForecastDays('E-1R-AGILE-NEXT-C')).toBe(1);
  });

  it('keeps one immutable run per model, target and issue cut-off then scores it', () => {
    const run = {
      model: 'fundamentals-analogue-v2',
      tariffCode,
      targetDate: '2026-08-29',
      generatedAt: '2026-08-28T13:01:00.000Z',
      issueCutoff: '2026-08-28T13:00:00.000Z',
      periods: [20, 21],
      inputVintages: ['2026-08-27T07:45:00.000Z'],
    };

    expect(store.insertForecastRun(run)).toBe(true);
    expect(store.insertForecastRun({ ...run, generatedAt: '2026-08-28T13:06:00.000Z' })).toBe(
      false,
    );
    const [stored] = store.listUnscoredForecastRuns('2026-08-30', 10);
    expect(stored).toMatchObject(run);

    store.scoreForecastRun(stored?.id as string, {
      scoredAt: '2026-08-30T00:00:00.000Z',
      maePence: 1.25,
      cheapest3hRegret: 0.2,
      within60Minutes: true,
    });

    expect(store.listUnscoredForecastRuns('2026-08-30', 10)).toEqual([]);
    expect(store.listForecastRuns(run.tariffCode, 10)).toEqual([
      expect.objectContaining({
        model: run.model,
        score: {
          scoredAt: '2026-08-30T00:00:00.000Z',
          maePence: 1.25,
          cheapest3hRegret: 0.2,
          within60Minutes: true,
        },
      }),
    ]);
    expect(store.countForecastRuns()).toBe(1);
  });
});
