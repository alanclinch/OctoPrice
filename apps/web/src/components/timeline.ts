import type { ForecastPricePeriod, PricePeriod } from '@octoprice/core';

export type TimelinePricePeriod = PricePeriod | ForecastPricePeriod;

export function isForecastPeriod(period: TimelinePricePeriod): period is ForecastPricePeriod {
  return 'model' in period;
}

/** Keep estimates only where an official Octopus price has not arrived. */
export function unconfirmedForecastPeriods<T extends { validFrom: string }>(
  confirmed: readonly { validFrom: string }[],
  forecast: readonly T[],
): T[] {
  const confirmedStarts = new Set(confirmed.map((period) => period.validFrom));
  return forecast.filter((period) => !confirmedStarts.has(period.validFrom));
}
