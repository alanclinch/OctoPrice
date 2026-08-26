import { createLogger, type Logger } from '../src/logger.ts';
import { HALF_HOUR_MS, startOfLondonDay } from '@octoprice/core';

/** A logger that produces no output, for tests that do not assert on logs. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', write: () => {} });
}

/** A logger that collects its lines, for tests that do assert on logs. */
export function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

export interface RateRecord {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
  payment_method: string | null;
}

/**
 * Builds an Octopus-shaped unit rate list for a London day, newest-first as
 * the real API returns them.
 */
export function makeRateRecords(date: string, valuesIncVat: readonly number[]): RateRecord[] {
  const start = startOfLondonDay(date).getTime();
  const records = valuesIncVat.map((value, index) => ({
    value_exc_vat: Number((value / 1.05).toFixed(4)),
    value_inc_vat: value,
    valid_from: new Date(start + index * HALF_HOUR_MS).toISOString(),
    valid_to: new Date(start + (index + 1) * HALF_HOUR_MS).toISOString(),
    payment_method: null,
  }));
  return records.reverse();
}

export function ratesResponse(results: readonly RateRecord[], next: string | null = null) {
  return { count: results.length, next, previous: null, results };
}

/**
 * A `fetch` stand-in driven by a URL-to-response map. Any URL containing a
 * key matches, so tests do not have to reproduce full query strings.
 */
export function fakeFetch(
  routes: Record<string, unknown>,
  options: { status?: number } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) {
      return new Response('{"detail":"Not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(routes[match]), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** A `fetch` stand-in that returns a sequence of responses, one per call. */
export function sequencedFetch(responses: readonly (() => Response | Promise<Response>)[]): {
  fetchFn: typeof fetch;
  calls: () => number;
} {
  let index = 0;
  const fetchFn = (async () => {
    const factory = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!factory) throw new Error('No response configured');
    return factory();
  }) as typeof fetch;
  return { fetchFn, calls: () => index };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
