/** Cloudflare D1 implementation of the storage boundary. */

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

export interface D1StoreOptions {
  database: D1Database;
  defaultRegion: string;
  defaultProductCode?: string;
}

export class D1Store implements Store {
  private readonly database: D1Database;
  private readonly defaultRegion: string;
  private readonly defaultProductCode: string;

  constructor(options: D1StoreOptions) {
    this.database = options.database;
    this.defaultRegion = options.defaultRegion;
    this.defaultProductCode = options.defaultProductCode ?? FALLBACK_AGILE_PRODUCT_CODE;
  }

  // --- Users ---------------------------------------------------------------

  async findUserByTokenHash(tokenHash: string): Promise<User | null> {
    const row = await this.database
      .prepare('SELECT * FROM users WHERE token_hash = ?')
      .bind(tokenHash)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const row = await this.database
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(id)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    const { results } = await this.database
      .prepare('SELECT * FROM users ORDER BY is_owner DESC, created_at ASC')
      .all<UserRow>();
    return results.map(toUser);
  }

  async createUser(user: NewUser): Promise<User> {
    const id = randomUUID();
    await this.database
      .prepare(
        `INSERT INTO users (id, name, token_hash, is_owner, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, user.name, user.tokenHash, bool(user.isOwner ?? false), new Date().toISOString())
      .run();
    return (await this.getUser(id)) as User;
  }

  async setUserToken(id: string, tokenHash: string): Promise<void> {
    // Reissuing a link also clears the claim, so the list honestly shows the
    // new link as unused until it is opened.
    await this.database
      .prepare('UPDATE users SET token_hash = ?, claimed_at = NULL WHERE id = ?')
      .bind(tokenHash, id)
      .run();
  }

  async markUserClaimed(id: string, at: Date): Promise<void> {
    await this.database
      .prepare('UPDATE users SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL')
      .bind(at.toISOString(), id)
      .run();
  }

  async recordUserSeen(id: string, at: Date): Promise<void> {
    await this.database
      .prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
      .bind(at.toISOString(), id)
      .run();
  }

  async deleteUser(id: string): Promise<boolean> {
    // The older tables carry no foreign keys, so the user's rows go
    // explicitly. Batched so a partial delete cannot leave orphans behind.
    const statements = [
      'DELETE FROM alert_rules WHERE user_id = ?',
      'DELETE FROM notification_subscriptions WHERE user_id = ?',
      'DELETE FROM notification_log WHERE user_id = ?',
      'DELETE FROM settings WHERE user_id = ?',
      'DELETE FROM users WHERE id = ?',
    ].map((sql) => this.database.prepare(sql).bind(id));

    const results = await this.database.batch(statements);
    const deletedUser = results[results.length - 1];
    return Number(deletedUser?.meta?.changes ?? 0) > 0;
  }

  // --- Prices --------------------------------------------------------------

  async upsertPrices(periods: readonly StoredPricePeriod[]): Promise<number> {
    if (periods.length === 0) return 0;
    const sql = `
      INSERT INTO prices (id, tariff_code, region, valid_from, valid_to,
                          price_inc_vat, price_exc_vat, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tariff_code, valid_from) DO UPDATE SET
        valid_to      = excluded.valid_to,
        price_inc_vat = excluded.price_inc_vat,
        price_exc_vat = excluded.price_exc_vat,
        retrieved_at  = excluded.retrieved_at`;
    await this.database.batch(
      periods.map((period) =>
        this.database
          .prepare(sql)
          .bind(
            randomUUID(),
            period.tariffCode,
            period.region,
            period.validFrom,
            period.validTo,
            period.valueIncVat,
            period.valueExcVat,
            period.retrievedAt,
          ),
      ),
    );
    return periods.length;
  }

  async getPrices(tariffCode: string, from: Date, to: Date): Promise<PricePeriod[]> {
    const result = await this.database
      .prepare(
        `SELECT valid_from, valid_to, price_inc_vat, price_exc_vat
         FROM prices
         WHERE tariff_code = ? AND valid_from >= ? AND valid_from < ?
         ORDER BY valid_from ASC`,
      )
      .bind(tariffCode, from.toISOString(), to.toISOString())
      .all<PriceRow>();
    return result.results.map((row) => ({
      validFrom: row.valid_from,
      validTo: row.valid_to,
      valueIncVat: row.price_inc_vat,
      valueExcVat: row.price_exc_vat,
    }));
  }

  async countPrices(): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS n FROM prices')
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async prunePricesBefore(before: Date): Promise<number> {
    const result = await this.database
      .prepare('DELETE FROM prices WHERE valid_from < ?')
      .bind(before.toISOString())
      .run();
    return result.meta.changes ?? 0;
  }

  async listRules(userId: string): Promise<AlertRule[]> {
    const result = await this.database
      .prepare('SELECT * FROM alert_rules WHERE user_id = ? ORDER BY created_at ASC')
      .bind(userId)
      .all<RuleRow>();
    return result.results.map(toAlertRule);
  }

  async getRule(id: string): Promise<AlertRule | null> {
    const row = await this.database
      .prepare('SELECT * FROM alert_rules WHERE id = ?')
      .bind(id)
      .first<RuleRow>();
    return row ? toAlertRule(row) : null;
  }

  async createRule(userId: string, input: AlertRuleInput): Promise<AlertRule> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.database
      .prepare(
        `INSERT INTO alert_rules (id, user_id, name, enabled, comparison_operator,
                                  price_threshold, minimum_duration_minutes,
                                  time_start, time_end, notify, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();
    return (await this.getRule(id)) as AlertRule;
  }

  async updateRule(id: string, input: AlertRuleInput): Promise<AlertRule | null> {
    if (!(await this.getRule(id))) return null;
    await this.database
      .prepare(
        `UPDATE alert_rules
         SET name = ?, enabled = ?, comparison_operator = ?, price_threshold = ?,
             minimum_duration_minutes = ?, time_start = ?, time_end = ?,
             notify = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
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
      )
      .run();
    return this.getRule(id);
  }

  async deleteRule(id: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM alert_rules WHERE id = ?')
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markRuleTriggered(id: string, at: Date): Promise<void> {
    await this.database
      .prepare('UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?')
      .bind(at.toISOString(), id)
      .run();
  }

  async listSubscriptions(userId: string): Promise<NotificationSubscription[]> {
    const result = await this.database
      .prepare('SELECT * FROM notification_subscriptions WHERE user_id = ? AND enabled = 1')
      .bind(userId)
      .all<SubscriptionRow>();
    return result.results.map(toSubscription);
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
  async addSubscription(subscription: NewSubscription): Promise<NotificationSubscription> {
    const now = new Date().toISOString();
    const id = randomUUID();

    // Batched so the endpoint can never be attached to two people at once.
    await this.database.batch([
      this.database
        .prepare(
          'DELETE FROM notification_subscriptions WHERE subscription_data = ? AND user_id != ?',
        )
        .bind(subscription.subscriptionData, subscription.userId),
      this.database
        .prepare(
          `INSERT INTO notification_subscriptions
             (id, user_id, provider, subscription_data, enabled, created_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT (user_id, subscription_data) DO UPDATE SET enabled = 1`,
        )
        .bind(id, subscription.userId, subscription.provider, subscription.subscriptionData, now),
    ]);
    const row = await this.database
      .prepare(
        'SELECT * FROM notification_subscriptions WHERE user_id = ? AND subscription_data = ?',
      )
      .bind(subscription.userId, subscription.subscriptionData)
      .first<SubscriptionRow>();
    if (!row) throw new Error('D1 did not return the stored subscription');
    return toSubscription(row);
  }

  async removeSubscriptionByData(userId: string, subscriptionData: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM notification_subscriptions WHERE user_id = ? AND subscription_data = ?')
      .bind(userId, subscriptionData)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async removeSubscription(id: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM notification_subscriptions WHERE id = ?')
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async recordSubscriptionResult(id: string, success: boolean, at: Date): Promise<void> {
    const sql = success
      ? 'UPDATE notification_subscriptions SET last_success = ? WHERE id = ?'
      : 'UPDATE notification_subscriptions SET last_failure = ? WHERE id = ?';
    await this.database.prepare(sql).bind(at.toISOString(), id).run();
  }

  async disableSubscription(id: string): Promise<void> {
    await this.database
      .prepare('UPDATE notification_subscriptions SET enabled = 0 WHERE id = ?')
      .bind(id)
      .run();
  }

  async hasSentNotification(dedupeKey: string): Promise<boolean> {
    const row = await this.database
      .prepare("SELECT 1 AS found FROM notification_log WHERE dedupe_key = ? AND status = 'sent'")
      .bind(dedupeKey)
      .first<{ found: number }>();
    return row !== null;
  }

  async recordNotification(entry: NotificationLogInput, at: Date): Promise<NotificationLogEntry> {
    const id = randomUUID();
    await this.database
      .prepare(
        `INSERT INTO notification_log
           (id, user_id, rule_id, type, dedupe_key, title, message, created_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           status = excluded.status, error = excluded.error, created_at = excluded.created_at`,
      )
      .bind(
        id,
        entry.userId,
        entry.ruleId,
        entry.type,
        entry.dedupeKey,
        entry.title,
        entry.message,
        at.toISOString(),
        entry.status,
        entry.error ?? null,
      )
      .run();
    const row = await this.database
      .prepare('SELECT * FROM notification_log WHERE dedupe_key = ?')
      .bind(entry.dedupeKey)
      .first<LogRow>();
    if (!row) throw new Error('D1 did not return the stored notification');
    return toLogEntry(row);
  }

  async listRecentNotifications(userId: string, limit: number): Promise<NotificationLogEntry[]> {
    const result = await this.database
      .prepare('SELECT * FROM notification_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userId, limit)
      .all<LogRow>();
    return result.results.map(toLogEntry);
  }

  async lastNotificationAt(userId: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        "SELECT created_at FROM notification_log WHERE user_id = ? AND status = 'sent' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(userId)
      .first<{ created_at: string }>();
    return row?.created_at ?? null;
  }

  async getSettings(userId: string): Promise<UserSettings> {
    const row = await this.database
      .prepare('SELECT * FROM settings WHERE user_id = ?')
      .bind(userId)
      .first<SettingsRow>();
    if (row) return toSettings(row);

    await this.database
      .prepare(
        `INSERT INTO settings (user_id, region, product_code, notify_daily_prices,
                               notify_rule_matches, hour12, theme, updated_at)
         VALUES (?, ?, ?, 1, 1, 0, 'system', ?)`,
      )
      .bind(userId, this.defaultRegion, this.defaultProductCode, new Date().toISOString())
      .run();
    return this.getSettings(userId);
  }

  async listAllSettings(): Promise<UserSettings[]> {
    const { results } = await this.database
      .prepare('SELECT * FROM settings ORDER BY user_id ASC')
      .all<SettingsRow>();
    return results.map(toSettings);
  }

  async updateSettings(userId: string, input: UserSettingsInput): Promise<UserSettings> {
    const current = await this.getSettings(userId);
    const merged: UserSettings = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    await this.database
      .prepare(
        `UPDATE settings
         SET region = ?, product_code = ?, notify_daily_prices = ?,
             notify_rule_matches = ?, hour12 = ?, theme = ?,
             region_confirmed = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(
        merged.region,
        merged.productCode,
        bool(merged.notifyDailyPrices),
        bool(merged.notifyRuleMatches),
        bool(merged.hour12),
        merged.theme,
        bool(merged.regionConfirmed),
        merged.updatedAt,
        userId,
      )
      .run();
    return this.getSettings(userId);
  }

  // --- Forecasting input archive -------------------------------------------

  async appendForecastInputs(rows: readonly NewForecastInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const sql = `INSERT INTO forecast_inputs
         (id, source, target_start, issued_at, collected_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`;
    // Batched: a few hundred rows per run, and a partial write would leave a
    // vintage that never existed.
    await this.database.batch(
      rows.map((row) =>
        this.database
          .prepare(sql)
          .bind(
            randomUUID(),
            row.source,
            row.targetStart,
            row.issuedAt,
            row.collectedAt,
            JSON.stringify(row.payload),
          ),
      ),
    );
    return rows.length;
  }

  async lastForecastInputAt(source: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        'SELECT collected_at FROM forecast_inputs WHERE source = ? ORDER BY collected_at DESC LIMIT 1',
      )
      .bind(source)
      .first<{ collected_at: string }>();
    return row?.collected_at ?? null;
  }

  async countForecastInputs(): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS n FROM forecast_inputs')
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async pruneForecastInputsBefore(before: Date): Promise<number> {
    const result = await this.database
      .prepare('DELETE FROM forecast_inputs WHERE target_start < ?')
      .bind(before.toISOString())
      .run();
    return result.meta.changes ?? 0;
  }

  async getState(key: string): Promise<string | null> {
    const row = await this.database
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value)
      .run();
  }

  async setStateIfAbsent(key: string, value: string): Promise<boolean> {
    const result = await this.database
      .prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
      .bind(key, value)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  close(): void {
    // D1 bindings are managed by the Workers runtime.
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
