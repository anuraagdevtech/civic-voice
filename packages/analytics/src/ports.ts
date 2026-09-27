import type { AnalyticsEvent, VerificationTier } from '@civic-voice/contracts';
import type { RawBucket, RollupMutation } from '@civic-voice/core';

/**
 * The analytical store. Two jobs:
 *
 *  1. Hold the event log as the system of record, so Redis counters are a disposable cache and every
 *     aggregate can be recomputed from scratch.
 *  2. Answer the questions that are not pre-computed — historical series, and the demographic
 *     cross-products that ADR-0002 deliberately does not maintain.
 */

export interface DailyRollupRow {
  day: string;
  topicId: number;
  regionId: number;
  dim: number;
  bucket: string;
  tier: VerificationTier;
  n: number;
  sumIntensity: number;
  histogram: [number, number, number, number, number];
}

export interface SeriesPoint {
  day: string;
  n: number;
  meanMood: number | null;
  histogram: [number, number, number, number, number];
}

export interface CrossSliceQuery {
  topicId: number;
  regionId: number;
  tiers: readonly VerificationTier[];
  /** The cross-product: dimension name → required bucket. This is the expensive, gated path. */
  where: Partial<Record<string, string>>;
  from?: string;
  to?: string;
}

export interface RtiOutcomeRow {
  authorityId: number;
  filedOn: string;
  closedOn: string | null;
  track: string;
  finalState: string;
  responseDays: number | null;
  deemedRefused: boolean;
  firstAppealed: boolean;
  appealOverturned: boolean;
  exemptionClause: string;
}

export interface ScorecardResult {
  authorityId: number;
  requests: number;
  onTimeRate: number | null;
  medianResponseDays: number | null;
  deemedRefusalRate: number | null;
  firstAppealRate: number | null;
  appealOverturnRate: number | null;
}

export interface AnalyticsStore {
  /** Append events. Batched: one insert per flush, never one per event. */
  insertEvents(events: readonly AnalyticsEvent[]): Promise<void>;
  /** Persist the daily marginals derived from a batch of mutations. */
  insertRollups(rows: readonly DailyRollupRow[]): Promise<void>;
  /** Historical series for one slice, for the trend chart. */
  series(
    topicId: number,
    regionId: number,
    dim: number,
    bucket: string,
    tiers: readonly VerificationTier[],
    from: string,
    to: string,
  ): Promise<SeriesPoint[]>;
  /**
   * Recompute a slice's marginals from the rollup table. Used by reconciliation to repair Redis
   * drift, which is what makes a lost Redis shard an availability event rather than data loss.
   */
  recomputeSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
  ): Promise<RawBucket[]>;
  /** The gated cross-product path (ADR-0002): on demand, rate-limited, k-anonymity enforced. */
  crossSlice(query: CrossSliceQuery): Promise<RawBucket>;
  /** Distinct participants, for the population-share ceiling. */
  participants(topicId: number, regionId: number, day: string): Promise<number>;
  insertRtiOutcomes(rows: readonly RtiOutcomeRow[]): Promise<void>;
  authorityScorecard(authorityId: number, windowDays: number): Promise<ScorecardResult>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Convert rollup mutations into daily rows, merging duplicates. One insert instead of thousands. */
export function mutationsToDailyRows(mutations: readonly RollupMutation[]): DailyRollupRow[] {
  const merged = new Map<string, DailyRollupRow>();
  for (const m of mutations) {
    const k = `${m.key.day}|${m.key.topicId}|${m.key.regionId}|${m.key.dim}|${m.key.bucket}|${m.key.tier}`;
    const row = merged.get(k) ?? {
      day: m.key.day,
      topicId: m.key.topicId,
      regionId: m.key.regionId,
      dim: m.key.dim,
      bucket: m.key.bucket,
      tier: m.key.tier,
      n: 0,
      sumIntensity: 0,
      histogram: [0, 0, 0, 0, 0] as [number, number, number, number, number],
    };
    row.n += m.delta;
    row.sumIntensity += m.intensity * m.delta;
    const slot = m.mood + 2;
    row.histogram[slot] = (row.histogram[slot] ?? 0) + m.delta;
    merged.set(k, row);
  }
  return [...merged.values()];
}
