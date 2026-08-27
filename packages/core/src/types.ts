/**
 * Domain models shared by the server and the PWA.
 *
 * All timestamps crossing a boundary (database, HTTP, push payload) are ISO
 * 8601 strings in UTC, e.g. `2026-08-27T21:30:00.000Z`. They are converted to
 * `Date` only inside calculations, and to London local time only for display.
 */

import { z } from 'zod';
import { REGION_CODES } from './regions.ts';
import type { PricingDate } from './time.ts';

/** Comparison operators supported by alert rules. */
export const COMPARISON_OPERATORS = ['lt', 'lte', 'gt', 'gte'] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export const OPERATOR_SYMBOLS: Record<ComparisonOperator, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** A single half-hour settlement period and its unit rate in p/kWh. */
export interface PricePeriod {
  /** Inclusive start of the period, ISO 8601 UTC. */
  validFrom: string;
  /** Exclusive end of the period, ISO 8601 UTC. */
  validTo: string;
  /** Unit rate including VAT, p/kWh. This is what the user actually pays. */
  valueIncVat: number;
  /** Unit rate excluding VAT, p/kWh. */
  valueExcVat: number;
}

/** A price period as stored, carrying the tariff it belongs to. */
export interface StoredPricePeriod extends PricePeriod {
  tariffCode: string;
  region: string;
  retrievedAt: string;
}

export const pricePeriodSchema = z.object({
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  valueIncVat: z.number(),
  valueExcVat: z.number(),
});

/** Statistics describing one pricing day. */
export interface DaySummary {
  date: PricingDate;
  /** Number of periods actually held. */
  periodCount: number;
  /** Number of periods a complete day should hold (46, 48 or 50). */
  expectedPeriodCount: number;
  /** True when every expected period is present. */
  complete: boolean;
  minPence: number;
  maxPence: number;
  averagePence: number;
  /** Count of periods priced below zero. */
  negativeCount: number;
  cheapest: PricePeriod;
  mostExpensive: PricePeriod;
}

/** A run of consecutive periods, used for both rule matches and windows. */
export interface PeriodRun {
  startUtc: string;
  endUtc: string;
  periodCount: number;
  durationMinutes: number;
  averagePence: number;
  minPence: number;
  maxPence: number;
}

/** A rule match: a qualifying run of periods on a given pricing day. */
export interface RuleMatch extends PeriodRun {
  ruleId: string;
  ruleName: string;
  pricingDate: PricingDate;
}

/** A user-configured price alert. */
export interface AlertRule {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  operator: ComparisonOperator;
  /** Threshold in p/kWh, compared against the VAT-inclusive rate. */
  thresholdPence: number;
  /**
   * Minimum length of a qualifying run, in minutes. 30 means a single
   * half-hour period is enough; 120 means "at least two hours".
   */
  minimumDurationMinutes: number;
  /** Optional London-local restriction, `HH:mm`. Null means any time. */
  timeStart: string | null;
  timeEnd: string | null;
  /** Whether matches of this rule should raise a notification. */
  notify: boolean;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt: string | null;
}

const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time in HH:mm form');

/** Fields a user may supply when creating or editing a rule. */
export const alertRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    operator: z.enum(COMPARISON_OPERATORS),
    thresholdPence: z.number().min(-100).max(200),
    minimumDurationMinutes: z
      .number()
      .int()
      .min(30)
      .max(24 * 60)
      .refine((v) => v % 30 === 0, 'Duration must be a whole number of half-hour periods')
      .default(30),
    timeStart: clockTimeSchema.nullable().default(null),
    timeEnd: clockTimeSchema.nullable().default(null),
    notify: z.boolean().default(true),
  })
  .refine((r) => (r.timeStart === null) === (r.timeEnd === null), {
    message: 'Provide both a start and an end time, or neither',
    path: ['timeEnd'],
  });

export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;

/** Notification transports. Only `webpush` is implemented initially. */
export const NOTIFICATION_PROVIDERS = [
  'webpush',
  'telegram',
  'email',
  'ntfy',
  'discord',
  'pushover',
] as const;
export type NotificationProvider = (typeof NOTIFICATION_PROVIDERS)[number];

export interface NotificationSubscription {
  id: string;
  userId: string;
  provider: NotificationProvider;
  /** Provider-specific payload. Treated as a secret and never logged. */
  subscriptionData: string;
  enabled: boolean;
  createdAt: string;
  lastSuccess: string | null;
  lastFailure: string | null;
}

export const webPushSubscriptionSchema = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;

/** Kinds of notification the application sends. */
export const NOTIFICATION_TYPES = [
  'daily_prices',
  /** A rule matched somewhere in a newly published day. Advance notice. */
  'rule_match',
  /** A matching stretch is about to begin. Notice in the moment. */
  'rule_upcoming',
  'test',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationStatus = 'sent' | 'failed';

export interface NotificationLogEntry {
  id: string;
  userId: string;
  ruleId: string | null;
  type: NotificationType;
  /** Idempotency key; a notification is sent at most once per key. */
  dedupeKey: string;
  title: string;
  message: string;
  createdAt: string;
  status: NotificationStatus;
  error: string | null;
}

/** A notification ready to be handed to a provider. */
export interface NotificationPayload {
  type: NotificationType;
  dedupeKey: string;
  title: string;
  body: string;
  /** In-app path to open when the notification is tapped. */
  url: string;
  ruleId?: string | null;
}

/**
 * Someone who uses this installation.
 *
 * A user *is* an invite: the owner creates one with an access token, sends the
 * link, and the row records when it was first opened. There are no passwords
 * and no email addresses, which suits a handful of friends and family.
 *
 * The token itself never appears here. Only its hash is stored, and the full
 * value is shown exactly once, when the link is created or regenerated.
 */
export interface User {
  id: string;
  /** Friendly label chosen by the owner, e.g. "Mum". Not a login name. */
  name: string;
  /** The owner can invite and remove other people. */
  isOwner: boolean;
  createdAt: string;
  /** When the invite link was first opened. Null means unused. */
  claimedAt: string | null;
  lastSeenAt: string | null;
  /** Whether an access link currently exists for this person. */
  hasToken: boolean;
}

export const inviteInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export type InviteInput = z.infer<typeof inviteInputSchema>;

/** User-level settings. Each person has their own region and preferences. */
export interface UserSettings {
  userId: string;
  region: string;
  productCode: string;
  /** Notify when the next day prices are published. */
  notifyDailyPrices: boolean;
  /** Notify when an alert rule matches. */
  notifyRuleMatches: boolean;
  hour12: boolean;
  theme: 'system' | 'light' | 'dark';
  /**
   * Whether this person has actually chosen their region, rather than being
   * left on the default. Lives here, next to the region itself, so it follows
   * them to any device instead of being remembered per browser.
   */
  regionConfirmed: boolean;
  updatedAt: string;
}

export const userSettingsInputSchema = z.object({
  region: z.enum(REGION_CODES).optional(),
  productCode: z.string().trim().min(1).max(64).optional(),
  notifyDailyPrices: z.boolean().optional(),
  notifyRuleMatches: z.boolean().optional(),
  hour12: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  regionConfirmed: z.boolean().optional(),
});

export type UserSettingsInput = z.infer<typeof userSettingsInputSchema>;

/** Health and troubleshooting information for the status page. */
export interface SystemStatus {
  version: string;
  commit: string;
  startedAt: string;
  lastCheckStartedAt: string | null;
  lastSuccessfulRetrievalAt: string | null;
  today: { date: PricingDate; periodCount: number; complete: boolean };
  tomorrow: { date: PricingDate; periodCount: number; complete: boolean };
  storedPeriodCount: number;
  lastNotificationAt: string | null;
  tariffCode: string;
}
