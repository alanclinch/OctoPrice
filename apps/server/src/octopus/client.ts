/**
 * Octopus Energy API client.
 *
 * Only the public product and tariff endpoints are used, which need no
 * credentials. The client is responsible for the transport concerns the rest
 * of the application should not have to think about: pagination, retries,
 * timeouts and validating that what came back looks like prices.
 *
 * Requests always use explicit UTC ISO-8601 timestamps, as the Octopus
 * documentation recommends, so daylight saving cannot shift a window.
 */

import { z } from 'zod';
import type { PricePeriod } from '@octoprice/core';
import { AGILE_IMPORT_PRODUCT_PREFIX, normalisePeriods } from '@octoprice/core';
import { LOG_EVENTS, describeError, type Logger } from '../logger.ts';

/** Octopus caps `page_size` at 1500; a two-day window needs far less. */
const MAX_PAGE_SIZE = 1500;

const unitRateSchema = z.object({
  value_exc_vat: z.number(),
  value_inc_vat: z.number(),
  valid_from: z.string(),
  // Open-ended rates report null. Agile always sets it, but be defensive.
  valid_to: z.string().nullable(),
  payment_method: z.string().nullable().optional(),
});

const unitRatesResponseSchema = z.object({
  count: z.number(),
  next: z.string().nullable(),
  previous: z.string().nullable().optional(),
  results: z.array(unitRateSchema),
});

const productSummarySchema = z.object({
  code: z.string(),
  direction: z.string(),
  brand: z.string().optional(),
  available_from: z.string().nullable().optional(),
  available_to: z.string().nullable().optional(),
});

const productsResponseSchema = z.object({
  count: z.number(),
  next: z.string().nullable(),
  results: z.array(productSummarySchema),
});

export type OctopusProductSummary = z.infer<typeof productSummarySchema>;

/** Raised for any Octopus request that could not be completed. */
export class OctopusApiError extends Error {
  // Declared explicitly rather than as constructor parameter properties:
  // those are not erasable syntax, and the server runs from TypeScript
  // source on Node, which only strips types.
  readonly status: number | undefined;
  readonly url: string | undefined;

  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'OctopusApiError';
    this.status = status;
    this.url = url;
  }

  /** 5xx and network failures are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === undefined || this.status >= 500 || this.status === 429;
  }
}

export interface OctopusClientOptions {
  baseUrl?: string;
  logger: Logger;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Attempts per request, including the first. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  retryDelayMs?: number;
  /** Injected for tests so backoff does not actually sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class OctopusClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: OctopusClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.octopus.energy/v1').replace(/\/$/, '');
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  /** Performs one request, with a timeout, and parses the JSON body. */
  private async requestOnce(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new OctopusApiError(
          `Octopus returned ${response.status} ${response.statusText}`,
          response.status,
          url,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof OctopusApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OctopusApiError(`Request timed out after ${this.timeoutMs}ms`, undefined, url);
      }
      throw new OctopusApiError(
        error instanceof Error ? error.message : String(error),
        undefined,
        url,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Performs a request, retrying retryable failures with exponential backoff.
   * A 4xx fails immediately: retrying a bad tariff code never helps.
   */
  private async request(url: string): Promise<unknown> {
    let lastError: OctopusApiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(url);
      } catch (error) {
        const apiError =
          error instanceof OctopusApiError
            ? error
            : new OctopusApiError(String(error), undefined, url);
        lastError = apiError;

        this.logger.warn('Octopus request failed', {
          event: LOG_EVENTS.octopusApiError,
          url,
          attempt,
          maxAttempts: this.maxAttempts,
          status: apiError.status,
          retryable: apiError.retryable,
          ...describeError(apiError),
        });

        if (!apiError.retryable || attempt === this.maxAttempts) break;
        await this.sleepFn(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }

    throw lastError ?? new OctopusApiError('Octopus request failed', undefined, url);
  }

  /**
   * Half-hour unit rates for a tariff over a UTC window.
   *
   * `period_from` is inclusive and `period_to` exclusive. Results come back
   * newest-first and may be paginated; this returns them normalised to
   * oldest-first with duplicates removed.
   */
  async getUnitRates(options: {
    productCode: string;
    tariffCode: string;
    periodFrom: Date;
    periodTo: Date;
  }): Promise<PricePeriod[]> {
    const { productCode, tariffCode, periodFrom, periodTo } = options;
    const params = new URLSearchParams({
      period_from: periodFrom.toISOString(),
      period_to: periodTo.toISOString(),
      page_size: String(MAX_PAGE_SIZE),
    });

    let url =
      `${this.baseUrl}/products/${encodeURIComponent(productCode)}` +
      `/electricity-tariffs/${encodeURIComponent(tariffCode)}` +
      `/standard-unit-rates/?${params.toString()}`;

    const collected: PricePeriod[] = [];
    // Bounded so a misbehaving `next` link cannot loop forever.
    for (let page = 0; page < 20; page += 1) {
      const body = await this.request(url);
      const parsed = unitRatesResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new OctopusApiError(
          `Unexpected unit rate response shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          undefined,
          url,
        );
      }

      for (const rate of parsed.data.results) {
        const period = toPricePeriod(rate);
        if (period) collected.push(period);
      }

      if (!parsed.data.next) break;
      url = parsed.data.next;
    }

    return normalisePeriods(collected);
  }

  /** Every product Octopus lists, following pagination. */
  async listProducts(): Promise<OctopusProductSummary[]> {
    let url = `${this.baseUrl}/products/?page_size=100`;
    const collected: OctopusProductSummary[] = [];

    for (let page = 0; page < 20; page += 1) {
      const body = await this.request(url);
      const parsed = productsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new OctopusApiError('Unexpected products response shape', undefined, url);
      }
      collected.push(...parsed.data.results);
      if (!parsed.data.next) break;
      url = parsed.data.next;
    }

    return collected;
  }

  /**
   * The Agile *import* product currently on offer.
   *
   * Chooses the most recently available product whose code starts with
   * `AGILE-`, excluding the export ("outgoing") tariff. Returns null when
   * nothing matches, so the caller can fall back to a known product code
   * rather than failing outright.
   */
  async findCurrentAgileProduct(now: Date = new Date()): Promise<string | null> {
    const products = await this.listProducts();
    const candidates = products
      .filter((product) => isAgileImportProduct(product, now))
      .sort((a, b) => availableFromMs(b) - availableFromMs(a));

    const chosen = candidates[0]?.code ?? null;
    if (chosen) {
      this.logger.info('Discovered current Agile product', {
        event: LOG_EVENTS.productDiscovered,
        productCode: chosen,
        candidates: candidates.length,
      });
    }
    return chosen;
  }
}

function availableFromMs(product: OctopusProductSummary): number {
  return product.available_from ? Date.parse(product.available_from) : 0;
}

/** True for an Agile import product that is available at `now`. */
export function isAgileImportProduct(product: OctopusProductSummary, now: Date): boolean {
  if (!product.code.startsWith(AGILE_IMPORT_PRODUCT_PREFIX)) return false;
  if (product.direction !== 'IMPORT') return false;

  const at = now.getTime();
  const from = product.available_from
    ? Date.parse(product.available_from)
    : Number.NEGATIVE_INFINITY;
  const to = product.available_to ? Date.parse(product.available_to) : Number.POSITIVE_INFINITY;
  return from <= at && at < to;
}

/**
 * Converts one API record to a price period, or null when it is unusable.
 *
 * A missing `valid_to` is filled in as half an hour after `valid_from`, which
 * is what an open-ended Agile rate means in practice. Records with an
 * unparseable timestamp are dropped rather than poisoning the dataset.
 */
export function toPricePeriod(rate: z.infer<typeof unitRateSchema>): PricePeriod | null {
  const from = Date.parse(rate.valid_from);
  if (Number.isNaN(from)) return null;

  const to = rate.valid_to ? Date.parse(rate.valid_to) : from + 30 * 60 * 1000;
  if (Number.isNaN(to) || to <= from) return null;

  return {
    validFrom: new Date(from).toISOString(),
    validTo: new Date(to).toISOString(),
    valueIncVat: rate.value_inc_vat,
    valueExcVat: rate.value_exc_vat,
  };
}
