/**
 * Structured logging.
 *
 * One JSON object per line, so the output is greppable by hand during
 * development and parseable by whatever collects logs in production.
 *
 * Every notable event has a name from `LOG_EVENTS` (DESIGN.md section 37), so
 * "did tomorrow's prices arrive?" is answerable with a single grep rather
 * than by reading prose log messages.
 */

/** Named events, so log searches do not depend on message wording. */
export const LOG_EVENTS = {
  serverStarted: 'SERVER_STARTED',
  priceCheckStarted: 'PRICE_CHECK_STARTED',
  priceDataNotReady: 'PRICE_DATA_NOT_READY',
  priceDataComplete: 'PRICE_DATA_COMPLETE',
  priceDataStored: 'PRICE_DATA_STORED',
  ruleMatch: 'RULE_MATCH',
  notificationSent: 'NOTIFICATION_SENT',
  notificationSkipped: 'NOTIFICATION_SKIPPED',
  notificationFailed: 'NOTIFICATION_FAILED',
  subscriptionExpired: 'SUBSCRIPTION_EXPIRED',
  octopusApiError: 'OCTOPUS_API_ERROR',
  productDiscovered: 'PRODUCT_DISCOVERED',
  schedulerScheduled: 'SCHEDULER_SCHEDULED',
  schedulerGaveUp: 'SCHEDULER_GAVE_UP',
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Fields that must never reach the log, whatever nesting they appear at.
 *
 * Push subscriptions contain the endpoint and keys needed to send messages to
 * a device, and Octopus credentials are account secrets. DESIGN.md section 37
 * is explicit that neither may be logged.
 */
const REDACTED_KEYS = new Set([
  'subscriptionData',
  'subscription_data',
  'subscription',
  'endpoint',
  'keys',
  'p256dh',
  'auth',
  'apiKey',
  'api_key',
  'accountNumber',
  'account_number',
  'vapidPrivateKey',
  'privateKey',
  'password',
  'authorization',
]);

const REDACTED = '[redacted]';

/** Recursively replaces secret-bearing fields with a placeholder. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
}

export interface LogFields {
  event?: LogEvent;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Overridable for tests. */
  write?: (line: string) => void;
  /** Overridable for tests. */
  now?: () => Date;
  bindings?: LogFields;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const log = (entryLevel: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const entry = {
      time: now().toISOString(),
      level: entryLevel,
      message,
      ...(redact({ ...bindings, ...fields }) as Record<string, unknown>),
    };
    write(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (extra) => createLogger({ ...options, level, bindings: { ...bindings, ...extra } }),
  };
}

/** Turns an unknown thrown value into something safe to log. */
export function describeError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { error: String(error) };
}
