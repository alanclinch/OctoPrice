import { describe, expect, it, vi } from 'vitest';
import {
  OctopusApiError,
  OctopusClient,
  isAgileImportProduct,
  toPricePeriod,
} from '../src/octopus/client.ts';
import { endOfLondonDay, startOfLondonDay } from '@octoprice/core';
import {
  fakeFetch,
  jsonResponse,
  makeRateRecords,
  ratesResponse,
  sequencedFetch,
  silentLogger,
} from './helpers.ts';

const DAY = '2026-01-15';
const RATES_PATH = 'standard-unit-rates';

function makeClient(fetchFn: typeof fetch, overrides = {}) {
  return new OctopusClient({
    logger: silentLogger(),
    fetchFn,
    retryDelayMs: 0,
    sleepFn: async () => {},
    ...overrides,
  });
}

function fetchDay(client: OctopusClient, date = DAY) {
  return client.getUnitRates({
    productCode: 'AGILE-24-10-01',
    tariffCode: 'E-1R-AGILE-24-10-01-C',
    periodFrom: startOfLondonDay(date),
    periodTo: endOfLondonDay(date),
  });
}

describe('parsing unit rates', () => {
  it('parses a normal response into oldest-first periods', async () => {
    const client = makeClient(
      fakeFetch({ [RATES_PATH]: ratesResponse(makeRateRecords(DAY, [10, 20, 30])) }),
    );
    const periods = await fetchDay(client);

    expect(periods.map((p) => p.valueIncVat)).toEqual([10, 20, 30]);
    expect(periods[0]?.validFrom).toBe('2026-01-15T00:00:00.000Z');
    expect(periods[0]?.validTo).toBe('2026-01-15T00:30:00.000Z');
  });

  it('handles negative and zero prices', async () => {
    const client = makeClient(
      fakeFetch({ [RATES_PATH]: ratesResponse(makeRateRecords(DAY, [-3.6, 0, 12])) }),
    );
    expect((await fetchDay(client)).map((p) => p.valueIncVat)).toEqual([-3.6, 0, 12]);
  });

  it('keeps VAT-exclusive and VAT-inclusive values separate', async () => {
    const client = makeClient(
      fakeFetch({ [RATES_PATH]: ratesResponse(makeRateRecords(DAY, [21])) }),
    );
    const period = (await fetchDay(client))[0];
    expect(period?.valueIncVat).toBe(21);
    expect(period?.valueExcVat).toBeCloseTo(20, 1);
  });

  it('de-duplicates repeated periods, keeping the later value', async () => {
    const records = makeRateRecords(DAY, [10, 20]);
    const corrected = { ...(records[1] as object), value_inc_vat: 9 } as (typeof records)[number];
    const client = makeClient(fakeFetch({ [RATES_PATH]: ratesResponse([...records, corrected]) }));
    const periods = await fetchDay(client);
    expect(periods).toHaveLength(2);
    expect(periods[0]?.valueIncVat).toBe(9);
  });

  it('accepts a partial day without complaint', async () => {
    const client = makeClient(
      fakeFetch({ [RATES_PATH]: ratesResponse(makeRateRecords(DAY, [10, 20, 30])) }),
    );
    // Completeness is the price service's decision, not the client's.
    expect(await fetchDay(client)).toHaveLength(3);
  });

  it('returns nothing for an empty result set', async () => {
    const client = makeClient(fakeFetch({ [RATES_PATH]: ratesResponse([]) }));
    expect(await fetchDay(client)).toEqual([]);
  });

  it('rejects a response that is not shaped like unit rates', async () => {
    const client = makeClient(fakeFetch({ [RATES_PATH]: { unexpected: true } }));
    await expect(fetchDay(client)).rejects.toThrow(/Unexpected unit rate response/);
  });
});

describe('toPricePeriod', () => {
  it('fills in a missing valid_to as half an hour later', () => {
    const period = toPricePeriod({
      value_exc_vat: 10,
      value_inc_vat: 10.5,
      valid_from: '2026-01-15T00:00:00Z',
      valid_to: null,
    });
    expect(period?.validTo).toBe('2026-01-15T00:30:00.000Z');
  });

  it('drops a record with an unparseable timestamp', () => {
    expect(
      toPricePeriod({
        value_exc_vat: 10,
        value_inc_vat: 10.5,
        valid_from: 'not a date',
        valid_to: null,
      }),
    ).toBeNull();
  });

  it('drops a record whose end is not after its start', () => {
    expect(
      toPricePeriod({
        value_exc_vat: 10,
        value_inc_vat: 10.5,
        valid_from: '2026-01-15T01:00:00Z',
        valid_to: '2026-01-15T00:30:00Z',
      }),
    ).toBeNull();
  });
});

describe('pagination', () => {
  it('follows the next link and merges pages', async () => {
    const firstPage = ratesResponse(
      makeRateRecords(DAY, [10, 20]),
      'https://api.octopus.energy/v1/next-page',
    );
    const secondPage = ratesResponse(makeRateRecords('2026-01-16', [30, 40]));

    const { fetchFn } = sequencedFetch([
      () => jsonResponse(firstPage),
      () => jsonResponse(secondPage),
    ]);

    const periods = await fetchDay(makeClient(fetchFn));
    expect(periods.map((p) => p.valueIncVat)).toEqual([10, 20, 30, 40]);
  });
});

describe('retries and failures', () => {
  it('retries a 500 and succeeds', async () => {
    const { fetchFn, calls } = sequencedFetch([
      () => jsonResponse({ detail: 'server error' }, 500),
      () => jsonResponse(ratesResponse(makeRateRecords(DAY, [11]))),
    ]);

    const periods = await fetchDay(makeClient(fetchFn));
    expect(periods).toHaveLength(1);
    expect(calls()).toBe(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const { fetchFn, calls } = sequencedFetch([() => jsonResponse({ detail: 'nope' }, 503)]);
    const client = makeClient(fetchFn, { maxAttempts: 3 });

    await expect(fetchDay(client)).rejects.toThrow(OctopusApiError);
    expect(calls()).toBe(3);
  });

  it('does not retry a 404, which will never succeed', async () => {
    const { fetchFn, calls } = sequencedFetch([() => jsonResponse({ detail: 'no tariff' }, 404)]);
    await expect(fetchDay(makeClient(fetchFn))).rejects.toThrow(/404/);
    expect(calls()).toBe(1);
  });

  it('retries a 429', async () => {
    const { fetchFn, calls } = sequencedFetch([
      () => jsonResponse({ detail: 'slow down' }, 429),
      () => jsonResponse(ratesResponse(makeRateRecords(DAY, [11]))),
    ]);
    await fetchDay(makeClient(fetchFn));
    expect(calls()).toBe(2);
  });

  it('surfaces a network failure as an OctopusApiError', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(fetchDay(makeClient(fetchFn, { maxAttempts: 1 }))).rejects.toThrow(/fetch failed/);
  });

  it('times out a request that never responds', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as unknown as typeof fetch;

      const client = makeClient(fetchFn, { maxAttempts: 1, timeoutMs: 100 });
      const promise = fetchDay(client);
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies which errors are worth retrying', () => {
    expect(new OctopusApiError('x', 500).retryable).toBe(true);
    expect(new OctopusApiError('x', 429).retryable).toBe(true);
    expect(new OctopusApiError('x', undefined).retryable).toBe(true);
    expect(new OctopusApiError('x', 404).retryable).toBe(false);
    expect(new OctopusApiError('x', 400).retryable).toBe(false);
  });
});

describe('product discovery', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('recognises a current Agile import product', () => {
    expect(
      isAgileImportProduct(
        {
          code: 'AGILE-24-10-01',
          direction: 'IMPORT',
          available_from: '2024-10-01T00:00:00+01:00',
          available_to: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it('rejects the outgoing (export) tariff', () => {
    expect(
      isAgileImportProduct(
        {
          code: 'AGILE-OUTGOING-19-05-13',
          direction: 'EXPORT',
          available_from: '2018-01-01T00:00:00Z',
          available_to: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it('rejects a withdrawn product', () => {
    expect(
      isAgileImportProduct(
        {
          code: 'AGILE-18-02-21',
          direction: 'IMPORT',
          available_from: '2018-02-21T00:00:00Z',
          available_to: '2024-10-01T00:00:00Z',
        },
        now,
      ),
    ).toBe(false);
  });

  it('rejects a non-Agile product', () => {
    expect(
      isAgileImportProduct(
        { code: 'VAR-22-11-01', direction: 'IMPORT', available_from: null, available_to: null },
        now,
      ),
    ).toBe(false);
  });

  it('picks the most recently available Agile import product', async () => {
    const client = makeClient(
      fakeFetch({
        products: {
          count: 3,
          next: null,
          results: [
            {
              code: 'AGILE-18-02-21',
              direction: 'IMPORT',
              available_from: '2018-02-21T00:00:00Z',
              available_to: null,
            },
            {
              code: 'AGILE-24-10-01',
              direction: 'IMPORT',
              available_from: '2024-10-01T00:00:00+01:00',
              available_to: null,
            },
            {
              code: 'AGILE-OUTGOING-19-05-13',
              direction: 'EXPORT',
              available_from: '2019-05-13T00:00:00Z',
              available_to: null,
            },
          ],
        },
      }),
    );

    expect(await client.findCurrentAgileProduct(now)).toBe('AGILE-24-10-01');
  });

  it('returns null when nothing matches, so the caller can fall back', async () => {
    const client = makeClient(fakeFetch({ products: { count: 0, next: null, results: [] } }));
    expect(await client.findCurrentAgileProduct(now)).toBeNull();
  });
});
