/** One chronological price timeline spanning every published day. */

import { useMemo, useState } from 'react';
import { findCheapestWindow, type PeriodRun } from '@octoprice/core';
import type { Overview } from '../api.ts';
import { bandClass, clock, duration, pence, type DisplayOptions } from '../format.ts';
import { NowCard } from './NowCard.tsx';
import { PriceChart } from './PriceChart.tsx';
import { PriceTable } from './PriceTable.tsx';
import type { JSX } from 'react';

const WINDOW_CHOICES = [60, 120, 180, 240] as const;
const PRICE_TOOL_STORAGE_KEY = 'octoprice-open-price-tool';
type PriceTool = 'window' | 'timeline';

function storedPriceTool(): PriceTool | null {
  const stored = window.localStorage.getItem(PRICE_TOOL_STORAGE_KEY);
  return stored === 'window' || stored === 'timeline' ? stored : null;
}

interface PricesViewProps {
  overview: Overview;
  now: Date;
  display: DisplayOptions;
}

export function PricesView({ overview, now, display }: PricesViewProps): JSX.Element {
  const [remainingOnly, setRemainingOnly] = useState(true);
  const [windowMinutes, setWindowMinutes] = useState<number>(180);
  const [openTool, setOpenTool] = useState<PriceTool | null>(storedPriceTool);
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
  const tomorrowStatus = overview.tomorrow.complete
    ? "Tomorrow's prices are ready"
    : overview.tomorrow.periods.length > 0
      ? "Tomorrow's prices are updating"
      : 'Prices usually update around 4pm';

  function toggleTool(tool: PriceTool): void {
    const nextTool = openTool === tool ? null : tool;
    setOpenTool(nextTool);
    if (nextTool) {
      window.localStorage.setItem(PRICE_TOOL_STORAGE_KEY, nextTool);
    } else {
      window.localStorage.removeItem(PRICE_TOOL_STORAGE_KEY);
    }
  }

  return (
    <>
      <NowCard current={overview.current} next={overview.next} display={display} />

      <div className="card price-tools-card">
        <div className="price-availability">
          <span>{tomorrowStatus}</span>
          <span className={`pill ${overview.tomorrow.complete ? 'ready' : 'waiting'}`}>
            {overview.tomorrow.complete
              ? 'Complete'
              : `${overview.tomorrow.periods.length}/${overview.tomorrow.expectedPeriodCount}`}
          </span>
        </div>
        <div className="price-tool-buttons" aria-label="Optional price tools">
          <button
            type="button"
            className={`price-tool-toggle${openTool === 'window' ? ' active' : ''}`}
            aria-expanded={openTool === 'window'}
            onClick={() => toggleTool('window')}
            disabled={visiblePeriods.length === 0}
          >
            <span>Cheapest window</span>
            <span className="disclosure" aria-hidden="true">
              {openTool === 'window' ? '−' : '+'}
            </span>
          </button>
          <button
            type="button"
            className={`price-tool-toggle${openTool === 'timeline' ? ' active' : ''}`}
            aria-expanded={openTool === 'timeline'}
            onClick={() => toggleTool('timeline')}
            disabled={visiblePeriods.length === 0}
          >
            <span>Price timeline</span>
            <span className="disclosure" aria-hidden="true">
              {openTool === 'timeline' ? '−' : '+'}
            </span>
          </button>
        </div>

        {openTool === 'window' && visiblePeriods.length > 0 && (
          <div className="price-tool-content">
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
        )}

        {openTool === 'timeline' && visiblePeriods.length > 0 && (
          <div className="price-tool-content">
            <PriceChart periods={visiblePeriods} now={now} display={display} />
          </div>
        )}
      </div>

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
