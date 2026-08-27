/**
 * Environment configuration.
 *
 * Parsed and validated once at startup so that a misconfigured deployment
 * fails immediately with a readable message rather than at 16:05 when the
 * first poll runs.
 */

import { z } from 'zod';
import { DEFAULT_USER_ID, REGION_CODES } from '@octoprice/core';

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().default('file:./data/octoprice.sqlite'),

  OCTOPUS_BASE_URL: z.url().default('https://api.octopus.energy/v1'),
  OCTOPUS_PRODUCT_CODE: z.string().trim().min(1).optional(),
  OCTOPUS_API_KEY: z.string().optional(),
  OCTOPUS_ACCOUNT_NUMBER: z.string().optional(),

  DEFAULT_REGION: z.enum(REGION_CODES).default('C'),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:octoprice@example.com'),

  POLL_START: clockTime.default('16:05'),
  POLL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(120).default(5),
  POLL_CUTOFF: clockTime.default('22:15'),

  /** Set to `false` to run the API without the background poller. */
  ENABLE_SCHEDULER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** Directory of built PWA assets to serve. Empty disables static serving. */
  WEB_DIST_PATH: z.string().default('../web/dist'),

  /** Experimental display-only estimate; safe to withdraw independently. */
  FORECAST_BASELINE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Collect Carbon Intensity vintages that cannot be retrieved later. At the
   * default cadence this is about 770 rows a day and changes nothing by itself.
   */
  FORECAST_ARCHIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  FORECAST_ARCHIVE_INTERVAL_MINUTES: z.coerce.number().int().min(30).max(1440).default(180),
  /**
   * How long to keep archived observations. Carbon-only production rows
   * measured 292.8 bytes of column payload and 96-97 rows per run, so 180 days
   * is roughly 41 MB before SQLite/index overhead.
   */
  FORECAST_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
});

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseFile: string;
  octopus: {
    baseUrl: string;
    /** When set, product discovery is skipped and this product is used. */
    productCode: string | undefined;
  };
  defaultRegion: (typeof REGION_CODES)[number];
  /** Null when no VAPID key pair is configured; push is then unavailable. */
  vapid: VapidConfig | null;
  poll: {
    start: string;
    intervalMinutes: number;
    cutoff: string;
  };
  enableScheduler: boolean;
  webDistPath: string;
  forecastBaselineEnabled: boolean;
  forecastArchiveEnabled: boolean;
  forecastArchiveIntervalMinutes: number;
  forecastArchiveRetentionDays: number;
  userId: string;
}

/**
 * `DATABASE_URL` accepts `file:./path`, a bare path, or `:memory:`. Postgres
 * URLs are recognised but not yet supported, and fail loudly rather than
 * silently falling back to SQLite.
 */
function parseDatabaseUrl(value: string): string {
  if (value.startsWith('postgres://') || value.startsWith('postgresql://')) {
    throw new Error(
      'PostgreSQL support is not implemented yet. Use a SQLite file path or :memory:.',
    );
  }
  return value.startsWith('file:') ? value.slice('file:'.length) : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const e = parsed.data;
  const hasVapid = Boolean(e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY);

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseFile: parseDatabaseUrl(e.DATABASE_URL),
    octopus: {
      baseUrl: e.OCTOPUS_BASE_URL.replace(/\/$/, ''),
      productCode: e.OCTOPUS_PRODUCT_CODE,
    },
    defaultRegion: e.DEFAULT_REGION,
    vapid: hasVapid
      ? {
          publicKey: e.VAPID_PUBLIC_KEY as string,
          privateKey: e.VAPID_PRIVATE_KEY as string,
          subject: e.VAPID_SUBJECT,
        }
      : null,
    poll: {
      start: e.POLL_START,
      intervalMinutes: e.POLL_INTERVAL_MINUTES,
      cutoff: e.POLL_CUTOFF,
    },
    enableScheduler: e.ENABLE_SCHEDULER,
    webDistPath: e.WEB_DIST_PATH,
    forecastBaselineEnabled: e.FORECAST_BASELINE_ENABLED,
    forecastArchiveEnabled: e.FORECAST_ARCHIVE_ENABLED,
    forecastArchiveIntervalMinutes: e.FORECAST_ARCHIVE_INTERVAL_MINUTES,
    forecastArchiveRetentionDays: e.FORECAST_ARCHIVE_RETENTION_DAYS,
    userId: DEFAULT_USER_ID,
  };
}
