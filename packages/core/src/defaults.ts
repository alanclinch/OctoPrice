/**
 * Sensible defaults, applied on first run so the app is useful immediately.
 *
 * These are ordinary rules created in the database like any other - the user
 * can edit or delete them. Nothing about them is special-cased in the engine.
 */

import type { AlertRuleInput } from './types.ts';

/** The Agile import product in use. Overridden by automatic discovery. */
export const FALLBACK_AGILE_PRODUCT_CODE = 'AGILE-24-10-01';

/** Prefix used to recognise Agile import products during discovery. */
export const AGILE_IMPORT_PRODUCT_PREFIX = 'AGILE-';

/** The single-user identifier used until multi-user support is added. */
export const DEFAULT_USER_ID = 'default';

/** Rules created for a new installation. */
export const DEFAULT_ALERT_RULES: readonly AlertRuleInput[] = [
  {
    name: 'Negative prices',
    enabled: true,
    operator: 'lt',
    thresholdPence: 0,
    minimumDurationMinutes: 30,
    timeStart: null,
    timeEnd: null,
    notify: true,
  },
  {
    name: 'Cheap electricity',
    enabled: true,
    operator: 'lte',
    thresholdPence: 7,
    minimumDurationMinutes: 30,
    timeStart: null,
    timeEnd: null,
    notify: true,
  },
  {
    name: 'Two cheap hours',
    enabled: true,
    operator: 'lte',
    thresholdPence: 7,
    minimumDurationMinutes: 120,
    timeStart: null,
    timeEnd: null,
    notify: true,
  },
] as const;

/** Window lengths offered by the cheapest-window calculator, in minutes. */
export const WINDOW_DURATION_CHOICES = [30, 60, 90, 120, 180, 240, 360] as const;

/**
 * Price bands used for colouring the chart and table. Values are p/kWh
 * including VAT, and the band is the first whose `upTo` the price is at or
 * below.
 */
export const PRICE_BANDS = [
  { id: 'negative', label: 'Negative', upTo: 0 },
  { id: 'verycheap', label: 'Very cheap', upTo: 5 },
  { id: 'cheap', label: 'Cheap', upTo: 10 },
  { id: 'normal', label: 'Normal', upTo: 20 },
  { id: 'high', label: 'High', upTo: 30 },
  { id: 'veryhigh', label: 'Very high', upTo: Number.POSITIVE_INFINITY },
] as const;

export type PriceBandId = (typeof PRICE_BANDS)[number]['id'];

/** The band a price falls into. */
export function priceBand(valueIncVat: number): PriceBandId {
  for (const band of PRICE_BANDS) {
    if (valueIncVat <= band.upTo) return band.id;
  }
  return 'veryhigh';
}
