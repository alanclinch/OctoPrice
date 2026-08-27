import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NotificationPayload, NotificationProvider } from '@octoprice/core';
import { buildApp, type BuiltApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SqliteStore } from '../src/db/sqlite.ts';
import type {
  DeliveryResult,
  DeliveryTarget,
  NotificationSender,
} from '../src/notifications/provider.ts';
import { fakeFetch, makeRateRecords, ratesResponse, silentLogger } from './helpers.ts';

/** Fixed "now": 17:00 London on 15 January 2026, so tomorrow is the 16th. */
const NOW = new Date('2026-01-15T17:00:00Z');
const TODAY = '2026-01-15';
const TOMORROW = '2026-01-16';

/**
 * A full 48-period day: mostly 20p, with a two-hour cheap stretch from 02:00
 * and one negative period at 10:00.
 */
function tomorrowPrices(): number[] {
  const values = Array.from({ length: 48 }, () => 20);
  for (const index of [4, 5, 6, 7]) values[index] = 5;
  values[20] = -2;
  return values;
}

/** Records what would have been sent, and can be made to fail on demand. */
class RecordingSender implements NotificationSender {
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

const PUSH_SUBSCRIPTION = {
  endpoint: 'https://push.example.com/subscription/abc123',
  keys: { p256dh: 'a-public-key', auth: 'an-auth-secret' },
};

interface TestContext {
  built: BuiltApp;
  app: FastifyInstance;
  sender: RecordingSender;
}

async function createTestApp(
  rates: number[] = tomorrowPrices(),
  // Building the poller does not start it, so this is safe in tests and lets
  // them exercise the real dispatch gate rather than calling past it.
  options: { scheduler?: boolean } = {},
): Promise<TestContext> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    DEFAULT_REGION: 'C',
    ENABLE_SCHEDULER: options.scheduler ? 'true' : 'false',
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

  return { built, app: built.app, sender };
}

describe('price retrieval and alerting', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
    // Register a device so notifications have somewhere to go.
    await context.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });
  });

  afterEach(async () => {
    await context.built.close();
  });

  it('stores a complete day and reports it as complete', async () => {
    const result = await context.built.priceService.refresh(TOMORROW);
    expect(result.complete).toBe(true);
    expect(result.periods).toHaveLength(48);
    expect(result.missingCount).toBe(0);
  });

  it('sends the daily summary and one notification per rule match', async () => {
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

    const types = context.sender.sent.map((payload) => payload.type);
    expect(types.filter((type) => type === 'daily_prices')).toHaveLength(1);
    // Negative prices (1), Cheap electricity (2 stretches), Two cheap hours (1).
    expect(types.filter((type) => type === 'rule_match')).toHaveLength(4);
  });

  it('describes the day correctly in the daily summary', async () => {
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

    const daily = context.sender.sent.find((payload) => payload.type === 'daily_prices');
    expect(daily?.body).toContain('Cheapest: -2p/kWh at 10:00');
    expect(daily?.body).toContain('Most expensive: 20p/kWh');
    expect(daily?.body).toContain('1 period is negative');
  });

  it('does not send anything twice when the day is polled again', async () => {
    const first = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, first.periods);
    const countAfterFirst = context.sender.sent.length;

    const second = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, second.periods);

    expect(context.sender.sent).toHaveLength(countAfterFirst);
  });

  it('records the day as retrieved so polling can stop', async () => {
    expect(await context.built.priceService.isRetrieved(TOMORROW)).toBe(false);
    await context.built.priceService.refresh(TOMORROW);
    expect(await context.built.priceService.isRetrieved(TOMORROW)).toBe(true);
  });

  it('marks matched rules as triggered', async () => {
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

    const rules = await context.built.store.listRules('default');
    expect(rules.every((rule) => rule.lastTriggeredAt !== null)).toBe(true);
  });

  it('retries a notification that failed the first time', async () => {
    context.sender.shouldFail = true;
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);
    expect(context.sender.sent).toHaveLength(0);

    // The dedupe key was not claimed by the failure, so a later attempt works.
    context.sender.shouldFail = false;
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);
    expect(context.sender.sent.length).toBeGreaterThan(0);
  });

  it('respects the daily-notification setting', async () => {
    await context.built.store.updateSettings('default', { notifyDailyPrices: false });
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

    expect(context.sender.sent.some((payload) => payload.type === 'daily_prices')).toBe(false);
    expect(context.sender.sent.some((payload) => payload.type === 'rule_match')).toBe(true);
  });

  it('respects the rule-notification setting', async () => {
    await context.built.store.updateSettings('default', { notifyRuleMatches: false });
    const result = await context.built.priceService.refresh(TOMORROW);
    await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

    expect(context.sender.sent.some((payload) => payload.type === 'rule_match')).toBe(false);
  });
});

describe('the real Octopus publication shape', () => {
  // Regression test for the bug that made the app silent in production.
  //
  // Octopus publishes a day up to roughly 23:00 local and delivers the last
  // hour later, usually with the following day's batch. Every earlier test
  // built a complete 48-period day, so nothing caught that gating
  // notification on completeness meant never notifying at all.
  const PARTIAL = tomorrowPrices().slice(0, 46);

  it('reports a 46-of-48 day as publishable but not complete', async () => {
    const context = await createTestApp(PARTIAL);
    try {
      const result = await context.built.priceService.refresh(TOMORROW);
      expect(result.complete).toBe(false);
      expect(result.publishable).toBe(true);
      expect(result.missingCount).toBe(2);
    } finally {
      await context.built.close();
    }
  });

  it('sends the daily summary and rule alerts without waiting for the last hour', async () => {
    const context = await createTestApp(PARTIAL);
    try {
      await context.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: PUSH_SUBSCRIPTION,
      });

      const result = await context.built.priceService.refresh(TOMORROW);
      await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);

      const types = context.sender.sent.map((payload) => payload.type);
      expect(types.filter((type) => type === 'daily_prices')).toHaveLength(1);
      expect(types.filter((type) => type === 'rule_match').length).toBeGreaterThan(0);
    } finally {
      await context.built.close();
    }
  });

  it('dispatches through the poller gate, which is where the bug lived', async () => {
    // Deliberately goes through checkAndDispatch rather than calling
    // dispatchForDay directly, because the gate is the thing that was wrong.
    const context = await createTestApp(PARTIAL, { scheduler: true });
    try {
      await context.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: PUSH_SUBSCRIPTION,
      });

      expect(context.built.poller).not.toBeNull();
      await context.built.poller?.checkAndDispatch(TOMORROW);

      expect(context.sender.sent.length).toBeGreaterThan(0);
      expect(context.sender.sent.some((payload) => payload.type === 'daily_prices')).toBe(true);
    } finally {
      await context.built.close();
    }
  });

  it('records the day as retrieved so polling stops', async () => {
    const context = await createTestApp(PARTIAL);
    try {
      await context.built.priceService.refresh(TOMORROW);
      expect(await context.built.priceService.isRetrieved(TOMORROW)).toBe(true);
    } finally {
      await context.built.close();
    }
  });

  it('does not repeat itself when the final periods arrive', async () => {
    const context = await createTestApp(PARTIAL);
    try {
      await context.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: PUSH_SUBSCRIPTION,
      });

      const partialResult = await context.built.priceService.refresh(TOMORROW);
      await context.built.dispatcher.dispatchForDay(TOMORROW, partialResult.periods);
      const afterPartial = context.sender.sent.length;
      expect(afterPartial).toBeGreaterThan(0);

      // The missing final hour turns up.
      const tariff = await context.built.priceService.tariff();
      await context.built.store.upsertPrices(
        [46, 47].map((index) => {
          const start = Date.parse(`${TOMORROW}T00:00:00.000Z`) + index * 30 * 60 * 1000;
          return {
            tariffCode: tariff.tariffCode,
            region: tariff.region,
            validFrom: new Date(start).toISOString(),
            validTo: new Date(start + 30 * 60 * 1000).toISOString(),
            valueIncVat: 20,
            valueExcVat: 19,
            retrievedAt: NOW.toISOString(),
          };
        }),
      );

      const completed = await context.built.priceService.storedDay(TOMORROW);
      await context.built.dispatcher.dispatchForDay(TOMORROW, completed);

      expect(context.sender.sent).toHaveLength(afterPartial);
    } finally {
      await context.built.close();
    }
  });

  it('withholds a stretch still growing at the edge, then sends it once settled', async () => {
    // Cheap right up to the end of what has arrived, so the run will grow.
    const rates = Array.from({ length: 46 }, (_, index) => (index >= 44 ? 5 : 20));
    const context = await createTestApp(rates);
    try {
      await context.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: PUSH_SUBSCRIPTION,
      });

      const result = await context.built.priceService.refresh(TOMORROW);
      await context.built.dispatcher.dispatchForDay(TOMORROW, result.periods);
      expect(context.sender.sent.filter((p) => p.type === 'rule_match')).toHaveLength(0);

      // The rest of the day arrives and is expensive, so the run is settled.
      const tariff = await context.built.priceService.tariff();
      await context.built.store.upsertPrices(
        [46, 47].map((index) => {
          const start = Date.parse(`${TOMORROW}T00:00:00.000Z`) + index * 30 * 60 * 1000;
          return {
            tariffCode: tariff.tariffCode,
            region: tariff.region,
            validFrom: new Date(start).toISOString(),
            validTo: new Date(start + 30 * 60 * 1000).toISOString(),
            valueIncVat: 30,
            valueExcVat: 28,
            retrievedAt: NOW.toISOString(),
          };
        }),
      );

      const completed = await context.built.priceService.storedDay(TOMORROW);
      await context.built.dispatcher.dispatchForDay(TOMORROW, completed);
      expect(context.sender.sent.filter((p) => p.type === 'rule_match')).toHaveLength(1);
    } finally {
      await context.built.close();
    }
  });
});

describe('starting-soon alerts', () => {
  // One cheap half hour at 10:00 UTC on the pricing day; nothing else matches.
  const ONE_CHEAP_SLOT = Array.from({ length: 48 }, (_, index) => (index === 20 ? 5 : 20));

  async function prepared() {
    const context = await createTestApp(ONE_CHEAP_SLOT);
    await context.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });
    await context.built.priceService.refresh(TOMORROW);
    return context;
  }

  const lookup = (context: TestContext) => (date: string) =>
    context.built.priceService.storedDay(date);

  it('alerts shortly before a matching stretch begins', async () => {
    const context = await prepared();
    try {
      const sent = await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T09:45:00Z'),
        lookup(context),
      );
      expect(sent).toBe(1);
      const alert = context.sender.sent.find((p) => p.type === 'rule_upcoming');
      expect(alert?.body).toContain('Starting in 15 minutes');
    } finally {
      await context.built.close();
    }
  });

  it('alerts only once, however often the check runs', async () => {
    const context = await prepared();
    try {
      await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T09:45:00Z'),
        lookup(context),
      );
      await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T09:50:00Z'),
        lookup(context),
      );
      await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T09:55:00Z'),
        lookup(context),
      );
      expect(context.sender.sent.filter((p) => p.type === 'rule_upcoming')).toHaveLength(1);
    } finally {
      await context.built.close();
    }
  });

  it('says nothing when the stretch is still hours away', async () => {
    const context = await prepared();
    try {
      const sent = await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T06:00:00Z'),
        lookup(context),
      );
      expect(sent).toBe(0);
    } finally {
      await context.built.close();
    }
  });

  it('says nothing once the stretch has already started', async () => {
    const context = await prepared();
    try {
      const sent = await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T10:15:00Z'),
        lookup(context),
      );
      expect(sent).toBe(0);
    } finally {
      await context.built.close();
    }
  });

  it('respects the price-alert setting', async () => {
    const context = await prepared();
    try {
      await context.built.store.updateSettings('default', { notifyRuleMatches: false });
      const sent = await context.built.dispatcher.dispatchUpcoming(
        new Date('2026-01-16T09:45:00Z'),
        lookup(context),
      );
      expect(sent).toBe(0);
    } finally {
      await context.built.close();
    }
  });
});

describe('partial data', () => {
  it('does not treat a partial day as published', async () => {
    const context = await createTestApp(Array.from({ length: 30 }, () => 12));
    try {
      const result = await context.built.priceService.refresh(TOMORROW);
      expect(result.complete).toBe(false);
      expect(result.missingCount).toBe(18);
      expect(await context.built.priceService.isRetrieved(TOMORROW)).toBe(false);
    } finally {
      await context.built.close();
    }
  });

  it('completes the day once the rest arrives', async () => {
    const context = await createTestApp(Array.from({ length: 30 }, () => 12));
    try {
      await context.built.priceService.refresh(TOMORROW);
      expect(await context.built.priceService.isRetrieved(TOMORROW)).toBe(false);
    } finally {
      await context.built.close();
    }

    // A later poll returns the whole day.
    const complete = await createTestApp(Array.from({ length: 48 }, () => 12));
    try {
      const result = await complete.built.priceService.refresh(TOMORROW);
      expect(result.complete).toBe(true);
    } finally {
      await complete.built.close();
    }
  });
});

describe('HTTP API', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.built.close();
  });

  it('reports health', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports status, including what is stored', async () => {
    await context.built.priceService.refresh(TOMORROW);
    const response = await context.app.inject({ method: 'GET', url: '/api/status' });
    const body = response.json();

    expect(body.tariffCode).toBe('E-1R-AGILE-24-10-01-C');
    expect(body.tomorrow).toMatchObject({ date: TOMORROW, periodCount: 48, complete: true });
    expect(body.today).toMatchObject({ date: TODAY, complete: false });
    expect(body.storedPeriodCount).toBe(48);
  });

  it('returns an overview with the current and next period', async () => {
    // Store today as well so "now" falls inside a known period.
    const context2 = await createTestApp();
    try {
      const store = context2.built.store;
      const tariff = await context2.built.priceService.tariff();
      await store.upsertPrices(
        Array.from({ length: 48 }, (_, index) => {
          const start = Date.parse(`${TODAY}T00:00:00.000Z`) + index * 30 * 60 * 1000;
          return {
            tariffCode: tariff.tariffCode,
            region: tariff.region,
            validFrom: new Date(start).toISOString(),
            validTo: new Date(start + 30 * 60 * 1000).toISOString(),
            valueIncVat: index,
            valueExcVat: index,
            retrievedAt: NOW.toISOString(),
          };
        }),
      );

      const response = await context2.app.inject({ method: 'GET', url: '/api/overview' });
      const body = response.json();
      // 17:00 UTC is period 34 on a January day.
      expect(body.current.valueIncVat).toBe(34);
      expect(body.next.valueIncVat).toBe(35);
      expect(body.today.complete).toBe(true);
    } finally {
      await context2.built.close();
    }
  });

  it('serves prices for a specific date', async () => {
    await context.built.priceService.refresh(TOMORROW);
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/prices?date=${TOMORROW}`,
    });
    const body = response.json();
    expect(body.periods).toHaveLength(48);
    expect(body.summary.minPence).toBe(-2);
    expect(body.complete).toBe(true);
  });

  it('rejects a malformed date', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/prices?date=tomorrow' });
    expect(response.statusCode).toBe(400);
  });

  it('finds the cheapest continuous window', async () => {
    await context.built.priceService.refresh(TOMORROW);
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/windows?date=${TOMORROW}&durationMinutes=120`,
    });
    const body = response.json();
    expect(body.cheapest.averagePence).toBe(5);
    expect(body.cheapest.startUtc).toBe('2026-01-16T02:00:00.000Z');
  });

  it('lists the seeded default rules', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/rules' });
    const names = response.json().rules.map((rule: { name: string }) => rule.name);
    expect(names).toEqual(['Negative Prices', 'Cheap Electricity', 'Two Cheap Hours']);
    expect(await context.built.store.setStateIfAbsent('rules_seeded', 'later')).toBe(false);
  });

  it('claims a new state key only once', async () => {
    expect(await context.built.store.setStateIfAbsent('test_claim', 'first')).toBe(true);
    expect(await context.built.store.setStateIfAbsent('test_claim', 'second')).toBe(false);
    expect(await context.built.store.getState('test_claim')).toBe('first');
  });

  it('creates, updates and deletes a rule', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        name: 'Very cheap',
        operator: 'lte',
        thresholdPence: 3,
        minimumDurationMinutes: 30,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const updated = await context.app.inject({
      method: 'PUT',
      url: `/api/rules/${id}`,
      payload: {
        name: 'Very cheap indeed',
        operator: 'lt',
        thresholdPence: 2,
        minimumDurationMinutes: 60,
        enabled: false,
      },
    });
    expect(updated.json()).toMatchObject({
      name: 'Very cheap indeed',
      operator: 'lt',
      thresholdPence: 2,
      enabled: false,
    });

    const deleted = await context.app.inject({ method: 'DELETE', url: `/api/rules/${id}` });
    expect(deleted.statusCode).toBe(204);

    const missing = await context.app.inject({ method: 'DELETE', url: `/api/rules/${id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects an invalid rule', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { name: '', operator: 'nonsense', thresholdPence: 5 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a rule with only one half of a time restriction', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        name: 'Overnight',
        operator: 'lte',
        thresholdPence: 7,
        timeStart: '22:00',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reads and updates settings', async () => {
    const patched = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { region: 'M', hour12: true, theme: 'dark' },
    });
    expect(patched.json()).toMatchObject({ region: 'M', hour12: true, theme: 'dark' });

    const read = await context.app.inject({ method: 'GET', url: '/api/settings' });
    expect(read.json().region).toBe('M');
  });

  it('rejects an unknown region', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { region: 'Z' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lists the 14 distribution regions', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/regions' });
    expect(response.json().regions).toHaveLength(14);
  });

  it('registers and removes a push subscription without echoing it back', async () => {
    const subscribed = await context.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });
    expect(subscribed.statusCode).toBe(201);
    expect(JSON.stringify(subscribed.json())).not.toContain('an-auth-secret');

    const count = await context.app.inject({ method: 'GET', url: '/api/push/subscriptions' });
    expect(count.json().count).toBe(1);

    const removed = await context.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      payload: PUSH_SUBSCRIPTION,
    });
    expect(removed.json().removed).toBe(true);
  });

  it('rejects a malformed push subscription', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { endpoint: 'not-a-url' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('exposes the public VAPID key', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/push/key' });
    expect(response.json()).toEqual({ publicKey: 'test-public', configured: true });
  });

  it('sends a test notification', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/notifications/test',
    });
    expect(response.json().sent).toBe(true);
    expect(context.sender.sent.at(-1)?.type).toBe('test');
  });

  it('returns 404 for an unknown API route', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('triggers a manual check', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/check-now?date=${TOMORROW}`,
    });
    expect(response.json()).toMatchObject({ complete: true, periodCount: 48 });
  });
});
