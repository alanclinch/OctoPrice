/**
 * One pricing day: summary, cheapest window, chart and table.
 *
 * Used for both today and tomorrow. Tomorrow may legitimately have no data
 * yet, or partial data while Octopus is still publishing, and both states are
 * shown honestly rather than as an error.
 */

import { useEffect, useState } from 'react';
import { findCheapestWindow, type PeriodRun } from '@octoprice/core';
import type { DayPayload } from '../api.ts';
import { bandClass, clock, duration, longDate, pence, type DisplayOptions } from '../format.ts';
import { PriceChart } from './PriceChart.tsx';
import { PriceTable } from './PriceTable.tsx';
import type { JSX } from 'react';

const WINDOW_CHOICES = [60, 120, 180, 240] as const;

export interface DayViewProps {
  day: DayPayload;
  now: Date;
  display: DisplayOptions;
  /** Today hides periods that have already passed in the table by default. */
  defaultHidePast?: boolean;
}

export function DayView({ day, now, display, defaultHidePast = false }: DayViewProps): JSX.Element {
  const [windowMinutes, setWindowMinutes] = useState<number>(180);
  const [hidePast, setHidePast] = useState(defaultHidePast);
  const [cheapestWindow, setCheapestWindow] = useState<PeriodRun | null>(null);

  useEffect(() => {
    setCheapestWindow(findCheapestWindow(day.periods, windowMinutes));
  }, [day.periods, windowMinutes]);

  if (day.periods.length === 0) {
    return (
      <div className="card">
        <h2>{longDate(day.date)}</h2>
        <p className="centre">
          Waiting for Octopus to publish these prices.
          <br />
          <span className="small">
            They usually arrive from about 16:00, but can be as late as 22:00.
          </span>
        </p>
      </div>
    );
  }

  const summary = day.summary;

  return (
    <>
      <div className="card">
        <div className="app-header" style={{ padding: 0, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{longDate(day.date)}</h2>
          <span className={`pill ${day.complete ? 'ready' : 'waiting'}`}>
            {day.complete ? 'Complete' : `${day.periods.length} of ${day.expectedPeriodCount}`}
          </span>
        </div>

        {summary && (
          <dl className="status-grid">
            <dt>Cheapest</dt>
            <dd>
              <strong className={bandClass(summary.minPence)}>{pence(summary.minPence)}</strong> at{' '}
              {clock(summary.cheapest.validFrom, display)}
            </dd>
            <dt>Most expensive</dt>
            <dd>
              <strong className={bandClass(summary.maxPence)}>{pence(summary.maxPence)}</strong> at{' '}
              {clock(summary.mostExpensive.validFrom, display)}
            </dd>
            <dt>Average</dt>
            <dd>{pence(summary.averagePence)}</dd>
            {summary.negativeCount > 0 && (
              <>
                <dt>Negative</dt>
                <dd className="band-negative">
                  <strong>
                    {summary.negativeCount} {summary.negativeCount === 1 ? 'period' : 'periods'}
                  </strong>{' '}
                  paid to use
                </dd>
              </>
            )}
          </dl>
        )}
      </div>

      <div className="card">
        <h2>Cheapest continuous window</h2>
        <div className="field-row" style={{ marginBottom: 10 }}>
          {WINDOW_CHOICES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`btn${windowMinutes === minutes ? ' primary' : ''}`}
              onClick={() => setWindowMinutes(minutes)}
            >
              {duration(minutes)}
            </button>
          ))}
        </div>
        {cheapestWindow ? (
          <p style={{ margin: 0 }}>
            <strong style={{ fontSize: '1.2rem' }}>
              {clock(cheapestWindow.startUtc, display)} – {clock(cheapestWindow.endUtc, display)}
            </strong>
            <br />
            <span className="muted">
              Average{' '}
              <strong className={bandClass(cheapestWindow.averagePence)}>
                {pence(cheapestWindow.averagePence, 2)}/kWh
              </strong>
              , low of {pence(cheapestWindow.minPence, 2)}
            </span>
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Not enough consecutive prices for a {duration(windowMinutes)} window yet.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Chart</h2>
        <PriceChart periods={day.periods} now={now} display={display} />
      </div>

      <div className="card">
        <div className="app-header" style={{ padding: 0, marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>All periods</h2>
          <label className="small" style={{ margin: 0, display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={hidePast}
              onChange={(event) => setHidePast(event.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            Remaining only
          </label>
        </div>
        <PriceTable periods={day.periods} now={now} display={display} hidePast={hidePast} />
      </div>
    </>
  );
}
