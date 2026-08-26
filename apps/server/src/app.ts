/**
 * Application wiring.
 *
 * Everything is constructed here and passed in explicitly rather than reached
 * for through imports, which is what lets the tests build the whole app
 * against an in-memory database and a fake Octopus API.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { DEFAULT_ALERT_RULES, alertRuleInputSchema } from '@octoprice/core';
import type { AppConfig } from './config.ts';
import { LOG_EVENTS, createLogger, type Logger } from './logger.ts';
import { SqliteStore } from './db/sqlite.ts';
import type { Store } from './db/store.ts';
import { OctopusClient } from './octopus/client.ts';
import { PriceService } from './prices/service.ts';
import { NotificationService } from './notifications/service.ts';
import { WebPushSender } from './notifications/webpush.ts';
import type { NotificationSender } from './notifications/provider.ts';
import { AlertDispatcher } from './alerts/dispatcher.ts';
import { PricePoller } from './scheduler/poller.ts';
import { createApiRoutes } from './api/routes.ts';
import { buildInfo } from './version.ts';

export interface BuildAppOverrides {
  store?: Store;
  logger?: Logger;
  fetchFn?: typeof fetch;
  senders?: readonly NotificationSender[];
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  store: Store;
  logger: Logger;
  priceService: PriceService;
  notifications: NotificationService;
  dispatcher: AlertDispatcher;
  poller: PricePoller | null;
  close(): Promise<void>;
}

/**
 * Creates the alert rules a new installation starts with.
 *
 * These are ordinary rules the user can edit or delete; seeding just means
 * the app is useful before anyone opens Settings.
 */
function seedDefaultRules(store: Store, userId: string, logger: Logger): void {
  if (store.getState('rules_seeded') !== null) return;
  if (store.listRules(userId).length === 0) {
    for (const rule of DEFAULT_ALERT_RULES) {
      store.createRule(userId, alertRuleInputSchema.parse(rule));
    }
    logger.info('Created default alert rules', { count: DEFAULT_ALERT_RULES.length });
  }
  store.setState('rules_seeded', new Date().toISOString());
}

/** Resolves the built PWA directory, or null when it has not been built. */
function resolveWebDist(config: AppConfig): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, config.webDistPath),
    resolve(here, '..', config.webDistPath),
    resolve(process.cwd(), config.webDistPath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function buildApp(
  config: AppConfig,
  overrides: BuildAppOverrides = {},
): Promise<BuiltApp> {
  const logger =
    overrides.logger ?? createLogger({ level: config.logLevel, bindings: { app: 'octoprice' } });

  const store =
    overrides.store ??
    new SqliteStore({ file: config.databaseFile, defaultRegion: config.defaultRegion });

  seedDefaultRules(store, config.userId, logger);

  const client = new OctopusClient({
    baseUrl: config.octopus.baseUrl,
    logger,
    ...(overrides.fetchFn ? { fetchFn: overrides.fetchFn } : {}),
  });

  const priceService = new PriceService({
    store,
    client,
    logger,
    userId: config.userId,
    forcedProductCode: config.octopus.productCode,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const senders = overrides.senders ?? [new WebPushSender(config.vapid)];
  const notifications = new NotificationService({
    store,
    senders,
    logger,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const dispatcher = new AlertDispatcher({
    store,
    notifications,
    logger,
    userId: config.userId,
  });

  const poller = config.enableScheduler
    ? new PricePoller({
        priceService,
        dispatcher,
        logger,
        window: {
          start: config.poll.start,
          cutoff: config.poll.cutoff,
          intervalMinutes: config.poll.intervalMinutes,
        },
        ...(overrides.now ? { now: overrides.now } : {}),
      })
    : null;

  const app = Fastify({
    // The application does its own structured logging; Fastify's would be a
    // second, differently shaped log stream.
    logger: false,
    trustProxy: true,
  });

  await app.register(fastifyCors, { origin: config.nodeEnv === 'development' });

  await app.register(
    createApiRoutes({
      config,
      store,
      priceService,
      notifications,
      poller,
      logger,
      ...(overrides.now ? { now: overrides.now } : {}),
    }),
    { prefix: '/api' },
  );

  const webDist = resolveWebDist(config);
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // Single-page app: anything that is not an API route or a real file is
    // served the app shell so client-side routing works on a hard refresh.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
    logger.info('Serving the built PWA', { webDist });
  } else {
    logger.warn('No built PWA found; serving the API only', {
      searched: config.webDistPath,
    });
  }

  app.addHook('onResponse', (request, reply, done) => {
    if (request.url.startsWith('/api')) {
      logger.debug('Request handled', {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
    done();
  });

  const close = async (): Promise<void> => {
    poller?.stop();
    await app.close();
    store.close();
  };

  const { version, commit } = buildInfo();
  logger.info('Application built', {
    event: LOG_EVENTS.serverStarted,
    version,
    commit,
    schedulerEnabled: config.enableScheduler,
    pushConfigured: config.vapid !== null,
  });

  return { app, store, logger, priceService, notifications, dispatcher, poller, close };
}
