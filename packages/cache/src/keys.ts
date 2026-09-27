import type { VerificationTier } from '@civic-voice/contracts';

/**
 * Redis key shapes, in one place.
 *
 * Keys are deliberately short: at 9.8M commands/s during a spike, key bytes are real bandwidth. And
 * they are deliberately low-cardinality, because cardinality is what decides whether the read path
 * can be cached at all (docs/SCALING.md §2).
 *
 * The `{...}` braces are Redis Cluster hash tags. Grouping a slice's tiers into one slot lets a
 * read fetch every tier in a single round trip instead of one per tier.
 */
export const keys = {
  /** Cumulative standing distribution for a slice. No day: the daily rows live in ClickHouse. */
  counter: (topicId: number, regionId: number, dim: number, tier: VerificationTier) =>
    `c:{${topicId}:${regionId}}:${dim}:${tier}`,

  /** Hash of topicId → epoch ms of the last applied mutation, for the staleness we publish. */
  appliedAt: 'c:ts',

  tokenBucket: (citizenId: string) => `q:${citizenId}`,
  topicCooldown: (citizenId: string, topicId: number) => `qt:${citizenId}:${topicId}`,

  idempotency: (key: string) => `idem:${key}`,
  pendingOpinion: (citizenId: string, topicId: number) => `po:${citizenId}:${topicId}`,
  profile: (citizenId: string) => `cp:${citizenId}`,
  dedupe: (eventId: string) => `dd:${eventId}`,

  forumLimit: (citizenId: string, action: string, window: number) =>
    `fl:${citizenId}:${action}:${window}`,
  /** One slot per region, so the 24 hourly buckets can be summed with one ZUNION. */
  trending: (regionId: number, hour: number) => `tr:{r${regionId}}:${hour}`,
  /** One slot per topic, so a day's hourly comment counts are one MGET. */
  topicComments: (topicId: number, hour: number) => `tc:{t${topicId}}:${hour}`,
} as const;

export const TTL = {
  /** Cumulative counters are long-lived but still expendable: they rebuild from ClickHouse. */
  counterSeconds: 60 * 60 * 24 * 30,
  idempotencySeconds: 60 * 60 * 24,
  /** Must comfortably exceed worker lag, so read-your-write does not blink out mid-catch-up. */
  pendingOpinionSeconds: 300,
  /** Must exceed the maximum redelivery lag, or a redelivered event would double count. */
  dedupeSeconds: 60 * 60 * 24 * 3,
  /** Long enough to keep the write path off Postgres; short enough that a stale band self-heals. */
  profileSeconds: 60 * 60 * 6,
  /** A bucket outlives the window it is summed over by an hour, so the oldest one is never half-gone. */
  trendingBucketSeconds: 60 * 60 * 25,
} as const;

/** Hash field names inside a counter key. Six fields per bucket: histogram[5] + summed intensity. */
export const field = {
  histogram: (bucket: string, moodIndex: number) => `${bucket}|h${moodIndex}`,
  intensity: (bucket: string) => `${bucket}|i`,
} as const;

export function parseField(f: string): { bucket: string; kind: 'h' | 'i'; index: number } | null {
  const at = f.lastIndexOf('|');
  if (at < 1) return null;
  const bucket = f.slice(0, at);
  const suffix = f.slice(at + 1);
  if (suffix === 'i') return { bucket, kind: 'i', index: -1 };
  if (suffix.startsWith('h')) {
    const index = Number.parseInt(suffix.slice(1), 10);
    if (index >= 0 && index <= 4) return { bucket, kind: 'h', index };
  }
  return null;
}
