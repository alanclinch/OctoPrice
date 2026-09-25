import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGILEPREDICT_MODEL } from '@octoprice/core';
import { unconfirmedForecastPeriods } from '../src/components/timeline.ts';
import { PriceTable } from '../src/components/PriceTable.tsx';

it('excludes estimates with a corresponding official price', () => {
  const official = [{ validFrom: '2026-09-24T22:00:00.000Z' }];
  const estimates = [
    { validFrom: '2026-09-24T22:00:00.000Z', valueIncVat: 20 },
    { validFrom: '2026-09-24T22:30:00.000Z', valueIncVat: 18 },
  ];

  expect(unconfirmedForecastPeriods(official, estimates)).toEqual([estimates[1]]);
});

it('keeps the provider explanation collapsed at the experimental-price boundary', () => {
  const html = renderToStaticMarkup(
    createElement(PriceTable, {
      periods: [
        {
          validFrom: '2026-09-25T00:00:00.000Z',
          validTo: '2026-09-25T00:30:00.000Z',
          valueIncVat: 18,
          lowerIncVat: 15,
          upperIncVat: 22,
          sampleCount: 0,
          model: AGILEPREDICT_MODEL,
        },
      ],
      now: new Date('2026-09-24T23:00:00.000Z'),
      display: { hour12: false },
      forecastInfo: { source: AGILEPREDICT_MODEL, issuedAt: '2026-09-24T15:15:00.000Z' },
    }),
  );

  expect(html).toContain('Experimental prices below');
  expect(html).toContain('aria-label="Show forecast information"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toMatch(/class="forecast-boundary-info" hidden=""/);
  expect(html).toContain('Forecasts by AgilePredict. Contains BMRS data');
  expect(html).not.toContain('Experimental estimates from here');
});
