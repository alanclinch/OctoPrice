/**
 * The plain list of half-hour prices (DESIGN.md section 14).
 *
 * Negative periods have to be immediately obvious, so they get the band
 * colour and an explicit minus sign rather than relying on the reader
 * noticing a small numeric difference.
 */

import { Fragment } from 'react';
import { londonDateOf, type PricePeriod } from '@octoprice/core';
import { bandClass, longDate, pence, periodRange, type DisplayOptions } from '../format.ts';
import type { JSX } from 'react';

export interface PriceTableProps {
  periods: PricePeriod[];
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

          return (
            <Fragment key={period.validFrom}>
              {date !== previousDate && (
                <tr className="day-separator">
                  <th colSpan={2} scope="rowgroup">
                    {longDate(date)}
                  </th>
                </tr>
              )}
              <tr className={isNow ? 'is-now' : isPast ? 'is-past' : undefined}>
                <td>
                  {periodRange(period, display)}
                  {isNow && <span className="muted small"> · now</span>}
                </td>
                <td className={`numeric price ${bandClass(period.valueIncVat)}`}>
                  {pence(period.valueIncVat, 2)}
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
