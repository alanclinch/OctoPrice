import { describe, expect, it } from 'vitest';
import {
  cheapestPeriods,
  dedupePeriods,
  findNextPeriod,
  findPeriodAt,
  groupByLondonDay,
  isDayComplete,
  missingPeriodStarts,
  periodsForLondonDay,
  remainingPeriods,
  sortPeriods,
  splitIntoContiguousRuns,
  summariseDay,
} from '../src/prices.ts';
import { makeDay, makeDayWith, makeFlatDay, makePeriod } from './helpers.ts';
import { HALF_HOUR_MS, startOfLondonDay } from '../src/time.ts';

const NORMAL_DAY = '2026-01-15';
const SHORT_DAY = '2026-03-29';
const LONG_DAY = '2026-10-25';

describe('normalisation', () => {
  it('sorts newest-first API output into oldest-first order', () => {
    const day = makeDay(NORMAL_DAY, [10, 20, 30]);
    const reversed = [...day].reverse();
    expect(sortPeriods(reversed).map((p) => p.valueIncVat)).toEqual([10, 20, 30]);
  });

  it('removes duplicate periods, keeping the later entry', () => {
    const day = makeDay(NORMAL_DAY, [10, 20]);
    const corrected = { ...(day[0] as object), valueIncVat: 9 } as (typeof day)[number];
    const result = dedupePeriods([...day, corrected]);
    expect(result).toHaveLength(2);
    expect(result[0]?.valueIncVat).toBe(9);
  });

  it('does not mutate its input', () => {
    const day = makeDay(NORMAL_DAY, [30, 10, 20]);
    const snapshot = day.map((p) => p.valueIncVat);
    sortPeriods(day);
    expect(day.map((p) => p.valueIncVat)).toEqual(snapshot);
  });
});

describe('day slicing', () => {
  it('keeps only periods starting within the London day', () => {
    const today = makeFlatDay(NORMAL_DAY, 10);
    const tomorrow = makeFlatDay('2026-01-16', 20);
    const sliced = periodsForLondonDay([...today, ...tomorrow], NORMAL_DAY);
    expect(sliced).toHaveLength(48);
    expect(sliced.every((p) => p.valueIncVat === 10)).toBe(true);
  });

  it('groups a two-day set by local date', () => {
    const groups = groupByLondonDay([...makeFlatDay(NORMAL_DAY), ...makeFlatDay('2026-01-16')]);
    expect([...groups.keys()]).toEqual([NORMAL_DAY, '2026-01-16']);
    expect(groups.get(NORMAL_DAY)).toHaveLength(48);
  });

  it('assigns a 23:30 BST period to the correct local day', () => {
    const periods = makeFlatDay('2026-06-15');
    const groups = groupByLondonDay(periods);
    expect([...groups.keys()]).toEqual(['2026-06-15']);
  });
});

describe('completeness', () => {
  it('accepts a full 48-period day', () => {
    expect(isDayComplete(makeFlatDay(NORMAL_DAY), NORMAL_DAY)).toBe(true);
  });

  it('accepts a full 46-period short day', () => {
    expect(isDayComplete(makeFlatDay(SHORT_DAY), SHORT_DAY)).toBe(true);
  });

  it('accepts a full 50-period long day', () => {
    expect(isDayComplete(makeFlatDay(LONG_DAY), LONG_DAY)).toBe(true);
  });

  it('rejects a partial day', () => {
    const partial = makeDay(
      NORMAL_DAY,
      Array.from({ length: 40 }, () => 12),
    );
    expect(isDayComplete(partial, NORMAL_DAY)).toBe(false);
  });

  it('rejects a day with the right count but a hole in the middle', () => {
    const full = makeFlatDay(NORMAL_DAY);
    const withHole = full.filter((_, index) => index !== 20);
    // Add an extra period after the end so the count is right again.
    const extra = makePeriod(startOfLondonDay('2026-01-16').getTime(), 12);
    expect(isDayComplete([...withHole, extra], NORMAL_DAY)).toBe(false);
  });

  it('attributes surplus periods to the next day on a short day', () => {
    // A caller asking for 48 periods on the 46-period day runs two periods
    // past local midnight; those belong to the following day, and the short
    // day is still complete with 46.
    const spilling = makeDay(
      SHORT_DAY,
      Array.from({ length: 48 }, () => 12),
    );
    expect(periodsForLondonDay(spilling, SHORT_DAY)).toHaveLength(46);
    expect(isDayComplete(spilling, SHORT_DAY)).toBe(true);
    expect(periodsForLondonDay(spilling, '2026-03-30')).toHaveLength(2);
  });

  it('rejects a short day that is two periods light', () => {
    const partial = makeDay(
      SHORT_DAY,
      Array.from({ length: 44 }, () => 12),
    );
    expect(isDayComplete(partial, SHORT_DAY)).toBe(false);
  });

  it('lists the periods a partial day is missing', () => {
    const partial = makeDay(
      NORMAL_DAY,
      Array.from({ length: 46 }, () => 12),
    );
    const missing = missingPeriodStarts(partial, NORMAL_DAY);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toBe('2026-01-15T23:00:00.000Z');
  });
});

describe('contiguous runs', () => {
  it('returns a single run for unbroken data', () => {
    expect(splitIntoContiguousRuns(makeFlatDay(NORMAL_DAY))).toHaveLength(1);
  });

  it('splits at a gap', () => {
    const day = makeFlatDay(NORMAL_DAY);
    const gapped = day.filter((_, index) => index !== 10);
    const runs = splitIntoContiguousRuns(gapped);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(10);
    expect(runs[1]).toHaveLength(37);
  });

  it('returns nothing for an empty list', () => {
    expect(splitIntoContiguousRuns([])).toEqual([]);
  });
});

describe('summaries', () => {
  it('reports min, max, average and the periods they fall in', () => {
    const day = makeDayWith(NORMAL_DAY, { 5: 3.2, 35: 31.4 }, 16.8);
    const summary = summariseDay(day, NORMAL_DAY);
    expect(summary).not.toBeNull();
    expect(summary?.minPence).toBe(3.2);
    expect(summary?.maxPence).toBe(31.4);
    expect(summary?.cheapest.validFrom).toBe(day[5]?.validFrom);
    expect(summary?.mostExpensive.validFrom).toBe(day[35]?.validFrom);
    expect(summary?.complete).toBe(true);
    expect(summary?.expectedPeriodCount).toBe(48);
  });

  it('averages correctly', () => {
    const summary = summariseDay(makeDayWith(NORMAL_DAY, { 0: 20 }, 10), NORMAL_DAY);
    // 47 periods at 10p and one at 20p.
    expect(summary?.averagePence).toBeCloseTo((47 * 10 + 20) / 48, 3);
  });

  it('counts negative periods and handles a zero price', () => {
    const day = makeDayWith(NORMAL_DAY, { 3: -1.2, 4: -3.6, 5: 0 }, 12);
    const summary = summariseDay(day, NORMAL_DAY);
    expect(summary?.negativeCount).toBe(2);
    expect(summary?.minPence).toBe(-3.6);
  });

  it('marks a partial day as incomplete but still summarises it', () => {
    const partial = makeDay(NORMAL_DAY, [10, 20, 30]);
    const summary = summariseDay(partial, NORMAL_DAY);
    expect(summary?.complete).toBe(false);
    expect(summary?.periodCount).toBe(3);
  });

  it('returns null when there is no data for the day', () => {
    expect(summariseDay([], NORMAL_DAY)).toBeNull();
    expect(summariseDay(makeFlatDay('2026-01-16'), NORMAL_DAY)).toBeNull();
  });
});

describe('lookups', () => {
  const day = makeDay(NORMAL_DAY, [10, 20, 30, 40]);
  const start = startOfLondonDay(NORMAL_DAY).getTime();

  it('finds the period covering an instant', () => {
    expect(findPeriodAt(day, new Date(start + 10 * 60 * 1000))?.valueIncVat).toBe(10);
    expect(findPeriodAt(day, new Date(start + HALF_HOUR_MS))?.valueIncVat).toBe(20);
  });

  it('treats the period end as exclusive', () => {
    expect(findPeriodAt(day, new Date(start + 4 * HALF_HOUR_MS))).toBeNull();
  });

  it('finds the next period', () => {
    expect(findNextPeriod(day, new Date(start + 10 * 60 * 1000))?.valueIncVat).toBe(20);
    expect(findNextPeriod(day, new Date(start + 4 * HALF_HOUR_MS))).toBeNull();
  });

  it('lists periods that have not finished yet', () => {
    const remaining = remainingPeriods(day, new Date(start + HALF_HOUR_MS + 1));
    expect(remaining.map((p) => p.valueIncVat)).toEqual([20, 30, 40]);
  });

  it('ranks the cheapest periods', () => {
    expect(cheapestPeriods(day, 2).map((p) => p.valueIncVat)).toEqual([10, 20]);
    expect(cheapestPeriods(day, 0)).toEqual([]);
  });
});
