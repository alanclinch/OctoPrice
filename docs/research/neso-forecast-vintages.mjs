/**
 * Proves that NESO forecast vintages can be reconstructed after the fact.
 *
 * `docs/forecasting.md` originally claimed NESO could not supply history, and
 * the input archive was built partly on that premise. It was wrong: NESO
 * publishes annual half-hourly forecast archives carrying a real
 * `Forecast_Datetime` for every issue of every 0-14 day forecast.
 *
 * This script demonstrates it by picking one settlement period and listing the
 * successive forecasts made for it as the day approached — which is exactly
 * the shape a leak-free back-test needs and exactly what a rolling feed with
 * no issue time cannot give you.
 *
 *   node docs/research/neso-forecast-vintages.mjs
 *
 * Method notes, so the result can be argued with:
 *
 *   Resource     31861619-0b86-47ba-bac2-d008a760af54 (June-December 2026).
 *                January-June 2026 is d6375700-69c2-4c25-8bde-883a205d742e.
 *   Period       DATE_GMT / TIME_GMT are the settlement period *end* in UTC,
 *                so the period start is 30 minutes earlier. Getting this
 *                wrong shifts every feature by one half-hour.
 *   Issue time   Forecast_Datetime, which the rolling feed does not carry.
 */

const RESOURCE = '31861619-0b86-47ba-bac2-d008a760af54';
const API = 'https://api.neso.energy/api/3/action';

const query = async (sql) => {
  const response = await fetch(`${API}/datastore_search_sql?sql=${encodeURIComponent(sql)}`);
  const body = await response.json();
  if (!body.success) throw new Error(JSON.stringify(body.error).slice(0, 200));
  return body.result.records;
};

/** The published instant is the period end; the period starts 30 minutes earlier. */
const periodStart = (dateGmt, timeGmt) => {
  // Only the date part of DATE_GMT is trusted; TIME_GMT holds the period end.
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateGmt));
  const time = /^(\d{1,2}):(\d{2})/.exec(String(timeGmt));
  if (!date || !time) return null;
  const end = Date.UTC(+date[1], +date[2] - 1, +date[3], +time[1], +time[2]);
  return new Date(end - 30 * 60 * 1000).toISOString();
};

const [{ rows, earliest, latest }] = await query(
  `SELECT COUNT(*) AS rows, MIN("Forecast_Datetime") AS earliest,
          MAX("Forecast_Datetime") AS latest FROM "${RESOURCE}"`,
);

console.log(`resource     ${RESOURCE}`);
console.log(`rows         ${Number(rows).toLocaleString('en-GB')}`);
console.log(`issue times  ${earliest} .. ${latest}`);
console.log(
  `currency     latest issue is ${((Date.now() - Date.parse(`${latest}Z`)) / 3600000).toFixed(
    1,
  )} hours old\n`,
);

// Pick a settlement period a couple of days back, so several forecasts of it
// exist, and show how the estimate moved as it approached.
const target = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);

const vintages = await query(
  `SELECT "DATE_GMT", "TIME_GMT", "SETTLEMENT_PERIOD", "EMBEDDED_WIND_FORECAST", "Forecast_Datetime"
     FROM "${RESOURCE}"
    WHERE "DATE_GMT" = '${target}T00:00:00' AND "SETTLEMENT_PERIOD" = 27
    ORDER BY "Forecast_Datetime" ASC
    LIMIT 12`,
);

if (vintages.length === 0) {
  console.log(`No rows found for ${target}. Try a different date.`);
} else {
  const start = periodStart(vintages[0].DATE_GMT, vintages[0].TIME_GMT);
  console.log(`Successive forecasts for the period starting ${start}`);
  console.log(`(settlement period ${vintages[0].SETTLEMENT_PERIOD})\n`);
  console.log('  issued at            lead time   embedded wind');
  console.log('  -------------------  ----------  -------------');
  for (const row of vintages) {
    const issued = Date.parse(`${row.Forecast_Datetime}Z`);
    const lead = (Date.parse(start) - issued) / 3600000;
    console.log(
      `  ${row.Forecast_Datetime}  ${lead.toFixed(1).padStart(7)} h  ${String(
        row.EMBEDDED_WIND_FORECAST,
      ).padStart(9)} MW`,
    );
  }
  console.log(
    '\nEach row is what NESO believed at that moment. A back-test picks the',
    '\nlast issue before its forecast time; using the newest value instead',
    '\nwould leak information that did not exist yet.',
  );
}
