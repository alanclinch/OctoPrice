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
  User,
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

export interface NewUser {
  name: string;
  isOwner?: boolean;
  /** SHA-256 hex of the access token. */
  tokenHash: string;
}

export interface NewForecastInput {
  source: string;
  /** Settlement period the observation is about, ISO 8601 UTC. */
  targetStart: string;
  /** The source's own publish time, or null when it does not provide one. */
  issuedAt: string | null;
  collectedAt: string;
  /** Source-shaped values, stored as JSON. */
  payload: Record<string, number | string>;
}

export interface PreparedForecastDay {
  tariffCode: string;
  date: string;
  issueCutoff: string;
  residualDemand: number[];
  baselinePrices: number[] | null;
  actualPrices: number[] | null;
  inputVintages: string[];
  preparedAt: string;
}

export interface NewForecastRun {
  model: string;
  tariffCode: string;
  targetDate: string;
  generatedAt: string;
  issueCutoff: string;
  periods: number[];
  inputVintages: string[];
}

export interface StoredForecastRun extends NewForecastRun {
  id: string;
}

export interface ForecastRunScore {
  scoredAt: string;
  maePence: number;
  cheapest3hRegret: number;
  within60Minutes: boolean;
}

export interface Store {
  // --- Users -------------------------------------------------------------

  /**
   * Resolves an access token hash to its user, or null.
   *
   * Callers pass a *hash*, never a raw token, so the plain value is confined
   * to the request that carried it.
   */
  findUserByTokenHash(tokenHash: string): StoreResult<User | null>;

  getUser(id: string): StoreResult<User | null>;
  listUsers(): StoreResult<User[]>;
  createUser(user: NewUser): StoreResult<User>;
  /** Replaces a user's token, invalidating any previous link. */
  setUserToken(id: string, tokenHash: string): StoreResult<void>;
  /** Records that an invite link has been opened, if it had not been. */
  markUserClaimed(id: string, at: Date): StoreResult<void>;
  recordUserSeen(id: string, at: Date): StoreResult<void>;
  /** Removes a user along with their rules, subscriptions and settings. */
  deleteUser(id: string): StoreResult<boolean>;

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
  /**
   * Settings for everyone who has any, used by the poller to work out which
   * distinct tariffs need fetching.
   */
  listAllSettings(): StoreResult<UserSettings[]>;
  updateSettings(userId: string, input: UserSettingsInput): StoreResult<UserSettings>;

  // --- Forecasting input archive -----------------------------------------

  /**
   * Appends collected observations. Insert-only by design: a later collection
   * of the same period is a new row, because the difference between the two
   * is the revision a back-test must not be allowed to see.
   */
  appendForecastInputs(rows: readonly NewForecastInput[]): StoreResult<number>;
  /** When a source was last collected, for staleness reporting. */
  lastForecastInputAt(source: string): StoreResult<string | null>;
  countForecastInputs(): StoreResult<number>;
  /**
   * Deletes observations about periods older than `before`. A free D1
   * database is capped at 500 MB, so the archive cannot grow indefinitely.
   */
  pruneForecastInputsBefore(before: Date): StoreResult<number>;

  // --- Forecast shadow evaluation ---------------------------------------

  upsertPreparedForecastDay(day: PreparedForecastDay): StoreResult<void>;
  listPreparedForecastDays(
    tariffCode: string,
    from: string,
    toExclusive: string,
  ): StoreResult<PreparedForecastDay[]>;
  /** Inserts one immutable issue vintage; false means it already existed. */
  insertForecastRun(run: NewForecastRun): StoreResult<boolean>;
  listUnscoredForecastRuns(beforeDate: string, limit: number): StoreResult<StoredForecastRun[]>;
  scoreForecastRun(id: string, score: ForecastRunScore): StoreResult<void>;
  countForecastRuns(): StoreResult<number>;

  // --- Worker state ------------------------------------------------------

  getState(key: string): StoreResult<string | null>;
  setState(key: string, value: string): StoreResult<void>;
  /** Atomically inserts a state key, returning false when it already exists. */
  setStateIfAbsent(key: string, value: string): StoreResult<boolean>;

  close(): StoreResult<void>;
}
