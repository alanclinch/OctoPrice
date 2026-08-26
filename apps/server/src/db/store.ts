/**
 * The data-access boundary.
 *
 * Everything the application needs from storage is expressed here, in domain
 * terms, with no SQL and nothing database-specific. SQLite backs it today;
 * PostgreSQL is the intended production option (DESIGN.md section 18) and
 * should only need a second implementation of this interface.
 */

import type {
  AlertRule,
  AlertRuleInput,
  NotificationLogEntry,
  NotificationProvider,
  NotificationSubscription,
  PricePeriod,
  StoredPricePeriod,
  UserSettings,
  UserSettingsInput,
} from '@octoprice/core';

/** Keys used with `getState` / `setState` for worker bookkeeping. */
export const STATE_KEYS = {
  lastCheckStartedAt: 'last_check_started_at',
  lastSuccessfulRetrievalAt: 'last_successful_retrieval_at',
  /** Pricing dates already retrieved in full, so polling can stop. */
  retrievedDatePrefix: 'retrieved_date:',
} as const;

export interface NewSubscription {
  userId: string;
  provider: NotificationProvider;
  subscriptionData: string;
}

export interface NotificationLogInput {
  userId: string;
  ruleId: string | null;
  type: NotificationLogEntry['type'];
  dedupeKey: string;
  title: string;
  message: string;
  status: NotificationLogEntry['status'];
  error?: string | null;
}

export interface Store {
  // --- Prices ------------------------------------------------------------

  /**
   * Inserts or updates price periods. Returns how many rows were written.
   * Re-storing identical data is harmless, which matters because the poller
   * may fetch overlapping windows.
   */
  upsertPrices(periods: readonly StoredPricePeriod[]): number;

  /** Prices for a tariff whose period starts within `[from, to)`. */
  getPrices(tariffCode: string, from: Date, to: Date): PricePeriod[];

  /** Total number of stored price rows, for the status page. */
  countPrices(): number;

  /** Deletes prices starting before `before`, returning the count removed. */
  prunePricesBefore(before: Date): number;

  // --- Alert rules -------------------------------------------------------

  listRules(userId: string): AlertRule[];
  getRule(id: string): AlertRule | null;
  createRule(userId: string, input: AlertRuleInput): AlertRule;
  updateRule(id: string, input: AlertRuleInput): AlertRule | null;
  deleteRule(id: string): boolean;
  markRuleTriggered(id: string, at: Date): void;

  // --- Notification subscriptions ---------------------------------------

  listSubscriptions(userId: string): NotificationSubscription[];
  addSubscription(subscription: NewSubscription): NotificationSubscription;
  /** Removes by provider-specific identity (a push endpoint). Idempotent. */
  removeSubscriptionByData(userId: string, subscriptionData: string): boolean;
  removeSubscription(id: string): boolean;
  recordSubscriptionResult(id: string, success: boolean, at: Date): void;
  disableSubscription(id: string): void;

  // --- Notification log and deduplication --------------------------------

  /** True when this exact notification has already been sent successfully. */
  hasSentNotification(dedupeKey: string): boolean;
  recordNotification(entry: NotificationLogInput, at: Date): NotificationLogEntry;
  listRecentNotifications(userId: string, limit: number): NotificationLogEntry[];
  lastNotificationAt(userId: string): string | null;

  // --- Settings ----------------------------------------------------------

  getSettings(userId: string): UserSettings;
  updateSettings(userId: string, input: UserSettingsInput): UserSettings;

  // --- Worker state ------------------------------------------------------

  getState(key: string): string | null;
  setState(key: string, value: string): void;

  close(): void;
}
