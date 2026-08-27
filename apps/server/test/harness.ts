/**
 * Shared setup for the server tests.
 *
 * Builds the whole application against an in-memory database, a fake Octopus
 * API and a recording notification sender, then signs in as the owner. Tests
 * therefore exercise the real routing, the real authentication and the real
 * dispatch path without a network or a device.
 */

import type { FastifyInstance, InjectOptions } from 'fastify';
import type { NotificationPayload, NotificationProvider } from '@octoprice/core';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { hashToken } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/db/sqlite.ts';
import type { TariffSelection } from '../src/prices/service.ts';
import type {
  DeliveryResult,
  DeliveryTarget,
  NotificationSender,
} from '../src/notifications/provider.ts';
import { fakeFetch, makeRateRecords, ratesResponse, silentLogger } from './helpers.ts';

/** Fixed "now": 17:00 London on 15 January 2026, so tomorrow is the 16th. */
export const NOW = new Date('2026-01-15T17:00:00Z');
export const TODAY = '2026-01-15';
export const TOMORROW = '2026-01-16';

/** The owner's access token in tests. Any value works; this one is readable. */
export const OWNER_TOKEN = 'test-owner-token';
export const OWNER_ID = 'default';

export const PUSH_SUBSCRIPTION = {
  endpoint: 'https://push.example.com/subscription/abc123',
  keys: { p256dh: 'a-public-key', auth: 'an-auth-secret' },
};

/**
 * A full 48-period day: mostly 20p, with a two-hour cheap stretch from 02:00
 * and one negative period at 10:00.
 */
export function tomorrowPrices(): number[] {
  const values = Array.from({ length: 48 }, () => 20);
  for (const index of [4, 5, 6, 7]) values[index] = 5;
  values[20] = -2;
  return values;
}

/** Records what would have been sent, and can be made to fail on demand. */
export class RecordingSender implements NotificationSender {
  readonly provider: NotificationProvider = 'webpush';
  readonly available = true;
  readonly sent: NotificationPayload[] = [];
  shouldFail = false;

  async send(
    payload: NotificationPayload,
    targets: readonly DeliveryTarget[],
  ): Promise<DeliveryResult[]> {
    if (this.shouldFail) {
      return targets.map((target) => ({
        targetId: target.id,
        success: false,
        error: 'push service unavailable',
      }));
    }
    this.sent.push(payload);
    return targets.map((target) => ({ targetId: target.id, success: true }));
  }
}

export interface TestContext {
  built: BuiltApp;
  app: FastifyInstance;
  sender: RecordingSender;
  /** The tariff the test owner is on, needed by the price service. */
  tariff: TariffSelection;
  /** Injects a request already carrying the owner's session. */
  inject: (options: InjectOptions) => ReturnType<FastifyInstance['inject']>;
  /** Injects with no credentials, for checking that a route is protected. */
  injectAnonymous: (options: InjectOptions) => ReturnType<FastifyInstance['inject']>;
  /** Creates an invite and returns the token from its link. */
  invite: (name: string) => Promise<{ id: string; token: string }>;
  /** Authorisation header for someone other than the owner. */
  asUser: (token: string) => Record<string, string>;
}

export async function createTestApp(
  rates: number[] = tomorrowPrices(),
  // Building the poller does not start it, so this is safe in tests and lets
  // them exercise the real dispatch gate rather than calling past it.
  options: { scheduler?: boolean; forecastBaseline?: boolean } = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    DEFAULT_REGION: 'C',
    ENABLE_SCHEDULER: options.scheduler ? 'true' : 'false',
    FORECAST_BASELINE_ENABLED: options.forecastBaseline ? 'true' : 'false',
    WEB_DIST_PATH: 'does-not-exist',
    VAPID_PUBLIC_KEY: 'test-public',
    VAPID_PRIVATE_KEY: 'test-private',
    OCTOPUS_PRODUCT_CODE: 'AGILE-24-10-01',
  } as NodeJS.ProcessEnv);

  const sender = new RecordingSender();
  const built = await buildApp(config, {
    store: new SqliteStore({ file: ':memory:', defaultRegion: 'C' }),
    logger: silentLogger(),
    senders: [sender],
    now: () => NOW,
    fetchFn: fakeFetch({
      'standard-unit-rates': ratesResponse(makeRateRecords(TOMORROW, rates)),
    }),
  });

  // The migration creates the owner without a link. Tests issue one so they
  // can authenticate, exactly as the owner-link script does in real use.
  await built.store.setUserToken(OWNER_ID, await hashToken(OWNER_TOKEN));
  await built.store.getSettings(OWNER_ID);
  const tariff = await built.priceService.tariff(OWNER_ID);

  const asUser = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
  });

  const withAuth = (injectOptions: InjectOptions): InjectOptions => ({
    ...injectOptions,
    headers: { ...injectOptions.headers, ...asUser(OWNER_TOKEN) },
  });

  const context: TestContext = {
    built,
    app: built.app,
    sender,
    tariff,
    asUser,
    inject: (injectOptions) => built.app.inject(withAuth(injectOptions)),
    injectAnonymous: (injectOptions) => built.app.inject(injectOptions),
    invite: async (name: string) => {
      const created = await built.app.inject(
        withAuth({ method: 'POST', url: '/api/invites', payload: { name } }),
      );
      const body = created.json() as { user: { id: string }; link: string };
      const token = new URL(body.link).searchParams.get('invite');
      if (!token) throw new Error('invite link carried no token');

      // Claim it, so the person exists in the same state as a real invitee:
      // settings created and starter rules seeded.
      await built.app.inject({
        method: 'POST',
        url: '/api/session/claim',
        payload: { token },
      });
      return { id: body.user.id, token };
    },
  };

  return context;
}
