import { describe, expect, it } from 'vitest';
import {
  findCheapestUpcomingWindow,
  findCheapestWindow,
  findMostExpensiveWindow,
  periodsForDuration,
  rankWindows,
} from '../src/windows.ts';
import { londonClock, makeDay, makeDayWith, makeFlatDay } from './helpers.ts';
import { startOfLondonDay } from '../src/time.ts';

const DAY = '2026-01-15';

describe('periodsForDuration', () => {
  it('converts whole half hours', () => {
    expect(periodsForDuration(30)).toBe(1);
    expect(periodsForDuration(180)).toBe(6);
  });

  it.each([0, -30, 45])('rejects %d minutes', (minutes) => {
    expect(() => periodsForDuration(minutes)).toThrow();
  });
});

describe('findCheapestWindow', () => {
  it('finds the cheapest continuous three hours', () => {
    // Periods 3-8 are 01:30 to 04:30.
    const day = makeDayWith(DAY, { 3: 4, 4: 4, 5: 5, 6: 5, 7: 4.6, 8: 5 }, 20);
    const window = findCheapestWindow(day, 180);
    expect(window).not.toBeNull();
    expect(londonClock(window?.startUtc as string)).toBe('01:30');
    expect(londonClock(window?.endUtc as string)).toBe('04:30');
    expect(window?.periodCount).toBe(6);
    expect(window?.averagePence).toBeCloseTo(4.6, 3);
  });

  it('returns null when there are not enough consecutive periods', () => {
    expect(findCheapestWindow(makeDay(DAY, [10, 10]), 180)).toBeNull();
  });

  it('will not span a gap in the data', () => {
    const day = makeFlatDay(DAY, 10).filter((_, index) => index !== 3);
    const window = findCheapestWindow(day, 180);
    expect(window).not.toBeNull();
    // The window must start at or after the gap, never across it.
    expect(Date.parse(window?.startUtc as string)).toBeGreaterThanOrEqual(
      startOfLondonDay(DAY).getTime() + 4 * 30 * 60 * 1000,
    );
  });

  it('breaks ties by choosing the earlier window', () => {
    const day = makeFlatDay(DAY, 10);
    const window = findCheapestWindow(day, 60);
    expect(londonClock(window?.startUtc as string)).toBe('00:00');
  });

  it('handles a window covering the whole day', () => {
    const day = makeFlatDay(DAY, 12);
    const window = findCheapestWindow(day, 24 * 60);
    expect(window?.periodCount).toBe(48);
    expect(window?.averagePence).toBe(12);
  });

  it('works with negative prices', () => {
    const day = makeDayWith(DAY, { 10: -2, 11: -3 }, 15);
    const window = findCheapestWindow(day, 60);
    expect(window?.averagePence).toBe(-2.5);
  });
});

describe('rankWindows', () => {
  it('orders windows cheapest first', () => {
    const day = makeDayWith(DAY, { 0: 1, 1: 1, 10: 2, 11: 2 }, 30);
    const ranked = rankWindows(day, 60, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.averagePence).toBe(1);
    expect(ranked[1]?.averagePence).toBe(2);
  });

  it('produces one window per possible start', () => {
    // 48 periods, 6 per window, gives 43 possible windows.
    expect(rankWindows(makeFlatDay(DAY, 10), 180)).toHaveLength(43);
  });

  it('returns nothing when the data is shorter than the window', () => {
    expect(rankWindows(makeDay(DAY, [10, 10]), 180)).toEqual([]);
  });
});

describe('findCheapestUpcomingWindow', () => {
  it('ignores windows that have already started', () => {
    const day = makeDayWith(DAY, { 0: 1, 1: 1, 20: 2, 21: 2 }, 30);
    const now = new Date(startOfLondonDay(DAY).getTime() + 5 * 30 * 60 * 1000);
    const window = findCheapestUpcomingWindow(day, 60, now);
    expect(window?.averagePence).toBe(2);
    expect(londonClock(window?.startUtc as string)).toBe('10:00');
  });

  it('returns null when nothing is left', () => {
    const day = makeFlatDay(DAY, 10);
    const now = new Date(startOfLondonDay(DAY).getTime() + 48 * 30 * 60 * 1000);
    expect(findCheapestUpcomingWindow(day, 60, now)).toBeNull();
  });
});

describe('findMostExpensiveWindow', () => {
  it('finds the peak stretch', () => {
    const day = makeDayWith(DAY, { 34: 60, 35: 60 }, 20);
    const window = findMostExpensiveWindow(day, 60);
    expect(window?.averagePence).toBe(60);
    expect(londonClock(window?.startUtc as string)).toBe('17:00');
  });
});

describe('daylight saving days', () => {
  it('spans the repeated hour on a 50-period day', () => {
    const window = findCheapestWindow(makeFlatDay('2026-10-25', 10), 24 * 60);
    expect(window?.periodCount).toBe(48);
  });

  it('handles the 46-period day', () => {
    const day = makeFlatDay('2026-03-29', 10);
    expect(day).toHaveLength(46);
    expect(findCheapestWindow(day, 23 * 60)?.periodCount).toBe(46);
  });
});
