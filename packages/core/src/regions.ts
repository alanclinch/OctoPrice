/**
 * Octopus / DNO electricity distribution regions.
 *
 * Agile unit rates differ by region. A tariff code is built as
 * `E-1R-{PRODUCT_CODE}-{REGION}`, e.g. `E-1R-AGILE-24-10-01-C`.
 *
 * Note there is no region `I` or `O` (they are skipped to avoid confusion
 * with the digits 1 and 0).
 */
export const REGION_CODES = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
] as const;

export type RegionCode = (typeof REGION_CODES)[number];

export interface RegionInfo {
  /** Single-letter DNO code used in Octopus tariff codes. */
  code: RegionCode;
  /** Distribution network operator name. */
  distributor: string;
  /** Human-friendly area description shown during setup. */
  area: string;
}

export const REGIONS: readonly RegionInfo[] = [
  { code: 'A', distributor: 'UK Power Networks', area: 'Eastern England' },
  { code: 'B', distributor: 'National Grid Electricity Distribution', area: 'East Midlands' },
  { code: 'C', distributor: 'UK Power Networks', area: 'London' },
  { code: 'D', distributor: 'SP Energy Networks', area: 'Merseyside, Cheshire & North Wales' },
  { code: 'E', distributor: 'National Grid Electricity Distribution', area: 'West Midlands' },
  { code: 'F', distributor: 'Northern Powergrid', area: 'North East England' },
  { code: 'G', distributor: 'Electricity North West', area: 'North West England' },
  { code: 'H', distributor: 'Scottish & Southern Electricity Networks', area: 'Southern England' },
  { code: 'J', distributor: 'UK Power Networks', area: 'South East England' },
  { code: 'K', distributor: 'National Grid Electricity Distribution', area: 'South Wales' },
  { code: 'L', distributor: 'National Grid Electricity Distribution', area: 'South West England' },
  { code: 'M', distributor: 'Northern Powergrid', area: 'Yorkshire' },
  { code: 'N', distributor: 'SP Energy Networks', area: 'Southern Scotland' },
  { code: 'P', distributor: 'Scottish & Southern Electricity Networks', area: 'Northern Scotland' },
] as const;

export function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === 'string' && (REGION_CODES as readonly string[]).includes(value);
}

export function getRegion(code: RegionCode): RegionInfo {
  const region = REGIONS.find((r) => r.code === code);
  if (!region) throw new Error(`Unknown region code: ${code}`);
  return region;
}

/**
 * Builds the single-register import tariff code for a product and region.
 * `E-1R` = Electricity, 1 Register (single rate).
 */
export function buildTariffCode(productCode: string, region: RegionCode): string {
  return `E-1R-${productCode}-${region}`;
}

/** Extracts the region from a tariff code, or null if it does not parse. */
export function regionFromTariffCode(tariffCode: string): RegionCode | null {
  const suffix = tariffCode.slice(-1);
  return isRegionCode(suffix) ? suffix : null;
}
