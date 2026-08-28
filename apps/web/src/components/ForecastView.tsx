/** Owner-only view of the private fundamentals-analogue experiment. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ANALOGUE_FORECAST_MODEL,
  FORECAST_MODEL,
  getRegion,
  type PricePeriod,
} from '@octoprice/core';
import {
  api,
  type ForecastExperimentPayload,
  type ForecastExperimentPeriod,
  type ForecastExperimentRun,
} from '../api.ts';
import { longDate, pence, periodRange, type DisplayOptions } from '../format.ts';
import type { JSX } from 'react';

const WIDTH = 360;
const HEIGHT = 170;
const PAD = { top: 10, right: 8, bottom: 20, left: 28 };

function modelLabel(model: string): string {
  if (model === FORECAST_MODEL) return 'Current v1';
  if (model === ANALOGUE_FORECAST_MODEL) return 'New v2';
  return model;
}

function phaseText(payload: ForecastExperimentPayload): string {
  switch (payload.phase) {
    case 'collecting-history':
      return 'Collecting the confirmed price history needed to reconstruct fair comparisons.';
    case 'preparing-days':
      return `Preparing compact analogue days: ${payload.preparedDays} of about ${payload.requiredPreparedDays}.`;
    case 'waiting-for-forecast':
      return 'The history is ready. Waiting for the next 2pm issue point to record the first comparison.';
    default:
      return 'The experiment is recording forecasts and scoring them after official prices arrive.';
  }
}

interface Curve {
  key: string;
  label: string;
  className: string;
  periods: ForecastExperimentPeriod[];
}

function ForecastComparisonChart({ curves }: { curves: Curve[] }): JSX.Element {
  const values = curves.flatMap((curve) => curve.periods.map((period) => period.valueIncVat));
  if (values.length === 0) return <p className="centre muted">No forecast curve yet.</p>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const timeline = curves.reduce(
    (longest, curve) => (curve.periods.length > longest.length ? curve.periods : longest),
    [] as ForecastExperimentPeriod[],
  );
  const count = timeline.length;
  const indexByStart = new Map(timeline.map((period, index) => [period.validFrom, index]));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const xFor = (index: number): number => PAD.left + (index / Math.max(count - 1, 1)) * plotWidth;
  const yFor = (value: number): number => PAD.top + ((high - value) / span) * plotHeight;

  return (
    <div>
      <div className="forecast-legend" aria-hidden="true">
        {curves.map((curve) => (
          <span key={curve.key} className={curve.className}>
            {curve.label}
          </span>
        ))}
      </div>
      <svg
        className="chart forecast-comparison-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={curves.map((curve) => curve.label).join(', ')}
      >
        <text className="axis-label" x={PAD.left - 4} y={yFor(high) + 3} textAnchor="end">
          {Math.round(high)}
        </text>
        <text className="axis-label" x={PAD.left - 4} y={yFor(low) + 3} textAnchor="end">
          {Math.round(low)}
        </text>
        <line
          className="axis-line"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={HEIGHT - PAD.bottom}
          y2={HEIGHT - PAD.bottom}
        />
        {curves.map((curve) => (
          <polyline
            key={curve.key}
            className={`forecast-curve ${curve.className}`}
            points={curve.periods
              .flatMap((period) => {
                const index = indexByStart.get(period.validFrom);
                return index === undefined ? [] : [`${xFor(index)},${yFor(period.valueIncVat)}`];
              })
              .join(' ')}
          />
        ))}
        {[0, 12, 24, 36]
          .filter((index) => index < count)
          .map((index) => (
            <text
              key={index}
              className="axis-label"
              x={xFor(index)}
              y={HEIGHT - 5}
              textAnchor={index === 0 ? 'start' : 'middle'}
            >
              {String(Math.floor(index / 2)).padStart(2, '0')}:00
            </text>
          ))}
      </svg>
    </div>
  );
}

function asExperimentPeriods(periods: PricePeriod[]): ForecastExperimentPeriod[] {
  return periods.map(({ validFrom, validTo, valueIncVat }) => ({
    validFrom,
    validTo,
    valueIncVat,
  }));
}

export function ForecastView({ display }: { display: DisplayOptions }): JSX.Element {
  const [payload, setPayload] = useState<ForecastExperimentPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await api.forecastExperiment());
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not load the forecast experiment.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const latestDate = payload?.runs[0]?.targetDate ?? null;
  const latestRuns = useMemo(
    () => payload?.runs.filter((run) => run.targetDate === latestDate) ?? [],
    [latestDate, payload?.runs],
  );
  const v1 = latestRuns.find((run) => run.model === FORECAST_MODEL);
  const v2 = latestRuns.find((run) => run.model === ANALOGUE_FORECAST_MODEL);
  const actual = payload && latestDate ? asExperimentPeriods(payload.actual) : [];
  const curves: Curve[] = [
    ...(v1 ? [{ key: 'v1', label: 'Current v1', className: 'curve-v1', periods: v1.periods }] : []),
    ...(v2 ? [{ key: 'v2', label: 'New v2', className: 'curve-v2', periods: v2.periods }] : []),
    ...(actual.length > 0
      ? [{ key: 'actual', label: 'Official', className: 'curve-actual', periods: actual }]
      : []),
  ];
  const actualByStart = new Map(actual.map((period) => [period.validFrom, period.valueIncVat]));
  const v2ByStart = new Map(v2?.periods.map((period) => [period.validFrom, period.valueIncVat]));
  const scored = payload?.runs.filter((run) => run.score !== null) ?? [];

  if (loading && !payload) return <p className="centre">Loading forecast experiment…</p>;

  return (
    <>
      <div className="card forecast-intro">
        <div className="card-heading-row">
          <div>
            <p className="eyebrow">Private experiment</p>
            <h2>Forecast development</h2>
          </div>
          <span className="pill">Experimental</span>
        </div>
        <p>{payload ? phaseText(payload) : 'Forecast status is unavailable.'}</p>
        {payload && (
          <>
            <div className="progress-track" aria-label="Prepared analogue days">
              <span
                style={{
                  width: `${Math.min(100, (payload.preparedDays / payload.requiredPreparedDays) * 100)}%`,
                }}
              />
            </div>
            <p className="muted small">
              {payload.preparedDays}/{payload.requiredPreparedDays} prepared
              {payload.historyThrough ? ` · price history through ${payload.historyThrough}` : ''}
              {payload.preparedThrough ? ` · features through ${payload.preparedThrough}` : ''}
            </p>
          </>
        )}
        <p className="muted small">
          This page is for observing the model while it is built. Nothing here drives alerts,
          current prices or cheapest-window advice.
        </p>
        <button
          type="button"
          className="btn compact"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>

      {payload &&
        !payload.regionalTransformAvailable &&
        payload.requestedRegion !== payload.displayRegion && (
          <p className="notice">
            Your regional conversion is not ready, so this currently shows reference-region prices.
          </p>
        )}

      {payload && latestDate && (
        <div className="card">
          <h2>{longDate(latestDate)}</h2>
          <p className="muted small">
            Displayed for {getRegion(payload.displayRegion).area}. The scored accuracy below remains
            the common reference-region comparison.
          </p>
          <ForecastComparisonChart curves={curves} />

          {v1 && (
            <details className="forecast-details">
              <summary>Half-hour comparison</summary>
              <div className="table-scroll">
                <table className="price-table forecast-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th className="numeric">v1</th>
                      <th className="numeric">v2</th>
                      <th className="numeric">Official</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v1.periods.map((period) => (
                      <tr key={period.validFrom}>
                        <td>{periodRange(period, display)}</td>
                        <td className="numeric">{pence(period.valueIncVat)}</td>
                        <td className="numeric">
                          {v2ByStart.has(period.validFrom)
                            ? pence(v2ByStart.get(period.validFrom) as number)
                            : '—'}
                        </td>
                        <td className="numeric">
                          {actualByStart.has(period.validFrom)
                            ? pence(actualByStart.get(period.validFrom) as number)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {payload && payload.runs.length === 0 && (
        <div className="card">
          <h2>No recorded comparison yet</h2>
          <p className="muted">
            This is expected during the initial catch-up. The first v1/v2 curves will appear here
            automatically once enough historical days are prepared.
          </p>
        </div>
      )}

      {scored.length > 0 && (
        <div className="card">
          <h2>Recorded accuracy</h2>
          <p className="muted small">
            Lower MAE and three-hour regret are better. “Near best” means the chosen cheap window
            started within one hour of the true optimum.
          </p>
          <div className="table-scroll">
            <table className="price-table forecast-score-table">
              <thead>
                <tr>
                  <th>Day/model</th>
                  <th className="numeric">MAE</th>
                  <th className="numeric">Regret</th>
                  <th className="numeric">Near best</th>
                </tr>
              </thead>
              <tbody>
                {scored.map((run: ForecastExperimentRun) => (
                  <tr key={run.id}>
                    <td>
                      {run.targetDate.slice(5)} · {modelLabel(run.model)}
                    </td>
                    <td className="numeric">{pence(run.score?.maePence as number)}</td>
                    <td className="numeric">{pence(run.score?.cheapest3hRegret as number)}</td>
                    <td className="numeric">{run.score?.within60Minutes ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
