import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FORECAST_MODEL } from '@octoprice/core';
import { expect, it } from 'vitest';
import type { Overview } from '../src/api.ts';
import { ForecastView } from '../src/components/ForecastView.tsx';

it('shows the current estimate while the separate comparison is still loading', () => {
  const overview = {
    today: { periods: [] },
    tomorrow: { periods: [] },
    settings: { region: 'N' },
    forecast: {
      periods: [
        {
          validFrom: '2026-09-25T00:00:00.000Z',
          validTo: '2026-09-25T00:30:00.000Z',
          valueIncVat: 18,
          lowerIncVat: 15,
          upperIncVat: 22,
          sampleCount: 8,
          model: FORECAST_MODEL,
        },
      ],
      unavailableReason: null,
    },
  } as Overview;

  const html = renderToStaticMarkup(
    createElement(ForecastView, {
      overview,
      now: new Date('2026-09-24T00:00:00.000Z'),
      display: { hour12: false },
    }),
  );

  expect(html).toContain('Upcoming estimates');
  expect(html).toContain('Half-hour estimates');
  expect(html).toContain('18.0p');
  expect(html).toContain('Loading model comparison');
});
