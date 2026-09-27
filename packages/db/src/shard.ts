/**
 * Shard routing (ADR-0001, docs/SCALING.md §6).
 *
 * Citizen-owned data is sharded by `hash(citizen_id) % 1024`. Hashing the citizen id rather than the
 * region is the single most important schema decision in the system: India's regions differ by a
 * factor of ~3,750 in population (Uttar Pradesh ~240M vs Lakshadweep ~64,000), so region sharding
 * produces a permanent hotspot that no rebalancing can fix. Hashing the id gives uniform shards by
 * construction, and region-shaped questions are answered from rollups instead.
 */

/**
 * 1024 logical vshards. Chosen to stay evenly divisible as the physical fleet grows from 4 clusters
 * to 128 (1024 = 2^10, so every power-of-two fleet size divides it), and small enough that one
 * vshard is ~2 GB — a rebalance is minutes, and its blast radius is 0.1% of citizens.
 */
export const VSHARD_COUNT = 1024;

/**
 * FNV-1a over the 16 bytes of the UUID.
 *
 * It must consume the *whole* id, not a prefix: UUIDv7's leading 48 bits are a timestamp, so
 * hashing a prefix would route everyone who registered in the same millisecond to one shard.
 *
 * FNV-1a is chosen for being trivially portable — a migration tool, an analytics job in another
 * language, or a future Go rewrite of the ingest path must compute the identical vshard, and that
 * rules out anything runtime-specific.
 */
export function hashCitizenId(citizenId: string): number {
  const hex = citizenId.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new RangeError(`not a uuid: ${citizenId}`);
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < 32; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    hash ^= byte;
    // FNV prime 16777619, in 32-bit arithmetic via Math.imul to avoid float precision loss.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function vshardFor(citizenId: string): number {
  return hashCitizenId(citizenId) % VSHARD_COUNT;
}

export interface ClusterConfig {
  id: string;
  connectionString: string;
  /** Vshards this cluster currently owns. */
  vshards: readonly number[];
}

/**
 * Maps vshards to physical clusters. A lookup table rather than modular arithmetic on the cluster
 * count, because arithmetic would remap every vshard when a cluster is added — the table lets a
 * rebalance move one vshard at a time.
 */
export class ShardMap {
  private readonly byVshard: string[];
  private readonly clusters: Map<string, ClusterConfig>;

  constructor(clusters: readonly ClusterConfig[]) {
    if (clusters.length === 0) throw new RangeError('a shard map needs at least one cluster');
    this.clusters = new Map(clusters.map((c) => [c.id, c]));
    this.byVshard = new Array<string>(VSHARD_COUNT);

    for (const cluster of clusters) {
      for (const vshard of cluster.vshards) {
        if (vshard < 0 || vshard >= VSHARD_COUNT || !Number.isInteger(vshard)) {
          throw new RangeError(`vshard ${vshard} is out of range`);
        }
        const existing = this.byVshard[vshard];
        if (existing !== undefined) {
          throw new RangeError(`vshard ${vshard} is claimed by both ${existing} and ${cluster.id}`);
        }
        this.byVshard[vshard] = cluster.id;
      }
    }

    // A gap here means some citizens are unroutable. Failing at construction beats discovering it
    // when one unlucky citizen in 1.4B gets a 500.
    const missing: number[] = [];
    for (let v = 0; v < VSHARD_COUNT; v += 1) if (this.byVshard[v] === undefined) missing.push(v);
    if (missing.length > 0) {
      throw new RangeError(
        `shard map does not cover all ${VSHARD_COUNT} vshards; ${missing.length} unassigned ` +
          `(first: ${missing.slice(0, 5).join(', ')})`,
      );
    }
  }

  clusterIdFor(citizenId: string): string {
    return this.byVshard[vshardFor(citizenId)] as string;
  }

  clusterForVshard(vshard: number): ClusterConfig {
    const id = this.byVshard[vshard];
    if (id === undefined) throw new RangeError(`vshard ${vshard} is unassigned`);
    return this.clusters.get(id) as ClusterConfig;
  }

  clusterFor(citizenId: string): ClusterConfig {
    return this.clusters.get(this.clusterIdFor(citizenId)) as ClusterConfig;
  }

  allClusters(): ClusterConfig[] {
    return [...this.clusters.values()];
  }

  /** How many vshards each cluster owns — the thing a rebalance is trying to even out. */
  distribution(): Map<string, number> {
    const out = new Map<string, number>();
    for (const id of this.byVshard) out.set(id, (out.get(id) ?? 0) + 1);
    return out;
  }
}

/** Evenly split the vshard range across n clusters. The starting point before any rebalancing. */
export function evenlyDistributed(
  clusters: readonly { id: string; connectionString: string }[],
): ClusterConfig[] {
  const n = clusters.length;
  if (n === 0) throw new RangeError('need at least one cluster');
  return clusters.map((c, i) => ({
    ...c,
    vshards: Array.from({ length: VSHARD_COUNT }, (_, v) => v).filter((v) => v % n === i),
  }));
}

/**
 * The local / single-node map: every vshard on one cluster. The SQL and the routing code are
 * identical to production; only this table differs, so a developer exercises the real code path.
 */
export function singleClusterMap(connectionString: string): ShardMap {
  return new ShardMap(evenlyDistributed([{ id: 'local', connectionString }]));
}
