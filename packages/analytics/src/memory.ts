import type {
  AnalyticsEvent,
  CommentAnalyticsEvent,
  Need,
  VerificationTier,
} from '@civic-voice/contracts';
import {
  dayOf,
  emptyRawBucket,
  fromHistogram,
  rollupAncestors,
  type RawBucket,
} from '@civic-voice/core';
import type {
  AnalyticsStore,
  CommentGroupFigures,
  CommentInsightQuery,
  CommentInsightResult,
  CrossSliceQuery,
  TopicSlicesQuery,
  DailyRollupRow,
  RtiOutcomeRow,
  ScorecardResult,
  SeriesPoint,
} from './ports.ts';

/**
 * In-memory analytics store.
 *
 * Implements the same query semantics the ClickHouse SQL does, including the two that carry real
 * risk of divergence: summing daily rows into a cumulative slice (so reconciliation produces the same
 * answer either way), and the cross-product filter (so the k-anonymity gate is exercised on the same
 * shape of input).
 */
export class MemoryAnalyticsStore implements AnalyticsStore {
  readonly events: AnalyticsEvent[] = [];
  readonly rollups: DailyRollupRow[] = [];
  readonly rtiOutcomes: RtiOutcomeRow[] = [];
  /** Keyed by `dedupe_key`: the ReplacingMergeTree's dedupe, done eagerly. */
  readonly commentEvents = new Map<string, CommentAnalyticsEvent>();

  async insertCommentEvents(events: readonly CommentAnalyticsEvent[]): Promise<void> {
    for (const e of events) this.commentEvents.set(e.dedupe_key, structuredClone(e));
  }

  async commentInsights(query: CommentInsightQuery): Promise<CommentInsightResult> {
    const since = Date.parse(query.since);
    const rows = [...this.commentEvents.values()].filter((e) => {
      if (Date.parse(e.hour) < since) return false;
      // Only the four rollup levels are stored in the analytical row, as in ClickHouse.
      if (!rollupAncestors(e.region_path).includes(query.regionId)) return false;
      for (const [dim, bands] of Object.entries(query.filter ?? {})) {
        const value = e.demographics[dim as keyof typeof e.demographics];
        if (value === undefined || !(bands as readonly string[]).includes(value)) return false;
      }
      return true;
    });
    const needs: Partial<Record<Need, number>> = {};
    const sentiment = { negative: 0, neutral: 0, positive: 0 };
    const perTopic = new Map<number, number>();
    for (const e of rows) {
      for (const n of new Set(e.needs)) needs[n] = (needs[n] ?? 0) + 1;
      sentiment[e.sentiment] += 1;
      perTopic.set(e.topic_id, (perTopic.get(e.topic_id) ?? 0) + 1);
    }
    const groups: Record<string, CommentGroupFigures> = {};
    for (const [name, groupNeeds] of Object.entries(query.needGroups ?? {})) {
      const inGroup = rows.filter((e) => e.needs.some((n) => groupNeeds.includes(n)));
      groups[name] = {
        voices: new Set(inGroup.map((e) => `${e.topic_id}:${e.author_key}`)).size,
        comments: inGroup.length,
        negative: inGroup.filter((e) => e.sentiment === 'negative').length,
        neutral: inGroup.filter((e) => e.sentiment === 'neutral').length,
        positive: inGroup.filter((e) => e.sentiment === 'positive').length,
      };
    }
    return {
      groups,
      voices: new Set(rows.map((e) => `${e.topic_id}:${e.author_key}`)).size,
      comments: rows.length,
      needs,
      sentiment,
      suggestions: rows.filter((e) => e.suggestion).length,
      topTopics: [...perTopic]
        .map(([topicId, comments]) => ({ topicId, comments }))
        .sort((a, b) => b.comments - a.comments || a.topicId - b.topicId)
        .slice(0, query.topTopics ?? 5),
    };
  }

  async insertEvents(events: readonly AnalyticsEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async insertRollups(rows: readonly DailyRollupRow[]): Promise<void> {
    this.rollups.push(
      ...rows.map((r) => ({ ...r, histogram: [...r.histogram] as DailyRollupRow['histogram'] })),
    );
  }

  async series(
    topicId: number,
    regionId: number,
    dim: number,
    bucket: string,
    tiers: readonly VerificationTier[],
    from: string,
    to: string,
  ): Promise<SeriesPoint[]> {
    const tierSet = new Set(tiers);
    const byDay = new Map<string, { n: number; histogram: number[] }>();

    for (const row of this.rollups) {
      if (
        row.topicId !== topicId ||
        row.regionId !== regionId ||
        row.dim !== dim ||
        row.bucket !== bucket ||
        !tierSet.has(row.tier) ||
        row.day < from ||
        row.day > to
      )
        continue;
      const acc = byDay.get(row.day) ?? { n: 0, histogram: [0, 0, 0, 0, 0] };
      acc.n += row.n;
      for (let i = 0; i < 5; i += 1)
        acc.histogram[i] = (acc.histogram[i] as number) + (row.histogram[i] as number);
      byDay.set(row.day, acc);
    }

    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, acc]) => {
        const rebuilt = fromHistogram(bucket, acc.histogram as never);
        return {
          day,
          n: acc.n,
          meanMood: acc.n > 0 ? Math.round((rebuilt.sumMood / acc.n) * 100) / 100 : null,
          histogram: acc.histogram as SeriesPoint['histogram'],
        };
      });
  }

  async recomputeSlice(
    topicId: number,
    regionId: number,
    dim: number,
    tier: VerificationTier,
  ): Promise<RawBucket[]> {
    const byBucket = new Map<string, { histogram: number[]; sumIntensity: number }>();
    for (const row of this.rollups) {
      if (
        row.topicId !== topicId ||
        row.regionId !== regionId ||
        row.dim !== dim ||
        row.tier !== tier
      ) {
        continue;
      }
      const acc = byBucket.get(row.bucket) ?? { histogram: [0, 0, 0, 0, 0], sumIntensity: 0 };
      for (let i = 0; i < 5; i += 1)
        acc.histogram[i] = (acc.histogram[i] as number) + (row.histogram[i] as number);
      acc.sumIntensity += row.sumIntensity;
      byBucket.set(row.bucket, acc);
    }
    return [...byBucket.entries()].map(([bucket, acc]) =>
      fromHistogram(bucket, acc.histogram as never, acc.sumIntensity),
    );
  }

  async topicSlices(query: TopicSlicesQuery): Promise<Map<number, RawBucket[]>> {
    const topics = new Set(query.topicIds);
    const tiers = new Set(query.tiers);
    const acc = new Map<number, Map<string, { histogram: number[]; sumIntensity: number }>>();
    for (const row of this.rollups) {
      if (!topics.has(row.topicId) || row.regionId !== query.regionId) continue;
      if (row.dim !== query.dim || !tiers.has(row.tier)) continue;
      const byBucket = acc.get(row.topicId) ?? new Map();
      const b = byBucket.get(row.bucket) ?? { histogram: [0, 0, 0, 0, 0], sumIntensity: 0 };
      for (let i = 0; i < 5; i += 1)
        b.histogram[i] = (b.histogram[i] as number) + (row.histogram[i] as number);
      b.sumIntensity += row.sumIntensity;
      byBucket.set(row.bucket, b);
      acc.set(row.topicId, byBucket);
    }
    return new Map(
      [...acc].map(([topicId, byBucket]) => [
        topicId,
        [...byBucket].map(([bucket, b]) =>
          fromHistogram(bucket, b.histogram as never, b.sumIntensity),
        ),
      ]),
    );
  }

  async crossSlice(query: CrossSliceQuery): Promise<RawBucket> {
    const tierSet = new Set(query.tiers);
    let acc = emptyRawBucket('cross');

    for (const event of this.events) {
      if (event.topic_id !== query.topicId) continue;
      if (!rollupAncestors(event.region_path).includes(query.regionId)) continue;
      if (!tierSet.has(event.verification_tier)) continue;
      const day = dayOf(event.occurred_at);
      if (query.from && day < query.from) continue;
      if (query.to && day > query.to) continue;

      // Every requested dimension must match — this is the cross-product, not a marginal.
      const matches = Object.entries(query.where).every(([dim, want]) => {
        if (want === undefined) return true;
        return (event.demographics as Record<string, string | undefined>)[dim] === want;
      });
      if (!matches) continue;

      const histogram = [...acc.histogram];
      histogram[event.mood + 2] = Math.max(0, (histogram[event.mood + 2] as number) + event.delta);
      acc = fromHistogram(
        'cross',
        histogram as never,
        Math.max(0, acc.sumIntensity + event.intensity * event.delta),
      );
    }
    return acc;
  }

  async participants(topicId: number, regionId: number, day: string): Promise<number> {
    const seen = new Set<string>();
    for (const event of this.events) {
      if (event.topic_id !== topicId || event.delta !== 1) continue;
      if (!rollupAncestors(event.region_path).includes(regionId)) continue;
      if (dayOf(event.occurred_at) !== day) continue;
      seen.add(event.pseudonym);
    }
    return seen.size;
  }

  async insertRtiOutcomes(rows: readonly RtiOutcomeRow[]): Promise<void> {
    this.rtiOutcomes.push(...rows);
  }

  async authorityScorecard(authorityId: number, windowDays: number): Promise<ScorecardResult> {
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
    const rows = this.rtiOutcomes.filter(
      (r) => r.authorityId === authorityId && r.filedOn >= cutoff,
    );
    if (rows.length === 0) {
      return {
        authorityId,
        requests: 0,
        onTimeRate: null,
        medianResponseDays: null,
        deemedRefusalRate: null,
        firstAppealRate: null,
        appealOverturnRate: null,
      };
    }
    const answered = rows.filter((r) => r.responseDays !== null);
    const days = answered.map((r) => r.responseDays as number).sort((a, b) => a - b);
    const median =
      days.length === 0
        ? null
        : days.length % 2 === 1
          ? (days[(days.length - 1) / 2] as number)
          : ((days[days.length / 2 - 1] as number) + (days[days.length / 2] as number)) / 2;
    const appealed = rows.filter((r) => r.firstAppealed);

    const rate = (n: number) => Math.round((n / rows.length) * 1000) / 1000;
    return {
      authorityId,
      requests: rows.length,
      // On time means answered within the statutory window: response days recorded and no deemed refusal.
      onTimeRate: rate(rows.filter((r) => r.responseDays !== null && !r.deemedRefused).length),
      medianResponseDays: median,
      deemedRefusalRate: rate(rows.filter((r) => r.deemedRefused).length),
      firstAppealRate: rate(appealed.length),
      appealOverturnRate:
        appealed.length === 0
          ? null
          : Math.round(
              (appealed.filter((r) => r.appealOverturned).length / appealed.length) * 1000,
            ) / 1000,
    };
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}
}

export function createMemoryAnalyticsStore(): MemoryAnalyticsStore {
  return new MemoryAnalyticsStore();
}
