import { Redis, type Cluster, type RedisOptions } from 'ioredis';
import type { VerificationTier } from '@civic-voice/contracts';
import {
  emptyHistogram,
  fromHistogram,
  QUOTAS,
  type CounterIncrement,
  type MoodHistogramLike,
  type RawBucket,
} from './core-shim.ts';
import { field, keys, parseField, TTL } from './keys.ts';
import {
  TRENDING_HALF_LIFE_HOURS,
  TRENDING_WINDOW_HOURS,
  type ForumAction,
  type ForumLimitStore,
  type TrendingStore,
} from './ports.ts';
import type {
  CacheTier,
  CitizenProfile,
  CounterStore,
  DedupeStore,
  IdempotencyClaim,
  IdempotencyStore,
  PendingOpinion,
  PendingOpinionStore,
  ProfileStore,
  QuotaDecision,
  QuotaStore,
  SliceQuery,
  SliceResult,
} from './ports.ts';
import { mergeRaw, totalOf } from './memory.ts';

export type RedisLike = Redis | Cluster;

/**
 * Redis-backed cache tier.
 *
 * Every write path is a single pipeline, and every read is a single round trip, because at the
 * spike load in docs/SCALING.md the round-trip count *is* the capacity question.
 */

export class RedisCounterStore implements CounterStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  /**
   * Two `HINCRBY` per increment: one histogram slot and one intensity sum — the exact figure the
   * capacity model in docs/SCALING.md §5 is built on. `n` and the mean mood are derived from the
   * histogram on read rather than stored, which halves the command count and makes it impossible for
   * `n` and the histogram to drift apart.
   */
  async apply(increments: readonly CounterIncrement[]): Promise<void> {
    if (increments.length === 0) return;
    const pipeline = this.redis.pipeline();
    const touchedTopics = new Set<number>();
    const touchedKeys = new Set<string>();

    for (const inc of increments) {
      const key = keys.counter(inc.key.topicId, inc.key.regionId, inc.key.dim, inc.key.tier);
      pipeline.hincrby(key, field.histogram(inc.key.bucket, inc.mood + 2), inc.count);
      pipeline.hincrby(key, field.intensity(inc.key.bucket), inc.intensity);
      touchedKeys.add(key);
      touchedTopics.add(inc.key.topicId);
    }
    // TTL is refreshed per key, not per mutation, so a hot key costs one EXPIRE per flush.
    for (const key of touchedKeys) pipeline.expire(key, TTL.counterSeconds);
    // One HSET per distinct topic per flush, for the staleness the read path publishes.
    const now = Date.now();
    for (const topicId of touchedTopics) pipeline.hset(keys.appliedAt, String(topicId), now);

    await pipeline.exec();
  }

  async readSlice(query: SliceQuery): Promise<SliceResult> {
    const pipeline = this.redis.pipeline();
    for (const tier of query.tiers) {
      pipeline.hgetall(keys.counter(query.topicId, query.regionId, query.dim, tier));
    }
    pipeline.hget(keys.appliedAt, String(query.topicId));
    const results = await pipeline.exec();
    if (!results) return { total: totalOf([]), buckets: [], stalenessSeconds: 0 };

    const merged = new Map<string, RawBucket>();
    for (let i = 0; i < query.tiers.length; i += 1) {
      const row = results[i];
      const hash = (row?.[1] ?? {}) as Record<string, string>;
      for (const [bucket, raw] of decodeHash(hash)) {
        const soFar = merged.get(bucket);
        merged.set(bucket, soFar ? mergeRaw(soFar, raw) : raw);
      }
    }

    const appliedAtRaw = results[query.tiers.length]?.[1] as string | null | undefined;
    const appliedAt = appliedAtRaw ? Number(appliedAtRaw) : null;
    const buckets = [...merged.values()];
    return {
      total: totalOf(buckets),
      buckets,
      stalenessSeconds: appliedAt ? Math.max(0, Math.round((Date.now() - appliedAt) / 1000)) : 0,
    };
  }

  async overwriteSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
    buckets: readonly RawBucket[],
  ): Promise<void> {
    const key = keys.counter(topicId, regionId, dim, tier);
    const flat: string[] = [];
    for (const b of buckets) {
      for (let i = 0; i < b.histogram.length; i += 1) {
        flat.push(field.histogram(b.bucket, i), String(b.histogram[i] ?? 0));
      }
      flat.push(field.intensity(b.bucket), String(b.sumIntensity));
    }
    const pipeline = this.redis.pipeline();
    // DEL then HSET, so a bucket that no longer exists in truth does not survive in cache.
    pipeline.del(key);
    if (flat.length > 0) pipeline.hset(key, ...flat);
    pipeline.expire(key, TTL.counterSeconds);
    await pipeline.exec();
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

function decodeHash(hash: Record<string, string>): Map<string, RawBucket> {
  const histograms = new Map<string, number[]>();
  const intensities = new Map<string, number>();

  for (const [f, v] of Object.entries(hash)) {
    const parsed = parseField(f);
    if (!parsed) continue;
    if (parsed.kind === 'h') {
      const h = histograms.get(parsed.bucket) ?? [...emptyHistogram()];
      h[parsed.index] = Math.max(0, Number(v) || 0);
      histograms.set(parsed.bucket, h);
    } else {
      intensities.set(parsed.bucket, Math.max(0, Number(v) || 0));
    }
  }

  const out = new Map<string, RawBucket>();
  for (const [bucket, h] of histograms) {
    out.set(bucket, fromHistogram(bucket, h as MoodHistogramLike, intensities.get(bucket) ?? 0));
  }
  return out;
}

/**
 * Token bucket plus per-topic cooldown, evaluated and consumed atomically in one Lua script.
 *
 * Atomicity matters here: a read-then-write from the application would let two concurrent requests
 * from the same citizen each see one token left and both spend it, which is exactly the hole a
 * brigading script would drive through.
 */
const QUOTA_SCRIPT = `
local bucketKey   = KEYS[1]
local cooldownKey = KEYS[2]
local capacity    = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs       = tonumber(ARGV[3])
local cooldownSec = tonumber(ARGV[4])

if redis.call('EXISTS', cooldownKey) == 1 then
  return {0, 2, redis.call('TTL', cooldownKey)}
end

local tokens = tonumber(redis.call('HGET', bucketKey, 't'))
local last   = tonumber(redis.call('HGET', bucketKey, 'ts'))
if tokens == nil then tokens = capacity; last = nowMs end

tokens = math.min(capacity, tokens + (nowMs - last) * refillPerMs)

if tokens < 1 then
  redis.call('HSET', bucketKey, 't', tokens, 'ts', nowMs)
  redis.call('EXPIRE', bucketKey, 7200)
  local waitMs = (1 - tokens) / refillPerMs
  return {0, 1, math.max(1, math.ceil(waitMs / 1000))}
end

redis.call('HSET', bucketKey, 't', tokens - 1, 'ts', nowMs)
redis.call('EXPIRE', bucketKey, 7200)
redis.call('SET', cooldownKey, 1, 'EX', cooldownSec)
return {1, 0, 0}
`;

export class RedisQuotaStore implements QuotaStore {
  private readonly perHour: number;
  private readonly burst: number;
  private readonly cooldownSeconds: number;

  private readonly redis: RedisLike;

  constructor(
    redis: RedisLike,
    opts: { perHour?: number; burst?: number; cooldownSeconds?: number } = {},
  ) {
    this.redis = redis;
    this.perHour = opts.perHour ?? QUOTAS.perCitizenPerHour;
    this.burst = opts.burst ?? QUOTAS.perCitizenBurst;
    this.cooldownSeconds = opts.cooldownSeconds ?? QUOTAS.topicCooldownSeconds;
    this.redis.defineCommand('civicQuota', { numberOfKeys: 2, lua: QUOTA_SCRIPT });
  }

  async checkAndConsume(citizenId: string, topicId: number): Promise<QuotaDecision> {
    const result = (await (
      this.redis as RedisLike & {
        civicQuota: (...args: unknown[]) => Promise<[number, number, number]>;
      }
    ).civicQuota(
      keys.tokenBucket(citizenId),
      keys.topicCooldown(citizenId, topicId),
      this.burst,
      this.perHour / 3_600_000,
      Date.now(),
      this.cooldownSeconds,
    )) as [number, number, number];

    const [allowed, reasonCode, retryAfter] = result;
    if (allowed === 1) return { allowed: true };
    return {
      allowed: false,
      reason: reasonCode === 2 ? 'cooldown_active' : 'rate_limited',
      retryAfterSeconds: Math.max(1, retryAfter),
    };
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async claim(
    key: string,
    requestHash: string,
    ttlSeconds = TTL.idempotencySeconds,
  ): Promise<IdempotencyClaim> {
    const k = keys.idempotency(key);
    const won = await this.redis.set(
      k,
      JSON.stringify({ hash: requestHash }),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (won === 'OK') return { claimed: true };

    const raw = await this.redis.get(k);
    if (raw === null) {
      // The winner's record expired between our SET and GET. Treat it as ours rather than failing.
      const retry = await this.redis.set(
        k,
        JSON.stringify({ hash: requestHash }),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (retry === 'OK') return { claimed: true };
      return { claimed: false, response: null, conflict: false };
    }
    const record = JSON.parse(raw) as { hash?: string; response?: string };
    return {
      claimed: false,
      response: record.response ?? null,
      conflict: record.hash !== undefined && record.hash !== requestHash,
    };
  }

  async complete(key: string, response: string): Promise<void> {
    const k = keys.idempotency(key);
    const raw = await this.redis.get(k);
    const record = raw ? (JSON.parse(raw) as { hash?: string }) : {};
    await this.redis.set(
      k,
      JSON.stringify({ hash: record.hash, response }),
      'EX',
      TTL.idempotencySeconds,
    );
  }

  async release(key: string): Promise<void> {
    await this.redis.del(keys.idempotency(key));
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

export class RedisPendingOpinionStore implements PendingOpinionStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async put(citizenId: string, topicId: number, opinion: PendingOpinion): Promise<void> {
    await this.redis.set(
      keys.pendingOpinion(citizenId, topicId),
      JSON.stringify(opinion),
      'EX',
      TTL.pendingOpinionSeconds,
    );
  }

  async get(citizenId: string, topicId: number): Promise<PendingOpinion | null> {
    const raw = await this.redis.get(keys.pendingOpinion(citizenId, topicId));
    return raw ? (JSON.parse(raw) as PendingOpinion) : null;
  }

  async getMany(
    citizenId: string,
    topicIds: readonly number[],
  ): Promise<Map<number, PendingOpinion>> {
    if (topicIds.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const topicId of topicIds) pipeline.get(keys.pendingOpinion(citizenId, topicId));
    const results = await pipeline.exec();
    const out = new Map<number, PendingOpinion>();
    results?.forEach((row, i) => {
      const raw = row?.[1] as string | null;
      const topicId = topicIds[i];
      if (raw && topicId !== undefined) out.set(topicId, JSON.parse(raw) as PendingOpinion);
    });
    return out;
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

export class RedisProfileStore implements ProfileStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async get(citizenId: string): Promise<CitizenProfile | null> {
    const raw = await this.redis.get(keys.profile(citizenId));
    return raw ? (JSON.parse(raw) as CitizenProfile) : null;
  }

  async put(citizenId: string, profile: CitizenProfile): Promise<void> {
    await this.redis.set(
      keys.profile(citizenId),
      JSON.stringify(profile),
      'EX',
      TTL.profileSeconds,
    );
  }

  async invalidate(citizenId: string): Promise<void> {
    await this.redis.del(keys.profile(citizenId));
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

export class RedisDedupeStore implements DedupeStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async markApplied(eventId: string): Promise<boolean> {
    const set = await this.redis.set(keys.dedupe(eventId), 1, 'EX', TTL.dedupeSeconds, 'NX');
    return set === 'OK';
  }

  async markManyApplied(eventIds: readonly string[]): Promise<string[]> {
    if (eventIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of eventIds) pipeline.set(keys.dedupe(id), 1, 'EX', TTL.dedupeSeconds, 'NX');
    const results = await pipeline.exec();
    const fresh: string[] = [];
    results?.forEach((row, i) => {
      const id = eventIds[i];
      if (row?.[1] === 'OK' && id !== undefined) fresh.push(id);
    });
    return fresh;
  }

  async close(): Promise<void> {
    await closeQuietly(this.redis);
  }
}

export interface RedisCacheOptions {
  url?: string;
  options?: RedisOptions;
}

export function createRedisClient(opts: RedisCacheOptions = {}): Redis {
  const url = opts.url ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  return new Redis(url, {
    // A write path that must ack in 250ms p99 cannot sit in an unbounded retry queue: fail fast,
    // return 503 with Retry-After, and let the client replay with the same idempotency key.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    lazyConnect: false,
    ...opts.options,
  });
}

/** Resolves when the client can serve commands, or rejects so a readiness probe can fail loudly. */
export async function waitUntilReady(redis: RedisLike, timeoutMs = 5_000): Promise<void> {
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`redis not ready within ${timeoutMs}ms (status: ${redis.status})`));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('error', onError);
    };
    redis.once('ready', onReady);
    redis.once('error', onError);
  });
}

/**
 * Shut down without masking the original failure.
 *
 * `QUIT` is itself a command, so on a client that is already down it throws the very
 * "stream isn't writeable" error that made us shut down. Fall back to tearing the socket down.
 */
async function closeQuietly(redis: RedisLike): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

export class RedisForumLimitStore implements ForumLimitStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  async consume(
    citizenId: string,
    action: ForumAction,
    limit: number,
    windowSeconds: number,
  ): Promise<QuotaDecision> {
    const now = Date.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const key = keys.forumLimit(citizenId, action, window);
    // INCR then EXPIRE in one round trip; the count that comes back decides. A refused attempt still
    // counts against the window, which is what a limit on hammering should do.
    const result = await this.redis.multi().incr(key).expire(key, windowSeconds).exec();
    const used = Number(result?.[0]?.[1] ?? 0);
    if (used > limit) {
      const resetMs = (window + 1) * windowSeconds * 1000;
      return {
        allowed: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  async close(): Promise<void> {}
}

export class RedisTrendingStore implements TrendingStore {
  private readonly redis: RedisLike;

  constructor(redis: RedisLike) {
    this.redis = redis;
  }

  private hour(at: Date): number {
    return Math.floor(at.getTime() / 3_600_000);
  }

  async bump(
    topicId: number,
    regionIds: readonly number[],
    weight: number,
    comments: number,
    at: Date,
  ): Promise<void> {
    const hour = this.hour(at);
    const pipe = this.redis.pipeline();
    for (const regionId of regionIds) {
      const key = keys.trending(regionId, hour);
      pipe.zincrby(key, weight, String(topicId));
      pipe.expire(key, TTL.trendingBucketSeconds);
    }
    if (comments > 0) {
      const key = keys.topicComments(topicId, hour);
      pipe.incrby(key, comments);
      pipe.expire(key, TTL.trendingBucketSeconds);
    }
    await pipe.exec();
  }

  async top(
    regionId: number,
    limit: number,
    now: Date,
  ): Promise<Array<{ topicId: number; score: number }>> {
    const current = this.hour(now);
    const sources: string[] = [];
    const weights: number[] = [];
    for (let age = 0; age < TRENDING_WINDOW_HOURS; age++) {
      sources.push(keys.trending(regionId, current - age));
      weights.push(0.5 ** (age / TRENDING_HALF_LIFE_HOURS));
    }
    // ZUNION (Redis ≥ 6.2) sums the decayed buckets without writing a temporary key; the hash tag
    // puts every bucket of one region in one slot, which a cluster requires.
    const raw = (await this.redis.call(
      'ZUNION',
      String(sources.length),
      ...sources,
      'WEIGHTS',
      ...weights.map(String),
      'WITHSCORES',
    )) as string[];
    const scored: Array<{ topicId: number; score: number }> = [];
    for (let i = 0; i + 1 < raw.length; i += 2)
      scored.push({ topicId: Number(raw[i]), score: Number(raw[i + 1]) });
    return scored.sort((a, b) => b.score - a.score || a.topicId - b.topicId).slice(0, limit);
  }

  async commentsLast24h(topicIds: readonly number[], now: Date): Promise<Map<number, number>> {
    const current = this.hour(now);
    const out = new Map<number, number>();
    const pipe = this.redis.pipeline();
    for (const topicId of topicIds) {
      const hours = Array.from({ length: TRENDING_WINDOW_HOURS }, (_, age) =>
        keys.topicComments(topicId, current - age),
      );
      pipe.mget(...hours);
    }
    const results = (await pipe.exec()) ?? [];
    topicIds.forEach((topicId, i) => {
      const values = (results[i]?.[1] ?? []) as Array<string | null>;
      out.set(
        topicId,
        values.reduce((sum, v) => sum + Number(v ?? 0), 0),
      );
    });
    return out;
  }

  async close(): Promise<void> {}
}

/** One connection serves every port: they share a hot path and separate pools would only add RTT. */
export function createRedisCacheTier(opts: RedisCacheOptions = {}): CacheTier {
  const redis = createRedisClient(opts);
  return {
    counters: new RedisCounterStore(redis),
    forumLimits: new RedisForumLimitStore(redis),
    trending: new RedisTrendingStore(redis),
    quotas: new RedisQuotaStore(redis),
    idempotency: new RedisIdempotencyStore(redis),
    pending: new RedisPendingOpinionStore(redis),
    profiles: new RedisProfileStore(redis),
    dedupe: new RedisDedupeStore(redis),
    ready: () => waitUntilReady(redis),
    close: () => closeQuietly(redis),
  };
}
