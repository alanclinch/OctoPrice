/**
 * The notification transport boundary.
 *
 * Web push is the only implementation today. Telegram, ntfy, email and the
 * rest (DESIGN.md section 11) should be added as further implementations of
 * this interface, so the price-monitoring engine never learns about them.
 */

import type { NotificationPayload, NotificationProvider } from '@octoprice/core';

/** One destination for a message: a device, chat or address. */
export interface DeliveryTarget {
  /** The subscription row id, used to record success or failure. */
  id: string;
  /** Provider-specific payload. Secret; never log it. */
  subscriptionData: string;
}

export interface DeliveryResult {
  targetId: string;
  success: boolean;
  error?: string;
  /**
   * True when the target is permanently gone (an uninstalled PWA, a revoked
   * push subscription). The caller disables it rather than retrying forever.
   */
  expired?: boolean;
}

export interface NotificationSender {
  readonly provider: NotificationProvider;
  /** False when the transport is not configured, e.g. no VAPID keys. */
  readonly available: boolean;
  send(payload: NotificationPayload, targets: readonly DeliveryTarget[]): Promise<DeliveryResult[]>;
}
