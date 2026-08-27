/**
 * Status.
 *
 * Two audiences with genuinely different questions.
 *
 * Anyone: are my prices up to date, and are my alerts working? That is the
 * whole of it, phrased so it can be acted on.
 *
 * The owner, additionally: when did the app last speak to Octopus, what is
 * stored, which tariff, which build. That is troubleshooting, and showing it
 * to everybody makes the page look like a fault report when nothing is wrong.
 *
 * One thing is deliberately not surfaced to either: a day being "partial".
 * Octopus delivers a day up to about 23:00 local and the rest arrives with the
 * following day's batch, so a perfectly healthy day sits one hour short for
 * most of its life. Reporting that as partial reads as breakage.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { NotificationLogEntry } from '@octoprice/core';
import { api, type SessionUser, type SystemStatusPayload } from '../api.ts';
import { relativeTime } from '../format.ts';
import { pushState, type PushState } from '../push.ts';

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  daily_prices: 'Prices published',
  rule_match: 'Price alert',
  rule_upcoming: 'Starting soon',
  test: 'Test',
};

export interface StatusViewProps {
  now: Date;
  user: SessionUser | null;
}

export function StatusView({ now, user }: StatusViewProps): JSX.Element {
  const [status, setStatus] = useState<SystemStatusPayload | null>(null);
  const [notifications, setNotifications] = useState<NotificationLogEntry[]>([]);
  const [push, setPush] = useState<PushState>('disabled');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.status());
      setNotifications((await api.notifications()).notifications);
      setPush(await pushState());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load status.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api.checkNow();
      setMessage(
        result.publishable
          ? `Tomorrow's prices are in.`
          : 'Octopus has not published tomorrow yet. Try again later.',
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The check failed.');
    } finally {
      setChecking(false);
    }
  };

  if (!status) {
    return <p className="centre">{error ?? 'Loading…'}</p>;
  }

  const tomorrowReady = status.tomorrow.ready;

  return (
    <>
      <div className="card">
        <h2>Prices</h2>

        <div className="status-line">
          <span>Today</span>
          <span className={`pill ${status.today.ready ? 'ready' : 'waiting'}`}>
            {status.today.ready ? 'Ready' : 'Waiting for Octopus'}
          </span>
        </div>

        <div className="status-line">
          <span>Tomorrow</span>
          <span className={`pill ${tomorrowReady ? 'ready' : 'waiting'}`}>
            {tomorrowReady ? 'Ready' : 'Not published yet'}
          </span>
        </div>

        <p className="muted small" style={{ marginBottom: 0 }}>
          {tomorrowReady
            ? 'Tomorrow’s prices have arrived. Anything matching your rules is listed under Prices.'
            : `Octopus usually publishes tomorrow’s prices from about ${status.publicationWindow.start}, and is allowed until ${status.publicationWindow.cutoff}. You will be notified as soon as they land.`}
        </p>

        {!tomorrowReady && (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              disabled={checking}
              onClick={() => void checkNow()}
            >
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </div>
        )}

        {message && <p className="small">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>Your alerts</h2>

        <div className="status-line">
          <span>Notifications on this device</span>
          <span className={`pill ${push === 'enabled' ? 'ready' : 'waiting'}`}>
            {push === 'enabled' ? 'On' : push === 'denied' ? 'Blocked' : 'Off'}
          </span>
        </div>

        <div className="status-line">
          <span>Last alert sent</span>
          <span>{relativeTime(status.lastNotificationAt, now)}</span>
        </div>

        {push !== 'enabled' && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            {push === 'denied'
              ? 'Your browser is blocking notifications for this site. Allow them in its site settings, then turn them on in Settings.'
              : 'Turn them on in Settings to be told when prices are published and when your alerts match.'}
          </p>
        )}

        {notifications.length > 0 && (
          <div className="notification-list">
            {notifications.map((entry) => (
              <div key={entry.id} className="notification-row">
                <div>
                  <div className="notification-title">{entry.title}</div>
                  <div className="muted small">
                    {NOTIFICATION_TYPE_LABELS[entry.type] ?? entry.type} ·{' '}
                    {relativeTime(entry.createdAt, now)}
                  </div>
                </div>
                {entry.status !== 'sent' && <span className="pill waiting">failed</span>}
              </div>
            ))}
          </div>
        )}

        {notifications.length === 0 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Nothing sent yet.
          </p>
        )}
      </div>

      {user?.isOwner && (
        <div className="card">
          <h2>For the owner</h2>
          <p className="muted small">Troubleshooting detail. Nobody else sees this.</p>

          <dl className="status-grid">
            <dt>Last Octopus check</dt>
            <dd>{relativeTime(status.lastCheckStartedAt, now)}</dd>
            <dt>Last day retrieved</dt>
            <dd>{relativeTime(status.lastSuccessfulRetrievalAt, now)}</dd>
            <dt>Today</dt>
            <dd>
              {status.today.periodCount} periods
              {status.today.complete ? '' : ', last hour still to come'}
            </dd>
            <dt>Tomorrow</dt>
            <dd>
              {status.tomorrow.periodCount === 0
                ? 'nothing yet'
                : `${status.tomorrow.periodCount} periods${status.tomorrow.complete ? '' : ', last hour still to come'}`}
            </dd>
            <dt>Stored periods</dt>
            <dd>{status.storedPeriodCount}</dd>
            <dt>Scheduler</dt>
            <dd>{status.schedulerEnabled ? 'running' : 'disabled'}</dd>
            <dt>Push configured</dt>
            <dd>{status.pushConfigured ? 'yes' : 'no VAPID keys'}</dd>
            <dt>Tariff</dt>
            <dd>{status.tariffCode}</dd>
            <dt>Build</dt>
            <dd>
              {status.version} · {status.commit}
            </dd>
          </dl>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn"
              disabled={checking}
              onClick={() => void checkNow()}
            >
              {checking ? 'Checking…' : 'Check Octopus now'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
