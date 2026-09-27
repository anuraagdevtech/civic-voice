import type { Demographics, Mood, ReasonCode, VerificationTier } from '@civic-voice/contracts';
import type { CounterIncrement, RawBucket } from '@civic-voice/core';

/**
 * The cache-tier ports. Each has a real (Redis) and an in-memory implementation, so the whole test
 * suite runs with no daemon (ADR-0006) and the API can be exercised end to end in a unit test.
 *
 * Nothing behind these ports is a source of truth. Every value is rebuildable from ClickHouse, which
 * is why losing a Redis shard is an availability event and not a data-loss event.
 */

export interface SliceQuery {
  topicId: number;
  regionId: number;
  /** 0 = total, 1..6 = demographic dimension index. */
  dim: number;
  /** Tiers to sum. The default public view is [2, 3] (docs/TRUST.md). */
  tiers: readonly VerificationTier[];
}

export interface SliceResult {
  total: RawBucket;
  buckets: RawBucket[];
  /** Seconds since the newest mutation applied to this topic. Reported, never hidden. */
  stalenessSeconds: number;
}

export interface CounterStore {
  /**
   * Apply accumulated increments to the cumulative counters. Written by the **worker only** — the API
   * must not touch these, because it cannot know whether a compensating `−1` is owed (ADR-0003).
   *
   * The key's `day` is ignored here: Redis holds the cumulative standing distribution, and the
   * per-day rows go to ClickHouse for the time series. One batch of mutations feeds both sinks, each
   * using the part it needs.
   */
  apply(increments: readonly CounterIncrement[]): Promise<void>;
  readSlice(query: SliceQuery): Promise<SliceResult>;
  /** Replace a slice wholesale. Used by reconciliation to repair drift from ClickHouse truth. */
  overwriteSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
    buckets: readonly RawBucket[],
  ): Promise<void>;
  close(): Promise<void>;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: 'rate_limited' | 'cooldown_active';
  retryAfterSeconds?: number;
}

export interface QuotaStore {
  /**
   * Evaluate the per-citizen token bucket and the per-(citizen, topic) cooldown, and consume on
   * success. One round trip: at 170k writes/s the difference between one and three is the
   * difference between 65 pods and 200.
   */
  checkAndConsume(citizenId: string, topicId: number): Promise<QuotaDecision>;
  close(): Promise<void>;
}

export type IdempotencyClaim =
  | { claimed: true }
  /** Lost the race. `response` is null while the winner is still in flight. */
  | { claimed: false; response: string | null; conflict: boolean };

export interface IdempotencyStore {
  /**
   * `SET key NX EX` — exactly one caller wins. `requestHash` guards against a client reusing a key
   * for a *different* body, which is a bug we would rather surface than silently replay.
   */
  claim(key: string, requestHash: string, ttlSeconds?: number): Promise<IdempotencyClaim>;
  complete(key: string, response: string): Promise<void>;
  release(key: string): Promise<void>;
  close(): Promise<void>;
}

export interface PendingOpinion {
  mood: Mood;
  intensity: number;
  reason_code: ReasonCode;
  updated_at: string;
}

/**
 * The read-your-write overlay. The API writes the citizen's own submission here; `GET
 * /v1/me/sentiment` reads through it on top of Postgres, so the citizen sees their own opinion
 * immediately while the worker catches up (ADR-0003). TTL covers the worker's redelivery window.
 */
export interface PendingOpinionStore {
  put(citizenId: string, topicId: number, opinion: PendingOpinion): Promise<void>;
  get(citizenId: string, topicId: number): Promise<PendingOpinion | null>;
  getMany(citizenId: string, topicIds: readonly number[]): Promise<Map<number, PendingOpinion>>;
  close(): Promise<void>;
}

export interface CitizenProfile {
  region_path: number[];
  verification_tier: VerificationTier;
  demographics: Demographics;
}

/**
 * Read-through cache of the small, slow-changing part of a citizen record that the write path needs
 * to build an event: their region path, tier and demographic bands.
 *
 * Without this, every submission would be a Postgres point lookup, which ADR-0003 exists to keep off
 * the write path. The payload is ~40 bytes, so at 90M daily actives the whole working set is a few
 * GB across the cluster. A miss costs one point lookup on the citizen's own shard, which happens once
 * per citizen per TTL rather than once per write.
 */
export interface ProfileStore {
  get(citizenId: string): Promise<CitizenProfile | null>;
  put(citizenId: string, profile: CitizenProfile): Promise<void>;
  /** Called on a profile update, so a changed band takes effect on the next submission. */
  invalidate(citizenId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * At-least-once delivery means a redelivered event must be a no-op rather than a double count. The
 * retention window must exceed the maximum redelivery lag (docs/ARCHITECTURE.md §6).
 */
export interface DedupeStore {
  /** True when this event id was newly marked, false when it had already been applied. */
  markApplied(eventId: string): Promise<boolean>;
  markManyApplied(eventIds: readonly string[]): Promise<string[]>;
  close(): Promise<void>;
}

export interface CacheTier {
  counters: CounterStore;
  /** Replaceable, so a service can supply a store built from its own configured quotas. */
  quotas: QuotaStore;
  idempotency: IdempotencyStore;
  pending: PendingOpinionStore;
  profiles: ProfileStore;
  dedupe: DedupeStore;
  /**
   * Resolves once the tier can actually serve commands.
   *
   * The Redis client runs with `enableOfflineQueue: false` so that a write never sits in an
   * unbounded queue behind a dead socket — it fails fast and the client replays with the same
   * idempotency key. The cost of that choice is that commands issued before the connection is up
   * throw, so a service must not report itself ready until this resolves. The API's readiness probe
   * gates on exactly this.
   */
  ready(): Promise<void>;
  close(): Promise<void>;
}
