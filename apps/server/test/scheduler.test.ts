import { describe, expect, it } from 'vitest';
import { londonTimeOnDate, planPoll, type PollWindow } from '../src/scheduler/plan.ts';

const WINDOW: PollWindow = { start: '16:05', cutoff: '22:15', intervalMinutes: 5 };
const never = () => false;
const always = () => true;

/** A UTC instant for a London wall-clock time, for readable test setup. */
function at(date: string, clock: string): Date {
  return londonTimeOnDate(date, clock);
}

describe('londonTimeOnDate', () => {
  it('resolves a GMT time to the same UTC time', () => {
    expect(at('2026-01-15', '16:05').toISOString()).toBe('2026-01-15T16:05:00.000Z');
  });

  it('resolves a BST time an hour earlier in UTC', () => {
    expect(at('2026-08-26', '16:05').toISOString()).toBe('2026-08-26T15:05:00.000Z');
  });
});

describe('before the polling window', () => {
  it('waits until the start time', () => {
    const plan = planPoll(at('2026-01-15', '09:00'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(false);
    expect(plan.reason).toBe('before-window');
    expect(plan.nextRunAt).toEqual(at('2026-01-15', '16:05'));
  });

  it('targets tomorrow, not today', () => {
    expect(planPoll(at('2026-01-15', '09:00'), WINDOW, never).targetDate).toBe('2026-01-16');
  });

  it('waits correctly during BST', () => {
    const plan = planPoll(at('2026-08-26', '09:00'), WINDOW, never);
    expect(plan.nextRunAt.toISOString()).toBe('2026-08-26T15:05:00.000Z');
  });
});

describe('inside the polling window', () => {
  it('checks immediately at the start time', () => {
    const plan = planPoll(at('2026-01-15', '16:05'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(true);
    expect(plan.reason).toBe('in-window');
  });

  it('retries at the configured interval', () => {
    const plan = planPoll(at('2026-01-15', '16:05'), WINDOW, never);
    expect(plan.nextRunAt).toEqual(at('2026-01-15', '16:10'));
  });

  it('keeps checking late in the window', () => {
    const plan = planPoll(at('2026-01-15', '21:40'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(true);
  });

  it('never schedules a retry beyond the cutoff', () => {
    const plan = planPoll(at('2026-01-15', '22:13'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(true);
    expect(plan.nextRunAt).toEqual(at('2026-01-15', '22:15'));
  });
});

describe('after the cutoff', () => {
  it('stops for the day and waits for tomorrow', () => {
    const plan = planPoll(at('2026-01-15', '22:15'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(false);
    expect(plan.reason).toBe('after-cutoff');
    expect(plan.nextRunAt).toEqual(at('2026-01-16', '16:05'));
  });

  it('also waits for tomorrow just before midnight', () => {
    const plan = planPoll(at('2026-01-15', '23:50'), WINDOW, never);
    expect(plan.reason).toBe('after-cutoff');
    expect(plan.nextRunAt).toEqual(at('2026-01-16', '16:05'));
  });
});

describe('when the day has already been retrieved', () => {
  it('does not check again inside the window', () => {
    const plan = planPoll(at('2026-01-15', '17:00'), WINDOW, always);
    expect(plan.shouldCheckNow).toBe(false);
    expect(plan.reason).toBe('already-retrieved');
  });

  it('waits for the next day window rather than retrying', () => {
    const plan = planPoll(at('2026-01-15', '17:00'), WINDOW, always);
    expect(plan.nextRunAt).toEqual(at('2026-01-16', '16:05'));
  });

  it('only treats the target date as retrieved, not any date', () => {
    const retrieved = (date: string) => date === '2026-01-16';
    expect(planPoll(at('2026-01-15', '17:00'), WINDOW, retrieved).reason).toBe('already-retrieved');
    // The following day, the target moves on and polling resumes.
    expect(planPoll(at('2026-01-16', '17:00'), WINDOW, retrieved).reason).toBe('in-window');
  });
});

describe('restart safety', () => {
  it('a restart at 03:00 waits rather than polling', () => {
    expect(planPoll(at('2026-01-15', '03:00'), WINDOW, never).shouldCheckNow).toBe(false);
  });

  it('a restart at 20:00 with prices already held does not re-fetch', () => {
    expect(planPoll(at('2026-01-15', '20:00'), WINDOW, always).shouldCheckNow).toBe(false);
  });

  it('a restart at 20:00 without prices resumes polling', () => {
    expect(planPoll(at('2026-01-15', '20:00'), WINDOW, never).shouldCheckNow).toBe(true);
  });
});

describe('daylight saving days', () => {
  it('plans correctly on the day the clocks go forward', () => {
    const plan = planPoll(at('2026-03-29', '16:05'), WINDOW, never);
    expect(plan.shouldCheckNow).toBe(true);
    expect(plan.targetDate).toBe('2026-03-30');
  });

  it('plans correctly on the day the clocks go back', () => {
    const plan = planPoll(at('2026-10-25', '09:00'), WINDOW, never);
    expect(plan.targetDate).toBe('2026-10-26');
    // 16:05 on the long day is GMT, so 16:05 UTC.
    expect(plan.nextRunAt.toISOString()).toBe('2026-10-25T16:05:00.000Z');
  });

  it('crosses the spring transition when scheduling tomorrow', () => {
    // 22:30 on 28 March is GMT; 16:05 on 29 March is BST.
    const plan = planPoll(at('2026-03-28', '22:30'), WINDOW, never);
    expect(plan.nextRunAt.toISOString()).toBe('2026-03-29T15:05:00.000Z');
  });
});

describe('custom windows', () => {
  it('honours a different start, cutoff and interval', () => {
    const custom: PollWindow = { start: '17:00', cutoff: '23:00', intervalMinutes: 15 };
    expect(planPoll(at('2026-01-15', '16:30'), custom, never).shouldCheckNow).toBe(false);
    const plan = planPoll(at('2026-01-15', '17:00'), custom, never);
    expect(plan.shouldCheckNow).toBe(true);
    expect(plan.nextRunAt).toEqual(at('2026-01-15', '17:15'));
  });
});
