import type { ForecastPricePeriod, PricePeriod } from '@octoprice/core';

export type TimelinePricePeriod = PricePeriod | ForecastPricePeriod;

export function isForecastPeriod(period: TimelinePricePeriod): period is ForecastPricePeriod {
  return 'model' in period;
}
