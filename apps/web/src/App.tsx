/**
 * The application shell.
 *
 * Four tabs, no router: the app has one screen per thing a person might want,
 * and a dependency-free `?date=` query parameter is enough for a notification
 * to deep-link into tomorrow (DESIGN.md section 6).
 */

import { useCallback, useEffect, useState } from 'react';
import type { UserSettings } from '@octoprice/core';
import { addDays, londonDateOf } from '@octoprice/core';
import { api, ApiError, type Overview } from './api.ts';
import { NowCard } from './components/NowCard.tsx';
import { DayView } from './components/DayView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { StatusView } from './components/StatusView.tsx';
import type { JSX } from 'react';

type Tab = 'today' | 'tomorrow' | 'settings' | 'status';

/** Refresh often enough that the "now" price is never visibly stale. */
const REFRESH_INTERVAL_MS = 60_000;

/** A notification opens the app at `/?date=YYYY-MM-DD`; honour that. */
function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get('date');
  if (requested && requested === addDays(londonDateOf(new Date()), 1)) return 'tomorrow';
  if (window.location.pathname.startsWith('/settings')) return 'settings';
  return 'today';
}

/** Applies the chosen theme, or lets the system decide. */
function applyTheme(theme: UserSettings['theme']): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const loaded = await api.overview();
      setOverview(loaded);
      applyTheme(loaded.settings.theme);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 0
          ? 'Cannot reach the OctoPrice server. Showing nothing rather than something wrong.'
          : caught instanceof Error
            ? caught.message
            : 'Something went wrong.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      setNow(new Date());
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Coming back to a backgrounded PWA should show current prices, not the
  // ones from whenever it was last open.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        setNow(new Date());
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const settings = overview?.settings;
  const display = { hour12: settings?.hour12 ?? false };

  const onSettingsChange = (updated: UserSettings): void => {
    applyTheme(updated.theme);
    setOverview((previous) => (previous ? { ...previous, settings: updated } : previous));
    void load();
  };

  return (
    <>
      <header className="app-header">
        <div>
          <h1>OctoPrice</h1>
          {overview && <span className="region">Agile · region {overview.tariff.region}</span>}
        </div>
        {overview && (
          <span className={`pill ${overview.tomorrow.complete ? 'ready' : 'waiting'}`}>
            {overview.tomorrow.complete ? 'Tomorrow ready' : 'Awaiting tomorrow'}
          </span>
        )}
      </header>

      <nav className="tabs" role="tablist">
        {(
          [
            ['today', 'Today'],
            ['tomorrow', 'Tomorrow'],
            ['settings', 'Settings'],
            ['status', 'Status'],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && <p className="error">{error}</p>}

      {loading && !overview && <p className="centre">Loading prices…</p>}

      {overview && tab === 'today' && (
        <>
          <NowCard current={overview.current} next={overview.next} display={display} />
          <DayView day={overview.today} now={now} display={display} defaultHidePast />
        </>
      )}

      {overview && tab === 'tomorrow' && (
        <DayView day={overview.tomorrow} now={now} display={display} />
      )}

      {overview && settings && tab === 'settings' && (
        <SettingsView settings={settings} onSettingsChange={onSettingsChange} />
      )}

      {tab === 'status' && <StatusView now={now} />}
    </>
  );
}
