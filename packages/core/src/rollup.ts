import {
  DEMOGRAPHIC_DIMENSIONS,
  DIMENSION_TOTAL,
  dimensionIndex,
  type DemographicDimension,
  type Demographics,
  type SentimentEvent,
  type VerificationTier,
} from '@civic-voice/contracts';
import { rollupAncestors } from './geo.ts';
import { dayOf } from './time.ts';

/**
 * Rollup key derivation — the bounded fan-out that makes 1B users tractable (ADR-0002).
 *
 * Per event we touch `regions × (dimensions + 1)` counters: 4 × 8 = **32**, with the marginal of
 * each demographic dimension maintained independently. Crossing the seven dimensions would be 28,800
 * combinations per (topic, region, day, tier) and billions of rows a day, for questions almost
 * nobody asks; those are answered on demand from ClickHouse instead.
 */

export const TOTAL_BUCKET = 'all';

export interface RollupKey {
  day: string;
  topicId: number;
  regionId: number;
  /** 0 = total, 1..6 = the demographic dimension's fixed index. */
  dim: number;
  bucket: string;
  tier: VerificationTier;
}

/** Stable string form. Also the Redis key suffix, so it must stay low-cardinality and compact. */
export function rollupKeyString(k: RollupKey): string {
  return `${k.day}:${k.topicId}:${k.regionId}:${k.dim}:${k.bucket}:${k.tier}`;
}

export function parseRollupKey(s: string): RollupKey {
  const parts = s.split(':');
  if (parts.length !== 6) throw new RangeError(`bad rollup key: ${s}`);
  const [day, topicId, regionId, dim, bucket, tier] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    day,
    topicId: Number(topicId),
    regionId: Number(regionId),
    dim: Number(dim),
    bucket,
    tier: Number(tier) as VerificationTier,
  };
}

/**
 * Which dimensions this citizen contributes a bucket to. A declined dimension contributes to the
 * total but to no bucket, which is why demographics are optional without breaking the arithmetic.
 */
export function presentDimensions(d: Demographics): DemographicDimension[] {
  return DEMOGRAPHIC_DIMENSIONS.filter((dim) => d[dim] !== undefined);
}

export function rollupKeysFor(event: SentimentEvent): RollupKey[] {
  const day = dayOf(event.occurred_at);
  const regions = rollupAncestors(event.region_path);
  const dims = presentDimensions(event.demographics);
  const keys: RollupKey[] = [];

  for (const regionId of regions) {
    keys.push({
      day,
      topicId: event.topic_id,
      regionId,
      dim: DIMENSION_TOTAL,
      bucket: TOTAL_BUCKET,
      tier: event.verification_tier,
    });
    for (const dim of dims) {
      const bucket = event.demographics[dim];
      if (bucket === undefined) continue;
      keys.push({
        day,
        topicId: event.topic_id,
        regionId,
        dim: dimensionIndex(dim),
        bucket,
        tier: event.verification_tier,
      });
    }
  }
  return keys;
}

/** The count asserted by docs/SCALING.md §5. Upper bound: every dimension, full region path. */
export function maxKeysPerEvent(): number {
  return rollupAncestors([1, 2, 3, 4, 5]).length * (DEMOGRAPHIC_DIMENSIONS.length + 1);
}

/**
 * A rollup mutation, paired with the event that caused it so the consumer can be idempotent on
 * redelivery. Consumers are at-least-once; every mutation is keyed by `eventId` in a dedupe set
 * with a retention window longer than the maximum redelivery lag (docs/ARCHITECTURE.md §6).
 */
export interface RollupMutation {
  key: RollupKey;
  eventId: string;
  mood: number;
  intensity: number;
  delta: 1 | -1;
}

/**
 * Expand an event into its mutations. A replacement event yields *two* per key: a `−1` for the
 * mood being left and a `+1` for the mood being adopted. Without the compensating pair, changing
 * your mind would inflate both buckets and aggregates would drift upward forever.
 */
export function mutationsFor(event: SentimentEvent): RollupMutation[] {
  const keys = rollupKeysFor(event);
  const mutations: RollupMutation[] = [];
  for (const key of keys) {
    if (event.replaces) {
      mutations.push({
        key,
        eventId: event.event_id,
        mood: event.replaces.mood,
        intensity: event.replaces.intensity,
        delta: -1,
      });
    }
    mutations.push({
      key,
      eventId: event.event_id,
      mood: event.mood,
      intensity: event.intensity,
      delta: event.delta,
    });
  }
  return mutations;
}

/**
 * An accumulated change to one counter slot.
 *
 * Distinct from `RollupMutation` because a mutation describes *one event's* effect and carries
 * `delta: 1 | -1`, which cannot represent "net +7 with a summed intensity of 23". Merging mutations
 * into a mutation would therefore have to approximate the intensity — arithmetically plausible and
 * quietly wrong. This type can hold the accumulation exactly, so the merge is lossless.
 */
export interface CounterIncrement {
  key: RollupKey;
  /** Which histogram slot this changes. */
  mood: number;
  /** Net change to that slot's count. Any integer, including negative. */
  count: number;
  /** Net change to the bucket's summed intensity. */
  intensity: number;
}

/**
 * Collapse mutations into the smallest set of counter increments that has the identical effect.
 *
 * Merges on `(key, mood)`, not on key alone: two events on one key with different moods touch
 * different histogram slots and must not be added together — doing so would corrupt the distribution
 * while leaving `n` correct.
 *
 * A `+1` and a `−1` on the same key and mood cancel; the pair is dropped only when the intensity
 * contribution cancels too, so a citizen who keeps their mood but changes their intensity still moves
 * the mean.
 */
export function incrementsFrom(mutations: readonly RollupMutation[]): CounterIncrement[] {
  const merged = new Map<string, CounterIncrement>();
  for (const m of mutations) {
    const id = `${rollupKeyString(m.key)}|${m.mood}`;
    const existing = merged.get(id);
    if (existing) {
      existing.count += m.delta;
      existing.intensity += m.intensity * m.delta;
    } else {
      merged.set(id, {
        key: m.key,
        mood: m.mood,
        count: m.delta,
        intensity: m.intensity * m.delta,
      });
    }
  }
  return [...merged.values()].filter((i) => i.count !== 0 || i.intensity !== 0);
}
