/**
 * The half-hourly price chart.
 *
 * Hand-drawn SVG rather than a charting library: the requirements are
 * specific (negative bars below the axis, coloured price bands, an obvious
 * "now" marker, tap a bar for its exact price) and small enough that a
 * library would be more constraint than help. It also keeps the bundle tiny,
 * which matters for a phone-first PWA.
 */

import { useMemo, useState } from 'react';
import { bandClass, clock, pence, periodRange, type DisplayOptions } from '../format.ts';
import { isForecastPeriod, type TimelinePricePeriod } from './timeline.ts';
import type { JSX } from 'react';

const WIDTH = 360;
const HEIGHT = 170;
const PADDING = { top: 8, right: 4, bottom: 16, left: 26 };

export interface PriceChartProps {
  periods: TimelinePricePeriod[];
  now: Date;
  display: DisplayOptions;
}

export function PriceChart({ periods, now, display }: PriceChartProps): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null);

  const scale = useMemo(() => {
    const values = periods.map((period) => period.valueIncVat);
    const rawMax = values.length > 0 ? Math.max(...values) : 30;
    const rawMin = values.length > 0 ? Math.min(...values) : 0;
    // Always include zero so negative prices read as "below the line".
    const max = Math.max(rawMax, 0);
    const min = Math.min(rawMin, 0);
    // A little headroom stops the tallest bar touching the top edge.
    const top = max === min ? max + 1 : max + (max - min) * 0.08;
    const bottom = min;
    return { top, bottom };
  }, [periods]);

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const span = scale.top - scale.bottom || 1;

  const yFor = (value: number): number => PADDING.top + ((scale.top - value) / span) * plotHeight;

  const barWidth = periods.length > 0 ? plotWidth / periods.length : 0;
  const zeroY = yFor(0);

  const nowIndex = periods.findIndex(
    (period) =>
      Date.parse(period.validFrom) <= now.getTime() && Date.parse(period.validTo) > now.getTime(),
  );

  const selectedPeriod = selected === null ? null : (periods[selected] ?? null);

  if (periods.length === 0) {
    return <p className="centre">No prices to chart yet.</p>;
  }

  // Hour labels every four periods (two hours) keeps a phone readable.
  const labelEvery = 8;

  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Half-hourly electricity prices, ${periods.length} periods`}
        onMouseLeave={() => setSelected(null)}
      >
        {/* Vertical axis labels: top, zero and bottom of the range. */}
        {[scale.top, 0, scale.bottom]
          .filter((value, index, all) => all.indexOf(value) === index)
          .map((value) => (
            <text
              key={`y-${value}`}
              className="axis-label"
              x={PADDING.left - 4}
              y={yFor(value) + 3}
              textAnchor="end"
            >
              {Math.round(value)}
            </text>
          ))}

        {periods.map((period, index) => {
          const value = period.valueIncVat;
          const top = yFor(Math.max(value, 0));
          const bottom = yFor(Math.min(value, 0));
          const x = PADDING.left + index * barWidth;

          return (
            <rect
              key={period.validFrom}
              className={`bar ${bandClass(value, 'bar')}${selected === index ? ' selected' : ''}`}
              data-forecast={isForecastPeriod(period) ? 'true' : undefined}
              x={x}
              y={top}
              width={Math.max(barWidth - 0.6, 0.8)}
              height={Math.max(bottom - top, 0.8)}
              onClick={() => setSelected(selected === index ? null : index)}
              onMouseEnter={() => setSelected(index)}
            >
              <title>
                {periodRange(period, display)}: {pence(value)}
                {isForecastPeriod(period)
                  ? ` estimate (${pence(period.lowerIncVat)}–${pence(period.upperIncVat)} recent range)`
                  : ''}
              </title>
            </rect>
          );
        })}

        {/* Zero line, drawn over the bars so negative periods are unmistakable. */}
        {scale.bottom < 0 && (
          <line
            className="zero-line"
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={zeroY}
            y2={zeroY}
          />
        )}

        <line
          className="axis-line"
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={HEIGHT - PADDING.bottom}
          y2={HEIGHT - PADDING.bottom}
        />

        {/* Where we are now. */}
        {nowIndex >= 0 && (
          <line
            className="now-marker"
            x1={PADDING.left + nowIndex * barWidth + barWidth / 2}
            x2={PADDING.left + nowIndex * barWidth + barWidth / 2}
            y1={PADDING.top}
            y2={HEIGHT - PADDING.bottom}
          />
        )}

        {periods.map((period, index) =>
          index % labelEvery === 0 ? (
            <text
              key={`x-${period.validFrom}`}
              className="axis-label"
              x={PADDING.left + index * barWidth}
              y={HEIGHT - 4}
            >
              {clock(period.validFrom, display).slice(0, 5)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="chart-readout">
        {selectedPeriod ? (
          <>
            <span>{periodRange(selectedPeriod, display)}</span>
            <strong className={bandClass(selectedPeriod.valueIncVat)}>
              {isForecastPeriod(selectedPeriod) ? '~' : ''}
              {pence(selectedPeriod.valueIncVat, isForecastPeriod(selectedPeriod) ? 1 : 2)}/kWh
            </strong>
          </>
        ) : (
          <span className="muted small">Tap a bar for the exact price.</span>
        )}
      </div>
    </div>
  );
}
