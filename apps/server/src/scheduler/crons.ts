/** Cron expressions and their explicit Worker routing. */

export const CORE_CRON = '*/5 * * * *';
export const FORECAST_BACKGROUND_CRON = '2-59/5 * * * *';

export type ScheduledJob = 'core' | 'forecast' | 'unknown';

export function scheduledJobForCron(cron: string): ScheduledJob {
  if (cron === CORE_CRON) return 'core';
  if (cron === FORECAST_BACKGROUND_CRON) return 'forecast';
  return 'unknown';
}
