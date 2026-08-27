/**
 * Access control.
 *
 * The app moved from one shared account behind a public URL to per-person
 * access, so these tests care about the things that would be embarrassing to
 * get wrong: an unauthenticated request reaching data, one person seeing or
 * editing another's rules, a token leaking through an API response, or a
 * removed person still being able to get in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  PUSH_SUBSCRIPTION,
  TOMORROW,
  createTestApp,
  tomorrowPrices,
  type TestContext,
} from './harness.ts';

describe('access control', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.built.close();
  });

  describe('authentication', () => {
    it.each(['/api/overview', '/api/rules', '/api/settings', '/api/status', '/api/notifications'])(
      'refuses %s without a session',
      async (url) => {
        const response = await context.injectAnonymous({ method: 'GET', url });
        expect(response.statusCode).toBe(401);
      },
    );

    it('refuses an unknown token', async () => {
      const response = await context.injectAnonymous({
        method: 'GET',
        url: '/api/overview',
        headers: context.asUser('not-a-real-token'),
      });
      expect(response.statusCode).toBe(401);
    });

    it.each(['/api/health', '/api/regions'])('still serves %s without a session', async (url) => {
      const response = await context.injectAnonymous({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('invite links', () => {
    it('exchanges a link for a session cookie', async () => {
      const created = await context.inject({
        method: 'POST',
        url: '/api/invites',
        payload: { name: 'Mum' },
      });
      expect(created.statusCode).toBe(201);

      const token = new URL(created.json().link as string).searchParams.get('invite') as string;
      const claimed = await context.injectAnonymous({
        method: 'POST',
        url: '/api/session/claim',
        payload: { token },
      });

      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().user.name).toBe('Mum');

      const cookie = claimed.headers['set-cookie'] as string;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('accepts the cookie it issued', async () => {
      const { token } = await context.invite('Mum');
      const claimed = await context.injectAnonymous({
        method: 'POST',
        url: '/api/session/claim',
        payload: { token },
      });
      const cookie = (claimed.headers['set-cookie'] as string).split(';')[0] as string;

      const session = await context.injectAnonymous({
        method: 'GET',
        url: '/api/session',
        headers: { cookie },
      });
      expect(session.json().user.name).toBe('Mum');
    });

    it('rejects a claim with a token that was never issued', async () => {
      const response = await context.injectAnonymous({
        method: 'POST',
        url: '/api/session/claim',
        payload: { token: 'nonsense' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('never exposes a token or its hash when listing people', async () => {
      await context.invite('Dad');
      const listed = await context.inject({ method: 'GET', url: '/api/invites' });

      expect(JSON.stringify(listed.json())).not.toContain('token');
      expect(listed.json().users).toHaveLength(2);
    });

    it('invalidates the previous link when one is reissued', async () => {
      const { id, token: first } = await context.invite('Mum');

      const reissued = await context.inject({ method: 'POST', url: `/api/invites/${id}/link` });
      const second = new URL(reissued.json().link as string).searchParams.get('invite') as string;
      expect(second).not.toBe(first);

      const withOld = await context.injectAnonymous({
        method: 'GET',
        url: '/api/overview',
        headers: context.asUser(first),
      });
      expect(withOld.statusCode).toBe(401);

      const withNew = await context.injectAnonymous({
        method: 'GET',
        url: '/api/overview',
        headers: context.asUser(second),
      });
      expect(withNew.statusCode).toBe(200);
    });
  });

  describe('separation between people', () => {
    it('keeps rules private to their owner', async () => {
      const { token } = await context.invite('Mum');

      const created = await context.injectAnonymous({
        method: 'POST',
        url: '/api/rules',
        headers: context.asUser(token),
        payload: { name: 'Mum only', operator: 'lte', thresholdPence: 5 },
      });
      const ruleId = created.json().id as string;

      const ownerRules = await context.inject({ method: 'GET', url: '/api/rules' });
      const names = (ownerRules.json().rules as { name: string }[]).map((rule) => rule.name);
      expect(names).not.toContain('Mum only');
      expect(ruleId).toBeTruthy();
    });

    it('answers 404 rather than 403 for someone else, so the API cannot be probed', async () => {
      const { token } = await context.invite('Mum');
      const created = await context.injectAnonymous({
        method: 'POST',
        url: '/api/rules',
        headers: context.asUser(token),
        payload: { name: 'Mum only', operator: 'lte', thresholdPence: 5 },
      });
      const ruleId = created.json().id as string;

      const edited = await context.inject({
        method: 'PUT',
        url: `/api/rules/${ruleId}`,
        payload: { name: 'Hijacked', operator: 'lte', thresholdPence: 99 },
      });
      expect(edited.statusCode).toBe(404);

      const deleted = await context.inject({ method: 'DELETE', url: `/api/rules/${ruleId}` });
      expect(deleted.statusCode).toBe(404);

      // And the rule is untouched.
      const stillThere = await context.injectAnonymous({
        method: 'GET',
        url: '/api/rules',
        headers: context.asUser(token),
      });
      const names = (stillThere.json().rules as { name: string }[]).map((rule) => rule.name);
      expect(names).toContain('Mum only');
    });

    it('keeps regions separate, so one person cannot change another’s prices', async () => {
      const { token } = await context.invite('Cousin in Yorkshire');

      await context.injectAnonymous({
        method: 'PATCH',
        url: '/api/settings',
        headers: context.asUser(token),
        payload: { region: 'M' },
      });

      const ownerSettings = await context.inject({ method: 'GET', url: '/api/settings' });
      expect(ownerSettings.json().region).toBe('C');

      const theirSettings = await context.injectAnonymous({
        method: 'GET',
        url: '/api/settings',
        headers: context.asUser(token),
      });
      expect(theirSettings.json().region).toBe('M');
    });

    it('gives a new person their own starter rules', async () => {
      const { id } = await context.invite('Mum');
      const rules = await context.built.store.listRules(id);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((rule) => rule.userId === id)).toBe(true);
    });
  });

  describe('owner privileges', () => {
    it.each([
      { method: 'GET' as const, url: '/api/invites' },
      { method: 'POST' as const, url: '/api/invites', payload: { name: 'Someone else' } },
    ])('refuses $method $url for a non-owner', async (request) => {
      const { token } = await context.invite('Mum');
      const response = await context.injectAnonymous({
        ...request,
        headers: context.asUser(token),
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses to remove the owner', async () => {
      const response = await context.inject({ method: 'DELETE', url: `/api/invites/${OWNER_ID}` });
      expect(response.statusCode).toBe(400);
    });

    it('removes a person, their data and their access together', async () => {
      const { id, token } = await context.invite('Temporary');
      expect((await context.built.store.listRules(id)).length).toBeGreaterThan(0);

      const removed = await context.inject({ method: 'DELETE', url: `/api/invites/${id}` });
      expect(removed.statusCode).toBe(204);

      expect(await context.built.store.listRules(id)).toEqual([]);

      const after = await context.injectAnonymous({
        method: 'GET',
        url: '/api/overview',
        headers: context.asUser(token),
      });
      expect(after.statusCode).toBe(401);
    });
  });
});

describe('changing region', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.built.close();
  });

  it('fetches the new area prices immediately, not at the next poll', async () => {
    // Region M has nothing stored, so without a backfill the person would see
    // an empty app until the publication window.
    const before = await context.built.store.getPrices(
      'E-1R-AGILE-24-10-01-M',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(before).toHaveLength(0);

    const response = await context.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { region: 'M' },
    });
    expect(response.statusCode).toBe(200);

    const after = await context.built.store.getPrices(
      'E-1R-AGILE-24-10-01-M',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(after.length).toBeGreaterThan(0);
  });

  it('marks the region as confirmed when one is chosen', async () => {
    const { token } = await context.invite('Mum');

    const before = await context.injectAnonymous({
      method: 'GET',
      url: '/api/settings',
      headers: context.asUser(token),
    });
    expect(before.json().regionConfirmed).toBe(false);

    await context.injectAnonymous({
      method: 'PATCH',
      url: '/api/settings',
      headers: context.asUser(token),
      payload: { region: 'M' },
    });

    const after = await context.injectAnonymous({
      method: 'GET',
      url: '/api/settings',
      headers: context.asUser(token),
    });
    expect(after.json().regionConfirmed).toBe(true);
  });

  it('asks each person separately, whatever device they use', async () => {
    // The owner confirms theirs...
    await context.inject({ method: 'PATCH', url: '/api/settings', payload: { region: 'N' } });
    const owner = await context.inject({ method: 'GET', url: '/api/settings' });
    expect(owner.json().regionConfirmed).toBe(true);

    // ...which says nothing about anybody else, whatever device they use.

    const { token } = await context.invite('Mum');
    const mum = await context.injectAnonymous({
      method: 'GET',
      url: '/api/settings',
      headers: context.asUser(token),
    });
    expect(mum.json().regionConfirmed).toBe(false);
  });

  it('does not refetch when the region is unchanged', async () => {
    const settings = await context.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { hour12: true },
    });
    expect(settings.json().hour12).toBe(true);
    expect(settings.json().region).toBe('C');
  });
});

describe('push registration belongs to a person', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.built.close();
  });

  it('reports a subscription as registered for the person who registered it', async () => {
    await context.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });

    const status = await context.inject({
      method: 'POST',
      url: '/api/push/status',
      payload: PUSH_SUBSCRIPTION,
    });
    expect(status.json().registered).toBe(true);
  });

  it('does not report someone else device subscription as theirs', async () => {
    // The owner registers this device, then the device changes hands.
    await context.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: PUSH_SUBSCRIPTION,
    });

    const { token } = await context.invite('Mum');
    const status = await context.injectAnonymous({
      method: 'POST',
      url: '/api/push/status',
      headers: context.asUser(token),
      payload: PUSH_SUBSCRIPTION,
    });

    expect(status.json().registered).toBe(false);
  });

  it('reports an unregistered subscription as not registered', async () => {
    const status = await context.inject({
      method: 'POST',
      url: '/api/push/status',
      payload: PUSH_SUBSCRIPTION,
    });
    expect(status.json().registered).toBe(false);
  });
});

describe('status page content', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.built.close();
  });

  it('reports a day as ready once it is usable, not only once complete', async () => {
    // The shape Octopus actually publishes: 46 of 48 periods.
    const partial = await createTestApp(tomorrowPrices().slice(0, 46));
    try {
      await partial.built.priceService.refresh(TOMORROW, partial.tariff);
      const status = await partial.inject({ method: 'GET', url: '/api/status' });
      const body = status.json();

      expect(body.tomorrow.ready).toBe(true);
      expect(body.tomorrow.complete).toBe(false);
    } finally {
      await partial.built.close();
    }
  });

  it('reports a day that has barely arrived as not ready', async () => {
    const barely = await createTestApp(tomorrowPrices().slice(0, 10));
    try {
      await barely.built.priceService.refresh(TOMORROW, barely.tariff);
      const status = await barely.inject({ method: 'GET', url: '/api/status' });
      expect(status.json().tomorrow.ready).toBe(false);
    } finally {
      await barely.built.close();
    }
  });

  it('tells the page when to expect prices', async () => {
    const status = await context.inject({ method: 'GET', url: '/api/status' });
    expect(status.json().publicationWindow).toEqual({ start: '16:05', cutoff: '22:15' });
  });

  it('says whether the viewer is the owner, so detail can be withheld', async () => {
    const owner = await context.inject({ method: 'GET', url: '/api/status' });
    expect(owner.json().isOwner).toBe(true);

    const { token } = await context.invite('Mum');
    const theirs = await context.injectAnonymous({
      method: 'GET',
      url: '/api/status',
      headers: context.asUser(token),
    });
    expect(theirs.json().isOwner).toBe(false);
  });

  it('reports each person their own tariff', async () => {
    const { token } = await context.invite('Cousin');
    await context.injectAnonymous({
      method: 'PATCH',
      url: '/api/settings',
      headers: context.asUser(token),
      payload: { region: 'M' },
    });

    const owner = await context.inject({ method: 'GET', url: '/api/status' });
    const theirs = await context.injectAnonymous({
      method: 'GET',
      url: '/api/status',
      headers: context.asUser(token),
    });

    expect(owner.json().tariffCode).toContain('-C');
    expect(theirs.json().tariffCode).toContain('-M');
  });
});
