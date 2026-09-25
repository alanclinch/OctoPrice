/** Private, immutable comparison snapshots from AgilePredict's documented API. */

import {
  addDays,
  AGILEPREDICT_MODEL,
  buildTariffCode,
  londonDateAndMinutes,
  londonDayPeriodStarts,
  type PricingDate,
} from '@octoprice/core';
import type { Store } from '../db/store.ts';
import { describeError, type Logger } from '../logger.ts';
import type { PriceService } from '../prices/service.ts';
import { COLLECTOR_USER_AGENT } from './collectors.ts';

const API_URL = 'https://agilepredict.com/api/N/?days=4&forecast_count=3&high_low=False';
const STATE_PREFIX = 'competitor:agilepredict:';

export interface ProviderForecast {
  createdAt: string;
  values: Map<string, number>;
  ranges: Map<string, { low: number; high: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject malformed, non-finite and duplicate values rather than silently scoring bad data. */
export function parseAgilePredict(value: unknown): ProviderForecast[] {
  if (!Array.isArray(value)) throw new Error('AgilePredict response is not an array');
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.created_at !== 'string' || !Array.isArray(item.prices)) {
      return [];
    }
    const issued = Date.parse(item.created_at);
    if (!Number.isFinite(issued)) return [];
    const values = new Map<string, number>();
    const ranges = new Map<string, { low: number; high: number }>();
    for (const price of item.prices) {
      if (!isRecord(price) || typeof price.date_time !== 'string') continue;
      const at = Date.parse(price.date_time);
      const pence = price.agile_pred;
      if (!Number.isFinite(at) || typeof pence !== 'number' || !Number.isFinite(pence)) continue;
      const key = new Date(at).toISOString();
      if (values.has(key)) return [];
      values.set(key, pence);
      const low = price.agile_low;
      const high = price.agile_high;
      if (
        typeof low === 'number' &&
        Number.isFinite(low) &&
        typeof high === 'number' &&
        Number.isFinite(high) &&
        low <= high
      ) {
        ranges.set(key, { low, high });
      }
    }
    return [{ createdAt: new Date(issued).toISOString(), values, ranges }];
  });
}

/** Capture the latest provider issue available before our 14:00 comparison cut-off. */
export async function collectAgilePredict(options: {
  store: Store;
  priceService: PriceService;
  logger: Logger;
  now: Date;
  fetchFn?: typeof fetch;
}): Promise<number> {
  const local = londonDateAndMinutes(options.now);
  // The existing forecast cron runs at :02/:07/...; retry until 16:00 if the
  // provider is briefly down. Never issue after official prices may arrive.
  if (local.minutes < 14 * 60 || local.minutes >= 16 * 60) return 0;
  const stateKey = `${STATE_PREFIX}${local.date}`;
  const target = addDays(local.date, 1);
  const cutoff = londonDayPeriodStarts(local.date).find(
    (at) => londonDateAndMinutes(at).minutes === 14 * 60,
  );
  if (!cutoff) return 0;
  try {
    if (await options.store.getState(stateKey)) return 0;
    // Only record a benchmark for a tariff whose official Region N prices the
    // regular poller is already collecting. Never guess a product code here.
    const tariffs = await options.priceService.distinctTariffs();
    const southern = tariffs.find((tariff) => tariff.region === 'N');
    if (!southern) return 0;
    const response = await (options.fetchFn ?? fetch)(API_URL, {
      headers: { Accept: 'application/json', 'User-Agent': COLLECTOR_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`AgilePredict returned HTTP ${response.status}`);
    const forecasts = parseAgilePredict(await response.json());
    const issue = forecasts
      .filter((candidate) => {
        const at = Date.parse(candidate.createdAt);
        return at <= cutoff.getTime() && at >= cutoff.getTime() - 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!issue) throw new Error('AgilePredict has no recent pre-cut-off issue');
    const tariffCode = buildTariffCode(southern.productCode, 'N');
    let recorded = 0;
    let complete = 0;
    for (let offset = 0; offset < 3; offset += 1) {
      const targetDate = addDays(target, offset) as PricingDate;
      const values = londonDayPeriodStarts(targetDate).map((at) =>
        issue.values.get(at.toISOString()),
      );
      if (values.some((value) => value === undefined)) continue;
      complete += 1;
      const inserted = await options.store.insertForecastRun({
        model: AGILEPREDICT_MODEL,
        tariffCode,
        targetDate,
        generatedAt: options.now.toISOString(),
        issueCutoff: cutoff.toISOString(),
        inputVintages: [issue.createdAt],
        periods: values as number[],
      });
      if (inserted) recorded += 1;
    }
    if (complete === 0) throw new Error('AgilePredict has no complete future day');
    await options.store.setState(stateKey, issue.createdAt);
    options.logger.info('Recorded private competitor forecast', {
      source: AGILEPREDICT_MODEL,
      issue: issue.createdAt,
      days: recorded,
    });
    return recorded;
  } catch (error) {
    options.logger.warn('Private competitor collection failed', describeError(error));
    return 0;
  }
}
