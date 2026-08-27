/**
 * Creating and editing alert rules (DESIGN.md sections 7 to 9).
 *
 * The form mirrors the rule model exactly - operator, threshold, minimum
 * duration, optional time restriction - rather than offering a handful of
 * canned alerts, because the whole point is that rules are not hard-coded.
 */

import { useState } from 'react';
import type { AlertRule, AlertRuleInput, ComparisonOperator } from '@octoprice/core';
import { OPERATOR_SYMBOLS, describeRule } from '@octoprice/core';
import type { FormEvent, JSX } from 'react';

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  lt: 'is below',
  lte: 'is at or below',
  gt: 'is above',
  gte: 'is at or above',
};

const DURATION_CHOICES = [30, 60, 90, 120, 180, 240, 360];

const LEGACY_DEFAULT_RULE_NAMES: Readonly<Record<string, string>> = {
  'Negative prices': 'Negative Prices',
  'Cheap electricity': 'Cheap Electricity',
  'Two cheap hours': 'Two Cheap Hours',
};

function displayRuleName(name: string): string {
  return LEGACY_DEFAULT_RULE_NAMES[name] ?? name;
}

export interface RuleFormProps {
  initial?: AlertRule;
  onSave: (input: AlertRuleInput) => Promise<void>;
  onCancel: () => void;
}

export function RuleForm({ initial, onSave, onCancel }: RuleFormProps): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [operator, setOperator] = useState<ComparisonOperator>(initial?.operator ?? 'lte');
  const [threshold, setThreshold] = useState(String(initial?.thresholdPence ?? 7));
  const [minimumDuration, setMinimumDuration] = useState(initial?.minimumDurationMinutes ?? 30);
  const [restrictTime, setRestrictTime] = useState(
    initial?.timeStart !== null && initial !== undefined,
  );
  const [timeStart, setTimeStart] = useState(initial?.timeStart ?? '22:00');
  const [timeEnd, setTimeEnd] = useState(initial?.timeEnd ?? '06:00');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [notify, setNotify] = useState(initial?.notify ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    const thresholdValue = Number(threshold);
    if (!name.trim()) return setError('Give the rule a name.');
    if (Number.isNaN(thresholdValue)) return setError('The price threshold must be a number.');

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        operator,
        thresholdPence: thresholdValue,
        minimumDurationMinutes: minimumDuration,
        timeStart: restrictTime ? timeStart : null,
        timeEnd: restrictTime ? timeEnd : null,
        enabled,
        notify,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the rule.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rule" onSubmit={submit}>
      <div className="field">
        <label htmlFor="rule-name">Name</label>
        <input
          id="rule-name"
          type="text"
          value={name}
          placeholder="Cheap overnight electricity"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="rule-operator">Alert me when the price</label>
          <select
            id="rule-operator"
            value={operator}
            onChange={(event) => setOperator(event.target.value as ComparisonOperator)}
          >
            {(Object.keys(OPERATOR_LABELS) as ComparisonOperator[]).map((key) => (
              <option key={key} value={key}>
                {OPERATOR_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-threshold">p/kWh</label>
          <input
            id="rule-threshold"
            type="number"
            step="0.1"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="rule-duration">For at least</label>
        <select
          id="rule-duration"
          value={minimumDuration}
          onChange={(event) => setMinimumDuration(Number(event.target.value))}
        >
          {DURATION_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 30 ? 'Any single half hour' : `${minutes / 60} hours`}
            </option>
          ))}
        </select>
      </div>

      <div className="toggle">
        <span>
          <span className="title">Only between certain times</span>
          <span className="hint">A window may cross midnight, e.g. 22:00 to 06:00.</span>
        </span>
        <input
          type="checkbox"
          checked={restrictTime}
          onChange={(event) => setRestrictTime(event.target.checked)}
        />
      </div>

      {restrictTime && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="rule-start">From</label>
            <input
              id="rule-start"
              type="time"
              value={timeStart}
              onChange={(event) => setTimeStart(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="rule-end">Until</label>
            <input
              id="rule-end"
              type="time"
              value={timeEnd}
              onChange={(event) => setTimeEnd(event.target.value)}
            />
          </div>
        </div>
      )}

      <div className="toggle">
        <span className="title">Rule enabled</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </div>

      <div className="toggle">
        <span>
          <span className="title">Send a notification</span>
          <span className="hint">Off means matches still show in the app, but stay quiet.</span>
        </span>
        <input
          type="checkbox"
          checked={notify}
          onChange={(event) => setNotify(event.target.checked)}
        />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface RuleListProps {
  rules: AlertRule[];
  onEdit: (rule: AlertRule) => void;
  onDelete: (rule: AlertRule) => void;
  onToggle: (rule: AlertRule, enabled: boolean) => void;
}

export function RuleList({ rules, onEdit, onDelete, onToggle }: RuleListProps): JSX.Element {
  if (rules.length === 0) {
    return <p className="muted">No alert rules yet.</p>;
  }

  return (
    <>
      {rules.map((rule) => (
        <div key={rule.id} className={`rule${rule.enabled ? '' : ' disabled'}`}>
          <div className="toggle" style={{ borderBottom: 0, paddingTop: 0 }}>
            <span>
              <span className="rule-name">{displayRuleName(rule.name)}</span>
              <span className="rule-detail">{describeRule(rule)}</span>
              {rule.lastTriggeredAt && (
                <span className="rule-detail">
                  Last matched {new Date(rule.lastTriggeredAt).toLocaleDateString('en-GB')}
                </span>
              )}
              {!rule.notify && <span className="rule-detail">Notifications off</span>}
            </span>
            <input
              type="checkbox"
              checked={rule.enabled}
              aria-label={`Enable ${displayRuleName(rule.name)}`}
              onChange={(event) => onToggle(rule, event.target.checked)}
            />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => onEdit(rule)}>
              Edit
            </button>
            <button type="button" className="btn danger" onClick={() => onDelete(rule)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <p className="muted small">
        Operators available: {Object.values(OPERATOR_SYMBOLS).join(' ')}
      </p>
    </>
  );
}
