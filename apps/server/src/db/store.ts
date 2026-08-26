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

/** SQLite returns immediately; remote stores such as D1 resolve asynchronously. */
export type StoreResult<T> = T | Promise<T>;

export interface Store {
  // --- Prices ------------------------------------------------------------

  /**
   * Inserts or updates price periods. Returns how many rows were written.
   * Re-storing identical data is harmless, which matters because the poller
   * may fetch overlapping windows.
   */
  upsertPrices(periods: readonly StoredPricePeriod[]): StoreResult<number>;

  /** Prices for a tariff whose period starts within `[from, to)`. */
  getPrices(tariffCode: string, from: Date, to: Date): StoreResult<PricePeriod[]>;

  /** Total number of stored price rows, for the status page. */
  countPrices(): StoreResult<number>;

  /** Deletes prices starting before `before`, returning the count removed. */
  prunePricesBefore(before: Date): StoreResult<number>;

  // --- Alert rules -------------------------------------------------------

  listRules(userId: string): StoreResult<AlertRule[]>;
  getRule(id: string): StoreResult<AlertRule | null>;
  createRule(userId: string, input: AlertRuleInput): StoreResult<AlertRule>;
  updateRule(id: string, input: AlertRuleInput): StoreResult<AlertRule | null>;
  deleteRule(id: string): StoreResult<boolean>;
  markRuleTriggered(id: string, at: Date): StoreResult<void>;

  // --- Notification subscriptions ---------------------------------------

  listSubscriptions(userId: string): StoreResult<NotificationSubscription[]>;
  addSubscription(subscription: NewSubscription): StoreResult<NotificationSubscription>;
  /** Removes by provider-specific identity (a push endpoint). Idempotent. */
  removeSubscriptionByData(userId: string, subscriptionData: string): StoreResult<boolean>;
  removeSubscription(id: string): StoreResult<boolean>;
  recordSubscriptionResult(id: string, success: boolean, at: Date): StoreResult<void>;
  disableSubscription(id: string): StoreResult<void>;

  // --- Notification log and deduplication --------------------------------

  /** True when this exact notification has already been sent successfully. */
  hasSentNotification(dedupeKey: string): StoreResult<boolean>;
  recordNotification(entry: NotificationLogInput, at: Date): StoreResult<NotificationLogEntry>;
  listRecentNotifications(userId: string, limit: number): StoreResult<NotificationLogEntry[]>;
  lastNotificationAt(userId: string): StoreResult<string | null>;

  // --- Settings ----------------------------------------------------------

  getSettings(userId: string): StoreResult<UserSettings>;
  updateSettings(userId: string, input: UserSettingsInput): StoreResult<UserSettings>;

  // --- Worker state ------------------------------------------------------

  getState(key: string): StoreResult<string | null>;
  setState(key: string, value: string): StoreResult<void>;

  close(): StoreResult<void>;
}
