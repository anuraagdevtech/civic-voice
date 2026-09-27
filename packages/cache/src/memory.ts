import type { VerificationTier } from '@civic-voice/contracts';
import {
  emptyRawBucket,
  fromHistogram,
  QUOTAS,
  type CounterIncrement,
  type RawBucket,
} from '@civic-voice/core';
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
import { TTL } from './keys.ts';

/**
 * In-memory implementations of the cache ports.
 *
 * These exist so the full API and worker can be exercised in a unit test with no daemon running
 * (ADR-0006). They mirror the Redis semantics that matter — `SET NX` races, token-bucket refill,
 * TTL expiry, histogram-derived counts — and are held to the same shared interface test suite as
 * the Redis versions, because an in-memory adapter that quietly diverges is worse than none.
 */

interface Expiring<T> {
  value: T;
  expiresAtMs: number;
}

class Clock {
  now = () => Date.now();
}

class ExpiringMap<T> {
  private readonly map = new Map<string, Expiring<T>>();
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs <= this.clock.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.map.set(key, { value, expiresAtMs: this.clock.now() + ttlSeconds * 1000 });
  }

  setIfAbsent(key: string, value: T, ttlSeconds: number): boolean {
    if (this.get(key) !== undefined) return false;
    this.set(key, value, ttlSeconds);
    return true;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    let n = 0;
    for (const key of [...this.map.keys()]) if (this.get(key) !== undefined) n += 1;
    return n;
  }
}

export class MemoryCounterStore implements CounterStore {
  /** slice key → bucket name → raw bucket */
  private readonly slices = new Map<string, Map<string, RawBucket>>();
  private readonly appliedAtMs = new Map<number, number>();
  private readonly clock: Clock;

  constructor(clock: Clock = new Clock()) {
    this.clock = clock;
  }

  private sliceKey(topicId: number, regionId: number, dim: number, tier: VerificationTier): string {
    return `${topicId}:${regionId}:${dim}:${tier}`;
  }

  async apply(increments: readonly CounterIncrement[]): Promise<void> {
    for (const inc of increments) {
      const sk = this.sliceKey(inc.key.topicId, inc.key.regionId, inc.key.dim, inc.key.tier);
      const slice = this.slices.get(sk) ?? new Map<string, RawBucket>();
      const existing = slice.get(inc.key.bucket) ?? emptyRawBucket(inc.key.bucket);
      const histogram = [...existing.histogram] as RawBucket['histogram'];
      const i = inc.mood + 2;
      // Clamped at zero, like the Redis read path: a spurious retraction must not produce a negative
      // cohort, and reconciliation repairs the underlying drift from ClickHouse truth.
      histogram[i] = Math.max(0, (histogram[i] as number) + inc.count);
      // n and sumMood are derived from the histogram, exactly as the Redis version derives them, so
      // the two can never disagree.
      const rebuilt = fromHistogram(
        inc.key.bucket,
        histogram,
        Math.max(0, existing.sumIntensity + inc.intensity),
      );
      slice.set(inc.key.bucket, rebuilt);
      this.slices.set(sk, slice);
      this.appliedAtMs.set(inc.key.topicId, this.clock.now());
    }
  }

  async readSlice(query: SliceQuery): Promise<SliceResult> {
    const merged = new Map<string, RawBucket>();
    for (const tier of query.tiers) {
      const slice = this.slices.get(this.sliceKey(query.topicId, query.regionId, query.dim, tier));
      if (!slice) continue;
      for (const [bucket, raw] of slice) {
        const soFar = merged.get(bucket);
        merged.set(bucket, soFar ? mergeRaw(soFar, raw) : { ...raw });
      }
    }
    const buckets = [...merged.values()];
    const appliedAt = this.appliedAtMs.get(query.topicId);
    return {
      total: totalOf(buckets),
      buckets,
      stalenessSeconds:
        appliedAt === undefined
          ? 0
          : Math.max(0, Math.round((this.clock.now() - appliedAt) / 1000)),
    };
  }

  async overwriteSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
    buckets: readonly RawBucket[],
  ): Promise<void> {
    const slice = new Map<string, RawBucket>();
    for (const b of buckets) slice.set(b.bucket, { ...b });
    this.slices.set(this.sliceKey(topicId, regionId, dim, tier), slice);
  }

  async close(): Promise<void> {}
}

function mergeRaw(a: RawBucket, b: RawBucket): RawBucket {
  const histogram = [...a.histogram] as RawBucket['histogram'];
  for (let i = 0; i < histogram.length; i += 1) {
    histogram[i] = (histogram[i] as number) + (b.histogram[i] as number);
  }
  return fromHistogram(a.bucket, histogram, a.sumIntensity + b.sumIntensity);
}

/** The total is the sum of the dimension's buckets — for dim 0 that is the single 'all' bucket. */
function totalOf(buckets: readonly RawBucket[]): RawBucket {
  let acc = emptyRawBucket('all');
  for (const b of buckets) acc = mergeRaw({ ...acc, bucket: 'all' }, b);
  return acc;
}

export class MemoryQuotaStore implements QuotaStore {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  private readonly cooldowns: ExpiringMap<true>;

  private readonly clock: Clock;
  private readonly quotas: { perHour: number; burst: number; cooldownSeconds: number };

  constructor(
    clock: Clock = new Clock(),
    quotas: { perHour: number; burst: number; cooldownSeconds: number } = {
      perHour: QUOTAS.perCitizenPerHour,
      burst: QUOTAS.perCitizenBurst,
      cooldownSeconds: QUOTAS.topicCooldownSeconds,
    },
  ) {
    this.clock = clock;
    this.quotas = quotas;
    this.cooldowns = new ExpiringMap<true>(clock);
  }

  async checkAndConsume(citizenId: string, topicId: number): Promise<QuotaDecision> {
    if (this.cooldowns.get(`${citizenId}:${topicId}`)) {
      return {
        allowed: false,
        reason: 'cooldown_active',
        retryAfterSeconds: this.quotas.cooldownSeconds,
      };
    }

    const now = this.clock.now();
    const refillPerMs = this.quotas.perHour / 3_600_000;
    const state = this.buckets.get(citizenId) ?? { tokens: this.quotas.burst, lastRefillMs: now };
    const refilled = Math.min(
      this.quotas.burst,
      state.tokens + (now - state.lastRefillMs) * refillPerMs,
    );

    if (refilled < 1) {
      this.buckets.set(citizenId, { tokens: refilled, lastRefillMs: now });
      return {
        allowed: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil((1 - refilled) / refillPerMs / 1000)),
      };
    }

    this.buckets.set(citizenId, { tokens: refilled - 1, lastRefillMs: now });
    this.cooldowns.set(`${citizenId}:${topicId}`, true, this.quotas.cooldownSeconds);
    return { allowed: true };
  }

  async close(): Promise<void> {}
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records: ExpiringMap<{ hash: string; response: string | null }>;

  constructor(clock = new Clock()) {
    this.records = new ExpiringMap(clock);
  }

  async claim(
    key: string,
    requestHash: string,
    ttlSeconds = TTL.idempotencySeconds,
  ): Promise<IdempotencyClaim> {
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, { hash: requestHash, response: null }, ttlSeconds);
      return { claimed: true };
    }
    // Same key, different body: a client bug. Surface it rather than replaying the wrong answer.
    return {
      claimed: false,
      response: existing.response,
      conflict: existing.hash !== requestHash,
    };
  }

  async complete(key: string, response: string): Promise<void> {
    const existing = this.records.get(key);
    this.records.set(key, { hash: existing?.hash ?? '', response }, TTL.idempotencySeconds);
  }

  async release(key: string): Promise<void> {
    this.records.delete(key);
  }

  async close(): Promise<void> {}
}

export class MemoryPendingOpinionStore implements PendingOpinionStore {
  private readonly records: ExpiringMap<PendingOpinion>;

  constructor(clock = new Clock()) {
    this.records = new ExpiringMap(clock);
  }

  async put(citizenId: string, topicId: number, opinion: PendingOpinion): Promise<void> {
    this.records.set(`${citizenId}:${topicId}`, opinion, TTL.pendingOpinionSeconds);
  }

  async get(citizenId: string, topicId: number): Promise<PendingOpinion | null> {
    return this.records.get(`${citizenId}:${topicId}`) ?? null;
  }

  async getMany(
    citizenId: string,
    topicIds: readonly number[],
  ): Promise<Map<number, PendingOpinion>> {
    const out = new Map<number, PendingOpinion>();
    for (const topicId of topicIds) {
      const found = this.records.get(`${citizenId}:${topicId}`);
      if (found) out.set(topicId, found);
    }
    return out;
  }

  async close(): Promise<void> {}
}

export class MemoryProfileStore implements ProfileStore {
  private readonly records: ExpiringMap<CitizenProfile>;

  constructor(clock = new Clock()) {
    this.records = new ExpiringMap(clock);
  }

  async get(citizenId: string): Promise<CitizenProfile | null> {
    return this.records.get(citizenId) ?? null;
  }

  async put(citizenId: string, profile: CitizenProfile): Promise<void> {
    this.records.set(citizenId, profile, TTL.profileSeconds);
  }

  async invalidate(citizenId: string): Promise<void> {
    this.records.delete(citizenId);
  }

  async close(): Promise<void> {}
}

export class MemoryDedupeStore implements DedupeStore {
  private readonly seen: ExpiringMap<true>;

  constructor(clock = new Clock()) {
    this.seen = new ExpiringMap(clock);
  }

  async markApplied(eventId: string): Promise<boolean> {
    return this.seen.setIfAbsent(eventId, true, TTL.dedupeSeconds);
  }

  async markManyApplied(eventIds: readonly string[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const id of eventIds) if (await this.markApplied(id)) fresh.push(id);
    return fresh;
  }

  async close(): Promise<void> {}
}

export function createMemoryCacheTier(): CacheTier {
  const clock = new Clock();
  const tier = {
    counters: new MemoryCounterStore(clock),
    quotas: new MemoryQuotaStore(clock),
    idempotency: new MemoryIdempotencyStore(clock),
    pending: new MemoryPendingOpinionStore(clock),
    profiles: new MemoryProfileStore(clock),
    dedupe: new MemoryDedupeStore(clock),
    async ready() {
      // Nothing to connect to.
    },
    async close() {
      await Promise.all([
        tier.counters.close(),
        tier.quotas.close(),
        tier.idempotency.close(),
        tier.pending.close(),
        tier.profiles.close(),
        tier.dedupe.close(),
      ]);
    },
  };
  return tier;
}

export { Clock, mergeRaw, totalOf };
