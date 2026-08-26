/**
 * Web Push delivery.
 *
 * Each device registers its own subscription, so one user can be notified on
 * a phone, a tablet and a PC (DESIGN.md section 11). Subscriptions expire when
 * the browser revokes them or the app is uninstalled; the push service reports
 * that as 404 or 410, and those targets are disabled rather than retried.
 */

import webpush from 'web-push';
import type { NotificationPayload, NotificationProvider } from '@octoprice/core';
import type { VapidConfig } from '../config.ts';
import type { DeliveryResult, DeliveryTarget, NotificationSender } from './provider.ts';

/** Statuses meaning "this subscription is gone for good". */
const GONE_STATUS_CODES = new Set([404, 410]);

export class WebPushSender implements NotificationSender {
  readonly provider: NotificationProvider = 'webpush';
  readonly available: boolean;

  constructor(vapid: VapidConfig | null) {
    this.available = vapid !== null;
    if (vapid) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    }
  }

  async send(
    payload: NotificationPayload,
    targets: readonly DeliveryTarget[],
  ): Promise<DeliveryResult[]> {
    if (!this.available) {
      return targets.map((target) => ({
        targetId: target.id,
        success: false,
        error: 'Web push is not configured (missing VAPID keys)',
      }));
    }

    // The service worker reads these fields in its `push` handler.
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url,
      type: payload.type,
      dedupeKey: payload.dedupeKey,
    });

    return Promise.all(targets.map((target) => this.sendOne(target, body)));
  }

  private async sendOne(target: DeliveryTarget, body: string): Promise<DeliveryResult> {
    try {
      const subscription = JSON.parse(target.subscriptionData) as webpush.PushSubscription;
      await webpush.sendNotification(subscription, body, { TTL: 6 * 60 * 60 });
      return { targetId: target.id, success: true };
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : undefined;

      return {
        targetId: target.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        expired: statusCode !== undefined && GONE_STATUS_CODES.has(statusCode),
      };
    }
  }
}
