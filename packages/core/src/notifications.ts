/**
 * Notification content and idempotency keys.
 *
 * Message text lives here rather than in the server so that it is unit
 * testable and so the wording stays identical across every future transport
 * (web push, Telegram, ntfy and so on).
 *
 * Every notification carries a `dedupeKey`. The key is derived only from
 * stable facts - who, which rule, which pricing day, which periods - so the
 * worker can check "have I already sent this?" and stay idempotent across
 * repeated polls and server restarts.
 */

import type { AlertRule, DaySummary, NotificationPayload, RuleMatch } from './types.ts';
import { describeRule, formatDuration, formatPence } from './rules.ts';
import { formatLondonTime, type PricingDate, type TimeFormatOptions } from './time.ts';

/** Key for the "next day prices are published" notification. */
export function dailyPricesDedupeKey(userId: string, date: PricingDate): string {
  return `${userId}:daily_prices:${date}`;
}

/**
 * Key for a rule match.
 *
 * The matched run start and length are part of the key so that a genuine
 * change in the data (Octopus republishing a corrected price that lengthens a
 * cheap window) is treated as new, while a repeated poll over identical data
 * is not.
 */
export function ruleMatchDedupeKey(userId: string, match: RuleMatch): string {
  return `${userId}:rule:${match.ruleId}:${match.pricingDate}:${match.startUtc}:${match.periodCount}`;
}

/** Builds the daily "prices are available" notification. */
export function buildDailyPricesNotification(options: {
  userId: string;
  summary: DaySummary;
  matches: readonly RuleMatch[];
  rules: readonly AlertRule[];
  timeFormat?: TimeFormatOptions;
}): NotificationPayload {
  const { summary, matches, rules, timeFormat } = options;
  const cheapestAt = formatLondonTime(new Date(summary.cheapest.validFrom), timeFormat);
  const dearestAt = formatLondonTime(new Date(summary.mostExpensive.validFrom), timeFormat);

  const lines = [
    `Cheapest: ${formatPence(summary.minPence)}/kWh at ${cheapestAt}`,
    `Most expensive: ${formatPence(summary.maxPence)}/kWh at ${dearestAt}`,
    `Average: ${formatPence(summary.averagePence)}/kWh`,
  ];

  if (summary.negativeCount > 0) {
    lines.push(
      `${summary.negativeCount} ${summary.negativeCount === 1 ? 'period is' : 'periods are'} negative`,
    );
  }

  const alertLine = summariseMatches(matches, rules);
  if (alertLine) lines.push(alertLine);

  return {
    type: 'daily_prices',
    dedupeKey: dailyPricesDedupeKey(options.userId, summary.date),
    title: `Octopus Agile prices for ${summary.date} are available`,
    body: lines.join('\n'),
    url: `/?date=${summary.date}`,
    ruleId: null,
  };
}

/**
 * One line summarising rule matches, e.g. `6 periods below your 7p alert`,
 * or null when nothing matched.
 */
function summariseMatches(
  matches: readonly RuleMatch[],
  rules: readonly AlertRule[],
): string | null {
  if (matches.length === 0) return null;

  const byRule = new Map<string, RuleMatch[]>();
  for (const match of matches) {
    const existing = byRule.get(match.ruleId);
    if (existing) existing.push(match);
    else byRule.set(match.ruleId, [match]);
  }

  const parts: string[] = [];
  for (const [ruleId, ruleMatches] of byRule) {
    const rule = rules.find((r) => r.id === ruleId);
    const periodCount = ruleMatches.reduce((sum, m) => sum + m.periodCount, 0);
    const name = rule?.name ?? ruleMatches[0]?.ruleName ?? 'your alert';
    parts.push(`${periodCount} ${periodCount === 1 ? 'period' : 'periods'} match ${name}`);
  }
  return parts.join('; ');
}

/** Builds the notification for a single rule match. */
export function buildRuleMatchNotification(options: {
  userId: string;
  rule: AlertRule;
  match: RuleMatch;
  timeFormat?: TimeFormatOptions;
}): NotificationPayload {
  const { rule, match, timeFormat } = options;
  const from = formatLondonTime(new Date(match.startUtc), timeFormat);
  const to = formatLondonTime(new Date(match.endUtc), timeFormat);

  const body = [
    `${from} to ${to} (${formatDuration(match.durationMinutes)})`,
    `Average ${formatPence(match.averagePence)}/kWh, low of ${formatPence(match.minPence)}/kWh`,
    describeRule(rule),
  ].join('\n');

  return {
    type: 'rule_match',
    dedupeKey: ruleMatchDedupeKey(options.userId, match),
    title: rule.name,
    body,
    url: `/?date=${match.pricingDate}`,
    ruleId: rule.id,
  };
}

/**
 * Key for a "starting soon" alert.
 *
 * Unlike a rule match, the run length is deliberately *not* part of the key.
 * A stretch is announced once as it begins; if later data extends it, that is
 * not a reason to interrupt someone a second time about the same stretch.
 */
export function upcomingMatchDedupeKey(userId: string, match: RuleMatch): string {
  return `${userId}:upcoming:${match.ruleId}:${match.pricingDate}:${match.startUtc}`;
}

/**
 * Builds the alert sent shortly before a matching stretch begins.
 *
 * The daily and rule-match notifications are advance notice, sent when prices
 * are published. This is the one that arrives in time to actually do
 * something: put the washing on, start the car charging.
 */
export function buildUpcomingMatchNotification(options: {
  userId: string;
  rule: AlertRule;
  match: RuleMatch;
  now: Date;
  timeFormat?: TimeFormatOptions;
}): NotificationPayload {
  const { rule, match, now, timeFormat } = options;
  const from = formatLondonTime(new Date(match.startUtc), timeFormat);
  const to = formatLondonTime(new Date(match.endUtc), timeFormat);
  const minutesAway = Math.round((Date.parse(match.startUtc) - now.getTime()) / 60000);

  const lead =
    minutesAway <= 0
      ? 'Starting now'
      : `Starting in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`;

  const body = [
    `${lead}: ${from} to ${to} (${formatDuration(match.durationMinutes)})`,
    `Average ${formatPence(match.averagePence)}/kWh, low of ${formatPence(match.minPence)}/kWh`,
  ].join('\n');

  return {
    type: 'rule_upcoming',
    dedupeKey: upcomingMatchDedupeKey(options.userId, match),
    title: rule.name,
    body,
    url: `/?date=${match.pricingDate}`,
    ruleId: rule.id,
  };
}

/** Builds the notification sent by the "test notification" button. */
export function buildTestNotification(userId: string, now: Date): NotificationPayload {
  return {
    type: 'test',
    dedupeKey: `${userId}:test:${now.toISOString()}`,
    title: 'OctoPrice test notification',
    body: 'Notifications are working on this device.',
    url: '/settings',
    ruleId: null,
  };
}
