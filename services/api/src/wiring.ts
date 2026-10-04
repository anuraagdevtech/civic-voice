import {
  createMemoryCacheTier,
  createRedisCacheTier,
  RedisQuotaStore,
  createRedisClient,
  type CacheTier,
} from '@civic-voice/cache';
import {
  createMemoryRepositories,
  createPgRepositories,
  loadDbConfig,
  shardMapFrom,
  ShardRouter,
  type Repositories,
} from '@civic-voice/db';
import {
  createKafkaEventBus,
  createMemoryEventBus,
  eventTopics,
  type EventBus,
} from '@civic-voice/stream';
import {
  createClickHouseAnalyticsStore,
  createMemoryAnalyticsStore,
  type AnalyticsStore,
} from '@civic-voice/analytics';
import type { Logger } from '@civic-voice/observability';
import type { ApiConfig } from './config.ts';

/**
 * Adapter selection.
 *
 * `CIVIC_MEMORY_ADAPTERS=1` swaps in the in-memory tier so the API can be run and exercised with no
 * infrastructure at all — a demo, a smoke test, an integration test in CI. Production takes the same
 * code path through the real adapters (ADR-0006).
 */
export interface Infrastructure {
  repos: Repositories;
  cache: CacheTier;
  bus: EventBus;
  /** Read-only from the API: cohort insights. The worker is the only writer. */
  analytics: AnalyticsStore;
  close(): Promise<void>;
}

export async function createInfrastructure(
  config: ApiConfig,
  logger: Logger,
): Promise<Infrastructure> {
  if (config.useMemoryAdapters) {
    logger.warn('using in-memory adapters — nothing is persisted');
    const repos = createMemoryRepositories();
    const cache = createMemoryCacheTier();
    const bus = createMemoryEventBus();
    const analytics = createMemoryAnalyticsStore();
    return {
      repos,
      cache,
      bus,
      analytics,
      async close() {
        await Promise.all([repos.close(), cache.close(), bus.close(), analytics.close()]);
      },
    };
  }

  const dbConfig = loadDbConfig();
  const router = new ShardRouter({
    shardMap: shardMapFrom(dbConfig),
    catalogueConnectionString: dbConfig.catalogueUrl,
    logger,
  });
  const repos = createPgRepositories(router);
  const cache = createRedisCacheTier();
  // Quotas come from configuration, so they can be retuned during an incident without a redeploy.
  cache.quotas = new RedisQuotaStore(createRedisClient(), {
    perHour: config.quotas.writesPerHour,
    burst: config.quotas.burst,
    cooldownSeconds: config.quotas.topicCooldownSeconds,
  });
  const bus = createKafkaEventBus({ logger });
  const analytics = createClickHouseAnalyticsStore();

  // Fail startup rather than accept traffic we cannot serve: the Redis client has its offline queue
  // disabled, so a pod that has not connected would reject every write. ClickHouse is not awaited:
  // it serves only cohort insights, and an API that cannot answer those should still take opinions.
  await Promise.all([repos.ready(), cache.ready(), bus.producer.ready()]);
  await bus.ensureTopics(eventTopics());

  return {
    repos,
    cache,
    bus,
    analytics,
    async close() {
      await Promise.all([repos.close(), cache.close(), bus.close(), analytics.close()]);
    },
  };
}
