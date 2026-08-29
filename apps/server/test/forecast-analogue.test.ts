import { describe, expect, it } from 'vitest';
import { londonDayPeriodStarts } from '@octoprice/core';
import {
  ANALOGUE_CANDIDATE_LIMIT,
  analogueIssueCutoff,
  collectResidualDemandForecast,
  limitAnalogueCandidates,
} from '../src/forecast/analogue.ts';
import type { PreparedForecastDay } from '../src/db/store.ts';
import { fakeFetch } from './helpers.ts';

const DATE = '2026-08-29';
const PUBLISHED = '2026-08-28T12:00:00.000Z';

function demandRows() {
  return londonDayPeriodStarts(DATE).map((at, index) => ({
    startTime: at.toISOString(),
    nationalDemand: 30_000 + index,
    publishTime: PUBLISHED,
  }));
}

function windRows() {
  const starts = londonDayPeriodStarts(DATE);
  const rows = starts
    .filter((_, index) => index % 2 === 0)
    .map((at, index) => ({
      startTime: at.toISOString(),
      generation: 4_000 + index * 20,
      publishTime: PUBLISHED,
    }));
  const final = starts[starts.length - 2] as Date;
  rows.push({
    startTime: new Date(final.getTime() + 60 * 60 * 1000).toISOString(),
    generation: 4_000 + rows.length * 20,
    publishTime: PUBLISHED,
  });
  return rows;
}

describe('fundamentals analogue input collection', () => {
  it('trims an oversized inference set to the nearest prepared days', () => {
    const candidates = Array.from(
      { length: ANALOGUE_CANDIDATE_LIMIT + 5 },
      (_, index): PreparedForecastDay => ({
        tariffCode: 'reference',
        date: `day-${String(index).padStart(3, '0')}`,
        issueCutoff: PUBLISHED,
        residualDemand: [],
        baselinePrices: [],
        actualPrices: [],
        inputVintages: [],
        preparedAt: PUBLISHED,
      }),
    );

    const limited = limitAnalogueCandidates(candidates);
    expect(limited).toHaveLength(ANALOGUE_CANDIDATE_LIMIT);
    expect(limited[0]?.date).toBe('day-005');
    expect(limited.at(-1)?.date).toBe('day-104');
  });

  it('resolves the 14:00 London issue instant across clock changes', () => {
    expect(analogueIssueCutoff('2026-03-29').toISOString()).toBe('2026-03-28T14:00:00.000Z');
    expect(analogueIssueCutoff('2026-10-25').toISOString()).toBe('2026-10-24T13:00:00.000Z');
  });

  it('aligns half-hourly demand with interpolated hourly wind', async () => {
    const result = await collectResidualDemandForecast({
      date: DATE,
      fetchFn: fakeFetch({
        '/forecast/demand/': demandRows(),
        '/forecast/generation/wind/': windRows(),
      }),
    });

    expect(result?.values).toHaveLength(48);
    expect(result?.values.slice(0, 4)).toEqual([26_000, 25_991, 25_982, 25_973]);
    expect(result?.inputVintages).toEqual([PUBLISHED]);
  });

  it('rejects a day rather than filling a missing demand period', async () => {
    const result = await collectResidualDemandForecast({
      date: DATE,
      fetchFn: fakeFetch({
        '/forecast/demand/': demandRows().slice(1),
        '/forecast/generation/wind/': windRows(),
      }),
    });

    expect(result).toBeNull();
  });

  it('excludes observations published after the issue cut-off', async () => {
    const rows = demandRows();
    rows[0] = { ...rows[0], publishTime: '2026-08-28T14:00:01.000Z' };
    const result = await collectResidualDemandForecast({
      date: DATE,
      fetchFn: fakeFetch({
        '/forecast/demand/': rows,
        '/forecast/generation/wind/': windRows(),
      }),
    });

    expect(result).toBeNull();
  });
});
