#!/usr/bin/env node
/**
 * API entrypoint. Stateless: it holds no session state, so it scales purely on pod count
 * (docs/ARCHITECTURE.md §2).
 */
import { createLogger, createMetrics } from '@civic-voice/observability';
import { loadApiConfig } from './config.ts';
import { buildApp } from './app.ts';
import { createInfrastructure } from './wiring.ts';

const config = loadApiConfig();
const logger = createLogger('api', { pretty: config.env === 'development' });
const metrics = createMetrics();

const infra = await createInfrastructure(config, logger);
const app = await buildApp({ config, ...infra, logger, metrics });

/**
 * Graceful shutdown. During a scale-down — which at spike-and-recover happens routinely — a pod must
 * finish the requests it has accepted before exiting, or citizens' submissions are dropped at exactly
 * the moment the platform is busiest.
 */
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await infra.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection');
});

await app.listen({ port: config.port, host: config.host });
logger.info({ port: config.port, env: config.env }, 'civic-voice api listening');
