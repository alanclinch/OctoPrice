/**
 * Notification delivery and duplicate prevention.
 *
 * The rule that matters here (DESIGN.md sections 20 and 21): the same
 * notification must never be sent twice, even if the worker polls repeatedly,
 * the server restarts mid-run, or Octopus republishes identical prices.
 *
 * Every payload carries a `dedupeKey` derived from stable facts. A key is
 * claimed only by a *successful* send, so a failure can still be retried
 * later.
 */

import type { NotificationPayload } from '@octoprice/core';
import { LOG_EVENTS, type Logger } from '../logger.ts';
import type { Store } from '../db/store.ts';
import type { DeliveryTarget, NotificationSender } from './provider.ts';

export interface NotificationServiceOptions {
  store: Store;
  senders: readonly NotificationSender[];
  logger: Logger;
  now?: () => Date;
}

export interface DeliverySummary {
  /** True when the message reached at least one device. */
  sent: boolean;
  /** True when it was suppressed because it had already been sent. */
  skipped: boolean;
  delivered: number;
  failed: number;
}

export class NotificationService {
  private readonly store: Store;
  private readonly senders: readonly NotificationSender[];
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(options: NotificationServiceOptions) {
    this.store = options.store;
    this.senders = options.senders;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Sends a notification to every enabled subscription for the user, unless
   * an identical one has already gone out.
   */
  async deliver(userId: string, payload: NotificationPayload): Promise<DeliverySummary> {
    if (this.store.hasSentNotification(payload.dedupeKey)) {
      this.logger.debug('Notification already sent, skipping', {
        event: LOG_EVENTS.notificationSkipped,
        type: payload.type,
        dedupeKey: payload.dedupeKey,
      });
      return { sent: false, skipped: true, delivered: 0, failed: 0 };
    }

    const subscriptions = this.store.listSubscriptions(userId);
    if (subscriptions.length === 0) {
      this.logger.warn('No notification subscriptions registered', {
        event: LOG_EVENTS.notificationFailed,
        type: payload.type,
        userId,
      });
      this.record(userId, payload, 'failed', 'No subscriptions registered');
      return { sent: false, skipped: false, delivered: 0, failed: 0 };
    }

    let delivered = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const sender of this.senders) {
      const targets: DeliveryTarget[] = subscriptions
        .filter((subscription) => subscription.provider === sender.provider)
        .map((subscription) => ({
          id: subscription.id,
          subscriptionData: subscription.subscriptionData,
        }));

      if (targets.length === 0) continue;

      const results = await sender.send(payload, targets);
      for (const result of results) {
        this.store.recordSubscriptionResult(result.targetId, result.success, this.now());
        if (result.success) {
          delivered += 1;
          continue;
        }

        failed += 1;
        if (result.error) errors.push(result.error);

        if (result.expired) {
          // The device is gone. Disable rather than retry forever.
          this.store.disableSubscription(result.targetId);
          this.logger.info('Disabled an expired push subscription', {
            event: LOG_EVENTS.subscriptionExpired,
            subscriptionId: result.targetId,
            provider: sender.provider,
          });
        } else {
          this.logger.warn('Notification delivery failed', {
            event: LOG_EVENTS.notificationFailed,
            provider: sender.provider,
            type: payload.type,
            error: result.error,
          });
        }
      }
    }

    const sent = delivered > 0;
    this.record(userId, payload, sent ? 'sent' : 'failed', sent ? null : errors.join('; ') || null);

    if (sent) {
      this.logger.info('Notification sent', {
        event: LOG_EVENTS.notificationSent,
        type: payload.type,
        title: payload.title,
        delivered,
        failed,
        dedupeKey: payload.dedupeKey,
      });
      if (payload.ruleId) {
        this.store.markRuleTriggered(payload.ruleId, this.now());
      }
    }

    return { sent, skipped: false, delivered, failed };
  }

  private record(
    userId: string,
    payload: NotificationPayload,
    status: 'sent' | 'failed',
    error: string | null,
  ): void {
    this.store.recordNotification(
      {
        userId,
        ruleId: payload.ruleId ?? null,
        type: payload.type,
        dedupeKey: payload.dedupeKey,
        title: payload.title,
        message: payload.body,
        status,
        error,
      },
      this.now(),
    );
  }
}
