import { describe, expect, it } from 'vitest';
import { londonDayPeriodStarts } from '@octoprice/core';
import { createTestApp, NOW, OWNER_ID, PUSH_SUBSCRIPTION, TOMORROW } from './harness.ts';

function providerCache(region: string, fetchedAt: string) {
  return JSON.stringify({
    version: 1,
    region,
    fetchedAt,
    forecast: {
      model: 'agilepredict',
      source: 'agilepredict',
      referenceRegion: region,
      historyDays: 0,
      issuedAt: fetchedAt,
      unavailableReason: null,
      periods: londonDayPeriodStarts(TOMORROW).map((from) => ({
        validFrom: from.toISOString(),
        validTo: new Date(from.getTime() + 30 * 60 * 1000).toISOString(),
        valueIncVat: 5,
        lowerIncVat: 1,
        upperIncVat: 10,
        sampleCount: 0,
        model: 'agilepredict',
      })),
    },
  });
}

describe('overview forecast source selection', () => {
  it('keeps the flag-off response unchanged even if a provider cache exists', async () => {
    const app = await createTestApp();
    try {
      // The first authenticated request records lastSeenAt; compare two steady-state responses.
      await app.inject({ method: 'GET', url: '/api/overview' });
      const before = await app.inject({ method: 'GET', url: '/api/overview' });
      await app.built.store.setState(
        'forecast_agilepredict_cache:C',
        providerCache('C', NOW.toISOString()),
      );
      const after = await app.inject({ method: 'GET', url: '/api/overview' });
      expect(after.body).toBe(before.body);
      expect(after.json().forecast).not.toHaveProperty('source');
    } finally {
      await app.built.close();
    }
  }, 15_000);

  it('serves only the user region, gives official prices priority, and does not affect windows', async () => {
    const app = await createTestApp([], { agilePredictForecast: true });
    try {
      const tariff = await app.built.priceService.tariff(OWNER_ID);
      const tomorrowStart = londonDayPeriodStarts(TOMORROW)[0];
      if (!tomorrowStart) throw new Error('test day has no periods');
      await app.built.store.upsertPrices([
        {
          tariffCode: tariff.tariffCode,
          region: tariff.region,
          validFrom: tomorrowStart.toISOString(),
          validTo: new Date(tomorrowStart.getTime() + 30 * 60 * 1000).toISOString(),
          valueIncVat: 20,
          valueExcVat: 20 / 1.05,
          retrievedAt: NOW.toISOString(),
        },
      ]);
      await app.built.store.setState(
        'forecast_agilepredict_cache:N',
        providerCache('N', NOW.toISOString()),
      );
      const wrongRegion = await app.inject({ method: 'GET', url: '/api/overview' });
      expect(wrongRegion.json().forecast).toMatchObject({
        source: 'seasonal-naive-v1',
        periods: [],
      });

      const windowsBefore = await app.inject({
        method: 'GET',
        url: '/api/windows?date=2026-01-16&hours=1',
      });
      await app.built.store.setState(
        'forecast_agilepredict_cache:C',
        providerCache('C', NOW.toISOString()),
      );
      const overview = await app.inject({ method: 'GET', url: '/api/overview' });
      const windowsAfter = await app.inject({
        method: 'GET',
        url: '/api/windows?date=2026-01-16&hours=1',
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().forecast).toMatchObject({
        source: 'agilepredict',
        issuedAt: NOW.toISOString(),
      });
      expect(overview.json().forecast.periods).toHaveLength(47);
      expect(overview.json().forecast.periods[0].validFrom).not.toBe(tomorrowStart.toISOString());
      expect(overview.json().tomorrow.periods[0].valueIncVat).toBe(20);
      expect(windowsAfter.body).toBe(windowsBefore.body);
      await app.inject({ method: 'POST', url: '/api/push/subscribe', payload: PUSH_SUBSCRIPTION });
      const officialDay = await app.built.priceService.storedDay(TOMORROW, tariff.tariffCode);
      const dispatch = await app.built.dispatcher.dispatchForDay(TOMORROW, officialDay, OWNER_ID);
      expect(dispatch.matches).toHaveLength(0);
      expect(app.sender.sent.map((notification) => notification.type)).toEqual(['daily_prices']);
      expect(app.sender.sent[0]?.body).toContain('20p/kWh');
      expect(app.sender.sent[0]?.body).not.toContain('5p/kWh');
      expect(
        (await app.built.store.listRules(OWNER_ID)).every((rule) => rule.lastTriggeredAt === null),
      ).toBe(true);
    } finally {
      await app.built.close();
    }
  });

  it('falls back when the provider cache has expired', async () => {
    const app = await createTestApp([], { agilePredictForecast: true });
    try {
      await app.built.store.setState(
        'forecast_agilepredict_cache:C',
        providerCache('C', new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString()),
      );
      const overview = await app.inject({ method: 'GET', url: '/api/overview' });
      expect(overview.json().forecast).toMatchObject({ source: 'seasonal-naive-v1', periods: [] });
    } finally {
      await app.built.close();
    }
  });
});
