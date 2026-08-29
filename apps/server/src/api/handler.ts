/**
 * The API, defined once.
 *
 * This module knows nothing about Fastify or the Workers runtime: it takes a
 * plain request description and returns a plain response. `api/routes.ts`
 * adapts it to Fastify for local development, and `worker.ts` adapts it to
 * `fetch` for production.
 *
 * It used to be two separate implementations of the same twenty endpoints,
 * which meant production ran the copy the tests never touched. Multi-user
 * access control made that untenable - authentication written twice is
 * authentication wrong once - so the routing moved here.
 */

import {
  FORECAST_REFERENCE_REGION,
  REGIONS,
  applyRegionalPriceTransform,
  describeDayCoverage,
  addDays,
  alertRuleInputSchema,
  buildTestNotification,
  buildTariffCode,
  endOfLondonDay,
  fitRegionalPriceTransform,
  findCheapestWindow,
  findNextPeriod,
  findPeriodAt,
  inviteInputSchema,
  isDayComplete,
  londonDateOf,
  londonDayPeriodStarts,
  rankWindows,
  summariseDay,
  startOfLondonDay,
  userSettingsInputSchema,
  webPushSubscriptionSchema,
  expectedPeriodCount,
  DEFAULT_ALERT_RULES,
  type PricingDate,
  type User,
} from '@octoprice/core';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import type { Store } from '../db/store.ts';
import type { PriceService } from '../prices/service.ts';
import type { NotificationService } from '../notifications/service.ts';
import type { AlertDispatcher } from '../alerts/dispatcher.ts';
import type { PricePoller } from '../scheduler/poller.ts';
import { describeError, type Logger } from '../logger.ts';
import {
  clearSessionCookie,
  generateToken,
  hashToken,
  inviteLink,
  readToken,
  resolveUser,
  sessionCookie,
} from '../auth.ts';
import { buildInfo } from '../version.ts';
import {
  readBaselineForecastCache,
  unavailableBaselineForecast,
  type BaselineForecast,
} from '../forecast/baseline.ts';
import { readAnalogueShadowStatus } from '../forecast/analogue.ts';

export interface ApiRequest {
  method: string;
  /** Path including the `/api` prefix, e.g. `/api/rules`. */
  path: string;
  query: URLSearchParams;
  headers: {
    cookie?: string | null;
    authorization?: string | null;
  };
  /** Already-parsed JSON body, or undefined. */
  body?: unknown;
  /** Absolute origin of the request, used to build invite links. */
  origin: string;
}

export interface ApiResponse {
  status: number;
  /** JSON-serialisable payload. Omitted for 204. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiContext {
  config: AppConfig;
  store: Store;
  priceService: PriceService;
  notifications: NotificationService;
  dispatcher: AlertDispatcher;
  poller: PricePoller | null;
  logger: Logger;
  now: () => Date;
}

const json = (body: unknown, status = 200, headers?: Record<string, string>): ApiResponse =>
  headers ? { status, body, headers } : { status, body };

const fail = (status: number, error: string): ApiResponse => ({ status, body: { error } });

function validationFailure(error: z.ZodError): ApiResponse {
  return fail(400, error.issues[0]?.message ?? 'Invalid request');
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

const claimSchema = z.object({ token: z.string().min(1).max(200) });

function queryObject(query: URLSearchParams): Record<string, string> {
  return Object.fromEntries(query.entries());
}

function requiresSecureCookie(config: AppConfig, origin: string): boolean {
  return !config.allowInsecureCookie || origin.startsWith('https://');
}

/** Shapes one pricing day the way every price endpoint returns it. */
async function describeDay(priceService: PriceService, date: PricingDate, tariffCode: string) {
  const periods = await priceService.storedDay(date, tariffCode);
  return {
    date,
    periods,
    summary: summariseDay(periods, date),
    complete: isDayComplete(periods, date),
    expectedPeriodCount: expectedPeriodCount(date),
  };
}

async function safeBaselineForecast(options: {
  enabled: boolean;
  store: Store;
  tariff: Awaited<ReturnType<PriceService['tariff']>>;
  now: Date;
  logger: Logger;
}): Promise<BaselineForecast> {
  if (!options.enabled) return unavailableBaselineForecast('disabled');

  try {
    return await readBaselineForecastCache(options);
  } catch (error) {
    options.logger.warn('Forecast unavailable; returning confirmed prices', describeError(error));
    return unavailableBaselineForecast('failed');
  }
}

/**
 * Gives a new person the starter rules, so their first visit is useful before
 * they have configured anything.
 */
async function seedRulesFor(store: Store, userId: string): Promise<void> {
  const key = `rules_seeded:${userId}`;
  const claimed = await store.setStateIfAbsent(key, new Date().toISOString());
  if (!claimed) return;

  for (const rule of DEFAULT_ALERT_RULES) {
    await store.createRule(userId, alertRuleInputSchema.parse(rule));
  }
}

/** Public view of a person, safe to return over the API. */
function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    isOwner: user.isOwner,
    createdAt: user.createdAt,
    claimedAt: user.claimedAt,
    lastSeenAt: user.lastSeenAt,
    hasLink: user.hasToken,
  };
}

/** Routes that work without a session. Everything else needs one. */
const PUBLIC_PATHS = new Set(['/api/health', '/api/session/claim', '/api/regions']);

export async function handleApiRequest(
  context: ApiContext,
  request: ApiRequest,
): Promise<ApiResponse> {
  const { config, store, priceService, notifications, dispatcher, logger } = context;
  const now = context.now();
  const { method, path } = request;

  // --- Public --------------------------------------------------------------

  if (method === 'GET' && path === '/api/health') {
    return json({ status: 'ok', time: now.toISOString() });
  }

  if (method === 'GET' && path === '/api/regions') {
    return json({ regions: REGIONS });
  }

  /**
   * Exchanges an invite token for a session cookie.
   *
   * Deliberately does not say whether an unknown token ever existed, and
   * marks the invite claimed so the owner can see it has been used.
   */
  if (method === 'POST' && path === '/api/session/claim') {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) return validationFailure(parsed.error);

    const user = await store.findUserByTokenHash(await hashToken(parsed.data.token));
    if (!user) {
      logger.warn('Rejected an unknown access token', { path });
      return fail(401, 'That link is not valid. Ask for a new one.');
    }

    await store.markUserClaimed(user.id, now);
    await store.recordUserSeen(user.id, now);
    await seedRulesFor(store, user.id);

    return json({ user: publicUser(user) }, 200, {
      'set-cookie': sessionCookie(parsed.data.token, requiresSecureCookie(config, request.origin)),
    });
  }

  // --- Authentication ------------------------------------------------------

  const user = await resolveUser(store, readToken(request.headers), now);

  if (!user) {
    if (!PUBLIC_PATHS.has(path)) {
      return fail(401, 'Sign in with your invite link.');
    }
    return fail(404, 'Not found');
  }

  const userId = user.id;

  if (method === 'GET' && path === '/api/session') {
    return json({ user: publicUser(user) });
  }

  if (method === 'POST' && path === '/api/session/signout') {
    return json({ signedOut: true }, 200, {
      'set-cookie': clearSessionCookie(requiresSecureCookie(config, request.origin)),
    });
  }

  // --- Forecast experiment (owner only) -----------------------------------

  if (method === 'GET' && path === '/api/forecast-experiment') {
    if (!user.isOwner) return fail(403, 'Only the owner can view forecast experiments.');

    const tariff = await priceService.tariff(userId);
    const shadow = await readAnalogueShadowStatus(store, tariff.productCode);
    const today = londonDateOf(now);
    const historyFrom = startOfLondonDay(addDays(today, -28));
    const historyTo = endOfLondonDay(today);
    const referenceTariffCode = buildTariffCode(tariff.productCode, FORECAST_REFERENCE_REGION);
    const [referenceHistory, targetHistory] = await Promise.all([
      store.getPrices(referenceTariffCode, historyFrom, historyTo),
      tariff.region === FORECAST_REFERENCE_REGION
        ? Promise.resolve([])
        : store.getPrices(tariff.tariffCode, historyFrom, historyTo),
    ]);
    const transform = fitRegionalPriceTransform(
      referenceHistory,
      targetHistory,
      tariff.region === FORECAST_REFERENCE_REGION,
    );
    const displayRegion = transform ? tariff.region : FORECAST_REFERENCE_REGION;
    const displayTariffCode = transform ? tariff.tariffCode : referenceTariffCode;
    const runs = shadow.runs.flatMap((run) => {
      const targets = londonDayPeriodStarts(run.targetDate as PricingDate);
      const values = transform
        ? applyRegionalPriceTransform(run.periods, targets, transform)
        : run.periods;
      if (!values || values.length !== targets.length) return [];
      return [
        {
          id: run.id,
          model: run.model,
          targetDate: run.targetDate,
          generatedAt: run.generatedAt,
          issueCutoff: run.issueCutoff,
          inputVintages: run.inputVintages,
          score: run.score,
          periods: targets.map((target, index) => ({
            validFrom: target.toISOString(),
            validTo: new Date(target.getTime() + 30 * 60 * 1000).toISOString(),
            valueIncVat: values[index] as number,
          })),
        },
      ];
    });
    const latestDate = runs[0]?.targetDate as PricingDate | undefined;
    const actual = latestDate
      ? await store.getPrices(
          displayTariffCode,
          startOfLondonDay(latestDate),
          endOfLondonDay(latestDate),
        )
      : [];
    const phase =
      runs.length > 0
        ? 'running'
        : shadow.preparedDays >= shadow.requiredPreparedDays
          ? 'waiting-for-forecast'
          : shadow.preparedDays > 0
            ? 'preparing-days'
            : 'collecting-history';

    return json({
      experimental: true,
      phase,
      requestedRegion: tariff.region,
      displayRegion,
      regionalTransformAvailable: transform !== null,
      referenceRegion: FORECAST_REFERENCE_REGION,
      historyThrough: shadow.historyThrough,
      preparedThrough: shadow.preparedThrough,
      preparedDays: shadow.preparedDays,
      requiredPreparedDays: shadow.requiredPreparedDays,
      runs,
      actual,
    });
  }

  // --- Status --------------------------------------------------------------

  if (method === 'GET' && path === '/api/status') {
    const today = londonDateOf(now);
    const tomorrow = addDays(today, 1);
    const tariff = await priceService.tariff(userId);
    const [todayPeriods, tomorrowPeriods] = await Promise.all([
      priceService.storedDay(today, tariff.tariffCode),
      priceService.storedDay(tomorrow, tariff.tariffCode),
    ]);
    const { version, commit } = buildInfo();

    return json({
      version,
      commit,
      tariffCode: tariff.tariffCode,
      productCode: tariff.productCode,
      region: tariff.region,
      lastCheckStartedAt: await store.getState('last_check_started_at'),
      lastSuccessfulRetrievalAt: await store.getState('last_successful_retrieval_at'),
      // `publishable` is what a person actually cares about: whether the day
      // is usable. `complete` is a technical detail - a day sits one hour
      // short until the following day's batch lands - and saying "partial"
      // about it reads as a fault when nothing is wrong.
      today: {
        date: today,
        periodCount: todayPeriods.length,
        complete: isDayComplete(todayPeriods, today),
        ready: describeDayCoverage(todayPeriods, today).publishable,
      },
      tomorrow: {
        date: tomorrow,
        periodCount: tomorrowPeriods.length,
        complete: isDayComplete(tomorrowPeriods, tomorrow),
        ready: describeDayCoverage(tomorrowPeriods, tomorrow).publishable,
      },
      publicationWindow: { start: config.poll.start, cutoff: config.poll.cutoff },
      isOwner: user.isOwner,
      storedPeriodCount: await store.countPrices(),
      lastNotificationAt: await store.lastNotificationAt(userId),
      pushConfigured: config.vapid !== null,
      schedulerEnabled: config.enableScheduler,
    });
  }

  // --- Prices --------------------------------------------------------------

  if (method === 'GET' && path === '/api/overview') {
    const today = londonDateOf(now);
    const tomorrow = addDays(today, 1);
    const tariff = await priceService.tariff(userId);
    const [todayDay, tomorrowDay, settings, cachedForecast] = await Promise.all([
      describeDay(priceService, today, tariff.tariffCode),
      describeDay(priceService, tomorrow, tariff.tariffCode),
      store.getSettings(userId),
      safeBaselineForecast({
        enabled: config.forecastBaselineEnabled,
        store,
        tariff,
        now,
        logger,
      }),
    ]);
    const known = [...todayDay.periods, ...tomorrowDay.periods];
    const confirmedStarts = new Set(known.map((period) => period.validFrom));
    const forecast = {
      ...cachedForecast,
      periods: cachedForecast.periods.filter((period) => !confirmedStarts.has(period.validFrom)),
    };

    return json({
      now: now.toISOString(),
      current: findPeriodAt(known, now),
      next: findNextPeriod(known, now),
      today: todayDay,
      tomorrow: tomorrowDay,
      forecast,
      settings,
      tariff,
      user: publicUser(user),
    });
  }

  if (method === 'GET' && path === '/api/prices') {
    const parsed = dateQuerySchema.safeParse(queryObject(request.query));
    if (!parsed.success) return validationFailure(parsed.error);
    const tariff = await priceService.tariff(userId);
    return json(
      await describeDay(priceService, parsed.data.date ?? londonDateOf(now), tariff.tariffCode),
    );
  }

  if (method === 'GET' && path === '/api/windows') {
    const parsed = windowQuerySchema.safeParse(queryObject(request.query));
    if (!parsed.success) return validationFailure(parsed.error);

    const { durationMinutes, limit } = parsed.data;
    const date = parsed.data.date ?? londonDateOf(now);
    const tariff = await priceService.tariff(userId);
    const periods = await priceService.storedDay(date, tariff.tariffCode);

    return json({
      date,
      durationMinutes,
      cheapest: findCheapestWindow(periods, durationMinutes),
      ranked: rankWindows(periods, durationMinutes, limit),
    });
  }

  if (method === 'POST' && path === '/api/check-now') {
    const parsed = dateQuerySchema.safeParse(queryObject(request.query));
    if (!parsed.success) return validationFailure(parsed.error);
    const date = parsed.data.date ?? addDays(londonDateOf(now), 1);

    try {
      const result = await priceService.refresh(date, await priceService.tariff(userId));
      if (result.publishable) await dispatcher.dispatchForDay(date, result.periods, userId);
      return json({
        date,
        complete: result.complete,
        publishable: result.publishable,
        periodCount: result.periods.length,
        missingCount: result.missingCount,
      });
    } catch (error) {
      logger.error('Manual price check failed', { date, ...describeError(error) });
      return fail(502, 'Could not reach the Octopus API');
    }
  }

  // --- Settings ------------------------------------------------------------

  if (method === 'GET' && path === '/api/settings') {
    return json(await store.getSettings(userId));
  }

  if (method === 'PATCH' && path === '/api/settings') {
    const parsed = userSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) return validationFailure(parsed.error);

    const previous = await store.getSettings(userId);
    const regionChanged = Boolean(parsed.data.region) && parsed.data.region !== previous.region;

    const updated = await store.updateSettings(userId, {
      ...parsed.data,
      // Choosing a region *is* confirming it, so there is no separate step to
      // remember and nothing device-specific to get out of step.
      ...(parsed.data.region ? { regionConfirmed: true } : {}),
    });

    if (regionChanged) {
      // Fetch the new region straight away. Without this a person who has
      // just picked their area sees an empty app until the next publication
      // window, which looks broken rather than merely unpublished.
      const tariff = await priceService.tariff(userId);
      const today = londonDateOf(now);
      for (const date of [today, addDays(today, 1)]) {
        try {
          await priceService.refresh(date, tariff);
        } catch (error) {
          // Not fatal: the setting is saved either way, and the poller will
          // pick the region up on its next run.
          logger.warn('Could not backfill prices after a region change', {
            date,
            tariffCode: tariff.tariffCode,
            ...describeError(error),
          });
        }
      }
    }

    return json(updated);
  }

  // --- Alert rules ---------------------------------------------------------

  if (method === 'GET' && path === '/api/rules') {
    return json({ rules: await store.listRules(userId) });
  }

  if (method === 'POST' && path === '/api/rules') {
    const parsed = alertRuleInputSchema.safeParse(request.body);
    if (!parsed.success) return validationFailure(parsed.error);
    return json(await store.createRule(userId, parsed.data), 201);
  }

  const ruleMatch = /^\/api\/rules\/([^/]+)$/.exec(path);
  if (ruleMatch) {
    const ruleId = decodeURIComponent(ruleMatch[1] as string);
    const existing = await store.getRule(ruleId);
    // Not found and not yours are answered identically, so the API cannot be
    // used to discover whether another person's rule exists.
    if (!existing || existing.userId !== userId) return fail(404, 'Rule not found');

    if (method === 'PUT') {
      const parsed = alertRuleInputSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(parsed.error);
      const updated = await store.updateRule(ruleId, parsed.data);
      if (!updated) return fail(404, 'Rule not found');
      return json(updated);
    }

    if (method === 'DELETE') {
      await store.deleteRule(ruleId);
      return { status: 204 };
    }
  }

  // --- Push ----------------------------------------------------------------

  if (method === 'GET' && path === '/api/push/key') {
    return json({ publicKey: config.vapid?.publicKey ?? null, configured: config.vapid !== null });
  }

  if (method === 'POST' && path === '/api/push/subscribe') {
    const parsed = webPushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) return fail(400, 'Invalid push subscription');
    const subscription = await store.addSubscription({
      userId,
      provider: 'webpush',
      subscriptionData: JSON.stringify(parsed.data),
    });
    // Deliberately does not echo the subscription back.
    return json({ id: subscription.id, enabled: subscription.enabled }, 201);
  }

  if (method === 'POST' && path === '/api/push/unsubscribe') {
    const parsed = webPushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) return fail(400, 'Invalid push subscription');
    return json({
      removed: await store.removeSubscriptionByData(userId, JSON.stringify(parsed.data)),
    });
  }

  /**
   * Whether a particular device subscription belongs to *this* person.
   *
   * A browser can hold a push subscription that was registered by whoever
   * used the device before. Without this check the new signed-in person is
   * told notifications are on when the server has never heard of them.
   */
  if (method === 'POST' && path === '/api/push/status') {
    const parsed = webPushSubscriptionSchema.safeParse(request.body);
    if (!parsed.success) return fail(400, 'Invalid push subscription');

    const wanted = JSON.stringify(parsed.data);
    const mine = await store.listSubscriptions(userId);
    return json({ registered: mine.some((entry) => entry.subscriptionData === wanted) });
  }

  if (method === 'GET' && path === '/api/push/subscriptions') {
    // Counts only. The subscription payload is a secret.
    return json({ count: (await store.listSubscriptions(userId)).length });
  }

  if (method === 'POST' && path === '/api/notifications/test') {
    if (config.vapid === null) return fail(503, 'Push is not configured on the server');
    const result = await notifications.deliver(userId, buildTestNotification(userId, now));
    return json({ sent: result.sent, delivered: result.delivered, failed: result.failed });
  }

  if (method === 'GET' && path === '/api/notifications') {
    return json({ notifications: await store.listRecentNotifications(userId, 20) });
  }

  // --- Invites (owner only) ------------------------------------------------

  if (path === '/api/invites' || path.startsWith('/api/invites/')) {
    if (!user.isOwner) return fail(403, 'Only the owner can manage who has access.');

    if (method === 'GET' && path === '/api/invites') {
      return json({ users: (await store.listUsers()).map(publicUser) });
    }

    if (method === 'POST' && path === '/api/invites') {
      const parsed = inviteInputSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(parsed.error);

      const token = generateToken();
      const created = await store.createUser({
        name: parsed.data.name,
        tokenHash: await hashToken(token),
      });
      logger.info('Created an invite', { userId: created.id, name: created.name });

      // The only time the plain token is ever returned.
      return json({ user: publicUser(created), link: inviteLink(request.origin, token) }, 201);
    }

    const inviteMatch = /^\/api\/invites\/([^/]+)(\/link)?$/.exec(path);
    if (inviteMatch) {
      const targetId = decodeURIComponent(inviteMatch[1] as string);
      const isLinkRoute = inviteMatch[2] !== undefined;
      const target = await store.getUser(targetId);
      if (!target) return fail(404, 'No such person');

      if (method === 'POST' && isLinkRoute) {
        const token = generateToken();
        await store.setUserToken(targetId, await hashToken(token));
        logger.info('Reissued an access link', { userId: targetId });
        return json({ user: publicUser(target), link: inviteLink(request.origin, token) });
      }

      if (method === 'DELETE' && !isLinkRoute) {
        if (target.isOwner) return fail(400, 'The owner cannot be removed.');
        await store.deleteUser(targetId);
        logger.info('Removed a person and their data', { userId: targetId });
        return { status: 204 };
      }
    }
  }

  return fail(404, 'Not found');
}

export { PUBLIC_PATHS };
