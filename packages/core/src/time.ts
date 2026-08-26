/**
 * Time handling.
 *
 * Rules for the whole project:
 *  - Everything is stored and compared in UTC.
 *  - Everything is *displayed* in `Europe/London`.
 *  - A "pricing day" is a local London calendar day, which is 46, 48 or 50
 *    half-hour periods long depending on daylight-saving transitions.
 *
 * No third-party date library is used: `Intl.DateTimeFormat` with an IANA
 * time zone is sufficient and is backed by the platform ICU data.
 */

export const LONDON_TIME_ZONE = 'Europe/London';
export const HALF_HOUR_MS = 30 * 60 * 1000;

/** A local calendar date in `YYYY-MM-DD` form. */
export type PricingDate = string;

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function londonParts(instant: Date): LondonParts {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing date part: ${type}`);
    return Number(part.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Offset of Europe/London from UTC at a given instant, in milliseconds.
 * `+3600000` during BST, `0` during GMT.
 */
export function londonOffsetMs(instant: Date): number {
  const p = londonParts(instant);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** True when British Summer Time is in effect at the given instant. */
export function isBritishSummerTime(instant: Date): boolean {
  return londonOffsetMs(instant) !== 0;
}

function formatDateParts(year: number, month: number, day: number): PricingDate {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The London calendar date (`YYYY-MM-DD`) that an instant falls on. */
export function londonDateOf(instant: Date): PricingDate {
  const p = londonParts(instant);
  return formatDateParts(p.year, p.month, p.day);
}

/** Parses `YYYY-MM-DD`, throwing on anything malformed. */
export function parsePricingDate(date: PricingDate): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid pricing date (expected YYYY-MM-DD): ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid pricing date: ${date}`);
  }
  return { year, month, day };
}

/**
 * Converts a London wall-clock time to the UTC instant it represents.
 *
 * Two refinement passes are used so that times near a DST boundary resolve
 * correctly. Times that do not exist locally (the skipped hour when clocks go
 * forward) resolve to the instant the clock jumps to; ambiguous times (the
 * repeated hour when clocks go back) resolve to the first, BST occurrence.
 */
export function londonWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let instant = naive - londonOffsetMs(new Date(naive));
  instant = naive - londonOffsetMs(new Date(instant));
  return new Date(instant);
}

/** The UTC instant of local midnight starting the given London date. */
export function startOfLondonDay(date: PricingDate): Date {
  const { year, month, day } = parsePricingDate(date);
  return londonWallClockToUtc(year, month, day, 0, 0);
}

/** Adds whole calendar days to a `YYYY-MM-DD` date, staying in local terms. */
export function addDays(date: PricingDate, days: number): PricingDate {
  const { year, month, day } = parsePricingDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The UTC instant of local midnight *ending* the given London date. */
export function endOfLondonDay(date: PricingDate): Date {
  return startOfLondonDay(addDays(date, 1));
}

/**
 * Number of half-hour settlement periods in a London day.
 *  - 48 on a normal day
 *  - 46 on the day clocks go forward (an hour is skipped)
 *  - 50 on the day clocks go back (an hour is repeated)
 */
export function expectedPeriodCount(date: PricingDate): number {
  const start = startOfLondonDay(date).getTime();
  const end = endOfLondonDay(date).getTime();
  return Math.round((end - start) / HALF_HOUR_MS);
}

/** Every half-hour boundary in a London day, as UTC instants. */
export function londonDayPeriodStarts(date: PricingDate): Date[] {
  const start = startOfLondonDay(date).getTime();
  const count = expectedPeriodCount(date);
  return Array.from({ length: count }, (_, i) => new Date(start + i * HALF_HOUR_MS));
}

/** The half-hour period containing an instant, rounded down. */
export function floorToHalfHour(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS);
}

export interface TimeFormatOptions {
  /** Use a 12-hour clock with am/pm rather than 24-hour. Defaults to false. */
  hour12?: boolean;
}

const time24Formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const time12Formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/**
 * Formats an instant as a London clock time, e.g. `17:30` or `5:30 pm`.
 * ICU emits a narrow no-break space before am/pm, which is normalised to a
 * plain space so that string comparisons stay predictable.
 */
export function formatLondonTime(instant: Date, options: TimeFormatOptions = {}): string {
  const formatter = options.hour12 ? time12Formatter : time24Formatter;
  return formatter.format(instant).replace(/[\u202f\u00a0]/g, ' ');
}

/** Formats a half-hour period as `HH:mm-HH:mm` in London time. */
export function formatLondonPeriod(from: Date, to: Date, options: TimeFormatOptions = {}): string {
  return `${formatLondonTime(from, options)}–${formatLondonTime(to, options)}`;
}

/** Minutes since local midnight for an instant, on its own London day. */
export function londonMinutesOfDay(instant: Date): number {
  const p = londonParts(instant);
  return p.hour * 60 + p.minute;
}

/** Parses `HH:mm` into minutes since midnight. */
export function parseClockTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time (expected HH:mm): ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${value}`);
  return hour * 60 + minute;
}

/** Formats minutes since midnight as `HH:mm`. */
export function formatClockTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * True when `minutes` falls inside a `[start, end)` window.
 * Windows where `start > end` wrap over midnight, e.g. 22:00-06:00.
 */
export function isWithinClockWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
