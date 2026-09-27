import {
  EVENT_TOPICS,
  stripIdentity,
  type AnalyticsEvent,
  type SentimentEvent,
} from '@civic-voice/contracts';
import { incrementsFrom, mutationsFor, type RollupMutation } from '@civic-voice/core';
import type { CacheTier } from '@civic-voice/cache';
import type { Repositories } from '@civic-voice/db';
import type { AnalyticsStore } from '@civic-voice/analytics';
import { mutationsToDailyRows } from '@civic-voice/analytics';
import type { Consumer, Envelope, EventBus } from '@civic-voice/stream';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * The aggregation pipeline (docs/ARCHITECTURE.md §4 step 6).
 *
 * For each batch of events:
 *
 *  1. Drop events already applied — delivery is at-least-once, so a redelivered event must be a
 *     no-op rather than a double count.
 *  2. Upsert `sentiment_current` on each citizen's own shard, which reports whether this **replaces**
 *     an earlier opinion. This is the step the API cannot do (ADR-0003).
 *  3. Expand into rollup mutations, emitting a compensating `−1` for any mood being left.
 *  4. **Merge in memory**, then flush. A spike is by definition concentrated on a few topics, and
 *     because the log is partitioned by `topic_id` every event for a topic reaches one consumer — so
 *     the merge collapses substantially exactly when it matters. Sizing does not depend on it
 *     (docs/SCALING.md §5), but the headroom is real.
 *  5. Write the cumulative counters (Redis), the daily rollups and the event history (ClickHouse).
 *
 * Ordering within the flush matters: counters last. If the process dies mid-flush, the durable stores
 * are ahead of the cache, and reconciliation repairs the cache from them. The other order would leave
 * counters claiming events that no durable store can account for.
 */

export interface AggregatorDeps {
  repos: Repositories;
  cache: CacheTier;
  analytics: AnalyticsStore;
  bus: EventBus;
  metrics: Metrics;
  logger: Logger;
  groupId?: string;
}

export interface FlushStats {
  received: number;
  deduped: number;
  applied: number;
  mutations: number;
  mergedKeys: number;
}

export class Aggregator {
  private readonly deps: AggregatorDeps;
  private consumer?: Consumer;

  constructor(deps: AggregatorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    this.consumer = this.deps.bus.consumer(this.deps.groupId ?? 'civic-aggregator');
    await this.consumer.subscribe<SentimentEvent>(EVENT_TOPICS.SENTIMENT, async (batch) => {
      await this.handleBatch(batch);
    });
    this.deps.logger.info('aggregator consuming');
  }

  async stop(): Promise<void> {
    await this.consumer?.close();
  }

  async handleBatch(batch: readonly Envelope<SentimentEvent>[]): Promise<FlushStats> {
    const received = batch.length;
    this.deps.metrics.inc('civic_events_consumed_total', {}, received);
    if (received === 0) {
      return { received: 0, deduped: 0, applied: 0, mutations: 0, mergedKeys: 0 };
    }

    // 1. Dedupe. `markManyApplied` returns only the ids that were newly marked.
    const fresh = new Set(
      await this.deps.cache.dedupe.markManyApplied(batch.map((e) => e.value.event_id)),
    );
    const deduped = received - fresh.size;
    if (deduped > 0) this.deps.metrics.inc('civic_events_deduped_total', {}, deduped);

    const mutations: RollupMutation[] = [];
    const analyticsEvents: AnalyticsEvent[] = [];
    let applied = 0;

    for (const envelope of batch) {
      const event = envelope.value;
      if (!fresh.has(event.event_id)) continue;

      // 2. Resolve the replacement on the citizen's own shard: a single-shard point lookup, which is
      // exactly what ADR-0001's routing exists for.
      let resolved: SentimentEvent = event;
      try {
        const upsert = await this.deps.repos.sentiment.upsert(event.citizen_id, {
          topic_id: event.topic_id,
          mood: event.mood,
          intensity: event.intensity,
          reason_code: event.reason_code,
          event_id: event.event_id,
        });

        if (!upsert.applied) {
          // The shard had already recorded this exact event — a redelivery that outlived the dedupe
          // window. The shard is the authority here, so skip it.
          this.deps.metrics.inc('civic_events_deduped_total');
          continue;
        }
        if (upsert.previous) {
          resolved = {
            ...event,
            replaces: {
              mood: upsert.previous.mood,
              intensity: upsert.previous.intensity,
              reason_code: upsert.previous.reason_code,
            },
          };
        }
      } catch (err) {
        // Un-mark it, or a redelivery would be swallowed by the dedupe set and the event lost.
        this.deps.logger.error(
          { err, event_id: event.event_id, topic_id: event.topic_id },
          'failed to resolve current opinion; leaving the event for redelivery',
        );
        throw err;
      }

      // 3. Expand. A replacement yields a compensating pair per key.
      mutations.push(...mutationsFor(resolved));
      analyticsEvents.push(stripIdentity(resolved));
      applied += 1;
    }

    if (mutations.length === 0) {
      return { received, deduped, applied, mutations: 0, mergedKeys: 0 };
    }

    // 4. Merge in memory. Lossless: `incrementsFrom` accumulates counts and intensity exactly.
    const merged = incrementsFrom(mutations);

    // 5. Flush: durable stores first, cache last.
    const dailyRows = mutationsToDailyRows(mutations);
    await this.deps.analytics.insertEvents(analyticsEvents);
    await this.deps.analytics.insertRollups(dailyRows);

    const startedAt = Date.now();
    await this.deps.cache.counters.apply(merged);
    this.deps.metrics.observe('civic_redis_pipeline_ms', Date.now() - startedAt);
    this.deps.metrics.set('civic_rollup_staleness_seconds', 0);

    return { received, deduped, applied, mutations: mutations.length, mergedKeys: merged.length };
  }
}
