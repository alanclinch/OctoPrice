import { describe, expect, it } from 'vitest';
import {
  addDays,
  endOfLondonDay,
  expectedPeriodCount,
  floorToHalfHour,
  formatClockTime,
  formatLondonTime,
  isBritishSummerTime,
  isWithinClockWindow,
  londonDateOf,
  londonDayPeriodStarts,
  londonMinutesOfDay,
  londonOffsetMs,
  londonWallClockToUtc,
  parseClockTime,
  parsePricingDate,
  startOfLondonDay,
} from '../src/time.ts';

// UK daylight saving: clocks go forward on the last Sunday in March and back
// on the last Sunday in October.
const DST_FORWARD_2026 = '2026-03-29';
const DST_BACK_2026 = '2026-10-25';
const DST_FORWARD_2025 = '2025-03-30';
const DST_BACK_2025 = '2025-10-26';

describe('offsets', () => {
  it('reports GMT in winter', () => {
    expect(londonOffsetMs(new Date('2026-01-15T12:00:00Z'))).toBe(0);
    expect(isBritishSummerTime(new Date('2026-01-15T12:00:00Z'))).toBe(false);
  });

  it('reports BST in summer', () => {
    expect(londonOffsetMs(new Date('2026-06-15T12:00:00Z'))).toBe(3_600_000);
    expect(isBritishSummerTime(new Date('2026-06-15T12:00:00Z'))).toBe(true);
  });

  it('switches exactly at the transition instant', () => {
    // Clocks go forward at 01:00 GMT.
    expect(isBritishSummerTime(new Date('2026-03-29T00:59:59Z'))).toBe(false);
    expect(isBritishSummerTime(new Date('2026-03-29T01:00:00Z'))).toBe(true);
    // Clocks go back at 01:00 UTC (02:00 BST).
    expect(isBritishSummerTime(new Date('2026-10-25T00:59:59Z'))).toBe(true);
    expect(isBritishSummerTime(new Date('2026-10-25T01:00:00Z'))).toBe(false);
  });
});

describe('period counts', () => {
  it('has 48 periods on a normal GMT day', () => {
    expect(expectedPeriodCount('2026-01-15')).toBe(48);
  });

  it('has 48 periods on a normal BST day', () => {
    expect(expectedPeriodCount('2026-06-15')).toBe(48);
  });

  it('has 46 periods on the day the clocks go forward', () => {
    expect(expectedPeriodCount(DST_FORWARD_2026)).toBe(46);
    expect(expectedPeriodCount(DST_FORWARD_2025)).toBe(46);
  });

  it('has 50 periods on the day the clocks go back', () => {
    expect(expectedPeriodCount(DST_BACK_2026)).toBe(50);
    expect(expectedPeriodCount(DST_BACK_2025)).toBe(50);
  });

  it('produces one start per period, half an hour apart', () => {
    const starts = londonDayPeriodStarts(DST_BACK_2026);
    expect(starts).toHaveLength(50);
    for (let i = 1; i < starts.length; i += 1) {
      const gap = (starts[i] as Date).getTime() - (starts[i - 1] as Date).getTime();
      expect(gap).toBe(30 * 60 * 1000);
    }
  });
});

describe('day boundaries', () => {
  it('anchors a GMT day to midnight UTC', () => {
    expect(startOfLondonDay('2026-01-15').toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(endOfLondonDay('2026-01-15').toISOString()).toBe('2026-01-16T00:00:00.000Z');
  });

  it('anchors a BST day to 23:00 UTC the previous day', () => {
    expect(startOfLondonDay('2026-06-15').toISOString()).toBe('2026-06-14T23:00:00.000Z');
    expect(endOfLondonDay('2026-06-15').toISOString()).toBe('2026-06-15T23:00:00.000Z');
  });

  it('spans 23 hours on the short day', () => {
    const start = startOfLondonDay(DST_FORWARD_2026).getTime();
    const end = endOfLondonDay(DST_FORWARD_2026).getTime();
    expect(end - start).toBe(23 * 60 * 60 * 1000);
  });

  it('spans 25 hours on the long day', () => {
    const start = startOfLondonDay(DST_BACK_2026).getTime();
    const end = endOfLondonDay(DST_BACK_2026).getTime();
    expect(end - start).toBe(25 * 60 * 60 * 1000);
  });
});

describe('london date of an instant', () => {
  it('uses local midnight, not UTC midnight, during BST', () => {
    // 23:30Z on 15 June is 00:30 on 16 June in London.
    expect(londonDateOf(new Date('2026-06-15T23:30:00Z'))).toBe('2026-06-16');
    expect(londonDateOf(new Date('2026-06-15T22:30:00Z'))).toBe('2026-06-15');
  });

  it('matches UTC during GMT', () => {
    expect(londonDateOf(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-15');
  });
});

describe('wall clock conversion', () => {
  it('round-trips a GMT time', () => {
    expect(londonWallClockToUtc(2026, 1, 15, 17, 30).toISOString()).toBe(
      '2026-01-15T17:30:00.000Z',
    );
  });

  it('round-trips a BST time', () => {
    expect(londonWallClockToUtc(2026, 6, 15, 17, 30).toISOString()).toBe(
      '2026-06-15T16:30:00.000Z',
    );
  });

  it('resolves a time that does not exist locally to the jump instant', () => {
    // 01:30 on the spring-forward day is skipped; the clock reads 02:30.
    expect(londonWallClockToUtc(2026, 3, 29, 1, 30).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('resolves an ambiguous autumn time to the first (BST) occurrence', () => {
    expect(londonWallClockToUtc(2026, 10, 25, 1, 30).toISOString()).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });
});

describe('formatting', () => {
  it('formats 24-hour London time', () => {
    expect(formatLondonTime(new Date('2026-06-15T16:30:00Z'))).toBe('17:30');
    expect(formatLondonTime(new Date('2026-01-15T16:30:00Z'))).toBe('16:30');
  });

  it('formats 12-hour London time with a plain space', () => {
    expect(formatLondonTime(new Date('2026-06-15T16:30:00Z'), { hour12: true })).toBe('5:30 pm');
  });

  it('formats minutes of day', () => {
    expect(formatClockTime(0)).toBe('00:00');
    expect(formatClockTime(23 * 60 + 30)).toBe('23:30');
  });

  it('reports minutes since local midnight', () => {
    expect(londonMinutesOfDay(new Date('2026-06-15T16:30:00Z'))).toBe(17 * 60 + 30);
    expect(londonMinutesOfDay(new Date('2026-01-15T16:30:00Z'))).toBe(16 * 60 + 30);
  });
});

describe('parsing and validation', () => {
  it('parses valid dates', () => {
    expect(parsePricingDate('2026-08-27')).toEqual({ year: 2026, month: 8, day: 27 });
  });

  it.each(['27-08-2026', '2026-8-27', 'tomorrow', '2026-13-01'])('rejects %s', (value) => {
    expect(() => parsePricingDate(value)).toThrow();
  });

  it('parses clock times', () => {
    expect(parseClockTime('00:00')).toBe(0);
    expect(parseClockTime('22:30')).toBe(22 * 60 + 30);
  });

  it.each(['24:00', '12:60', '1230', ''])('rejects clock time %s', (value) => {
    expect(() => parseClockTime(value)).toThrow();
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('clock windows', () => {
  it('treats a normal window as half-open', () => {
    expect(isWithinClockWindow(60, 60, 120)).toBe(true);
    expect(isWithinClockWindow(120, 60, 120)).toBe(false);
  });

  it('wraps a window that crosses midnight', () => {
    const start = 22 * 60;
    const end = 6 * 60;
    expect(isWithinClockWindow(23 * 60, start, end)).toBe(true);
    expect(isWithinClockWindow(2 * 60, start, end)).toBe(true);
    expect(isWithinClockWindow(12 * 60, start, end)).toBe(false);
  });

  it('treats an empty window as always matching', () => {
    expect(isWithinClockWindow(500, 60, 60)).toBe(true);
  });
});

describe('floorToHalfHour', () => {
  it('rounds down to the containing period', () => {
    expect(floorToHalfHour(new Date('2026-06-15T16:42:13Z')).toISOString()).toBe(
      '2026-06-15T16:30:00.000Z',
    );
    expect(floorToHalfHour(new Date('2026-06-15T16:30:00Z')).toISOString()).toBe(
      '2026-06-15T16:30:00.000Z',
    );
  });
});
