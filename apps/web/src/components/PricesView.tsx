/** One chronological price timeline spanning every published day. */

import { useMemo, useState } from 'react';
import { findCheapestWindow, londonDateOf, type PeriodRun } from '@octoprice/core';
import type { Overview } from '../api.ts';
import { bandClass, clock, duration, longDate, pence, type DisplayOptions } from '../format.ts';
import { NowCard } from './NowCard.tsx';
import { PriceChart } from './PriceChart.tsx';
import { PriceTable } from './PriceTable.tsx';
import type { JSX } from 'react';

const WINDOW_CHOICES = [60, 120, 180, 240] as const;

interface PricesViewProps {
  overview: Overview;
  now: Date;
  display: DisplayOptions;
}

export function PricesView({ overview, now, display }: PricesViewProps): JSX.Element {
  const [remainingOnly, setRemainingOnly] = useState(true);
  const [windowMinutes, setWindowMinutes] = useState<number>(180);
  const allPeriods = useMemo(
    () =>
      [...overview.today.periods, ...overview.tomorrow.periods].sort(
        (a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom),
      ),
    [overview.today.periods, overview.tomorrow.periods],
  );
  const visiblePeriods = remainingOnly
    ? allPeriods.filter((period) => Date.parse(period.validTo) > now.getTime())
    : allPeriods;
  const cheapestWindow: PeriodRun | null = findCheapestWindow(visiblePeriods, windowMinutes);
  const lastPeriod = visiblePeriods.at(-1);
  const tomorrowStatus = overview.tomorrow.complete
    ? "Tomorrow's prices are complete"
    : overview.tomorrow.periods.length > 0
      ? `Tomorrow: ${overview.tomorrow.periods.length} of ${overview.tomorrow.expectedPeriodCount} prices published`
      : "Tomorrow's prices have not been published yet";

  return (
    <>
      <NowCard current={overview.current} next={overview.next} display={display} />

      <div className="card">
        <div className="section-heading">
          <div>
            <h2>Available prices</h2>
            <p className="section-title">{tomorrowStatus}</p>
          </div>
          <span className={`pill ${overview.tomorrow.complete ? 'ready' : 'waiting'}`}>
            {overview.tomorrow.complete
              ? 'Complete'
              : `${overview.tomorrow.periods.length}/${overview.tomorrow.expectedPeriodCount}`}
          </span>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {lastPeriod
            ? `${visiblePeriods.length} half-hour prices shown, through ${longDate(londonDateOf(new Date(lastPeriod.validFrom)))} at ${clock(lastPeriod.validTo, display)}.`
            : 'No remaining prices are stored yet. OctoPrice will check again automatically.'}
        </p>
      </div>

      {visiblePeriods.length > 0 && (
        <>
          <div className="card">
            <h2>Cheapest continuous window</h2>
            <div className="field-row window-choices">
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
              <p style={{ marginBottom: 0 }}>
                <strong className="window-time">
                  {clock(cheapestWindow.startUtc, display)} –{' '}
                  {clock(cheapestWindow.endUtc, display)}
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
              <p className="muted" style={{ marginBottom: 0 }}>
                Not enough consecutive prices for a {duration(windowMinutes)} window yet.
              </p>
            )}
          </div>

          <div className="card">
            <h2>Price timeline</h2>
            <PriceChart periods={visiblePeriods} now={now} display={display} />
          </div>
        </>
      )}

      <div className="card">
        <div className="section-heading table-heading">
          <div>
            <h2>Half-hour prices</h2>
            <p className="section-title">
              {remainingOnly ? 'Current slot first' : 'Including elapsed prices'}
            </p>
          </div>
          <label className="remaining-toggle">
            <input
              type="checkbox"
              checked={remainingOnly}
              onChange={(event) => setRemainingOnly(event.target.checked)}
            />
            Remaining only
          </label>
        </div>
        <PriceTable periods={allPeriods} now={now} display={display} hidePast={remainingOnly} />
      </div>
    </>
  );
}
