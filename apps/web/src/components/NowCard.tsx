/**
 * The headline card: what electricity costs right now, and what it costs next
 * (DESIGN.md section 12).
 *
 * This is the one thing most people open the app for, so it gets the top of
 * the screen and the largest type on it.
 */

import type { PricePeriod } from '@octoprice/core';
import { bandClass, clock, pence, type DisplayOptions } from '../format.ts';
import type { JSX } from 'react';

export interface NowCardProps {
  current: PricePeriod | null;
  next: PricePeriod | null;
  display: DisplayOptions;
}

export function NowCard({ current, next, display }: NowCardProps): JSX.Element {
  return (
    <div className="card">
      <h2>Now</h2>

      {current ? (
        <>
          <div className={`now-price ${bandClass(current.valueIncVat)}`}>
            {pence(current.valueIncVat, 2)}
            <span className="unit">/kWh</span>
          </div>
          <div className="now-meta">Until {clock(current.validTo, display)}</div>
        </>
      ) : (
        <>
          <div className="now-price muted">--</div>
          <div className="now-meta">No price stored for right now.</div>
        </>
      )}

      {next && (
        <div className="next-row">
          <span className="label">Next, {clock(next.validFrom, display)}</span>
          <span className={`value ${bandClass(next.valueIncVat)}`}>
            {pence(next.valueIncVat, 2)}
          </span>
        </div>
      )}
    </div>
  );
}
