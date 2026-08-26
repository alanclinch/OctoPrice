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

import { addDays, londonDateOf } from '@octoprice/core';
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
}

/** Node timers cap at ~24.8 days; a shorter ceiling keeps drift in check. */
const MAX_TIMER_MS = 60 * 60 * 1000;

export class PricePoller {
  private readonly priceService: PriceService;
  private readonly dispatcher: AlertDispatcher;
  private readonly logger: Logger;
  private readonly window: PollWindow;
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private timer: ReturnType<typeof setTimeout> | null = null;
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
  }

  /** Begins polling. Safe to call once; use `stop` to shut down cleanly. */
  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  /**
   * Runs one polling decision: check if it is time to, then schedule the next
   * wake-up. Exposed for tests and for the manual "check now" endpoint.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const plan = planPoll(this.now(), this.window, (date) => this.priceService.isRetrieved(date));

      if (plan.reason === 'after-cutoff' && !this.priceService.isRetrieved(plan.targetDate)) {
        this.logger.warn('Gave up waiting for prices today', {
          event: LOG_EVENTS.schedulerGaveUp,
          date: plan.targetDate,
          cutoff: this.window.cutoff,
        });
      }

      if (plan.shouldCheckNow) {
        await this.checkAndDispatch(plan.targetDate);
      }
    } catch (error) {
      // Never let a failure kill the loop; the next tick will try again.
      this.logger.error('Poll tick failed', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  /**
   * Fetches a pricing day and, when it is complete, evaluates alert rules and
   * sends notifications.
   */
  async checkAndDispatch(date: PricingDate): Promise<void> {
    const result = await this.priceService.refresh(date);
    if (!result.complete) return;

    await this.dispatcher.dispatchForDay(date, result.periods);
  }

  /**
   * Brings the app up to date at startup: refresh today and tomorrow, and if
   * tomorrow turns out to be complete, run the alerts for it.
   *
   * Dedupe keys make this safe after a restart - anything already notified is
   * silently skipped rather than sent again.
   */
  async runStartupCatchUp(): Promise<void> {
    try {
      await this.priceService.discoverProduct();
      const results = await this.priceService.refreshCurrentDays();
      const tomorrow = addDays(londonDateOf(this.now()), 1);

      for (const result of results) {
        if (result.complete && result.date === tomorrow) {
          await this.dispatcher.dispatchForDay(result.date, result.periods);
        }
      }
    } catch (error) {
      this.logger.error('Startup catch-up failed', {
        event: LOG_EVENTS.octopusApiError,
        ...describeError(error),
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);

    const plan = planPoll(this.now(), this.window, (date) => this.priceService.isRetrieved(date));
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
