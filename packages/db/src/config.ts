import { evenlyDistributed, ShardMap } from './shard.ts';

/**
 * Database configuration from the environment.
 *
 * `CIVIC_SHARD_URLS` is a comma-separated list of shard cluster connection strings. The vshard→
 * cluster assignment is derived by even distribution here; in production it is loaded from the
 * shard-map table so that a rebalance can move individual vshards without a redeploy
 * (docs/SCALING.md §6).
 */
export interface DbConfig {
  catalogueUrl: string;
  shardUrls: string[];
}

const DEFAULT_URL = 'postgres://civic:civic@127.0.0.1:5432/civic';

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const catalogueUrl = env['CIVIC_CATALOGUE_URL'] ?? env['DATABASE_URL'] ?? DEFAULT_URL;
  const shardUrls = (env['CIVIC_SHARD_URLS'] ?? env['DATABASE_URL'] ?? DEFAULT_URL)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (shardUrls.length === 0) throw new Error('no shard cluster URLs configured');
  return { catalogueUrl, shardUrls };
}

export function shardMapFrom(config: DbConfig): ShardMap {
  return new ShardMap(
    evenlyDistributed(
      config.shardUrls.map((connectionString, i) => ({ id: `pg-${i}`, connectionString })),
    ),
  );
}
