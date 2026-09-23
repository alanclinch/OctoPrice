import { describe, expect, it, vi } from 'vitest';
import { addDays, buildTariffCode, londonDayPeriodStarts } from '@octoprice/core';
import { collectAgilePredict, parseAgilePredict } from '../src/forecast/competitor.ts';
import { scoreOneShadowRun } from '../src/forecast/analogue.ts';
import type { Store } from '../src/db/store.ts';
import type { PriceService } from '../src/prices/service.ts';
import type { Logger } from '../src/logger.ts';

const ISSUE_DATE = '2026-10-24';
const NOW = new Date('2026-10-24T13:07:00.000Z'); // 14:07 London, before DST ends

function providerIssue(createdAt: string, missing = false) {
  const periods = [1, 2, 3].flatMap((offset) => londonDayPeriodStarts(addDays(ISSUE_DATE, offset)));
  return {
    created_at: createdAt,
    prices: periods.slice(0, missing ? -1 : undefined).map((at, index) => ({
      date_time: at.toISOString(),
      agile_pred: index === 20 ? -2 : 20 + index / 100,
    })),
  };
}

function fixture(body: unknown) {
  const insertForecastRun = vi.fn(async () => true);
  const getState = vi.fn(async () => null);
  const setState = vi.fn(async () => undefined);
  const store = { insertForecastRun, getState, setState } as unknown as Store;
  const priceService = {
    distinctTariffs: vi.fn(async () => [{ productCode: 'AGILE-24-10-01', region: 'N' }]),
  } as unknown as PriceService;
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const fetchFn = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
  return { store, priceService, logger, fetchFn, insertForecastRun, getState, setState };
}

describe('private competitor snapshots', () => {
  it('selects the latest pre-2pm issue and stores three complete London days immutably', async () => {
    const f = fixture([
      providerIssue('2026-10-24T16:15:00+01:00'),
      providerIssue('2026-10-24T11:15:00+01:00'),
    ]);
    expect(await collectAgilePredict({ ...f, now: NOW })).toBe(3);
    expect(f.insertForecastRun).toHaveBeenCalledTimes(3);
    expect(f.insertForecastRun.mock.calls[0]?.[0]).toMatchObject({
      model: 'agilepredict',
      tariffCode: buildTariffCode('AGILE-24-10-01', 'N'),
      targetDate: '2026-10-25',
      issueCutoff: '2026-10-24T13:00:00.000Z',
      inputVintages: ['2026-10-24T10:15:00.000Z'],
    });
    expect(f.insertForecastRun.mock.calls[0]?.[0].periods).toHaveLength(50);
    expect(f.setState).toHaveBeenCalledWith(
      'competitor:agilepredict:2026-10-24',
      '2026-10-24T10:15:00.000Z',
    );
    expect(f.fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/N/'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not collect before 2pm or after the official publication window opens', async () => {
    const f = fixture([providerIssue('2026-10-24T11:15:00+01:00')]);
    expect(await collectAgilePredict({ ...f, now: new Date('2026-10-24T12:57:00Z') })).toBe(0);
    expect(await collectAgilePredict({ ...f, now: new Date('2026-10-24T15:02:00Z') })).toBe(0);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it('rejects bad prices and incomplete days without inventing periods', async () => {
    const parsed = parseAgilePredict([
      {
        created_at: '2026-10-24T11:15:00+01:00',
        prices: [{ date_time: '2026-10-25T00:00:00Z', agile_pred: Number.NaN }],
      },
    ]);
    expect(parsed[0]?.values.size).toBe(0);
    const f = fixture([providerIssue('2026-10-24T11:15:00+01:00', true)]);
    expect(await collectAgilePredict({ ...f, now: NOW })).toBe(2);
    expect(f.insertForecastRun).toHaveBeenCalledTimes(2);
  });

  it('keeps the fetch failure isolated from confirmed prices and forecast work', async () => {
    const f = fixture([]);
    expect(await collectAgilePredict({ ...f, now: NOW })).toBe(0);
    expect(f.logger.warn).toHaveBeenCalled();
    expect(f.setState).not.toHaveBeenCalled();
  });

  it('does not refetch a day that was already captured', async () => {
    const f = fixture([providerIssue('2026-10-24T11:15:00+01:00')]);
    f.getState.mockResolvedValue('2026-10-24T10:15:00.000Z');
    expect(await collectAgilePredict({ ...f, now: NOW })).toBe(0);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it('does not collect if no Southern Scotland tariff is being polled', async () => {
    const f = fixture([providerIssue('2026-10-24T11:15:00+01:00')]);
    f.priceService.distinctTariffs = vi.fn(async () => [
      { productCode: 'AGILE-24-10-01', tariffCode: 'AGILE-24-10-01-C', region: 'C' },
    ]);
    expect(await collectAgilePredict({ ...f, now: NOW })).toBe(0);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it('scores a complete run even when an unscoreable rival run comes first', async () => {
    const date = '2026-10-24';
    const starts = londonDayPeriodStarts(date);
    const actual = starts.map((at) => ({
      validFrom: at.toISOString(),
      validTo: new Date(at.getTime() + 1_800_000).toISOString(),
      valueIncVat: 20,
    }));
    const runs = ['rival', 'baseline'].map((id) => ({
      id,
      model: id,
      tariffCode: id === 'rival' ? 'AGILE-24-10-01-N' : 'AGILE-24-10-01-C',
      targetDate: date,
      generatedAt: NOW.toISOString(),
      issueCutoff: NOW.toISOString(),
      periods: starts.map(() => 20),
      inputVintages: [],
    }));
    const scoreForecastRun = vi.fn(async () => undefined);
    const store = {
      listUnscoredForecastRuns: vi.fn(async () => runs),
      getPrices: vi.fn(async (tariffCode: string) => (tariffCode.endsWith('-N') ? [] : actual)),
      scoreForecastRun,
    } as unknown as Store;
    expect(await scoreOneShadowRun({ store, now: new Date('2026-10-26T12:00:00Z') })).toBe(true);
    expect(scoreForecastRun).toHaveBeenCalledWith(
      'baseline',
      expect.objectContaining({ cheapest3hRegret: 0, within60Minutes: true }),
    );
  });
});
