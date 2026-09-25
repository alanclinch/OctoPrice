import { describe, expect, it, vi } from 'vitest';
import { addDays, londonDayPeriodStarts } from '@octoprice/core';
import { parseAgilePredict } from '../src/forecast/competitor.ts';
import {
  readAgilePredictForecastCache,
  refreshOneAgilePredictForecast,
} from '../src/forecast/provider.ts';
import type { Store } from '../src/db/store.ts';
import type { PriceService } from '../src/prices/service.ts';
import type { Logger } from '../src/logger.ts';

function responseFor(issueDay: string, issuedAt: string) {
  const starts = [0, 1, 2, 3, 4].flatMap((offset) =>
    londonDayPeriodStarts(addDays(issueDay, offset)),
  );
  return [
    {
      created_at: issuedAt,
      prices: starts.map((at, index) => ({
        date_time: at.toISOString(),
        agile_pred: index === 20 ? 30.33 : 25,
        agile_low: 20,
        agile_high: 35,
      })),
    },
  ];
}

function fixture(body: unknown, confirmedStarts: string[] = []) {
  const state = new Map<string, string>();
  const getState = vi.fn(async (key: string) => state.get(key) ?? null);
  const setState = vi.fn(async (key: string, value: string) => {
    state.set(key, value);
  });
  const getPrices = vi.fn(async () =>
    confirmedStarts.map((validFrom) => ({
      validFrom,
      validTo: new Date(Date.parse(validFrom) + 1_800_000).toISOString(),
      valueIncVat: 30.33,
    })),
  );
  const store = { getState, setState, getPrices } as unknown as Store;
  const priceService = {
    distinctTariffs: vi.fn(async () => [
      {
        region: 'N',
        productCode: 'AGILE-24-10-01',
        tariffCode: 'E-1R-AGILE-24-10-01-N',
      },
    ]),
  } as unknown as PriceService;
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const fetchFn = vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
  return { state, store, priceService, logger, fetchFn, getState, setState, getPrices };
}

describe('AgilePredict display cache', () => {
  it('keeps VAT-inclusive pence unchanged and parses provider-supplied ranges', () => {
    const parsed = parseAgilePredict([
      {
        created_at: '2026-09-24T16:15:00+01:00',
        prices: [
          {
            date_time: '2026-09-25T00:00:00+01:00',
            agile_pred: 30.33,
            agile_low: 27,
            agile_high: 35,
          },
        ],
      },
    ]);
    expect(parsed[0]?.values.get('2026-09-24T23:00:00.000Z')).toBe(30.33);
    expect(parsed[0]?.ranges.get('2026-09-24T23:00:00.000Z')).toEqual({ low: 27, high: 35 });
    const outOfRange = parseAgilePredict([
      {
        created_at: '2026-09-24T16:15:00+01:00',
        prices: [
          { date_time: '2026-09-25T00:00:00+01:00', agile_pred: 40, agile_low: 27, agile_high: 35 },
        ],
      },
    ]);
    expect(outOfRange[0]?.ranges.get('2026-09-24T23:00:00.000Z')).toEqual({ low: 27, high: 35 });
  });

  it('stores only unpublished future prices, one regional fetch, and reads no network on the request path', async () => {
    const now = new Date('2026-09-24T15:42:00Z');
    const confirmed = [
      ...londonDayPeriodStarts('2026-09-24'),
      ...londonDayPeriodStarts('2026-09-25'),
    ].map((at) => at.toISOString());
    const f = fixture(responseFor('2026-09-24', '2026-09-24T16:15:00+01:00'), confirmed);
    expect(await refreshOneAgilePredictForecast({ ...f, now })).toBe('N');
    const forecast = await readAgilePredictForecastCache({ store: f.store, region: 'N', now });
    expect(forecast).toMatchObject({
      source: 'agilepredict',
      model: 'agilepredict',
      issuedAt: '2026-09-24T15:15:00.000Z',
    });
    expect(forecast?.periods.every((period) => !confirmed.includes(period.validFrom))).toBe(true);
    expect(forecast?.periods[0]?.model).toBe('agilepredict');
    expect(forecast?.periods[0]?.lowerIncVat).toBe(20);
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    expect(f.fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/N/'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': expect.any(String) }),
      }),
    );
    expect(
      await refreshOneAgilePredictForecast({ ...f, now: new Date(now.getTime() + 300_000) }),
    ).toBeNull();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2026-03-29', '2026-03-28T11:15:00Z', 46],
    ['2026-10-25', '2026-10-24T11:15:00+01:00', 50],
  ])(
    'retains all %s settlement periods, including clock changes',
    async (target, issuedAt, count) => {
      const issueDay = addDays(target, -1);
      const now = new Date(Date.parse(issuedAt) + 3 * 60 * 60 * 1000);
      const f = fixture(responseFor(issueDay, issuedAt));
      expect(await refreshOneAgilePredictForecast({ ...f, now })).toBe('N');
      const forecast = await readAgilePredictForecastCache({ store: f.store, region: 'N', now });
      expect(
        forecast?.periods.filter((period) =>
          londonDayPeriodStarts(target).some((at) => at.toISOString() === period.validFrom),
        ),
      ).toHaveLength(count);
    },
  );

  it('rejects stale, malformed and missing-band provider data so v1 can take over', async () => {
    const now = new Date('2026-09-24T15:42:00Z');
    const body = responseFor('2026-09-24', '2026-09-24T16:15:00+01:00');
    const confirmedTomorrow = [
      ...londonDayPeriodStarts('2026-09-24'),
      ...londonDayPeriodStarts('2026-09-25'),
    ].map((at) => at.toISOString());
    const f = fixture(body, confirmedTomorrow);
    expect(await refreshOneAgilePredictForecast({ ...f, now })).toBe('N');
    expect(
      await readAgilePredictForecastCache({
        store: f.store,
        region: 'N',
        now: new Date(now.getTime() + 5 * 60 * 60 * 1000),
      }),
    ).toBeNull();
    f.state.set('forecast_agilepredict_cache:N', '{broken');
    expect(await readAgilePredictForecastCache({ store: f.store, region: 'N', now })).toBeNull();
    const broken = responseFor('2026-09-24', '2026-09-24T16:15:00+01:00');
    delete (broken[0]?.prices[100] as { agile_low?: number }).agile_low;
    const other = fixture(broken, confirmedTomorrow);
    expect(await refreshOneAgilePredictForecast({ ...other, now })).toBe('N');
    expect(other.state.has('forecast_agilepredict_cache:N')).toBe(false);
  });

  it('does not relabel provider actuals while tomorrow publication is incomplete', async () => {
    const now = new Date('2026-09-24T15:42:00Z');
    const partialTomorrow = londonDayPeriodStarts('2026-09-25')
      .slice(0, 46)
      .map((at) => at.toISOString());
    const f = fixture(responseFor('2026-09-24', '2026-09-24T16:15:00+01:00'), partialTomorrow);
    expect(await refreshOneAgilePredictForecast({ ...f, now })).toBe('N');
    expect(f.state.has('forecast_agilepredict_cache:N')).toBe(false);
    const early = new Date('2026-09-24T14:42:00Z');
    const earlyIssue = fixture(
      responseFor('2026-09-24', '2026-09-24T15:15:00+01:00'),
      partialTomorrow,
    );
    expect(await refreshOneAgilePredictForecast({ ...earlyIssue, now: early })).toBe('N');
    expect(earlyIssue.state.has('forecast_agilepredict_cache:N')).toBe(false);
  });

  it('retains a provider point outside its separately supplied range', async () => {
    const now = new Date('2026-09-24T15:42:00Z');
    const body = responseFor('2026-09-24', '2026-09-24T16:15:00+01:00');
    const odd = body[0]?.prices[100];
    if (!odd) throw new Error('missing fixture price');
    odd.agile_pred = 40;
    const confirmed = [
      ...londonDayPeriodStarts('2026-09-24'),
      ...londonDayPeriodStarts('2026-09-25'),
    ].map((at) => at.toISOString());
    const f = fixture(body, confirmed);
    expect(await refreshOneAgilePredictForecast({ ...f, now })).toBe('N');
    const forecast = await readAgilePredictForecastCache({ store: f.store, region: 'N', now });
    expect(
      forecast?.periods.some((period) => period.valueIncVat === 40 && period.upperIncVat === 35),
    ).toBe(true);
  });
});
