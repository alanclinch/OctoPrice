/**
 * Settings: tariff region, notifications, alert rules and display
 * preferences (DESIGN.md section 15).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AlertRule, AlertRuleInput, RegionInfo, UserSettings } from '@octoprice/core';
import { api } from '../api.ts';
import { disablePush, enablePush, pushState, type PushState } from '../push.ts';
import { RuleForm, RuleList } from './RuleEditor.tsx';
import type { JSX } from 'react';

export interface SettingsViewProps {
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
}

const PUSH_EXPLANATIONS: Record<PushState, string> = {
  unsupported: 'This browser cannot receive push notifications.',
  unconfigured: 'The server has no VAPID keys, so push is unavailable. See the README.',
  denied: 'Notifications are blocked for this site in your browser settings.',
  enabled: 'This device will receive notifications.',
  disabled: 'Notifications are off on this device.',
};

export function SettingsView({ settings, onSettingsChange }: SettingsViewProps): JSX.Element {
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);
  const [push, setPush] = useState<PushState>('disabled');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadRules = useCallback(async () => {
    const { rules: loaded } = await api.rules();
    setRules(loaded);
  }, []);

  useEffect(() => {
    void api.regions().then(({ regions: loaded }) => setRegions(loaded));
    void reloadRules();
    void pushState().then(setPush);
  }, [reloadRules]);

  const patch = async (changes: Parameters<typeof api.updateSettings>[0]): Promise<void> => {
    try {
      onSettingsChange(await api.updateSettings(changes));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that setting.');
    }
  };

  const togglePush = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setPush(push === 'enabled' ? await disablePush() : await enablePush());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change notifications.');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.testNotification();
      setMessage(
        result.sent
          ? `Test notification sent to ${result.delivered} device${result.delivered === 1 ? '' : 's'}.`
          : 'Could not deliver a test notification. Is this device subscribed?',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send a test.');
    } finally {
      setBusy(false);
    }
  };

  const saveRule = async (input: AlertRuleInput): Promise<void> => {
    if (editing && editing !== 'new') {
      await api.updateRule(editing.id, input);
    } else {
      await api.createRule(input);
    }
    setEditing(null);
    await reloadRules();
  };

  const deleteRule = async (rule: AlertRule): Promise<void> => {
    await api.deleteRule(rule.id);
    await reloadRules();
  };

  const toggleRule = async (rule: AlertRule, enabled: boolean): Promise<void> => {
    await api.updateRule(rule.id, {
      name: rule.name,
      operator: rule.operator,
      thresholdPence: rule.thresholdPence,
      minimumDurationMinutes: rule.minimumDurationMinutes,
      timeStart: rule.timeStart,
      timeEnd: rule.timeEnd,
      notify: rule.notify,
      enabled,
    });
    await reloadRules();
  };

  return (
    <>
      <div className="card">
        <h2>Tariff</h2>
        <div className="field">
          <label htmlFor="region">Electricity region</label>
          <select
            id="region"
            value={settings.region}
            onChange={(event) => void patch({ region: event.target.value as RegionInfo['code'] })}
          >
            {regions.map((region) => (
              <option key={region.code} value={region.code}>
                {region.code} — {region.area}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Agile prices differ by distribution region. Your region is the last letter of your Octopus
          tariff code, for example E-1R-AGILE-24-10-01-{settings.region}.
        </p>
      </div>

      <div className="card">
        <h2>Notifications</h2>

        <div className="toggle">
          <span>
            <span className="title">Notifications on this device</span>
            <span className="hint">{PUSH_EXPLANATIONS[push]}</span>
          </span>
          <button
            type="button"
            className={`btn${push === 'enabled' ? '' : ' primary'}`}
            disabled={
              busy || push === 'unsupported' || push === 'unconfigured' || push === 'denied'
            }
            onClick={() => void togglePush()}
          >
            {push === 'enabled' ? 'Turn off' : 'Turn on'}
          </button>
        </div>

        <div className="toggle">
          <span>
            <span className="title">Tomorrow&rsquo;s prices are published</span>
            <span className="hint">One summary each afternoon when the full day arrives.</span>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyDailyPrices}
            onChange={(event) => void patch({ notifyDailyPrices: event.target.checked })}
          />
        </div>

        <div className="toggle">
          <span>
            <span className="title">Price alerts</span>
            <span className="hint">When a stretch of prices matches one of your rules.</span>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyRuleMatches}
            onChange={(event) => void patch({ notifyRuleMatches: event.target.checked })}
          />
        </div>

        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn"
            disabled={busy || push !== 'enabled'}
            onClick={() => void sendTest()}
          >
            Send a test notification
          </button>
        </div>

        {message && <p className="small">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>Alert rules</h2>
        {editing ? (
          editing === 'new' ? (
            <RuleForm onSave={saveRule} onCancel={() => setEditing(null)} />
          ) : (
            <RuleForm initial={editing} onSave={saveRule} onCancel={() => setEditing(null)} />
          )
        ) : (
          <>
            <RuleList
              rules={rules}
              onEdit={setEditing}
              onDelete={(rule) => void deleteRule(rule)}
              onToggle={(rule, enabled) => void toggleRule(rule, enabled)}
            />
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: 10 }}
              onClick={() => setEditing('new')}
            >
              Add a rule
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Display</h2>

        <div className="toggle">
          <span className="title">12-hour clock</span>
          <input
            type="checkbox"
            checked={settings.hour12}
            onChange={(event) => void patch({ hour12: event.target.checked })}
          />
        </div>

        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="theme">Theme</label>
          <select
            id="theme"
            value={settings.theme}
            onChange={(event) => void patch({ theme: event.target.value as UserSettings['theme'] })}
          >
            <option value="system">Match my system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <p className="muted small" style={{ margin: 0 }}>
          Times are always shown in UK time (Europe/London), which is what Octopus prices are quoted
          against.
        </p>
      </div>
    </>
  );
}
