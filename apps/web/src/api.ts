/**
 * Typed client for the OctoAgile Advisor API.
 *
 * Response shapes reuse the domain models from `@octoprice/core`, which is
 * the main practical benefit of TypeScript on both sides: a change to a price
 * or rule shape is a compile error in the UI rather than a runtime surprise.
 */

import type {
  AlertRule,
  AlertRuleInput,
  DaySummary,
  ForecastPricePeriod,
  NotificationLogEntry,
  PeriodRun,
  PricePeriod,
  PricingDate,
  RegionInfo,
  RegionCode,
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
  /** Enough contiguous prices from local midnight have arrived for planning. */
  ready: boolean;
  /** Exclusive local-day coverage boundary, expressed as an ISO UTC instant. */
  coveredUntil: string | null;
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
  forecast: {
    model: string;
    referenceRegion: string;
    historyDays: number;
    periods: ForecastPricePeriod[];
    unavailableReason:
      'disabled' | 'failed' | 'stale' | 'insufficient-history' | 'regional-transform-failed' | null;
  };
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
  /** `ready` means usable; `complete` is the technical detail behind it. */
  today: { date: PricingDate; periodCount: number; complete: boolean; ready: boolean };
  tomorrow: { date: PricingDate; periodCount: number; complete: boolean; ready: boolean };
  publicationWindow: { start: string; cutoff: string };
  isOwner: boolean;
  storedPeriodCount: number;
  lastNotificationAt: string | null;
  pushConfigured: boolean;
  schedulerEnabled: boolean;
}

export interface ForecastExperimentPeriod {
  validFrom: string;
  validTo: string;
  valueIncVat: number;
}

export interface ForecastExperimentRun {
  id: string;
  model: string;
  targetDate: PricingDate;
  generatedAt: string;
  issueCutoff: string;
  inputVintages: string[];
  periods: ForecastExperimentPeriod[];
  score: {
    scoredAt: string;
    maePence: number;
    cheapest3hRegret: number;
    within60Minutes: boolean;
  } | null;
}

export interface ForecastExperimentPayload {
  experimental: true;
  phase: 'collecting-history' | 'preparing-days' | 'waiting-for-forecast' | 'running';
  requestedRegion: RegionCode;
  displayRegion: RegionCode;
  regionalTransformAvailable: boolean;
  referenceRegion: RegionCode;
  historyThrough: PricingDate | null;
  preparedThrough: PricingDate | null;
  preparedDays: number;
  requiredPreparedDays: number;
  runs: ForecastExperimentRun[];
  actual: PricePeriod[];
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
    throw new ApiError('Could not reach the OctoAgile Advisor server', 0);
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

  forecastExperiment: () => request<ForecastExperimentPayload>('/forecast-experiment'),

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
  /** Whether this device's subscription belongs to the signed-in person. */
  pushStatus: (subscription: PushSubscriptionJSON) =>
    request<{ registered: boolean }>('/push/status', { method: 'POST', body: json(subscription) }),
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
    request<{
      date: PricingDate;
      complete: boolean;
      publishable: boolean;
      periodCount: number;
      missingCount: number;
    }>(`/check-now${date ? `?date=${encodeURIComponent(date)}` : ''}`, { method: 'POST' }),
};
