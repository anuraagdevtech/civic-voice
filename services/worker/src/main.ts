#!/usr/bin/env node
/**
 * Worker entrypoint.
 *
 * Runs the stream consumer plus three periodic jobs. Deployed as its own Deployment so the aggregation
 * pipeline can be scaled on consumer lag independently of the API's request load — they have completely
 * different scaling signals, and coupling them would mean over-provisioning one to serve the other.
 */
import { createMemoryCacheTier, createRedisCacheTier, type CacheTier } from '@civic-voice/cache';
import {
  createMemoryRepositories,
  createPgRepositories,
  loadDbConfig,
  shardMapFrom,
  ShardRouter,
  type Repositories,
} from '@civic-voice/db';
import {
  createClickHouseAnalyticsStore,
  createMemoryAnalyticsStore,
  type AnalyticsStore,
} from '@civic-voice/analytics';
import {
  createKafkaEventBus,
  createMemoryEventBus,
  eventTopics,
  type EventBus,
} from '@civic-voice/stream';
import { EVENT_TOPICS } from '@civic-voice/contracts';
import { createLogger, createMetrics } from '@civic-voice/observability';
import { ClaudeAnalyzer, claudeConfigured, trainSeedModel } from '@civic-voice/nlp';
import { Aggregator } from './pipelines/aggregator.ts';
import { CommentPipeline } from './pipelines/comments.ts';
import { RtiSweeper } from './pipelines/rti-sweeper.ts';
import { Reconciler } from './pipelines/reconciler.ts';
import { Sentinel } from './pipelines/sentinel.ts';

const useMemory = process.env['CIVIC_MEMORY_ADAPTERS'] === '1';
const logger = createLogger('worker', { pretty: process.env['CIVIC_ENV'] !== 'production' });
const metrics = createMetrics();

const sweepIntervalMs = Number(process.env['CIVIC_SWEEP_INTERVAL_MS'] ?? 60 * 60 * 1000);

// Keys the analytics projection's hashes (ADR-0008). Like the pseudonym salt root, the development
// default is refused in production: anyone who has read this repository could otherwise reproduce it.
const INSECURE_DEFAULT = 'dev-only-insecure-secret-change-me';
const analyticsKey = process.env['CIVIC_ANALYTICS_KEY'] ?? INSECURE_DEFAULT;
if (
  process.env['CIVIC_ENV'] === 'production' &&
  (analyticsKey === INSECURE_DEFAULT || analyticsKey.length < 32)
) {
  throw new Error(
    'CIVIC_ANALYTICS_KEY must be set to at least 32 characters when CIVIC_ENV=production',
  );
}
const lagIntervalMs = Number(process.env['CIVIC_LAG_INTERVAL_MS'] ?? 15_000);

let repos: Repositories;
let cache: CacheTier;
let analytics: AnalyticsStore;
let bus: EventBus;
let router: ShardRouter | null = null;

if (useMemory) {
  logger.warn('using in-memory adapters — nothing is persisted');
  repos = createMemoryRepositories();
  cache = createMemoryCacheTier();
  analytics = createMemoryAnalyticsStore();
  bus = createMemoryEventBus();
} else {
  const dbConfig = loadDbConfig();
  router = new ShardRouter({
    shardMap: shardMapFrom(dbConfig),
    catalogueConnectionString: dbConfig.catalogueUrl,
    logger,
  });
  repos = createPgRepositories(router);
  cache = createRedisCacheTier();
  analytics = createClickHouseAnalyticsStore();
  const kafka = createKafkaEventBus({ logger, clientId: 'civic-worker' });
  bus = kafka;
  await Promise.all([repos.ready(), cache.ready(), analytics.ready(), kafka.producer.ready()]);
  // Before subscribing. A consumer subscribing to a missing topic makes the broker auto-create it
  // with one partition, which would silently cap this pipeline's parallelism at a single consumer.
  await kafka.ensureTopics(eventTopics());
}

const aggregator = new Aggregator({ repos, cache, analytics, bus, metrics, logger });

// The in-house comment model trains from the bundled dataset at startup: deterministic, a couple of
// seconds, and no model artefact to ship or version separately (its version is a hash of its inputs).
const commentModel = trainSeedModel();
const claude = claudeConfigured(process.env) ? new ClaudeAnalyzer() : null;
if (!claude) logger.info('no ANTHROPIC_API_KEY: comments are analysed by the in-house model only');
const comments = new CommentPipeline({
  repos,
  cache,
  analytics,
  bus,
  model: commentModel,
  claude,
  analyticsKey,
  escalationsPerMinute: Number(process.env['CIVIC_ESCALATIONS_PER_MINUTE'] ?? 1200),
  metrics,
  logger,
});
const sweeper = router
  ? new RtiSweeper({
      router,
      analytics,
      metrics,
      logger,
      notify: async (notification) => {
        // A real deployment hands this to the notification fan-out. Logging it keeps the sweep
        // observable without pretending a channel exists that does not.
        logger.info(
          {
            request_id: notification.requestId,
            action: notification.action,
            deadline: notification.deadline,
          },
          'RTI deadline notification',
        );
      },
    })
  : null;
const reconciler = new Reconciler({ cache, analytics, metrics, logger });
const sentinel = new Sentinel({ repos, cache, analytics, metrics, logger });
void reconciler;
void sentinel;

await aggregator.start();
await comments.start();

const timers: NodeJS.Timeout[] = [];

if (sweeper) {
  let tick = 0;
  timers.push(
    setInterval(() => {
      const current = tick++;
      void sweeper.sweep(current).catch((err) => logger.error({ err }, 'RTI sweep failed'));
    }, sweepIntervalMs),
  );
}

// Consumer lag is the alarm that says aggregates are going stale. It is reported rather than hidden,
// because a stale number that admits it is fine and one that pretends to be fresh is not.
timers.push(
  setInterval(() => {
    void (async () => {
      try {
        const lag = await bus.consumer('civic-aggregator').lag();
        let total = 0;
        for (const [partition, behind] of lag) {
          metrics.set('civic_consumer_lag_events', behind, { partition });
          total += behind;
        }
        if (total > 100_000) logger.warn({ total }, 'consumer lag is high; aggregates are stale');
      } catch (err) {
        logger.debug({ err }, 'lag probe failed');
      }
    })();
  }, lagIntervalMs),
);

logger.info(
  { topics: [EVENT_TOPICS.SENTIMENT, EVENT_TOPICS.COMMENT], model: commentModel.version },
  'civic-voice worker running',
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  for (const timer of timers) clearInterval(timer);
  try {
    // Stop consuming first, so the in-flight batch finishes and commits before the stores close.
    await aggregator.stop();
    await comments.stop();
    await Promise.all([repos.close(), cache.close(), analytics.close(), bus.close()]);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
