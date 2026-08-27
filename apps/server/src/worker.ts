/** Cloudflare Worker entry point for the API, static PWA and scheduled polling. */

import { z } from 'zod';
import {
  DEFAULT_ALERT_RULES,
  REGIONS,
  addDays,
  alertRuleInputSchema,
  buildTestNotification,
  expectedPeriodCount,
  findCheapestWindow,
  findNextPeriod,
  findPeriodAt,
  isDayComplete,
  londonDateOf,
  rankWindows,
  summariseDay,
  userSettingsInputSchema,
  webPushSubscriptionSchema,
  type PricingDate,
} from '@octoprice/core';
import { loadConfig, type AppConfig } from './config.ts';
import { D1Store } from './db/d1.ts';
import type { Store } from './db/store.ts';
import { createLogger, describeError, type Logger } from './logger.ts';
import { OctopusClient } from './octopus/client.ts';
import { PriceService } from './prices/service.ts';
import { NotificationService } from './notifications/service.ts';
import { WebPushSender } from './notifications/webpush.ts';
import { AlertDispatcher } from './alerts/dispatcher.ts';
import { PricePoller } from './scheduler/poller.ts';

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
}

const dateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD form')
    .optional(),
});

const windowQuerySchema = dateQuerySchema.extend({
  durationMinutes: z.coerce
    .number()
    .int()
    .min(30)
    .max(24 * 60)
    .default(180),
  limit: z.coerce.number().int().min(1).max(20).default(3),
});

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
  };

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

async function createRuntime(env: Env): Promise<Runtime> {
  const config = configFor(env);
  const logger = createLogger({ level: config.logLevel, bindings: { app: 'octoprice-worker' } });
  const store = new D1Store({ database: env.DB, defaultRegion: config.defaultRegion });
  await seedDefaultRules(store, config.userId);

  const priceService = new PriceService({
    store,
    client: new OctopusClient({ baseUrl: config.octopus.baseUrl, logger }),
    logger,
    userId: config.userId,
    forcedProductCode: config.octopus.productCode,
  });
  const notifications = new NotificationService({
    store,
    senders: [new WebPushSender(config.vapid)],
    logger,
  });
  const dispatcher = new AlertDispatcher({ store, notifications, logger, userId: config.userId });
  const poller = new PricePoller({
    priceService,
    dispatcher,
    logger,
    window: config.poll,
  });
  return { config, store, priceService, notifications, dispatcher, poller, logger };
}

function getRuntime(env: Env): Promise<Runtime> {
  runtimePromise ??= createRuntime(env);
  return runtimePromise;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function validationError(result: { error: z.ZodError }): Response {
  return json({ error: result.error.issues[0]?.message ?? 'Invalid request' }, 400);
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function describeDay(priceService: PriceService, date: PricingDate) {
  const periods = await priceService.storedDay(date);
  return {
    date,
    periods,
    summary: summariseDay(periods, date),
    complete: isDayComplete(periods, date),
    expectedPeriodCount: expectedPeriodCount(date),
  };
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const runtime = await getRuntime(env);
  const { config, store, priceService, notifications, logger } = runtime;
  const userId = config.userId;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const query = Object.fromEntries(url.searchParams);
  const method = request.method;
  const now = new Date();

  try {
    if (method === 'GET' && path === '/api/health') {
      return json({ status: 'ok', time: now.toISOString() });
    }

    if (method === 'GET' && path === '/api/status') {
      const today = londonDateOf(now);
      const tomorrow = addDays(today, 1);
      const todayPeriods = await priceService.storedDay(today);
      const tomorrowPeriods = await priceService.storedDay(tomorrow);
      const tariff = await priceService.tariff();
      return json({
        version: '0.1.0',
        commit: env.OCTOPRICE_COMMIT?.slice(0, 12) ?? 'cloudflare',
        tariffCode: tariff.tariffCode,
        productCode: tariff.productCode,
        region: tariff.region,
        lastCheckStartedAt: await store.getState('last_check_started_at'),
        lastSuccessfulRetrievalAt: await store.getState('last_successful_retrieval_at'),
        today: {
          date: today,
          periodCount: todayPeriods.length,
          complete: isDayComplete(todayPeriods, today),
        },
        tomorrow: {
          date: tomorrow,
          periodCount: tomorrowPeriods.length,
          complete: isDayComplete(tomorrowPeriods, tomorrow),
        },
        storedPeriodCount: await store.countPrices(),
        lastNotificationAt: await store.lastNotificationAt(userId),
        pushConfigured: config.vapid !== null,
        schedulerEnabled: true,
      });
    }

    if (method === 'GET' && path === '/api/overview') {
      const today = londonDateOf(now);
      const tomorrow = addDays(today, 1);
      const todayPeriods = await priceService.storedDay(today);
      const tomorrowPeriods = await priceService.storedDay(tomorrow);
      const known = [...todayPeriods, ...tomorrowPeriods];
      return json({
        now: now.toISOString(),
        current: findPeriodAt(known, now),
        next: findNextPeriod(known, now),
        today: await describeDay(priceService, today),
        tomorrow: await describeDay(priceService, tomorrow),
        settings: await store.getSettings(userId),
        tariff: await priceService.tariff(),
      });
    }

    if (method === 'GET' && path === '/api/prices') {
      const parsed = dateQuerySchema.safeParse(query);
      if (!parsed.success) return validationError(parsed);
      return json(await describeDay(priceService, parsed.data.date ?? londonDateOf(now)));
    }

    if (method === 'GET' && path === '/api/windows') {
      const parsed = windowQuerySchema.safeParse(query);
      if (!parsed.success) return validationError(parsed);
      const date = parsed.data.date ?? londonDateOf(now);
      const periods = await priceService.storedDay(date);
      return json({
        date,
        durationMinutes: parsed.data.durationMinutes,
        cheapest: findCheapestWindow(periods, parsed.data.durationMinutes),
        ranked: rankWindows(periods, parsed.data.durationMinutes, parsed.data.limit),
      });
    }

    if (method === 'POST' && path === '/api/check-now') {
      const parsed = dateQuerySchema.safeParse(query);
      if (!parsed.success) return validationError(parsed);
      const date = parsed.data.date ?? addDays(londonDateOf(now), 1);
      try {
        const result = await priceService.refresh(date);
        if (result.complete) await runtime.dispatcher.dispatchForDay(date, result.periods);
        return json({
          date,
          complete: result.complete,
          periodCount: result.periods.length,
          missingCount: result.missingCount,
        });
      } catch (error) {
        logger.error('Manual price check failed', { date, ...describeError(error) });
        return json({ error: 'Could not reach the Octopus API' }, 502);
      }
    }

    if (method === 'GET' && path === '/api/regions') return json({ regions: REGIONS });
    if (method === 'GET' && path === '/api/settings') return json(await store.getSettings(userId));
    if (method === 'PATCH' && path === '/api/settings') {
      const parsed = userSettingsInputSchema.safeParse(await requestBody(request));
      if (!parsed.success) return validationError(parsed);
      const previous = await store.getSettings(userId);
      const updated = await store.updateSettings(userId, parsed.data);
      if (parsed.data.region && parsed.data.region !== previous.region) {
        await priceService.refreshCurrentDays();
      }
      return json(updated);
    }

    if (method === 'GET' && path === '/api/rules') {
      return json({ rules: await store.listRules(userId) });
    }
    if (method === 'POST' && path === '/api/rules') {
      const parsed = alertRuleInputSchema.safeParse(await requestBody(request));
      if (!parsed.success) return validationError(parsed);
      return json(await store.createRule(userId, parsed.data), 201);
    }

    const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
    if (ruleMatch && (method === 'PUT' || method === 'DELETE')) {
      const id = decodeURIComponent(ruleMatch[1] ?? '');
      if (!id) return json({ error: 'Invalid rule id' }, 400);
      if (method === 'DELETE') {
        return (await store.deleteRule(id))
          ? new Response(null, { status: 204 })
          : json({ error: 'Rule not found' }, 404);
      }
      const parsed = alertRuleInputSchema.safeParse(await requestBody(request));
      if (!parsed.success) return validationError(parsed);
      const updated = await store.updateRule(id, parsed.data);
      return updated ? json(updated) : json({ error: 'Rule not found' }, 404);
    }

    if (method === 'GET' && path === '/api/push/key') {
      return json({
        publicKey: config.vapid?.publicKey ?? null,
        configured: config.vapid !== null,
      });
    }
    if (method === 'POST' && path === '/api/push/subscribe') {
      const parsed = webPushSubscriptionSchema.safeParse(await requestBody(request));
      if (!parsed.success) return json({ error: 'Invalid push subscription' }, 400);
      const subscription = await store.addSubscription({
        userId,
        provider: 'webpush',
        subscriptionData: JSON.stringify(parsed.data),
      });
      return json({ id: subscription.id, enabled: subscription.enabled }, 201);
    }
    if (method === 'POST' && path === '/api/push/unsubscribe') {
      const parsed = webPushSubscriptionSchema.safeParse(await requestBody(request));
      if (!parsed.success) return json({ error: 'Invalid push subscription' }, 400);
      const removed = await store.removeSubscriptionByData(userId, JSON.stringify(parsed.data));
      return json({ removed });
    }
    if (method === 'GET' && path === '/api/push/subscriptions') {
      return json({ count: (await store.listSubscriptions(userId)).length });
    }

    if (method === 'POST' && path === '/api/notifications/test') {
      if (config.vapid === null) {
        return json({ error: 'Push is not configured on the server' }, 503);
      }
      const result = await notifications.deliver(userId, buildTestNotification(userId, now));
      return json({ sent: result.sent, delivered: result.delivered, failed: result.failed });
    }
    if (method === 'GET' && path === '/api/notifications') {
      return json({ notifications: await store.listRecentNotifications(userId, 20) });
    }

    return json({ error: 'Not found' }, 404);
  } catch (error) {
    logger.error('API request failed', { method, path, ...describeError(error) });
    return json({ error: 'Internal server error' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api')) {
      return env.ASSETS.fetch(request);
    }
    return handleApi(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    const { poller, priceService, logger } = await getRuntime(env);
    const backfillToday = async (): Promise<void> => {
      const today = londonDateOf(new Date());
      if (await priceService.isRetrieved(today)) return;
      try {
        await priceService.refresh(today);
      } catch (error) {
        logger.error('Current-day price backfill failed', {
          date: today,
          ...describeError(error),
        });
      }
    };
    context.waitUntil(Promise.all([backfillToday(), poller.runScheduled()]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
