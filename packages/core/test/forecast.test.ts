import { describe, expect, it } from 'vitest';
import {
  FORECAST_MODEL,
  fitRegionalPriceTransform,
  forecastSeasonalPrices,
  londonDayPeriodStarts,
  londonMinutesOfDay,
  prepareForecastHistory,
  roundPence,
  type PricePeriod,
} from '../src/index.ts';

function period(at: Date, valueIncVat: number): PricePeriod {
  return {
    validFrom: at.toISOString(),
    validTo: new Date(at.getTime() + 30 * 60 * 1000).toISOString(),
    valueIncVat,
    valueExcVat: roundPence(valueIncVat / 1.05),
  };
}

function historyDay(date: string, offset: number): PricePeriod[] {
  return londonDayPeriodStarts(date).map((at, index) => period(at, offset + index / 10));
}

describe('seasonal-naive price forecasting', () => {
  it('uses recent matching weekdays and reports an empirical range', () => {
    const history = [
      ...historyDay('2026-01-05', 10),
      ...historyDay('2026-01-06', 20),
      ...historyDay('2026-01-07', 30),
      ...historyDay('2026-01-08', 40),
    ];
    const target = londonDayPeriodStarts('2026-01-09')[20] as Date;

    const result = forecastSeasonalPrices({
      history,
      targets: [target],
      transform: fitRegionalPriceTransform(history, history, true)!,
      now: new Date('2026-01-08T23:59:00.000Z'),
    });

    expect(result).toEqual([
      expect.objectContaining({
        validFrom: target.toISOString(),
        valueIncVat: 27,
        lowerIncVat: 22,
        upperIncVat: 32,
        sampleCount: 4,
        model: FORECAST_MODEL,
      }),
    ]);
  });

  it('keeps weekend observations separate from weekdays', () => {
    const history = [
      ...historyDay('2026-01-03', 2),
      ...historyDay('2026-01-04', 4),
      ...historyDay('2026-01-10', 6),
      ...historyDay('2026-01-05', 80),
      ...historyDay('2026-01-06', 90),
      ...historyDay('2026-01-07', 100),
    ];
    const target = londonDayPeriodStarts('2026-01-11')[0] as Date;

    const [forecast] = forecastSeasonalPrices({
      history,
      targets: [target],
      transform: fitRegionalPriceTransform(history, history, true)!,
      now: new Date('2026-01-10T23:59:00.000Z'),
    });

    expect(forecast?.valueIncVat).toBe(4);
    expect(forecast?.sampleCount).toBe(3);
  });

  it('produces no estimate when fewer than three comparable days exist', () => {
    const history = [...historyDay('2026-01-05', 10), ...historyDay('2026-01-06', 20)];
    const targets = londonDayPeriodStarts('2026-01-07');

    expect(
      forecastSeasonalPrices({
        history,
        targets,
        transform: fitRegionalPriceTransform(history, history, true)!,
        now: new Date('2026-01-06T23:59:00.000Z'),
      }),
    ).toEqual([]);
  });

  it('uses one prepared history pass for every target', () => {
    const history = [
      ...historyDay('2026-01-05', 10),
      ...historyDay('2026-01-06', 20),
      ...historyDay('2026-01-07', 30),
      ...historyDay('2026-01-08', 40),
    ];
    const now = new Date('2026-01-08T23:59:00.000Z');
    const preparedHistory = prepareForecastHistory(history);
    const unreadableHistory = new Proxy(history, {
      get() {
        throw new Error('forecast rescanned raw history');
      },
    });

    expect(
      forecastSeasonalPrices({
        history: unreadableHistory,
        preparedHistory,
        targets: londonDayPeriodStarts('2026-01-09'),
        transform: fitRegionalPriceTransform(history, history, true)!,
        now,
      }),
    ).toHaveLength(48);
  });

  it('creates the correct number of periods on short and long clock-change days', () => {
    const history = [
      ...historyDay('2026-03-14', 9),
      ...historyDay('2026-03-21', 10),
      ...historyDay('2026-03-22', 11),
      ...historyDay('2026-03-28', 12),
      ...historyDay('2026-10-10', 12),
      ...historyDay('2026-10-17', 13),
      ...historyDay('2026-10-18', 14),
      ...historyDay('2026-10-24', 15),
    ];
    const transform = fitRegionalPriceTransform(history, history, true)!;

    expect(
      forecastSeasonalPrices({
        history,
        targets: londonDayPeriodStarts('2026-03-29'),
        transform,
        now: new Date('2026-03-28T23:00:00.000Z'),
      }),
    ).toHaveLength(46);
    expect(
      forecastSeasonalPrices({
        history,
        targets: londonDayPeriodStarts('2026-10-25'),
        transform,
        now: new Date('2026-10-24T22:59:00.000Z'),
      }),
    ).toHaveLength(50);
  });

  it('classifies every clock-change settlement slot in London time', () => {
    const history = [...historyDay('2026-03-29', 10), ...historyDay('2026-10-25', 20)];

    for (const item of prepareForecastHistory(history)) {
      expect(item.minutes).toBe(londonMinutesOfDay(new Date(item.period.validFrom)));
    }
  });
});

describe('regional price transforms', () => {
  it('derives separate exact peak and off-peak mappings', () => {
    const reference = [
      ...historyDay('2025-12-29', 5),
      ...historyDay('2025-12-30', 6),
      ...historyDay('2025-12-31', 7),
      ...historyDay('2026-01-01', 8),
      ...historyDay('2026-01-05', 10),
      ...historyDay('2026-01-06', 20),
      ...historyDay('2026-01-07', 30),
      ...historyDay('2026-01-08', 40),
    ];
    const target = reference.map((source) => {
      const hour = new Date(source.validFrom).getUTCHours();
      const peak = hour >= 16 && hour < 19;
      return period(
        new Date(source.validFrom),
        source.valueIncVat * (peak ? 1.2 : 1.1) + (peak ? -2 : 0.5),
      );
    });

    const fitted = fitRegionalPriceTransform(reference, target);

    expect(fitted?.offPeak.slope).toBeCloseTo(1.1, 10);
    expect(fitted?.offPeak.intercept).toBeCloseTo(0.5, 10);
    expect(fitted?.peak.slope).toBeCloseTo(1.2, 10);
    expect(fitted?.peak.intercept).toBeCloseTo(-2, 10);
    expect(fitted?.peak.rSquared).toBeCloseTo(1, 10);
  });

  it('refuses a relationship that is not effectively exact', () => {
    const reference = [
      ...historyDay('2025-12-29', 5),
      ...historyDay('2025-12-30', 6),
      ...historyDay('2025-12-31', 7),
      ...historyDay('2026-01-01', 8),
      ...historyDay('2026-01-05', 10),
      ...historyDay('2026-01-06', 20),
      ...historyDay('2026-01-07', 30),
      ...historyDay('2026-01-08', 40),
    ];
    const target = reference.map((source, index) =>
      period(new Date(source.validFrom), source.valueIncVat + (index % 5) * 2),
    );

    expect(fitRegionalPriceTransform(reference, target)).toBeNull();
  });
});
