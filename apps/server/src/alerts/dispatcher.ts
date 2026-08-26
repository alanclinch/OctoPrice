/**
 * Turns a freshly retrieved pricing day into notifications.
 *
 * Two things go out, controlled independently in settings (DESIGN.md
 * section 6): the daily "prices are available" summary, and one notification
 * per matching stretch for each alert rule.
 *
 * Nothing here worries about duplicates - `NotificationService` refuses any
 * payload whose dedupe key has already been sent, so calling this twice for
 * the same day is harmless.
 */

import type { PricePeriod, PricingDate, RuleMatch } from '@octoprice/core';
import {
  buildDailyPricesNotification,
  buildRuleMatchNotification,
  evaluateRules,
  summariseDay,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { LOG_EVENTS, type Logger } from '../logger.ts';
import type { NotificationService } from '../notifications/service.ts';

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

  /** Evaluates rules for a pricing day and sends whatever is due. */
  async dispatchForDay(
    date: PricingDate,
    periods: readonly PricePeriod[],
  ): Promise<DispatchSummary> {
    const settings = this.store.getSettings(this.userId);
    const rules = this.store.listRules(this.userId);
    const matches = evaluateRules(rules, periods, date);
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
}
