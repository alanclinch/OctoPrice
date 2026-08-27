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
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  User,
  UserSettings,
  UserSettingsInput,
} from '@octoprice/core';
import { FALLBACK_AGILE_PRODUCT_CODE } from '@octoprice/core';
import type {
  NewForecastInput,
  NewSubscription,
  NewUser,
  NotificationLogInput,
  Store,
} from './store.ts';

/**
 * Schema migrations, read from the same `migrations/*.sql` files that
 * Wrangler applies to D1.
 *
 * They used to be a separate hardcoded array here, which had already drifted:
 * migration 0002 was applied to production but never to a local database.
 * Reading one source means local development cannot diverge from production
 * again, and a new migration is added in exactly one place.
 */
function migrationsDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Four levels up from both `src/db` and `dist/db` reaches the repository
  // root; the extra candidates keep this working if the layout moves.
  const candidates = [
    resolve(here, '..', '..', '..', '..', 'migrations'),
    resolve(here, '..', '..', '..', 'migrations'),
    resolve(process.cwd(), 'migrations'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Could not locate the migrations directory');
  return found;
}

function loadMigrations(): string[] {
  const directory = migrationsDirectory();
  return (
    readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      // Names are zero-padded and ordered, e.g. 0001_initial.sql.
      .sort()
      .map((name) => readFileSync(join(directory, name), 'utf8'))
  );
}

const bool = (value: boolean): number => (value ? 1 : 0);
const fromBool = (value: unknown): boolean => value === 1 || value === true;

interface UserRow {
  id: string;
  name: string;
  token_hash: string | null;
  is_owner: number;
  created_at: string;
  claimed_at: string | null;
  last_seen_at: string | null;
}

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
  region_confirmed: number;
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

    const migrations = loadMigrations();
    for (let index = current; index < migrations.length; index += 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(migrations[index] as string);
        current = index + 1;
        this.db.prepare('UPDATE schema_version SET version = ?').run(current);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- Users ---------------------------------------------------------------

  findUserByTokenHash(tokenHash: string): User | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE token_hash = ?')
      .get(tokenHash) as unknown as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as
      UserRow | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): User[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY is_owner DESC, created_at ASC')
      .all() as unknown as UserRow[];
    return rows.map(toUser);
  }

  createUser(user: NewUser): User {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (id, name, token_hash, is_owner, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, user.name, user.tokenHash, bool(user.isOwner ?? false), new Date().toISOString());
    return this.getUser(id) as User;
  }

  setUserToken(id: string, tokenHash: string): void {
    // Reissuing a link also clears the claim, so the list honestly shows the
    // new link as unused until it is opened.
    this.db
      .prepare('UPDATE users SET token_hash = ?, claimed_at = NULL WHERE id = ?')
      .run(tokenHash, id);
  }

  markUserClaimed(id: string, at: Date): void {
    this.db
      .prepare('UPDATE users SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL')
      .run(at.toISOString(), id);
  }

  recordUserSeen(id: string, at: Date): void {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  deleteUser(id: string): boolean {
    // No foreign keys on the older tables, so the user's rows are removed
    // explicitly rather than by cascade.
    this.db.exec('BEGIN');
    try {
      for (const sql of [
        'DELETE FROM alert_rules WHERE user_id = ?',
        'DELETE FROM notification_subscriptions WHERE user_id = ?',
        'DELETE FROM notification_log WHERE user_id = ?',
        'DELETE FROM settings WHERE user_id = ?',
      ]) {
        this.db.prepare(sql).run(id);
      }
      const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
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

  /**
   * Registers a device for a person, taking the device away from anyone else.
   *
   * Uniqueness is per (person, subscription), so the same browser endpoint can
   * otherwise sit against two people at once - which happens when a device
   * changes hands and the browser fails to release its old subscription. Both
   * rows then look valid and the device receives both people's alerts. A
   * device belongs to whoever registered it last.
   */
  addSubscription(subscription: NewSubscription): NotificationSubscription {
    const now = new Date().toISOString();
    const id = randomUUID();

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'DELETE FROM notification_subscriptions WHERE subscription_data = ? AND user_id != ?',
        )
        .run(subscription.subscriptionData, subscription.userId);
      this.db
        .prepare(
          `INSERT INTO notification_subscriptions
           (id, user_id, provider, subscription_data, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (user_id, subscription_data) DO UPDATE SET enabled = 1`,
        )
        .run(id, subscription.userId, subscription.provider, subscription.subscriptionData, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

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

  listAllSettings(): UserSettings[] {
    const rows = this.db
      .prepare('SELECT * FROM settings ORDER BY user_id ASC')
      .all() as unknown as SettingsRow[];
    return rows.map(toSettings);
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
             notify_rule_matches = ?, hour12 = ?, theme = ?,
             region_confirmed = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        merged.region,
        merged.productCode,
        bool(merged.notifyDailyPrices),
        bool(merged.notifyRuleMatches),
        bool(merged.hour12),
        merged.theme,
        bool(merged.regionConfirmed),
        merged.updatedAt,
        userId,
      );
    return this.getSettings(userId);
  }

  // --- Forecasting input archive -------------------------------------------

  appendForecastInputs(rows: readonly NewForecastInput[]): number {
    if (rows.length === 0) return 0;
    const statement = this.db.prepare(
      `INSERT INTO forecast_inputs
         (id, source, target_start, issued_at, collected_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        statement.run(
          randomUUID(),
          row.source,
          row.targetStart,
          row.issuedAt,
          row.collectedAt,
          JSON.stringify(row.payload),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  lastForecastInputAt(source: string): string | null {
    const row = this.db
      .prepare(
        'SELECT collected_at FROM forecast_inputs WHERE source = ? ORDER BY collected_at DESC LIMIT 1',
      )
      .get(source) as { collected_at: string } | undefined;
    return row?.collected_at ?? null;
  }

  countForecastInputs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM forecast_inputs').get() as { n: number };
    return row.n;
  }

  pruneForecastInputsBefore(before: Date): number {
    const result = this.db
      .prepare('DELETE FROM forecast_inputs WHERE target_start < ?')
      .run(before.toISOString());
    return Number(result.changes);
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

  setStateIfAbsent(key: string, value: string): boolean {
    const result = this.db
      .prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
      .run(key, value);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    isOwner: fromBool(row.is_owner),
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    lastSeenAt: row.last_seen_at,
    // The hash itself never leaves the store.
    hasToken: row.token_hash !== null,
  };
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
    regionConfirmed: fromBool(row.region_confirmed),
    updatedAt: row.updated_at,
  };
}
