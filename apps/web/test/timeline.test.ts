import { expect, it } from 'vitest';
import { unconfirmedForecastPeriods } from '../src/components/timeline.ts';

it('excludes estimates with a corresponding official price', () => {
  const official = [{ validFrom: '2026-09-24T22:00:00.000Z' }];
  const estimates = [
    { validFrom: '2026-09-24T22:00:00.000Z', valueIncVat: 20 },
    { validFrom: '2026-09-24T22:30:00.000Z', valueIncVat: 18 },
  ];

  expect(unconfirmedForecastPeriods(official, estimates)).toEqual([estimates[1]]);
});
