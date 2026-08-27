/**
 * The alert rule engine.
 *
 * A rule describes a price condition ("at or below 7p"), optionally restricted
 * to a time of day, and optionally requiring the condition to hold for a
 * minimum unbroken duration ("for at least 2 hours").
 *
 * Evaluation returns *maximal runs* of consecutive qualifying periods rather
 * than individual periods, so a three-hour cheap stretch is one match, not six.
 * Everything is deliberately generic: negative pricing, cheap pricing and
 * expensive-price warnings are all the same code path with different values.
 */

import type { AlertRule, ComparisonOperator, PricePeriod, RuleMatch } from './types.ts';
import { OPERATOR_SYMBOLS } from './types.ts';
import { buildRun, periodsForLondonDay, splitIntoContiguousRuns } from './prices.ts';
import {
  isWithinClockWindow,
  londonMinutesOfDay,
  parseClockTime,
  type PricingDate,
} from './time.ts';

/** Applies a comparison operator. */
export function compare(value: number, operator: ComparisonOperator, threshold: number): boolean {
  switch (operator) {
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
  }
}

/** True when a period falls inside a rule optional time restriction. */
export function isWithinRuleWindow(period: PricePeriod, rule: AlertRule): boolean {
  if (rule.timeStart === null || rule.timeEnd === null) return true;
  const minutes = londonMinutesOfDay(new Date(period.validFrom));
  return isWithinClockWindow(minutes, parseClockTime(rule.timeStart), parseClockTime(rule.timeEnd));
}

/** True when a single period satisfies both the price and time conditions. */
export function periodQualifies(period: PricePeriod, rule: AlertRule): boolean {
  return (
    compare(period.valueIncVat, rule.operator, rule.thresholdPence) &&
    isWithinRuleWindow(period, rule)
  );
}

export interface RuleEvaluationOptions {
  /**
   * Exclusive end of the price data that has settled, ISO 8601 UTC.
   *
   * A matching run ending exactly here is sitting on the edge of incomplete
   * data and will probably grow when the rest of the day arrives. Growing
   * changes its dedupe key, which would produce a second, near-identical
   * notification — so such a run is withheld until the day is complete.
   *
   * Null or undefined means every match is settled.
   */
  settledUntil?: string | null;
}

/**
 * Evaluates one rule against one pricing day.
 *
 * Returns every maximal run of consecutive qualifying periods that is at least
 * `minimumDurationMinutes` long. Disabled rules never match.
 */
export function evaluateRule(
  rule: AlertRule,
  periods: readonly PricePeriod[],
  date: PricingDate,
  options: RuleEvaluationOptions = {},
): RuleMatch[] {
  if (!rule.enabled) return [];

  const dayPeriods = periodsForLondonDay(periods, date);
  const qualifying = dayPeriods.filter((period) => periodQualifies(period, rule));
  if (qualifying.length === 0) return [];

  const minimumDuration = Math.max(30, rule.minimumDurationMinutes);
  const settledUntil = options.settledUntil ?? null;

  return splitIntoContiguousRuns(qualifying)
    .map((run) => buildRun(run))
    .filter((run) => run.durationMinutes >= minimumDuration)
    .filter((run) => settledUntil === null || run.endUtc !== settledUntil)
    .map((run) => ({
      ...run,
      ruleId: rule.id,
      ruleName: rule.name,
      pricingDate: date,
    }));
}

/** Evaluates every rule against a pricing day, in rule order. */
export function evaluateRules(
  rules: readonly AlertRule[],
  periods: readonly PricePeriod[],
  date: PricingDate,
  options: RuleEvaluationOptions = {},
): RuleMatch[] {
  return rules.flatMap((rule) => evaluateRule(rule, periods, date, options));
}

/** Formats a price for display, e.g. `7p`, `7.5p`, `-3.6p`. */
export function formatPence(value: number, decimals = 1): string {
  const rounded = Number(value.toFixed(decimals));
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(decimals)}p`;
}

/** Formats a duration in minutes as `30 minutes`, `2 hours`, `2.5 hours`. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${label} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * A human-readable description of a rule, used in the UI and in
 * notification text, e.g.
 * `Price <= 7p for at least 2 hours between 22:00 and 06:00`.
 */
export function describeRule(rule: AlertRule): string {
  const parts = [`Price ${OPERATOR_SYMBOLS[rule.operator]} ${formatPence(rule.thresholdPence)}`];
  if (rule.minimumDurationMinutes > 30) {
    parts.push(`for at least ${formatDuration(rule.minimumDurationMinutes)}`);
  }
  if (rule.timeStart !== null && rule.timeEnd !== null) {
    parts.push(`between ${rule.timeStart} and ${rule.timeEnd}`);
  }
  return parts.join(' ');
}

/** Total number of half-hour periods covered by a set of matches. */
export function countMatchedPeriods(matches: readonly RuleMatch[]): number {
  return matches.reduce((sum, match) => sum + match.periodCount, 0);
}
