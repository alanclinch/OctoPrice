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
import { OWNER_ID, createTestApp, type TestContext } from './harness.ts';

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
