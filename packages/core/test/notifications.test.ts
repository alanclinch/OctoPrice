import { describe, expect, it } from 'vitest';
import {
  buildDailyPricesNotification,
  buildRuleMatchNotification,
  buildTestNotification,
  dailyPricesDedupeKey,
  ruleMatchDedupeKey,
} from '../src/notifications.ts';
import { evaluateRule } from '../src/rules.ts';
import { summariseDay } from '../src/prices.ts';
import { makeDayWith, makeRule } from './helpers.ts';
import type { DaySummary, RuleMatch } from '../src/types.ts';

const DAY = '2026-01-15';
const USER = 'default';

function summaryFor(day: ReturnType<typeof makeDayWith>): DaySummary {
  const summary = summariseDay(day, DAY);
  if (!summary) throw new Error('expected a summary');
  return summary;
}

describe('daily price notification', () => {
  const day = makeDayWith(DAY, { 5: 3.2, 35: 31.4 }, 16.8);
  const rule = makeRule({ id: 'cheap', name: 'Cheap electricity', thresholdPence: 7 });
  const matches = evaluateRule(rule, day, DAY);

  it('leads with the pricing date', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(day),
      matches,
      rules: [rule],
    });
    expect(payload.title).toContain(DAY);
    expect(payload.type).toBe('daily_prices');
  });

  it('reports cheapest, dearest and average with their times', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(day),
      matches,
      rules: [rule],
    });
    expect(payload.body).toContain('Cheapest: 3.2p/kWh at 02:30');
    expect(payload.body).toContain('Most expensive: 31.4p/kWh at 17:30');
    expect(payload.body).toContain('Average: 16.8p/kWh');
  });

  it('counts the periods matching an alert', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(day),
      matches,
      rules: [rule],
    });
    expect(payload.body).toContain('1 period match Cheap electricity');
  });

  it('mentions negative pricing when it occurs', () => {
    const negativeDay = makeDayWith(DAY, { 3: -1.2, 4: -3.6 }, 12);
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(negativeDay),
      matches: [],
      rules: [],
    });
    expect(payload.body).toContain('2 periods are negative');
  });

  it('omits the alert line when nothing matched', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(makeDayWith(DAY, {}, 20)),
      matches: [],
      rules: [rule],
    });
    expect(payload.body).not.toContain('match');
  });

  it('deep-links to the pricing day', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(day),
      matches,
      rules: [rule],
    });
    expect(payload.url).toBe(`/?date=${DAY}`);
  });

  it('honours the 12-hour display preference', () => {
    const payload = buildDailyPricesNotification({
      userId: USER,
      summary: summaryFor(day),
      matches,
      rules: [rule],
      timeFormat: { hour12: true },
    });
    expect(payload.body).toContain('at 2:30 am');
  });
});

describe('rule match notification', () => {
  const day = makeDayWith(DAY, { 2: 4, 3: 6, 4: 5, 5: 5 }, 20);
  const rule = makeRule({
    id: 'two-hours',
    name: 'Two cheap hours',
    thresholdPence: 7,
    minimumDurationMinutes: 120,
  });
  const match = evaluateRule(rule, day, DAY)[0] as RuleMatch;

  it('titles the notification with the rule name', () => {
    const payload = buildRuleMatchNotification({ userId: USER, rule, match });
    expect(payload.title).toBe('Two cheap hours');
    expect(payload.ruleId).toBe('two-hours');
  });

  it('describes the window, the average and the rule', () => {
    const payload = buildRuleMatchNotification({ userId: USER, rule, match });
    expect(payload.body).toContain('01:00 to 03:00 (2 hours)');
    expect(payload.body).toContain('Average 5p/kWh');
    expect(payload.body).toContain('low of 4p/kWh');
    expect(payload.body).toContain('Price <= 7p for at least 2 hours');
  });
});

describe('deduplication keys', () => {
  const day = makeDayWith(DAY, { 2: 5, 3: 5 }, 20);
  const rule = makeRule({ id: 'cheap' });
  const match = evaluateRule(rule, day, DAY)[0] as RuleMatch;

  it('is stable for the same daily notification', () => {
    expect(dailyPricesDedupeKey(USER, DAY)).toBe(dailyPricesDedupeKey(USER, DAY));
    expect(dailyPricesDedupeKey(USER, DAY)).not.toBe(dailyPricesDedupeKey(USER, '2026-01-16'));
  });

  it('is stable for an unchanged rule match', () => {
    const again = evaluateRule(rule, day, DAY)[0] as RuleMatch;
    expect(ruleMatchDedupeKey(USER, match)).toBe(ruleMatchDedupeKey(USER, again));
  });

  it('differs per user', () => {
    expect(ruleMatchDedupeKey('a', match)).not.toBe(ruleMatchDedupeKey('b', match));
  });

  it('changes when a corrected price lengthens the matched run', () => {
    const longer = makeDayWith(DAY, { 2: 5, 3: 5, 4: 5 }, 20);
    const longerMatch = evaluateRule(rule, longer, DAY)[0] as RuleMatch;
    expect(ruleMatchDedupeKey(USER, longerMatch)).not.toBe(ruleMatchDedupeKey(USER, match));
  });

  it('does not change when an unrelated period changes', () => {
    const other = makeDayWith(DAY, { 2: 5, 3: 5, 40: 55 }, 20);
    const otherMatch = evaluateRule(rule, other, DAY)[0] as RuleMatch;
    expect(ruleMatchDedupeKey(USER, otherMatch)).toBe(ruleMatchDedupeKey(USER, match));
  });

  it('gives every test notification a fresh key', () => {
    const first = buildTestNotification(USER, new Date('2026-01-15T10:00:00Z'));
    const second = buildTestNotification(USER, new Date('2026-01-15T10:00:01Z'));
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    expect(first.type).toBe('test');
  });
});
