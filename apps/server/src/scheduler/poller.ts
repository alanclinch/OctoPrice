/**
 * The daily price-retrieval worker.
 *
 * Price checking must not depend on a browser being open (DESIGN.md section
 * 2.2), so this runs in the server process on a timer.
 *
 * The timing decisions live in `plan.ts`; this class only drives them and
 * performs the side effects. A single timer is used rather than a cron
 * library because the schedule is not a fixed cadence: it starts at 16:05,
 * retries every five minutes, and stops as soon as a complete day arrives.
 */

import { describeDayCoverage, londonDateOf } from '@octoprice/core';
import type { PricingDate } from '@octoprice/core';
import { LOG_EVENTS, describeError, type Logger } from '../logger.ts';
import type { PriceService } from '../prices/service.ts';
import type { AlertDispatcher } from '../alerts/dispatcher.ts';
import { planPoll, type PollWindow } from './plan.ts';

export interface PollerOptions {
  priceService: PriceService;
  dispatcher: AlertDispatcher;
  logger: Logger;
  window: PollWindow;
  now?: () => Date;
  /** Injected in tests so no real timer is created. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/** Node timers cap at ~24.8 days; a shorter ceiling keeps drift in check. */
const MAX_TIMER_MS = 60 * 60 * 1000;

/**
 * How often to look for stretches about to begin. Comfortably shorter than
 * the alert lead time, so a start cannot slip through between checks.
 */
const UPCOMING_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export class PricePoller {
  private readonly priceService: PriceService;
  private readonly dispatcher: AlertDispatcher;
  private readonly logger: Logger;
  private readonly window: PollWindow;
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private upcomingTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  constructor(options: PollerOptions) {
    this.priceService = options.priceService;
    this.dispatcher = options.dispatcher;
    this.logger = options.logger;
    this.window = options.window;
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  /** Begins polling. Safe to call once; use `stop` to shut down cleanly. */
  start(): void {
    this.stopped = false;
    void this.scheduleNext();
    this.startUpcomingChecks();
  }

  /**
   * Runs the "starting soon" check on its own steady cadence.
   *
   * Kept separate from the price-polling timer because the two have nothing in
   * common: price polling is a burst confined to the publication window, while
   * this has to tick quietly all day. It touches only the store, so the cost
   * is negligible.
   */
  private startUpcomingChecks(): void {
    if (this.upcomingTimer !== null) this.clearIntervalFn(this.upcomingTimer);
    this.upcomingTimer = this.setIntervalFn(() => {
      void this.checkUpcoming();
    }, UPCOMING_CHECK_INTERVAL_MS);
    this.upcomingTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (this.upcomingTimer !== null) {
      this.clearIntervalFn(this.upcomingTimer);
      this.upcomingTimer = null;
    }
  }

  /**
   * Runs one polling decision: check if it is time to, then schedule the next
   * wake-up. Exposed for tests and for the manual "check now" endpoint.
   */
  async tick(): Promise<void> {
    await this.runDecision(true);
  }

  /** Runs one decision without creating a timer, for Cloudflare Cron Triggers. */
  async runScheduled(): Promise<void> {
    await this.runDecision(false);
  }

  private async runDecision(scheduleNext: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const { plan, retrieved } = await this.currentPlan();

      if (plan.reason === 'after-cutoff' && !retrieved) {
        this.logger.warn('Gave up waiting for prices today', {
          event: LOG_EVENTS.schedulerGaveUp,
          date: plan.targetDate,
          cutoff: this.window.cutoff,
        });
      }

      if (plan.shouldCheckNow) {
        await this.checkAndDispatch(plan.targetDate);
        // The current day is usually missing its final period or two until
        // the next batch lands, so keep filling it in while we are awake and
        // already talking to Octopus.
        await this.backfillIncomplete(londonDateOf(this.now()));
      }
    } catch (error) {
      // Never let a failure kill the loop; the next tick will try again.
      this.logger.error('Poll tick failed', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    } finally {
      this.running = false;
      if (scheduleNext) await this.scheduleNext();
    }
  }

  /**
   * Fetches a pricing day and, once enough of it has arrived, evaluates alert
   * rules and sends notifications.
   *
   * The bar here is `publishable`, not `complete`. Octopus delivers a day in
   * two parts - the bulk of it in the afternoon batch, the final period or two
   * later - so gating on completeness meant nothing was ever dispatched.
   * Re-dispatching as the rest arrives is safe: dedupe keys suppress anything
   * already sent.
   */
  async checkAndDispatch(date: PricingDate): Promise<void> {
    // One fetch per distinct tariff, not per person: a household all in the
    // same region costs a single request, while someone in another region
    // still gets their own prices.
    for (const { tariff, userIds } of await this.priceService.tariffGroups()) {
      try {
        const result = await this.priceService.refresh(date, tariff);
        if (!result.publishable) continue;

        for (const userId of userIds) {
          await this.dispatcher.dispatchForDay(date, result.periods, userId);
        }
      } catch (error) {
        // One region failing must not stop the others being polled.
        this.logger.error('Price check failed for a tariff', {
          event: LOG_EVENTS.octopusApiError,
          date,
          tariffCode: tariff.tariffCode,
          ...describeError(error),
        });
      }
    }
  }

  /**
   * Brings the app up to date at startup: refresh today and tomorrow, and run
   * the alerts for whichever of them has enough data.
   *
   * Today is included so that a fresh install, or one recovering from an
   * outage, still tells the user about the day they are actually in.
   *
   * Dedupe keys make this safe after a restart - anything already notified is
   * silently skipped rather than sent again.
   */
  async runStartupCatchUp(): Promise<void> {
    try {
      await this.priceService.discoverProduct();
      const results = await this.priceService.refreshCurrentDays();
      const groups = await this.priceService.tariffGroups();

      for (const result of results) {
        if (!result.publishable) continue;
        const group = groups.find((g) => g.tariff.tariffCode === result.tariff.tariffCode);
        for (const userId of group?.userIds ?? []) {
          await this.dispatcher.dispatchForDay(result.date, result.periods, userId);
        }
      }
    } catch (error) {
      this.logger.error('Startup catch-up failed', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    }
  }

  /**
   * Re-fetches a day that is still missing periods, and dispatches it if it
   * now has enough. Does nothing once the day is complete, so this settles
   * down by itself rather than polling a finished day forever.
   */
  async backfillIncomplete(date: PricingDate): Promise<void> {
    for (const { tariff, userIds } of await this.priceService.tariffGroups()) {
      const stored = await this.priceService.storedDay(date, tariff.tariffCode);
      if (describeDayCoverage(stored, date).complete) continue;

      try {
        const result = await this.priceService.refresh(date, tariff);
        if (!result.publishable) continue;
        for (const userId of userIds) {
          await this.dispatcher.dispatchForDay(date, result.periods, userId);
        }
      } catch (error) {
        this.logger.error('Backfill failed for a tariff', {
          event: LOG_EVENTS.octopusApiError,
          date,
          tariffCode: tariff.tariffCode,
          ...describeError(error),
        });
      }
    }
  }

  /**
   * Sends any "starting soon" alerts that are due.
   *
   * Reads stored prices only, so it is cheap enough to run on every scheduler
   * invocation, all day, rather than only inside the publication window.
   */
  async checkUpcoming(): Promise<number> {
    let sent = 0;
    try {
      for (const { tariff, userIds } of await this.priceService.tariffGroups()) {
        for (const userId of userIds) {
          sent += await this.dispatcher.dispatchUpcoming(this.now(), userId, (date) =>
            this.priceService.storedDay(date, tariff.tariffCode),
          );
        }
      }
    } catch (error) {
      this.logger.error('Starting-soon check failed', { ...describeError(error) });
    }
    return sent;
  }

  private async currentPlan() {
    const at = this.now();
    const provisional = planPoll(at, this.window, () => false);

    // Polling stops only once *every* tariff in use has the day. One region
    // arriving early must not stop another region being waited for.
    const tariffs = await this.priceService.distinctTariffs();
    const flags = await Promise.all(
      tariffs.map((tariff) =>
        this.priceService.isRetrieved(provisional.targetDate, tariff.tariffCode),
      ),
    );
    const retrieved = tariffs.length > 0 && flags.every(Boolean);

    const plan = planPoll(at, this.window, (date) => date === provisional.targetDate && retrieved);
    return { plan, retrieved };
  }

  private async scheduleNext(): Promise<void> {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);

    const { plan } = await this.currentPlan();
    const delay = Math.min(
      Math.max(plan.nextRunAt.getTime() - this.now().getTime(), 1_000),
      MAX_TIMER_MS,
    );

    this.logger.debug('Scheduled next price check', {
      event: LOG_EVENTS.schedulerScheduled,
      nextRunAt: plan.nextRunAt.toISOString(),
      delayMs: delay,
      reason: plan.reason,
      targetDate: plan.targetDate,
    });

    this.timer = this.setTimeoutFn(() => {
      void this.tick();
    }, delay);
    // Do not hold the process open purely for the next poll.
    this.timer.unref?.();
  }
}
