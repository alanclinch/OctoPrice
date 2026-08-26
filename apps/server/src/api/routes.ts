/**
 * The HTTP API consumed by the PWA.
 *
 * Handlers stay thin: validate input, call a service, shape a response.
 * Anything resembling a decision belongs in `@octoprice/core` or a service so
 * it can be tested without HTTP.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  REGIONS,
  addDays,
  alertRuleInputSchema,
  findCheapestWindow,
  findNextPeriod,
  findPeriodAt,
  isDayComplete,
  londonDateOf,
  rankWindows,
  summariseDay,
  userSettingsInputSchema,
  webPushSubscriptionSchema,
  buildTestNotification,
  expectedPeriodCount,
  type PricingDate,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import type { PriceService } from '../prices/service.ts';
import type { NotificationService } from '../notifications/service.ts';
import type { PricePoller } from '../scheduler/poller.ts';
import type { AppConfig } from '../config.ts';
import { buildInfo } from '../version.ts';
import { describeError, type Logger } from '../logger.ts';

export interface ApiDependencies {
  config: AppConfig;
  store: Store;
  priceService: PriceService;
  notifications: NotificationService;
  poller: PricePoller | null;
  logger: Logger;
  now?: () => Date;
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

const idParamSchema = z.object({ id: z.string().min(1) });

/** Shapes one pricing day the way every price endpoint returns it. */
function describeDay(priceService: PriceService, date: PricingDate) {
  const periods = priceService.storedDay(date);
  return {
    date,
    periods,
    summary: summariseDay(periods, date),
    complete: isDayComplete(periods, date),
    expectedPeriodCount: expectedPeriodCount(date),
  };
}

export function createApiRoutes(deps: ApiDependencies): FastifyPluginAsync {
  const { config, store, priceService, notifications, poller, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const userId = config.userId;

  return async (app: FastifyInstance): Promise<void> => {
    // --- Health and status -------------------------------------------------

    app.get('/health', async () => ({ status: 'ok', time: now().toISOString() }));

    app.get('/status', async () => {
      const today = londonDateOf(now());
      const tomorrow = addDays(today, 1);
      const todayPeriods = priceService.storedDay(today);
      const tomorrowPeriods = priceService.storedDay(tomorrow);
      const { version, commit } = buildInfo();

      return {
        version,
        commit,
        tariffCode: priceService.tariff().tariffCode,
        productCode: priceService.tariff().productCode,
        region: priceService.tariff().region,
        lastCheckStartedAt: store.getState('last_check_started_at'),
        lastSuccessfulRetrievalAt: store.getState('last_successful_retrieval_at'),
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
        storedPeriodCount: store.countPrices(),
        lastNotificationAt: store.lastNotificationAt(userId),
        pushConfigured: config.vapid !== null,
        schedulerEnabled: config.enableScheduler,
      };
    });

    // --- Prices ------------------------------------------------------------

    /** Everything the dashboard needs in one request. */
    app.get('/overview', async () => {
      const at = now();
      const today = londonDateOf(at);
      const tomorrow = addDays(today, 1);
      const todayPeriods = priceService.storedDay(today);
      const tomorrowPeriods = priceService.storedDay(tomorrow);
      const known = [...todayPeriods, ...tomorrowPeriods];

      return {
        now: at.toISOString(),
        current: findPeriodAt(known, at),
        next: findNextPeriod(known, at),
        today: describeDay(priceService, today),
        tomorrow: describeDay(priceService, tomorrow),
        settings: store.getSettings(userId),
        tariff: priceService.tariff(),
      };
    });

    app.get('/prices', async (request, reply) => {
      const parsed = dateQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }
      const date = parsed.data.date ?? londonDateOf(now());
      return describeDay(priceService, date);
    });

    /** Cheapest continuous windows for a day (DESIGN.md section 10). */
    app.get('/windows', async (request, reply) => {
      const parsed = windowQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }
      const { durationMinutes, limit } = parsed.data;
      const date = parsed.data.date ?? londonDateOf(now());
      const periods = priceService.storedDay(date);

      return {
        date,
        durationMinutes,
        cheapest: findCheapestWindow(periods, durationMinutes),
        ranked: rankWindows(periods, durationMinutes, limit),
      };
    });

    /** Manual "check Octopus now", for the status page and for debugging. */
    app.post('/check-now', async (request, reply) => {
      const parsed = dateQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }
      const date = parsed.data.date ?? addDays(londonDateOf(now()), 1);

      try {
        const result = await priceService.refresh(date);
        if (result.complete && poller) {
          await poller.checkAndDispatch(date);
        }
        return {
          date,
          complete: result.complete,
          periodCount: result.periods.length,
          missingCount: result.missingCount,
        };
      } catch (error) {
        logger.error('Manual price check failed', { date, ...describeError(error) });
        return reply.status(502).send({ error: 'Could not reach the Octopus API' });
      }
    });

    // --- Regions and settings ---------------------------------------------

    app.get('/regions', async () => ({ regions: REGIONS }));

    app.get('/settings', async () => store.getSettings(userId));

    app.patch('/settings', async (request, reply) => {
      const parsed = userSettingsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }
      return store.updateSettings(userId, parsed.data);
    });

    // --- Alert rules -------------------------------------------------------

    app.get('/rules', async () => ({ rules: store.listRules(userId) }));

    app.post('/rules', async (request, reply) => {
      const parsed = alertRuleInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }
      return reply.status(201).send(store.createRule(userId, parsed.data));
    });

    app.put('/rules/:id', async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid rule id' });

      const parsed = alertRuleInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message });
      }

      const updated = store.updateRule(params.data.id, parsed.data);
      if (!updated) return reply.status(404).send({ error: 'Rule not found' });
      return updated;
    });

    app.delete('/rules/:id', async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid rule id' });

      const deleted = store.deleteRule(params.data.id);
      if (!deleted) return reply.status(404).send({ error: 'Rule not found' });
      return reply.status(204).send();
    });

    // --- Push notifications -----------------------------------------------

    /** The public VAPID key the browser needs in order to subscribe. */
    app.get('/push/key', async () => ({
      publicKey: config.vapid?.publicKey ?? null,
      configured: config.vapid !== null,
    }));

    app.post('/push/subscribe', async (request, reply) => {
      const parsed = webPushSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid push subscription' });
      }
      const subscription = store.addSubscription({
        userId,
        provider: 'webpush',
        subscriptionData: JSON.stringify(parsed.data),
      });
      // Deliberately does not echo the subscription back.
      return reply.status(201).send({ id: subscription.id, enabled: subscription.enabled });
    });

    app.post('/push/unsubscribe', async (request, reply) => {
      const parsed = webPushSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid push subscription' });
      }
      const removed = store.removeSubscriptionByData(userId, JSON.stringify(parsed.data));
      return { removed };
    });

    app.get('/push/subscriptions', async () => ({
      // Counts only. The subscription payload is a secret.
      count: store.listSubscriptions(userId).length,
    }));

    app.post('/notifications/test', async (_request, reply) => {
      if (config.vapid === null) {
        return reply.status(503).send({ error: 'Push is not configured on the server' });
      }
      const result = await notifications.deliver(userId, buildTestNotification(userId, now()));
      return { sent: result.sent, delivered: result.delivered, failed: result.failed };
    });

    app.get('/notifications', async () => ({
      notifications: store.listRecentNotifications(userId, 20),
    }));
  };
}
