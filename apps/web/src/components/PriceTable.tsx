/**
 * The plain list of half-hour prices (DESIGN.md section 14).
 *
 * Negative periods have to be immediately obvious, so they get the band
 * colour and an explicit minus sign rather than relying on the reader
 * noticing a small numeric difference.
 */

import { Fragment } from 'react';
import { londonDateOf } from '@octoprice/core';
import { bandClass, longDate, pence, periodRange, type DisplayOptions } from '../format.ts';
import { isForecastPeriod, type TimelinePricePeriod } from './timeline.ts';
import type { JSX } from 'react';

export interface PriceTableProps {
  periods: TimelinePricePeriod[];
  now: Date;
  display: DisplayOptions;
  /** Hide periods that have already finished. */
  hidePast?: boolean;
}

export function PriceTable({
  periods,
  now,
  display,
  hidePast = false,
}: PriceTableProps): JSX.Element {
  const at = now.getTime();
  const visible = hidePast ? periods.filter((period) => Date.parse(period.validTo) > at) : periods;

  if (visible.length === 0) {
    return <p className="centre">Nothing left to show for this day.</p>;
  }

  return (
    <table className="price-table">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col" className="numeric">
            Price
          </th>
        </tr>
      </thead>
      <tbody>
        {visible.map((period, index) => {
          const from = Date.parse(period.validFrom);
          const to = Date.parse(period.validTo);
          const isNow = from <= at && to > at;
          const isPast = to <= at;
          const date = londonDateOf(new Date(from));
          const previousDate =
            index > 0 ? londonDateOf(new Date(visible[index - 1]?.validFrom ?? from)) : null;
          const forecast = isForecastPeriod(period);
          const previous = visible[index - 1];
          const beginsForecast = forecast && (!previous || !isForecastPeriod(previous));

          return (
            <Fragment key={period.validFrom}>
              {date !== previousDate && (
                <tr className="day-separator">
                  <th colSpan={2} scope="rowgroup">
                    {longDate(date)}
                  </th>
                </tr>
              )}
              {beginsForecast && (
                <tr className="forecast-separator">
                  <th colSpan={2} scope="rowgroup">
                    Experimental estimates from here
                  </th>
                </tr>
              )}
              <tr
                className={
                  forecast ? 'is-forecast' : isNow ? 'is-now' : isPast ? 'is-past' : undefined
                }
              >
                <td>
                  {periodRange(period, display)}
                  {isNow && <span className="muted small"> · now</span>}
                  {forecast && <span className="forecast-label">Estimate</span>}
                </td>
                <td className={`numeric price ${bandClass(period.valueIncVat)}`}>
                  {forecast ? `~${pence(period.valueIncVat, 1)}` : pence(period.valueIncVat, 2)}
                  {forecast && (
                    <span className="forecast-range">
                      {pence(period.lowerIncVat, 1)}–{pence(period.upperIncVat, 1)} recent range
                    </span>
                  )}
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
