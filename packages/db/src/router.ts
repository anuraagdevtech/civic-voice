import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Logger } from '@civic-voice/observability';
import { ShardMap, vshardFor, vshardForTopic, type ClusterConfig } from './shard.ts';

/**
 * The shard router (ADR-0007).
 *
 * There is deliberately **no API here capable of expressing a cross-shard query.** No `queryAll`,
 * no shard iterator, no "for each shard" helper. `withCitizenShard` requires the routing key as an
 * argument and hands back exactly one connection.
 *
 * This is not pedantry. The single-shard guarantee is the load-bearing assumption of the entire
 * capacity model, and documented invariants of that kind decay: someone adds a reporting endpoint
 * under deadline, fans out across 1024 shards, and it passes review because it works fine against
 * the 1 shard in dev. Making the mistake *unrepresentable* in request-handling code is the only
 * version of this rule that survives.
 *
 * Bulk work that legitimately spans shards (the RTI deadline sweeper, reconciliation) lives in
 * `./maintenance.ts`, which is a separate package entry point and is not re-exported from the index.
 */

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface RouterOptions {
  shardMap: ShardMap;
  catalogueConnectionString: string;
  logger?: Logger;
  poolConfig?: Omit<PoolConfig, 'connectionString'>;
}

/**
 * Pool sizing note: at 1.7k writes/s average the API fleet is ~3 pods, and each pod holds a small
 * pool per cluster it talks to. What must not happen is `pods × clusters × poolSize` exceeding a
 * cluster's `max_connections` during a spike scale-out — 66 pods × 20 connections would be 1,320
 * against one cluster. Hence a small default, and a pgbouncer in front of each cluster in
 * production (infra/k8s).
 */
const DEFAULT_POOL: Omit<PoolConfig, 'connectionString'> = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  // A write path with a 250ms p99 budget must not wait on a wedged socket.
  statement_timeout: 5_000,
  query_timeout: 5_000,
};

export class ShardRouter {
  readonly shardMap: ShardMap;
  private readonly pools = new Map<string, Pool>();
  private readonly cataloguePool: Pool;
  private readonly logger?: Logger;
  private closed = false;

  constructor(opts: RouterOptions) {
    this.shardMap = opts.shardMap;
    if (opts.logger) this.logger = opts.logger;
    const poolConfig = { ...DEFAULT_POOL, ...opts.poolConfig };

    for (const cluster of opts.shardMap.allClusters()) {
      this.pools.set(
        cluster.id,
        new Pool({ ...poolConfig, connectionString: cluster.connectionString }),
      );
    }
    this.cataloguePool = new Pool({
      ...poolConfig,
      // The catalogue is read-mostly and fronted by replicas, so it can afford a larger pool.
      max: poolConfig.max === undefined ? 20 : poolConfig.max * 2,
      connectionString: opts.catalogueConnectionString,
    });

    for (const [id, pool] of this.pools) {
      // An idle-client error that nobody listens for takes the process down.
      pool.on('error', (err) =>
        this.logger?.error({ err, cluster: id }, 'idle shard client error'),
      );
    }
    this.cataloguePool.on('error', (err) =>
      this.logger?.error({ err }, 'idle catalogue client error'),
    );
  }

  /**
   * Run a query against exactly the one shard that owns this citizen.
   *
   * The `citizenId` is required, not inferred, so a handler cannot accidentally omit it — omitting
   * it is the bug this whole design exists to prevent.
   */
  async withCitizenShard<T>(citizenId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
    this.assertOpen();
    const cluster = this.shardMap.clusterFor(citizenId);
    const pool = this.poolFor(cluster);
    return fn(pool);
  }

  /**
   * A transaction on one citizen's shard. Single-shard by construction, so this is a plain local
   * transaction — there is no distributed commit anywhere in the system, and no two-phase protocol
   * to get wrong.
   */
  async withCitizenTransaction<T>(
    citizenId: string,
    fn: (db: Queryable) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const pool = this.poolFor(this.shardMap.clusterFor(citizenId));
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger?.error({ err: rollbackErr }, 'rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Run a query against the one shard that owns this topic's discussion (ADR-0008). */
  async withTopicShard<T>(topicId: number, fn: (db: Queryable) => Promise<T>): Promise<T> {
    this.assertOpen();
    return fn(this.poolFor(this.shardMap.clusterForVshard(vshardForTopic(topicId))));
  }

  /** A transaction on one topic's shard: a comment, its vote and its counter move together. */
  async withTopicTransaction<T>(topicId: number, fn: (db: Queryable) => Promise<T>): Promise<T> {
    this.assertOpen();
    const pool = this.poolFor(this.shardMap.clusterForVshard(vshardForTopic(topicId)));
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger?.error({ err: rollbackErr }, 'rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** The catalogue: global, read-mostly, bounded. No routing key needed because it is not sharded. */
  async catalogue<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    this.assertOpen();
    return fn(this.cataloguePool);
  }

  vshardOf(citizenId: string): number {
    return vshardFor(citizenId);
  }

  /** Readiness: every cluster and the catalogue must answer before the service accepts traffic. */
  async ping(): Promise<void> {
    await Promise.all([
      ...[...this.pools.values()].map((p) => p.query('SELECT 1')),
      this.cataloguePool.query('SELECT 1'),
    ]);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...[...this.pools.values()].map((p) => p.end()), this.cataloguePool.end()]);
  }

  private poolFor(cluster: ClusterConfig): Pool {
    const pool = this.pools.get(cluster.id);
    if (!pool) throw new Error(`no pool for cluster ${cluster.id}`);
    return pool;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('shard router is closed');
  }
}

/**
 * Internal accessor used by `./maintenance.ts` only.
 *
 * Kept in this module (rather than exposing the pools publicly) so that the only way to reach every
 * shard is through the deliberately awkward, deliberately separate maintenance entry point.
 */
export function internalPools(router: ShardRouter): {
  pools: ReadonlyMap<string, Pool>;
  shardMap: ShardMap;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- crossing the module boundary once
  const self = router as unknown as { pools: Map<string, Pool>; shardMap: ShardMap };
  return { pools: self.pools, shardMap: self.shardMap };
}
