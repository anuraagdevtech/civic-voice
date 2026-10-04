/**
 * Cross-shard maintenance. **Not importable from request handlers** (ADR-0007).
 *
 * This is a separate package entry point (`@civic-voice/db/maintenance`), it is not re-exported from
 * the index, an architecture test asserts the API service never imports it, and the names are chosen
 * so that using one in a request handler looks obviously wrong in review.
 *
 * Legitimate callers: the RTI deadline sweeper, rollup reconciliation, backfills, rebalancing.
 */
import type { Queryable, ShardRouter } from './router.ts';
import { internalPools } from './router.ts';
import { VSHARD_COUNT } from './shard.ts';

export interface ShardVisit {
  clusterId: string;
  db: Queryable;
}

/**
 * Visit every shard cluster, bounded concurrency.
 *
 * Concurrency is capped because the sweeper runs alongside live traffic: hitting 64 clusters at once
 * with an analytical query is how a background job becomes a user-visible outage.
 */
export async function forEachShardCluster<T>(
  router: ShardRouter,
  fn: (visit: ShardVisit) => Promise<T>,
  opts: { concurrency?: number } = {},
): Promise<T[]> {
  const { pools } = internalPools(router);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const entries = [...pools.entries()];
  const results: T[] = [];

  for (let i = 0; i < entries.length; i += concurrency) {
    const slice = entries.slice(i, i + concurrency);
    results.push(
      ...(await Promise.all(slice.map(([clusterId, pool]) => fn({ clusterId, db: pool })))),
    );
  }
  return results;
}

/**
 * Time-bucket the vshard range so a sweep is a bounded amount of work per tick rather than a full
 * scan. With 24 buckets an hourly sweeper touches ~43 vshards an hour and covers the fleet daily
 * (docs/RTI.md §3).
 */
export function vshardBucket(tick: number, buckets = 24): { from: number; to: number } {
  const size = Math.ceil(VSHARD_COUNT / buckets);
  const from = (tick % buckets) * size;
  return { from, to: Math.min(from + size, VSHARD_COUNT) };
}
