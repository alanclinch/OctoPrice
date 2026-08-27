import { describe, expect, it } from 'vitest';
import {
  compare,
  countMatchedPeriods,
  describeRule,
  evaluateRule,
  evaluateRules,
  formatDuration,
  formatPence,
  periodQualifies,
} from '../src/rules.ts';
import { londonClock, makeDay, makeDayWith, makeFlatDay, makeRule } from './helpers.ts';

const DAY = '2026-01-15';
const SHORT_DAY = '2026-03-29';
const LONG_DAY = '2026-10-25';

describe('compare', () => {
  it.each([
    ['lt', 5, 7, true],
    ['lt', 7, 7, false],
    ['lte', 7, 7, true],
    ['gt', 31, 30, true],
    ['gt', 30, 30, false],
    ['gte', 30, 30, true],
  ] as const)('%s %d vs %d', (operator, value, threshold, expected) => {
    expect(compare(value, operator, threshold)).toBe(expected);
  });

  it('handles negative thresholds', () => {
    expect(compare(-1.2, 'lt', 0)).toBe(true);
    expect(compare(0, 'lt', 0)).toBe(false);
  });
});

describe('single-period matching', () => {
  it('matches a period at or below the threshold', () => {
    const day = makeDayWith(DAY, { 4: 6.5 }, 20);
    const matches = evaluateRule(makeRule({ operator: 'lte', thresholdPence: 7 }), day, DAY);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(1);
    expect(matches[0]?.durationMinutes).toBe(30);
    expect(londonClock(matches[0]?.startUtc as string)).toBe('02:00');
  });

  it('detects negative pricing', () => {
    const day = makeDayWith(DAY, { 3: -1.2, 4: -3.6 }, 12);
    const rule = makeRule({ name: 'Negative prices', operator: 'lt', thresholdPence: 0 });
    const matches = evaluateRule(rule, day, DAY);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(2);
    expect(matches[0]?.minPence).toBe(-3.6);
  });

  it('detects expensive periods with a >= rule', () => {
    const day = makeDayWith(DAY, { 35: 42 }, 20);
    const rule = makeRule({ name: 'Expensive', operator: 'gte', thresholdPence: 40 });
    expect(evaluateRule(rule, day, DAY)).toHaveLength(1);
  });

  it('returns nothing when no period qualifies', () => {
    expect(evaluateRule(makeRule({ thresholdPence: 7 }), makeFlatDay(DAY, 20), DAY)).toEqual([]);
  });

  it('never matches a disabled rule', () => {
    const day = makeDayWith(DAY, { 4: 1 }, 20);
    expect(evaluateRule(makeRule({ enabled: false }), day, DAY)).toEqual([]);
  });
});

describe('consecutive periods', () => {
  it('groups adjacent qualifying periods into one match', () => {
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5, 5: 5 }, 20);
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), day, DAY);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(4);
    expect(matches[0]?.durationMinutes).toBe(120);
  });

  it('reports separate stretches separately', () => {
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 20: 6, 21: 6 }, 20);
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), day, DAY);
    expect(matches).toHaveLength(2);
    expect(countMatchedPeriods(matches)).toBe(4);
  });

  it('requires a minimum duration of two hours', () => {
    // A 90-minute stretch is not enough for a 2-hour rule.
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5 }, 20);
    const rule = makeRule({ thresholdPence: 7, minimumDurationMinutes: 120 });
    expect(evaluateRule(rule, day, DAY)).toEqual([]);
  });

  it('matches exactly at the minimum duration', () => {
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5, 5: 5 }, 20);
    const rule = makeRule({ thresholdPence: 7, minimumDurationMinutes: 120 });
    const matches = evaluateRule(rule, day, DAY);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.durationMinutes).toBe(120);
  });

  it('returns the whole run when it exceeds the minimum', () => {
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5 }, 20);
    const rule = makeRule({ thresholdPence: 7, minimumDurationMinutes: 120 });
    const matches = evaluateRule(rule, day, DAY);
    expect(matches[0]?.periodCount).toBe(6);
    expect(matches[0]?.durationMinutes).toBe(180);
  });

  it('does not bridge a gap in the price data', () => {
    const day = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5, 5: 5 }, 20).filter((_, i) => i !== 4);
    const rule = makeRule({ thresholdPence: 7, minimumDurationMinutes: 120 });
    // Periods 2-3 and period 5 qualify, but the missing period 4 breaks the run.
    expect(evaluateRule(rule, day, DAY)).toEqual([]);
  });

  it('reports averages across the run', () => {
    const day = makeDayWith(DAY, { 2: 4, 3: 6 }, 20);
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), day, DAY);
    expect(matches[0]?.averagePence).toBe(5);
    expect(matches[0]?.minPence).toBe(4);
    expect(matches[0]?.maxPence).toBe(6);
  });
});

describe('withholding matches at the edge of incomplete data', () => {
  // A run touching the end of what has arrived will usually grow when the
  // rest of the day lands. Growing changes its dedupe key, which would mean a
  // second, near-identical notification about the same stretch.
  const day = makeDayWith(DAY, { 44: 5, 45: 5 }, 20);
  const partial = day.slice(0, 46);
  const coveredUntil = partial[45]?.validTo as string;

  it('withholds a match that ends exactly at the edge', () => {
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), partial, DAY, {
      settledUntil: coveredUntil,
    });
    expect(matches).toEqual([]);
  });

  it('still reports a match that ends before the edge', () => {
    const settled = makeDayWith(DAY, { 10: 5, 11: 5 }, 20).slice(0, 46);
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), settled, DAY, {
      settledUntil: settled[45]?.validTo as string,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(2);
  });

  it('reports the edge match once the day is complete', () => {
    // settledUntil of null is what the dispatcher passes for a complete day.
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), day, DAY, {
      settledUntil: null,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(2);
  });

  it('withholds nothing when no edge is given', () => {
    expect(evaluateRule(makeRule({ thresholdPence: 7 }), partial, DAY)).toHaveLength(1);
  });

  it('applies the edge rule across every rule in a set', () => {
    const cheap = makeRule({ id: 'cheap', thresholdPence: 7 });
    const dear = makeRule({ id: 'dear', operator: 'gte', thresholdPence: 20 });
    const matches = evaluateRules([cheap, dear], partial, DAY, {
      settledUntil: coveredUntil,
    });
    // The cheap run sits on the edge and is withheld; the expensive run ends
    // before it and is reported.
    expect(matches.map((m) => m.ruleId)).toEqual(['dear']);
  });
});

describe('time restrictions', () => {
  it('ignores qualifying periods outside the window', () => {
    // Period 4 is 02:00, period 30 is 15:00.
    const day = makeDayWith(DAY, { 4: 5, 30: 5 }, 20);
    const rule = makeRule({ thresholdPence: 7, timeStart: '00:00', timeEnd: '06:00' });
    const matches = evaluateRule(rule, day, DAY);
    expect(matches).toHaveLength(1);
    expect(londonClock(matches[0]?.startUtc as string)).toBe('02:00');
  });

  it('supports a window that crosses midnight', () => {
    // Period 1 is 00:30, period 46 is 23:00.
    const day = makeDayWith(DAY, { 1: 5, 24: 5, 46: 5 }, 20);
    const rule = makeRule({ thresholdPence: 7, timeStart: '22:00', timeEnd: '06:00' });
    const matches = evaluateRule(rule, day, DAY);
    const starts = matches.map((m) => londonClock(m.startUtc));
    expect(starts).toEqual(['00:30', '23:00']);
  });

  it('applies no restriction when times are null', () => {
    const day = makeDayWith(DAY, { 4: 5, 30: 5 }, 20);
    expect(evaluateRule(makeRule({ thresholdPence: 7 }), day, DAY)).toHaveLength(2);
  });
});

describe('daylight saving days', () => {
  it('evaluates a 46-period day', () => {
    const day = makeDayWith(SHORT_DAY, { 4: 5, 5: 5 }, 20);
    const matches = evaluateRule(makeRule({ thresholdPence: 7 }), day, SHORT_DAY);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(2);
  });

  it('evaluates a 50-period day, including the repeated hour', () => {
    // Periods 2-5 span the repeated 01:00-02:00 hour on the long day.
    const day = makeDayWith(LONG_DAY, { 2: 5, 3: 5, 4: 5, 5: 5 }, 20);
    const matches = evaluateRule(
      makeRule({ thresholdPence: 7, minimumDurationMinutes: 120 }),
      day,
      LONG_DAY,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.periodCount).toBe(4);
    expect(matches[0]?.durationMinutes).toBe(120);
  });
});

describe('evaluating several rules', () => {
  it('returns matches for each rule in order', () => {
    const day = makeDayWith(DAY, { 4: -2, 5: 6 }, 20);
    const negative = makeRule({ id: 'r-neg', name: 'Negative', operator: 'lt', thresholdPence: 0 });
    const cheap = makeRule({ id: 'r-cheap', name: 'Cheap', operator: 'lte', thresholdPence: 7 });
    const matches = evaluateRules([negative, cheap], day, DAY);
    expect(matches.map((m) => m.ruleId)).toEqual(['r-neg', 'r-cheap']);
    // The cheap rule spans both periods; the negative rule only the first.
    expect(matches[0]?.periodCount).toBe(1);
    expect(matches[1]?.periodCount).toBe(2);
  });

  it('skips disabled rules but keeps the others', () => {
    const day = makeDayWith(DAY, { 4: 1 }, 20);
    const off = makeRule({ id: 'off', enabled: false });
    const on = makeRule({ id: 'on' });
    expect(evaluateRules([off, on], day, DAY).map((m) => m.ruleId)).toEqual(['on']);
  });

  it('only considers the requested pricing day', () => {
    const periods = [...makeDayWith(DAY, { 4: 1 }, 20), ...makeDayWith('2026-01-16', { 4: 1 }, 20)];
    expect(evaluateRule(makeRule(), periods, DAY)).toHaveLength(1);
  });
});

describe('single period qualification', () => {
  it('checks price and time together', () => {
    const day = makeDay(DAY, [5]);
    const period = day[0];
    expect(period).toBeDefined();
    const rule = makeRule({ thresholdPence: 7, timeStart: '06:00', timeEnd: '22:00' });
    expect(periodQualifies(period as (typeof day)[number], rule)).toBe(false);
    expect(periodQualifies(period as (typeof day)[number], makeRule())).toBe(true);
  });
});

describe('formatting helpers', () => {
  it('formats prices', () => {
    expect(formatPence(7)).toBe('7p');
    expect(formatPence(7.15)).toBe('7.2p');
    expect(formatPence(-3.6)).toBe('-3.6p');
  });

  it('formats durations', () => {
    expect(formatDuration(30)).toBe('30 minutes');
    expect(formatDuration(60)).toBe('1 hour');
    expect(formatDuration(120)).toBe('2 hours');
    expect(formatDuration(90)).toBe('1.5 hours');
  });

  it('describes a simple rule', () => {
    expect(describeRule(makeRule({ operator: 'lte', thresholdPence: 7 }))).toBe('Price <= 7p');
  });

  it('describes a duration and time restricted rule', () => {
    const rule = makeRule({
      operator: 'lt',
      thresholdPence: 5,
      minimumDurationMinutes: 120,
      timeStart: '22:00',
      timeEnd: '06:00',
    });
    expect(describeRule(rule)).toBe('Price < 5p for at least 2 hours between 22:00 and 06:00');
  });
});
