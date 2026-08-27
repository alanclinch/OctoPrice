/** Cloudflare Worker entry point for the API, static PWA and scheduled polling. */

import { DEFAULT_ALERT_RULES, alertRuleInputSchema } from '@octoprice/core';
import { loadConfig, type AppConfig } from './config.ts';
import { D1Store } from './db/d1.ts';
import type { Store } from './db/store.ts';
import { createLogger, type Logger } from './logger.ts';
import { OctopusClient } from './octopus/client.ts';
import { PriceService } from './prices/service.ts';
import { NotificationService } from './notifications/service.ts';
import { WebPushSender } from './notifications/webpush.ts';
import { AlertDispatcher } from './alerts/dispatcher.ts';
import { PricePoller } from './scheduler/poller.ts';
import { handleApiRequest } from './api/handler.ts';
import { runArchive, runScheduledJobs } from './forecast/archive.ts';
import { runForecastHistoryBackfill } from './forecast/baseline.ts';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEFAULT_REGION?: string;
  LOG_LEVEL?: string;
  OCTOPUS_BASE_URL?: string;
  OCTOPUS_PRODUCT_CODE?: string;
  POLL_START?: string;
  POLL_INTERVAL_MINUTES?: string;
  POLL_CUTOFF?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  FORECAST_ARCHIVE_ENABLED?: string;
  FORECAST_ARCHIVE_INTERVAL_MINUTES?: string;
  FORECAST_ARCHIVE_RETENTION_DAYS?: string;
  OCTOPRICE_COMMIT?: string;
}

interface Runtime {
  config: AppConfig;
  store: Store;
  priceService: PriceService;
  notifications: NotificationService;
  dispatcher: AlertDispatcher;
  poller: PricePoller;
  logger: Logger;
  now: () => Date;
}

/**
 * The runtime is built once per isolate and reused across requests, so a warm
 * Worker does not rebuild the store and services on every call.
 */
let runtimePromise: Promise<Runtime> | null = null;

function configFor(env: Env): AppConfig {
  const values: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: ':memory:',
    ENABLE_SCHEDULER: 'true',
    WEB_DIST_PATH: '__cloudflare_static_assets__',
    DEFAULT_REGION: env.DEFAULT_REGION ?? 'C',
    LOG_LEVEL: env.LOG_LEVEL ?? 'info',
    OCTOPUS_BASE_URL: env.OCTOPUS_BASE_URL ?? 'https://api.octopus.energy/v1',
    POLL_START: env.POLL_START ?? '16:05',
    POLL_INTERVAL_MINUTES: env.POLL_INTERVAL_MINUTES ?? '5',
    POLL_CUTOFF: env.POLL_CUTOFF ?? '22:15',
    FORECAST_ARCHIVE_ENABLED: env.FORECAST_ARCHIVE_ENABLED ?? 'true',
  };

  // Optional overrides are only set when present, so the schema default
  // applies otherwise rather than being silently overwritten with undefined.
  if (env.FORECAST_ARCHIVE_INTERVAL_MINUTES) {
    values.FORECAST_ARCHIVE_INTERVAL_MINUTES = env.FORECAST_ARCHIVE_INTERVAL_MINUTES;
  }
  if (env.FORECAST_ARCHIVE_RETENTION_DAYS) {
    values.FORECAST_ARCHIVE_RETENTION_DAYS = env.FORECAST_ARCHIVE_RETENTION_DAYS;
  }

  for (const key of [
    'OCTOPUS_PRODUCT_CODE',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
  ] as const) {
    if (env[key]) values[key] = env[key];
  }
  return loadConfig(values);
}

async function seedDefaultRules(store: Store, userId: string): Promise<void> {
  if (!(await store.setStateIfAbsent('rules_seeded', new Date().toISOString()))) return;
  if ((await store.listRules(userId)).length === 0) {
    for (const rule of DEFAULT_ALERT_RULES) {
      await store.createRule(userId, alertRuleInputSchema.parse(rule));
    }
  }
}

/**
 * Makes sure the owner has settings, so the poller can see which tariff to
 * fetch even before anyone opens the app.
 */
async function ensureOwnerSettings(store: Store, userId: string): Promise<void> {
  await store.getSettings(userId);
}

async function createRuntime(env: Env): Promise<Runtime> {
  const config = configFor(env);
  const logger = createLogger({ level: config.logLevel, bindings: { app: 'octoprice-worker' } });
  const store = new D1Store({ database: env.DB, defaultRegion: config.defaultRegion });
  await seedDefaultRules(store, config.userId);
  await ensureOwnerSettings(store, config.userId);

  const priceService = new PriceService({
    store,
    client: new OctopusClient({ baseUrl: config.octopus.baseUrl, logger }),
    logger,
    defaultRegion: config.defaultRegion,
    forcedProductCode: config.octopus.productCode,
  });
  const notifications = new NotificationService({
    store,
    senders: [new WebPushSender(config.vapid)],
    logger,
  });
  const dispatcher = new AlertDispatcher({ store, notifications, logger });
  const poller = new PricePoller({
    priceService,
    dispatcher,
    logger,
    window: config.poll,
  });
  return {
    config,
    store,
    priceService,
    notifications,
    dispatcher,
    poller,
    logger,
    now: () => new Date(),
  };
}

function getRuntime(env: Env): Promise<Runtime> {
  runtimePromise ??= createRuntime(env);
  return runtimePromise;
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const runtime = await getRuntime(env);
  const url = new URL(request.url);

  let body: unknown;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const response = await handleApiRequest(runtime, {
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    headers: {
      cookie: request.headers.get('cookie'),
      authorization: request.headers.get('authorization'),
    },
    body,
    origin: url.origin,
  });

  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers.set(name, value);
  }

  if (response.body === undefined) {
    headers.delete('content-type');
    return new Response(null, { status: response.status, headers });
  }
  return new Response(JSON.stringify(response.body), { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api')) {
      return env.ASSETS.fetch(request);
    }
    return handleApi(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    const { poller, store, priceService, logger, config } = await getRuntime(env);

    // The core work first, and only then the optional archive.
    //
    // `runScheduled` talks to Octopus, but only inside the publication window;
    // outside it the poll plan makes it a no-op, so the cron can safely run
    // all day. `checkUpcoming` reads stored prices only and never touches the
    // network, which is what lets "starting soon" alerts fire at any hour.
    //
    // These two finish *before* the archive begins. Handing all three to
    // Promise.all - as an earlier version did - starts them together and
    // makes them compete for the same 10 ms CPU allowance, whatever the
    // comment above them claims.
    context.waitUntil(
      runScheduledJobs({
        core: () => Promise.all([poller.runScheduled(), poller.checkUpcoming()]),
        archive: config.forecastArchiveEnabled
          ? () =>
              runArchive({
                store,
                logger,
                intervalMinutes: config.forecastArchiveIntervalMinutes,
                retentionDays: config.forecastArchiveRetentionDays,
              })
          : undefined,
        forecast: () => runForecastHistoryBackfill({ store, priceService, logger }),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
