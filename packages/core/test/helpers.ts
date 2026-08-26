import { HALF_HOUR_MS, expectedPeriodCount, startOfLondonDay } from '../src/time.ts';
import type { AlertRule, AlertRuleInput, PricePeriod } from '../src/types.ts';

/**
 * Builds half-hour periods for a London day from a list of VAT-inclusive
 * prices, starting at local midnight. Supplying fewer prices than the day
 * needs produces a deliberately partial day.
 */
export function makeDay(date: string, valuesIncVat: readonly number[]): PricePeriod[] {
  const start = startOfLondonDay(date).getTime();
  return valuesIncVat.map((value, index) => makePeriod(start + index * HALF_HOUR_MS, value));
}

/** Builds a full London day where every period has the same price. */
export function makeFlatDay(date: string, valueIncVat = 15): PricePeriod[] {
  return makeDay(
    date,
    Array.from({ length: expectedPeriodCount(date) }, () => valueIncVat),
  );
}

/** Builds a full London day, overriding prices at given period indexes. */
export function makeDayWith(
  date: string,
  overrides: Record<number, number>,
  baseValue = 15,
): PricePeriod[] {
  const values = Array.from({ length: expectedPeriodCount(date) }, (_, index) =>
    index in overrides ? (overrides[index] as number) : baseValue,
  );
  return makeDay(date, values);
}

export function makePeriod(startMs: number, valueIncVat: number): PricePeriod {
  return {
    validFrom: new Date(startMs).toISOString(),
    validTo: new Date(startMs + HALF_HOUR_MS).toISOString(),
    valueIncVat,
    valueExcVat: Number((valueIncVat / 1.05).toFixed(4)),
  };
}

/** Builds a rule, with everything not under test given a neutral default. */
export function makeRule(overrides: Partial<AlertRule> & Partial<AlertRuleInput> = {}): AlertRule {
  return {
    id: 'rule-1',
    userId: 'default',
    name: 'Test rule',
    enabled: true,
    operator: 'lte',
    thresholdPence: 7,
    minimumDurationMinutes: 30,
    timeStart: null,
    timeEnd: null,
    notify: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastTriggeredAt: null,
    ...overrides,
  };
}

/** London-local `HH:mm` of a period start, for readable assertions. */
export function londonClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
