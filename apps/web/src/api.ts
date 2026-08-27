/**
 * Typed client for the OctoPrice API.
 *
 * Response shapes reuse the domain models from `@octoprice/core`, which is
 * the main practical benefit of TypeScript on both sides: a change to a price
 * or rule shape is a compile error in the UI rather than a runtime surprise.
 */

import type {
  AlertRule,
  AlertRuleInput,
  DaySummary,
  NotificationLogEntry,
  PeriodRun,
  PricePeriod,
  PricingDate,
  RegionInfo,
  UserSettings,
  UserSettingsInput,
} from '@octoprice/core';

/** A person using this installation, as the API describes them. */
export interface SessionUser {
  id: string;
  name: string;
  isOwner: boolean;
  createdAt: string;
  claimedAt: string | null;
  lastSeenAt: string | null;
  /** Whether an access link currently exists for them. */
  hasLink: boolean;
}

export interface DayPayload {
  date: PricingDate;
  periods: PricePeriod[];
  summary: DaySummary | null;
  complete: boolean;
  expectedPeriodCount: number;
}

export interface TariffInfo {
  productCode: string;
  tariffCode: string;
  region: string;
}

export interface Overview {
  now: string;
  current: PricePeriod | null;
  next: PricePeriod | null;
  today: DayPayload;
  tomorrow: DayPayload;
  settings: UserSettings;
  tariff: TariffInfo;
  /** Who this response belongs to. */
  user: SessionUser;
}

export interface WindowsPayload {
  date: PricingDate;
  durationMinutes: number;
  cheapest: PeriodRun | null;
  ranked: PeriodRun[];
}

export interface SystemStatusPayload {
  version: string;
  commit: string;
  tariffCode: string;
  productCode: string;
  region: string;
  lastCheckStartedAt: string | null;
  lastSuccessfulRetrievalAt: string | null;
  today: { date: PricingDate; periodCount: number; complete: boolean };
  tomorrow: { date: PricingDate; periodCount: number; complete: boolean };
  storedPeriodCount: number;
  lastNotificationAt: string | null;
  pushConfigured: boolean;
  schedulerEnabled: boolean;
}

/** An API call that failed, carrying whatever the server explained. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    // Offline, or the server is not running.
    throw new ApiError('Could not reach the OctoPrice server', 0);
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit['body'] => JSON.stringify(body);

export const api = {
  // --- Session -----------------------------------------------------------

  session: () => request<{ user: SessionUser }>('/session'),
  /** Exchanges an invite token for a session cookie. */
  claim: (token: string) =>
    request<{ user: SessionUser }>('/session/claim', { method: 'POST', body: json({ token }) }),
  signOut: () => request<{ signedOut: boolean }>('/session/signout', { method: 'POST' }),

  // --- People (owner only) -----------------------------------------------

  invites: () => request<{ users: SessionUser[] }>('/invites'),
  createInvite: (name: string) =>
    request<{ user: SessionUser; link: string }>('/invites', {
      method: 'POST',
      body: json({ name }),
    }),
  reissueLink: (id: string) =>
    request<{ user: SessionUser; link: string }>(`/invites/${id}/link`, { method: 'POST' }),
  removeInvite: (id: string) => request<void>(`/invites/${id}`, { method: 'DELETE' }),

  overview: () => request<Overview>('/overview'),

  prices: (date?: PricingDate) =>
    request<DayPayload>(`/prices${date ? `?date=${encodeURIComponent(date)}` : ''}`),

  windows: (date: PricingDate, durationMinutes: number) =>
    request<WindowsPayload>(
      `/windows?date=${encodeURIComponent(date)}&durationMinutes=${durationMinutes}`,
    ),

  status: () => request<SystemStatusPayload>('/status'),

  regions: () => request<{ regions: RegionInfo[] }>('/regions'),

  settings: () => request<UserSettings>('/settings'),
  updateSettings: (input: UserSettingsInput) =>
    request<UserSettings>('/settings', { method: 'PATCH', body: json(input) }),

  rules: () => request<{ rules: AlertRule[] }>('/rules'),
  createRule: (input: AlertRuleInput) =>
    request<AlertRule>('/rules', { method: 'POST', body: json(input) }),
  updateRule: (id: string, input: AlertRuleInput) =>
    request<AlertRule>(`/rules/${id}`, { method: 'PUT', body: json(input) }),
  deleteRule: (id: string) => request<void>(`/rules/${id}`, { method: 'DELETE' }),

  pushKey: () => request<{ publicKey: string | null; configured: boolean }>('/push/key'),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ id: string }>('/push/subscribe', { method: 'POST', body: json(subscription) }),
  unsubscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ removed: boolean }>('/push/unsubscribe', {
      method: 'POST',
      body: json(subscription),
    }),
  testNotification: () =>
    request<{ sent: boolean; delivered: number; failed: number }>('/notifications/test', {
      method: 'POST',
    }),

  notifications: () => request<{ notifications: NotificationLogEntry[] }>('/notifications'),

  checkNow: (date?: PricingDate) =>
    request<{ date: PricingDate; complete: boolean; periodCount: number; missingCount: number }>(
      `/check-now${date ? `?date=${encodeURIComponent(date)}` : ''}`,
      { method: 'POST' },
    ),
};
