/**
 * SQLite implementation of `Store`, using Node's built-in `node:sqlite`.
 *
 * Chosen over `better-sqlite3` because it needs no native build step, which
 * matters on the Windows development machine. The trade-off is that it still
 * prints an experimental warning on Node 24.
 *
 * The API is synchronous. At this scale (a few thousand rows, one user) that
 * is simpler and faster than making every call await a pool.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AlertRule,
  AlertRuleInput,
  ComparisonOperator,
  NotificationLogEntry,
  NotificationProvider,
  NotificationSubscription,
  PricePeriod,
  StoredPricePeriod,
  UserSettings,
  UserSettingsInput,
} from '@octoprice/core';
import { FALLBACK_AGILE_PRODUCT_CODE } from '@octoprice/core';
import type { NewSubscription, NotificationLogInput, Store } from './store.ts';

/**
 * Schema migrations, applied in order. Never edit a migration that has
 * shipped; add another one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE prices (
    id            TEXT PRIMARY KEY,
    tariff_code   TEXT NOT NULL,
    region        TEXT NOT NULL,
    valid_from    TEXT NOT NULL,
    valid_to      TEXT NOT NULL,
    price_inc_vat REAL NOT NULL,
    price_exc_vat REAL NOT NULL,
    retrieved_at  TEXT NOT NULL,
    UNIQUE (tariff_code, valid_from)
  );
  CREATE INDEX idx_prices_tariff_from ON prices (tariff_code, valid_from);

  CREATE TABLE alert_rules (
    id                       TEXT PRIMARY KEY,
    user_id                  TEXT NOT NULL,
    name                     TEXT NOT NULL,
    enabled                  INTEGER NOT NULL DEFAULT 1,
    comparison_operator      TEXT NOT NULL,
    price_threshold          REAL NOT NULL,
    minimum_duration_minutes INTEGER NOT NULL DEFAULT 30,
    time_start               TEXT,
    time_end                 TEXT,
    notify                   INTEGER NOT NULL DEFAULT 1,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    last_triggered_at        TEXT
  );
  CREATE INDEX idx_rules_user ON alert_rules (user_id);

  CREATE TABLE notification_subscriptions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    provider          TEXT NOT NULL,
    subscription_data TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    last_success      TEXT,
    last_failure      TEXT,
    UNIQUE (user_id, subscription_data)
  );

  CREATE TABLE notification_log (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    rule_id    TEXT,
    type       TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status     TEXT NOT NULL,
    error      TEXT
  );
  CREATE INDEX idx_log_user_created ON notification_log (user_id, created_at);

  CREATE TABLE settings (
    user_id              TEXT PRIMARY KEY,
    region               TEXT NOT NULL,
    product_code         TEXT NOT NULL,
    notify_daily_prices  INTEGER NOT NULL DEFAULT 1,
    notify_rule_matches  INTEGER NOT NULL DEFAULT 1,
    hour12               INTEGER NOT NULL DEFAULT 0,
    theme                TEXT NOT NULL DEFAULT 'system',
    updated_at           TEXT NOT NULL
  );

  CREATE TABLE app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

const bool = (value: boolean): number => (value ? 1 : 0);
const fromBool = (value: unknown): boolean => value === 1 || value === true;

interface PriceRow {
  valid_from: string;
  valid_to: string;
  price_inc_vat: number;
  price_exc_vat: number;
}

interface RuleRow {
  id: string;
  user_id: string;
  name: string;
  enabled: number;
  comparison_operator: string;
  price_threshold: number;
  minimum_duration_minutes: number;
  time_start: string | null;
  time_end: string | null;
  notify: number;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  provider: string;
  subscription_data: string;
  enabled: number;
  created_at: string;
  last_success: string | null;
  last_failure: string | null;
}

interface LogRow {
  id: string;
  user_id: string;
  rule_id: string | null;
  type: string;
  dedupe_key: string;
  title: string;
  message: string;
  created_at: string;
  status: string;
  error: string | null;
}

interface SettingsRow {
  user_id: string;
  region: string;
  product_code: string;
  notify_daily_prices: number;
  notify_rule_matches: number;
  hour12: number;
  theme: string;
  updated_at: string;
}

export interface SqliteStoreOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  file: string;
  /** Region applied when settings are first created. */
  defaultRegion: string;
  defaultProductCode?: string;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly defaultRegion: string;
  private readonly defaultProductCode: string;

  constructor(options: SqliteStoreOptions) {
    if (options.file !== ':memory:') {
      mkdirSync(dirname(options.file), { recursive: true });
    }
    this.db = new DatabaseSync(options.file);
    this.defaultRegion = options.defaultRegion;
    this.defaultProductCode = options.defaultProductCode ?? FALLBACK_AGILE_PRODUCT_CODE;

    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  /** Applies any migrations the database has not seen yet. */
  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as
      { version: number } | undefined;
    let current = row?.version ?? 0;

    if (!row) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(0);
    }

    for (let index = current; index < MIGRATIONS.length; index += 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[index] as string);
        current = index + 1;
        this.db.prepare('UPDATE schema_version SET version = ?').run(current);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- Prices --------------------------------------------------------------

  upsertPrices(periods: readonly StoredPricePeriod[]): number {
    if (periods.length === 0) return 0;

    const statement = this.db.prepare(`
      INSERT INTO prices (id, tariff_code, region, valid_from, valid_to,
                          price_inc_vat, price_exc_vat, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tariff_code, valid_from) DO UPDATE SET
        valid_to      = excluded.valid_to,
        price_inc_vat = excluded.price_inc_vat,
        price_exc_vat = excluded.price_exc_vat,
        retrieved_at  = excluded.retrieved_at
    `);

    this.db.exec('BEGIN');
    try {
      for (const period of periods) {
        statement.run(
          randomUUID(),
          period.tariffCode,
          period.region,
          period.validFrom,
          period.validTo,
          period.valueIncVat,
          period.valueExcVat,
          period.retrievedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return periods.length;
  }

  getPrices(tariffCode: string, from: Date, to: Date): PricePeriod[] {
    const rows = this.db
      .prepare(
        `SELECT valid_from, valid_to, price_inc_vat, price_exc_vat
         FROM prices
         WHERE tariff_code = ? AND valid_from >= ? AND valid_from < ?
         ORDER BY valid_from ASC`,
      )
      .all(tariffCode, from.toISOString(), to.toISOString()) as unknown as PriceRow[];

    return rows.map((row) => ({
      validFrom: row.valid_from,
      validTo: row.valid_to,
      valueIncVat: row.price_inc_vat,
      valueExcVat: row.price_exc_vat,
    }));
  }

  countPrices(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM prices').get() as { n: number };
    return row.n;
  }

  prunePricesBefore(before: Date): number {
    const result = this.db
      .prepare('DELETE FROM prices WHERE valid_from < ?')
      .run(before.toISOString());
    return Number(result.changes);
  }

  // --- Alert rules ---------------------------------------------------------

  listRules(userId: string): AlertRule[] {
    const rows = this.db
      .prepare('SELECT * FROM alert_rules WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as unknown as RuleRow[];
    return rows.map(toAlertRule);
  }

  getRule(id: string): AlertRule | null {
    const row = this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as unknown as
      RuleRow | undefined;
    return row ? toAlertRule(row) : null;
  }

  createRule(userId: string, input: AlertRuleInput): AlertRule {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, user_id, name, enabled, comparison_operator,
                                  price_threshold, minimum_duration_minutes,
                                  time_start, time_end, notify, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        bool(input.enabled),
        input.operator,
        input.thresholdPence,
        input.minimumDurationMinutes,
        input.timeStart,
        input.timeEnd,
        bool(input.notify),
        now,
        now,
      );
    return this.getRule(id) as AlertRule;
  }

  updateRule(id: string, input: AlertRuleInput): AlertRule | null {
    const existing = this.getRule(id);
    if (!existing) return null;

    this.db
      .prepare(
        `UPDATE alert_rules
         SET name = ?, enabled = ?, comparison_operator = ?, price_threshold = ?,
             minimum_duration_minutes = ?, time_start = ?, time_end = ?,
             notify = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        bool(input.enabled),
        input.operator,
        input.thresholdPence,
        input.minimumDurationMinutes,
        input.timeStart,
        input.timeEnd,
        bool(input.notify),
        new Date().toISOString(),
        id,
      );
    return this.getRule(id);
  }

  deleteRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  markRuleTriggered(id: string, at: Date): void {
    this.db
      .prepare('UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?')
      .run(at.toISOString(), id);
  }

  // --- Notification subscriptions -----------------------------------------

  listSubscriptions(userId: string): NotificationSubscription[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_subscriptions WHERE user_id = ? AND enabled = 1')
      .all(userId) as unknown as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  addSubscription(subscription: NewSubscription): NotificationSubscription {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notification_subscriptions
           (id, user_id, provider, subscription_data, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (user_id, subscription_data) DO UPDATE SET enabled = 1`,
      )
      .run(id, subscription.userId, subscription.provider, subscription.subscriptionData, now);

    const row = this.db
      .prepare(
        'SELECT * FROM notification_subscriptions WHERE user_id = ? AND subscription_data = ?',
      )
      .get(subscription.userId, subscription.subscriptionData) as unknown as SubscriptionRow;
    return toSubscription(row);
  }

  removeSubscriptionByData(userId: string, subscriptionData: string): boolean {
    const result = this.db
      .prepare('DELETE FROM notification_subscriptions WHERE user_id = ? AND subscription_data = ?')
      .run(userId, subscriptionData);
    return Number(result.changes) > 0;
  }

  removeSubscription(id: string): boolean {
    const result = this.db.prepare('DELETE FROM notification_subscriptions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  recordSubscriptionResult(id: string, success: boolean, at: Date): void {
    const column = success ? 'last_success' : 'last_failure';
    this.db
      .prepare(`UPDATE notification_subscriptions SET ${column} = ? WHERE id = ?`)
      .run(at.toISOString(), id);
  }

  disableSubscription(id: string): void {
    this.db.prepare('UPDATE notification_subscriptions SET enabled = 0 WHERE id = ?').run(id);
  }

  // --- Notification log ----------------------------------------------------

  hasSentNotification(dedupeKey: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM notification_log WHERE dedupe_key = ? AND status = 'sent'")
      .get(dedupeKey) as { found: number } | undefined;
    return row !== undefined;
  }

  recordNotification(entry: NotificationLogInput, at: Date): NotificationLogEntry {
    const id = randomUUID();
    const createdAt = at.toISOString();
    // A failed attempt must not block a later retry, so only successes claim
    // the dedupe key; failures replace any previous failure for the same key.
    this.db
      .prepare(
        `INSERT INTO notification_log
           (id, user_id, rule_id, type, dedupe_key, title, message, created_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           status     = excluded.status,
           error      = excluded.error,
           created_at = excluded.created_at`,
      )
      .run(
        id,
        entry.userId,
        entry.ruleId,
        entry.type,
        entry.dedupeKey,
        entry.title,
        entry.message,
        createdAt,
        entry.status,
        entry.error ?? null,
      );

    const row = this.db
      .prepare('SELECT * FROM notification_log WHERE dedupe_key = ?')
      .get(entry.dedupeKey) as unknown as LogRow;
    return toLogEntry(row);
  }

  listRecentNotifications(userId: string, limit: number): NotificationLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as unknown as LogRow[];
    return rows.map(toLogEntry);
  }

  lastNotificationAt(userId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT created_at FROM notification_log WHERE user_id = ? AND status = 'sent' ORDER BY created_at DESC LIMIT 1",
      )
      .get(userId) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  // --- Settings ------------------------------------------------------------

  getSettings(userId: string): UserSettings {
    const row = this.db
      .prepare('SELECT * FROM settings WHERE user_id = ?')
      .get(userId) as unknown as SettingsRow | undefined;
    if (row) return toSettings(row);

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO settings (user_id, region, product_code, notify_daily_prices,
                               notify_rule_matches, hour12, theme, updated_at)
         VALUES (?, ?, ?, 1, 1, 0, 'system', ?)`,
      )
      .run(userId, this.defaultRegion, this.defaultProductCode, now);
    return this.getSettings(userId);
  }

  updateSettings(userId: string, input: UserSettingsInput): UserSettings {
    const current = this.getSettings(userId);
    const merged: UserSettings = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE settings
         SET region = ?, product_code = ?, notify_daily_prices = ?,
             notify_rule_matches = ?, hour12 = ?, theme = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        merged.region,
        merged.productCode,
        bool(merged.notifyDailyPrices),
        bool(merged.notifyRuleMatches),
        bool(merged.hour12),
        merged.theme,
        merged.updatedAt,
        userId,
      );
    return this.getSettings(userId);
  }

  // --- Worker state --------------------------------------------------------

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function toAlertRule(row: RuleRow): AlertRule {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    enabled: fromBool(row.enabled),
    operator: row.comparison_operator as ComparisonOperator,
    thresholdPence: row.price_threshold,
    minimumDurationMinutes: row.minimum_duration_minutes,
    timeStart: row.time_start,
    timeEnd: row.time_end,
    notify: fromBool(row.notify),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTriggeredAt: row.last_triggered_at,
  };
}

function toSubscription(row: SubscriptionRow): NotificationSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as NotificationProvider,
    subscriptionData: row.subscription_data,
    enabled: fromBool(row.enabled),
    createdAt: row.created_at,
    lastSuccess: row.last_success,
    lastFailure: row.last_failure,
  };
}

function toLogEntry(row: LogRow): NotificationLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    ruleId: row.rule_id,
    type: row.type as NotificationLogEntry['type'],
    dedupeKey: row.dedupe_key,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    status: row.status as NotificationLogEntry['status'],
    error: row.error,
  };
}

function toSettings(row: SettingsRow): UserSettings {
  return {
    userId: row.user_id,
    region: row.region,
    productCode: row.product_code,
    notifyDailyPrices: fromBool(row.notify_daily_prices),
    notifyRuleMatches: fromBool(row.notify_rule_matches),
    hour12: fromBool(row.hour12),
    theme: row.theme as UserSettings['theme'],
    updatedAt: row.updated_at,
  };
}
