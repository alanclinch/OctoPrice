/** The application shell and first-run region setup. */

import { useCallback, useEffect, useState } from 'react';
import {
  getRegion,
  isRegionCode,
  REGIONS,
  type RegionCode,
  type UserSettings,
} from '@octoprice/core';
import { api, ApiError, type Overview, type SessionUser } from './api.ts';
import { claimAccessToken } from './claim.ts';
import { PricesView } from './components/PricesView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { StatusView } from './components/StatusView.tsx';
import { PeopleView } from './components/PeopleView.tsx';
import { SignedOut } from './components/SignedOut.tsx';
import type { JSX } from 'react';

type Tab = 'prices' | 'settings' | 'people' | 'status';

/** Whether this device is signed in, and if not, why not. */
type AuthState = 'checking' | 'signed-in' | 'no-link' | 'bad-link' | 'claim-failed';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const REFRESH_INTERVAL_MS = 60_000;
const REGION_CONFIRMED_KEY = 'octoprice_region_confirmed_v1';

function initialTab(): Tab {
  if (window.location.pathname.startsWith('/settings')) return 'settings';
  return 'prices';
}

function applyTheme(theme: UserSettings['theme']): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

interface RegionSetupProps {
  initialRegion: RegionCode;
  onConfirm(region: RegionCode): Promise<void>;
}

function RegionSetup({ initialRegion, onConfirm }: RegionSetupProps): JSX.Element {
  const [region, setRegion] = useState(initialRegion);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(region);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your region.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="setup-screen">
      <div className="card setup-card">
        <p className="eyebrow">One quick step</p>
        <h2>Where do you use electricity?</h2>
        <p className="muted">
          Agile prices differ across Great Britain. Choose your area so every price shown is the one
          you would actually pay.
        </p>
        <div className="field">
          <label htmlFor="initial-region">Your area</label>
          <select
            id="initial-region"
            value={region}
            onChange={(event) => setRegion(event.target.value as RegionCode)}
          >
            {REGIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.area}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn primary wide" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : `Use ${getRegion(region).area}`}
        </button>
        <p className="muted small">You can change this later in Settings.</p>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}

/**
 * Signs the device in when it arrives via an invite link.
 *
 * The token is only removed from the address bar once the outcome is
 * definitive. On the first load after a deployment the service worker takes
 * control and reloads the page, which aborts whatever request is in flight;
 * keeping the token means that reload simply tries again instead of stranding
 * someone with a link that can never be used.
 */
async function claimFromUrl(): Promise<AuthState | null> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('invite');
  if (!token) return null;

  const forgetToken = (): void => {
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const outcome = await claimAccessToken(token, { claim: (value) => api.claim(value) });

  switch (outcome.kind) {
    case 'claimed':
      forgetToken();
      return 'signed-in';
    case 'rejected':
      // It will never work, so there is no reason to keep it in the URL.
      forgetToken();
      return 'bad-link';
    default:
      // Keep the token: refreshing retries the claim.
      return 'claim-failed';
  }
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [auth, setAuth] = useState<AuthState>('checking');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsRegion, setNeedsRegion] = useState(
    () => localStorage.getItem(REGION_CONFIRMED_KEY) !== 'true',
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(() => !isStandalone());
  const [installHelp, setInstallHelp] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api.overview();
      setOverview(loaded);
      setUser(loaded.user);
      setAuth('signed-in');
      applyTheme(loaded.settings.theme);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        // Not an error to show: the person simply has not been invited yet.
        setAuth((previous) => (previous === 'bad-link' ? previous : 'no-link'));
        setError(null);
        return;
      }
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
    let cancelled = false;
    void (async () => {
      const claimed = await claimFromUrl();
      if (cancelled) return;
      if (claimed === 'bad-link' || claimed === 'claim-failed') {
        setAuth(claimed);
        setLoading(false);
        return;
      }
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (auth !== 'signed-in') return;
    const timer = setInterval(() => {
      setNow(new Date());
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [auth, load]);

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

  useEffect(() => {
    const onPrompt = (event: Event): void => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
      setShowInstall(true);
    };
    const onInstalled = (): void => {
      setInstallPrompt(null);
      setShowInstall(false);
      setInstallHelp(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async (): Promise<void> => {
    if (!installPrompt) {
      setInstallHelp('Open your browser menu and choose “Install app” or “Add to Home Screen”.');
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setShowInstall(false);
    setInstallPrompt(null);
  };

  const onSettingsChange = (updated: UserSettings): void => {
    applyTheme(updated.theme);
    localStorage.setItem(REGION_CONFIRMED_KEY, 'true');
    setOverview((previous) => (previous ? { ...previous, settings: updated } : previous));
    void load();
  };

  const confirmRegion = async (region: RegionCode): Promise<void> => {
    const updated = await api.updateSettings({ region });
    localStorage.setItem(REGION_CONFIRMED_KEY, 'true');
    setNeedsRegion(false);
    onSettingsChange(updated);
  };

  if (auth === 'checking' || (loading && !overview)) {
    return <p className="centre">Loading prices…</p>;
  }
  if (auth === 'no-link' || auth === 'bad-link' || auth === 'claim-failed') {
    return (
      <SignedOut
        reason={
          auth === 'bad-link' ? 'invalid' : auth === 'claim-failed' ? 'unreachable' : 'missing'
        }
      />
    );
  }
  if (!overview) return <p className="error">{error ?? 'Could not load OctoPrice.'}</p>;
  const regionCode = isRegionCode(overview.settings.region) ? overview.settings.region : 'C';
  if (needsRegion) return <RegionSetup initialRegion={regionCode} onConfirm={confirmRegion} />;

  const display = { hour12: overview.settings.hour12 };
  const region = getRegion(regionCode);

  return (
    <>
      <header className="app-header">
        <div>
          <h1>OctoPrice</h1>
          <span className="region">
            {region.area}
            {user && !user.isOwner ? ` · ${user.name}` : ''}
          </span>
        </div>
        {showInstall && (
          <button type="button" className="btn compact" onClick={() => void install()}>
            Install app
          </button>
        )}
      </header>

      {installHelp && <p className="install-help">{installHelp}</p>}

      <nav className="tabs" role="tablist">
        {(
          [
            ['prices', 'Prices'],
            ['settings', 'Settings'],
            ...(user?.isOwner ? ([['people', 'People']] as [Tab, string][]) : []),
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

      {tab === 'prices' && <PricesView overview={overview} now={now} display={display} />}
      {tab === 'settings' && (
        <SettingsView settings={overview.settings} onSettingsChange={onSettingsChange} />
      )}
      {tab === 'people' && user?.isOwner && <PeopleView />}
      {tab === 'status' && <StatusView now={now} />}

      <footer className="app-footer">
        <span>Made by Alan Clinch</span>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/alanclinch/OctoPrice" target="_blank" rel="noreferrer">
          Source code
        </a>
      </footer>
    </>
  );
}
