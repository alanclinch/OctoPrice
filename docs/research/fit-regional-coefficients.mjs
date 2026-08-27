/**
 * Reproduces finding 1.1 in docs/forecasting.md: Agile regions are exact
 * linear transforms of one another.
 *
 * Checked in so the headline numbers can be re-derived rather than trusted.
 * A narrative figure cannot tell you when Octopus changes its methodology;
 * re-running this can.
 *
 *   node docs/research/fit-regional-coefficients.mjs [days] [reference]
 *
 * Method, stated explicitly so the result can be argued with:
 *
 *   Product      AGILE-24-10-01, single-register import (E-1R-...-<region>)
 *   Series       value_exc_vat, so the 1.05 VAT step is not folded into the
 *                fitted slope
 *   Alignment    by exact `valid_from` instant, never by index or position
 *   Split        peak = 16:00-19:00 Europe/London local, off-peak otherwise,
 *                because the peak adder differs and mixing them inflates the
 *                residual
 *   Regression   ordinary least squares, y = slope * x + intercept
 *   Reported     slope, intercept, R^2, and worst absolute residual - the
 *                worst residual matters more than R^2 here, because R^2 stays
 *                flattering long after a relationship stops being exact
 *
 * Default window is 30 days, which is roughly what one Octopus request
 * returns at page_size=1500.
 */

const DAYS = Number(process.argv[2] ?? 30);
const REFERENCE = process.argv[3] ?? 'C';
const PRODUCT = 'AGILE-24-10-01';
const REGIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P'];

const to = new Date();
const from = new Date(to.getTime() - DAYS * 24 * 3600 * 1000);
const iso = (d) => `${d.toISOString().slice(0, 19)}Z`;

async function ratesFor(region) {
  const url =
    `https://api.octopus.energy/v1/products/${PRODUCT}/electricity-tariffs/` +
    `E-1R-${PRODUCT}-${region}/standard-unit-rates/` +
    `?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${region}: HTTP ${response.status}`);
  const body = await response.json();
  return new Map(
    (body.results ?? []).map((row) => [new Date(row.valid_from).toISOString(), row.value_exc_vat]),
  );
}

function leastSquares(points) {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const slope =
    points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) /
    points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  const residuals = points.map((p) => p.y - (slope * p.x + intercept));
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const ssTot = points.reduce((s, p) => s + (p.y - my) ** 2, 0);
  return {
    n,
    slope,
    intercept,
    r2: 1 - ssRes / ssTot,
    worst: Math.max(...residuals.map(Math.abs)),
  };
}

const londonHour = (isoString) =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(isoString)),
  );

const isPeak = (isoString) => {
  const hour = londonHour(isoString);
  return hour >= 16 && hour < 19;
};

const reference = await ratesFor(REFERENCE);
const values = [...reference.values()];

console.log(`product   ${PRODUCT}`);
console.log(`window    ${iso(from)} .. ${iso(to)}  (${DAYS} days)`);
console.log(`reference region ${REFERENCE}: ${reference.size} periods`);
console.log(
  `          min ${Math.min(...values).toFixed(2)}p  max ${Math.max(...values).toFixed(2)}p  ` +
    `negative periods ${values.filter((v) => v < 0).length}   (p/kWh excluding VAT)\n`,
);

console.log('region  period    slope    intercept       R^2      worst residual');
console.log('------  --------  -------  ----------  ----------  --------------');

let worstOverall = 0;
for (const region of REGIONS) {
  if (region === REFERENCE) continue;
  const other = await ratesFor(region);

  for (const [label, wantPeak] of [
    ['off-peak', false],
    ['peak', true],
  ]) {
    const points = [];
    for (const [start, y] of other) {
      const x = reference.get(start);
      if (x === undefined) continue;
      if (isPeak(start) !== wantPeak) continue;
      points.push({ x, y });
    }
    if (points.length < 10) {
      console.log(`${region}       ${label.padEnd(8)}  (only ${points.length} points)`);
      continue;
    }
    const fit = leastSquares(points);
    worstOverall = Math.max(worstOverall, fit.worst);
    console.log(
      `${region}       ${label.padEnd(8)}  ${fit.slope.toFixed(4)}  ${fit.intercept
        .toFixed(4)
        .padStart(10)}  ${fit.r2.toFixed(8)}  ${fit.worst.toFixed(4)}p`,
    );
  }
}

console.log(`\nworst residual across every region and period: ${worstOverall.toFixed(4)}p`);
console.log(
  worstOverall < 0.05
    ? 'Consistent with an exact linear relationship (residual is publication rounding).'
    : 'WARNING: residual too large for an exact relationship. Has the methodology changed?',
);
