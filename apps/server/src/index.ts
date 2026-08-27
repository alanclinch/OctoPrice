/**
 * Server entry point.
 *
 * Starts the HTTP API, brings prices up to date, and starts the polling
 * worker. Shuts all three down cleanly on a signal so an in-flight poll
 * cannot be interrupted mid-write.
 */

import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { describeError } from './logger.ts';
import { runForecastHistoryBackfill } from './forecast/baseline.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, store, priceService, logger, poller, close } = await buildApp(config);

  await app.listen({ port: config.port, host: config.host });
  logger.info('Listening', { port: config.port, host: config.host });

  if (poller) {
    // Do not block startup on the network: the API should answer immediately
    // even if Octopus is slow or unreachable.
    void poller.runStartupCatchUp().then(async () => {
      await runForecastHistoryBackfill({ store, priceService, logger });
      poller.start();
    });
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('Shutdown failed', describeError(error));
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Configuration errors land here, and are the most likely startup failure.
  console.error(
    JSON.stringify({ level: 'error', message: 'Failed to start', ...describeError(error) }),
  );
  process.exit(1);
});
