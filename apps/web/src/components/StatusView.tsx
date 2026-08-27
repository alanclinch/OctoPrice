/**
 * The status page (DESIGN.md section 37).
 *
 * Exists to answer "why have I not been told about tomorrow yet?" without
 * anyone having to read server logs.
 */

import { useCallback, useEffect, useState } from 'react';
import { getRegion, isRegionCode, type NotificationLogEntry } from '@octoprice/core';
import { api, type SystemStatusPayload } from '../api.ts';
import { relativeTime } from '../format.ts';
import type { JSX } from 'react';

export function StatusView({ now }: { now: Date }): JSX.Element {
  const [status, setStatus] = useState<SystemStatusPayload | null>(null);
  const [notifications, setNotifications] = useState<NotificationLogEntry[]>([]);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.status());
      const { notifications: recent } = await api.notifications();
      setNotifications(recent);
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
        result.complete
          ? `Retrieved a complete day for ${result.date}.`
          : `${result.date} has ${result.periodCount} periods so far, ${result.missingCount} still to come.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The check failed.');
    } finally {
      setChecking(false);
    }
  };

  if (!status) {
    return <p className="centre">{error ?? 'Loading status…'}</p>;
  }
  const region = isRegionCode(status.region) ? getRegion(status.region) : null;

  return (
    <>
      <div className="card">
        <h2>Price retrieval</h2>
        <dl className="status-grid">
          <dt>Last check</dt>
          <dd>{relativeTime(status.lastCheckStartedAt, now)}</dd>
          <dt>Last complete day</dt>
          <dd>{relativeTime(status.lastSuccessfulRetrievalAt, now)}</dd>
          <dt>Today</dt>
          <dd>
            {status.today.periodCount} periods {status.today.complete ? '(complete)' : '(partial)'}
          </dd>
          <dt>Tomorrow</dt>
          <dd>
            {status.tomorrow.periodCount === 0
              ? 'not published yet'
              : `${status.tomorrow.periodCount} periods ${status.tomorrow.complete ? '(complete)' : '(partial)'}`}
          </dd>
          <dt>Stored periods</dt>
          <dd>{status.storedPeriodCount}</dd>
          <dt>Scheduler</dt>
          <dd>{status.schedulerEnabled ? 'running' : 'disabled'}</dd>
        </dl>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn primary"
            disabled={checking}
            onClick={() => void checkNow()}
          >
            {checking ? 'Checking…' : 'Check Octopus now'}
          </button>
        </div>
        {message && <p className="small">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>Tariff</h2>
        <dl className="status-grid">
          <dt>Product</dt>
          <dd>{status.productCode}</dd>
          <dt>Tariff</dt>
          <dd>{status.tariffCode}</dd>
          <dt>Region</dt>
          <dd>{region ? `${region.area} (${region.code})` : status.region}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>Notifications</h2>
        <dl className="status-grid">
          <dt>Push configured</dt>
          <dd>{status.pushConfigured ? 'yes' : 'no VAPID keys on the server'}</dd>
          <dt>Last sent</dt>
          <dd>{relativeTime(status.lastNotificationAt, now)}</dd>
        </dl>

        {notifications.length > 0 && (
          <table className="price-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th scope="col">Recent</th>
                <th scope="col" className="numeric">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {notifications.slice(0, 8).map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {entry.title}
                    <br />
                    <span className="muted small">{relativeTime(entry.createdAt, now)}</span>
                  </td>
                  <td className="numeric">
                    <span className={`pill ${entry.status === 'sent' ? 'ready' : 'waiting'}`}>
                      {entry.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Build</h2>
        <dl className="status-grid">
          <dt>Version</dt>
          <dd>{status.version}</dd>
          <dt>Commit</dt>
          <dd>{status.commit}</dd>
        </dl>
      </div>
    </>
  );
}
