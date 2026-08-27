/**
 * Display formatting.
 *
 * All of it goes through `@octoprice/core`, so the times shown on screen and
 * the times written into notifications are produced by the same code.
 */

import { formatLondonTime, priceBand } from '@octoprice/core';

export interface DisplayOptions {
  hour12: boolean;
}

/** `17:30`, or `5:30 pm` when the user prefers a 12-hour clock. */
export function clock(iso: string, options: DisplayOptions): string {
  return formatLondonTime(new Date(iso), { hour12: options.hour12 });
}

/** `12.4p`, `-3.6p`. One decimal is as precise as anyone needs on screen. */
export function pence(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}p`;
}

/** The CSS class carrying the colour for a price band. */
export function bandClass(value: number, prefix: 'band' | 'bar' = 'band'): string {
  return `${prefix}-${priceBand(value)}`;
}

/** `00:00-00:30` for a table row. */
export function periodRange(
  period: { validFrom: string; validTo: string },
  options: DisplayOptions,
): string {
  return `${clock(period.validFrom, options)}–${clock(period.validTo, options)}`;
}

/** `2 hours`, `30 minutes`, for window and rule descriptions. */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${label} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** `Thursday 27 August`, for day headings. */
export function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(at);
}

/** `just now`, `4 minutes ago`, for the status page. */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const deltaSeconds = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (deltaSeconds < 45) return 'just now';

  const formatter = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, seconds] of units) {
    if (deltaSeconds >= seconds) {
      return formatter.format(-Math.round(deltaSeconds / seconds), unit);
    }
  }
  return 'just now';
}
