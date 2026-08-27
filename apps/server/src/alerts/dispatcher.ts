/**
 * Turns pricing data into notifications.
 *
 * Three things go out. Two are advance notice, sent when prices are published
 * and controlled independently in settings (DESIGN.md section 6): the daily
 * "prices are available" summary, and one notification per matching stretch
 * for each alert rule. The third is the "starting soon" alert, which arrives
 * shortly before a matching stretch actually begins.
 *
 * Nothing here worries about duplicates - `NotificationService` refuses any
 * payload whose dedupe key has already been sent, so calling any of this
 * repeatedly is harmless. That is what makes it safe to re-evaluate a day
 * every time more of it arrives.
 */

import type { AlertRule, PricePeriod, PricingDate, RuleMatch } from '@octoprice/core';
import {
  addDays,
  buildDailyPricesNotification,
  buildRuleMatchNotification,
  buildUpcomingMatchNotification,
  describeDayCoverage,
  evaluateRules,
  londonDateOf,
  summariseDay,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { LOG_EVENTS, type Logger } from '../logger.ts';
import type { NotificationService } from '../notifications/service.ts';

/**
 * How far ahead a "starting soon" alert is sent. Long enough to act on -
 * to start an appliance or plug the car in - without being so early that it
 * is forgotten by the time the cheap period arrives.
 */
export const UPCOMING_LEAD_MINUTES = 15;

export interface DispatchSummary {
  matches: RuleMatch[];
  dailySent: boolean;
  ruleNotificationsSent: number;
}

export interface AlertDispatcherOptions {
  store: Store;
  notifications: NotificationService;
  logger: Logger;
  userId: string;
}

export class AlertDispatcher {
  private readonly store: Store;
  private readonly notifications: NotificationService;
  private readonly logger: Logger;
  private readonly userId: string;

  constructor(options: AlertDispatcherOptions) {
    this.store = options.store;
    this.notifications = options.notifications;
    this.logger = options.logger;
    this.userId = options.userId;
  }

  /**
   * Evaluates rules for a pricing day and sends whatever is due.
   *
   * A day does not have to be complete. Octopus publishes most of a day and
   * delivers the last period or two later, so waiting for completeness means
   * never notifying at all. Matches sitting on the edge of incomplete data are
   * withheld instead, because they may still grow.
   */
  async dispatchForDay(
    date: PricingDate,
    periods: readonly PricePeriod[],
  ): Promise<DispatchSummary> {
    const settings = await this.store.getSettings(this.userId);
    const rules = await this.store.listRules(this.userId);
    const coverage = describeDayCoverage(periods, date);
    const matches = evaluateRules(rules, periods, date, {
      settledUntil: coverage.complete ? null : coverage.coveredUntil,
    });
    const timeFormat = { hour12: settings.hour12 };

    for (const match of matches) {
      this.logger.info('Alert rule matched', {
        event: LOG_EVENTS.ruleMatch,
        ruleId: match.ruleId,
        ruleName: match.ruleName,
        date,
        startUtc: match.startUtc,
        periods: match.periodCount,
        averagePence: match.averagePence,
      });
    }

    let dailySent = false;
    const summary = summariseDay(periods, date);
    if (settings.notifyDailyPrices && summary) {
      const result = await this.notifications.deliver(
        this.userId,
        buildDailyPricesNotification({
          userId: this.userId,
          summary,
          matches,
          rules,
          timeFormat,
        }),
      );
      dailySent = result.sent;
    }

    let ruleNotificationsSent = 0;
    if (settings.notifyRuleMatches) {
      for (const match of matches) {
        const rule = rules.find((candidate) => candidate.id === match.ruleId);
        if (!rule || !rule.notify) continue;

        const result = await this.notifications.deliver(
          this.userId,
          buildRuleMatchNotification({ userId: this.userId, rule, match, timeFormat }),
        );
        if (result.sent) ruleNotificationsSent += 1;
      }
    }

    return { matches, dailySent, ruleNotificationsSent };
  }

  /**
   * Sends "starting soon" alerts for matching stretches about to begin.
   *
   * Run frequently and cheaply: it reads stored prices only, never Octopus.
   * Today and tomorrow are both evaluated so that a stretch beginning just
   * after midnight is still announced before it starts.
   *
   * Only stretches that have not yet started are announced. Something already
   * under way is not news, and announcing it after the fact would be worse
   * than silence.
   */
  async dispatchUpcoming(
    now: Date,
    lookupPeriods: (date: PricingDate) => Promise<PricePeriod[]> | PricePeriod[],
    leadMinutes = UPCOMING_LEAD_MINUTES,
  ): Promise<number> {
    const settings = await this.store.getSettings(this.userId);
    if (!settings.notifyRuleMatches) return 0;

    const rules = await this.store.listRules(this.userId);
    if (rules.length === 0) return 0;

    const timeFormat = { hour12: settings.hour12 };
    const windowEnd = now.getTime() + leadMinutes * 60_000;
    const today = londonDateOf(now);

    let sent = 0;
    for (const date of [today, addDays(today, 1)]) {
      const periods = await lookupPeriods(date);
      if (periods.length === 0) continue;

      // A run at the edge of incomplete data may still grow, but its *start*
      // is already known and is all this alert depends on, so nothing is
      // withheld here.
      const matches = evaluateRules(rules, periods, date);

      for (const match of matches) {
        const startsAt = Date.parse(match.startUtc);
        if (startsAt <= now.getTime() || startsAt > windowEnd) continue;

        const rule = rules.find((candidate: AlertRule) => candidate.id === match.ruleId);
        if (!rule || !rule.notify) continue;

        const result = await this.notifications.deliver(
          this.userId,
          buildUpcomingMatchNotification({ userId: this.userId, rule, match, now, timeFormat }),
        );
        if (result.sent) {
          sent += 1;
          this.logger.info('Sent a starting-soon alert', {
            event: LOG_EVENTS.ruleMatch,
            ruleId: rule.id,
            ruleName: rule.name,
            date,
            startUtc: match.startUtc,
            minutesAway: Math.round((startsAt - now.getTime()) / 60_000),
          });
        }
      }
    }

    return sent;
  }
}
