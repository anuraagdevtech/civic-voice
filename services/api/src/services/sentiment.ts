import {
  DEFAULT_PUBLIC_TIER,
  DIMENSION_BUCKETS_BY_INDEX,
  DIMENSION_TOTAL,
  dimensionIndex,
  EVENT_TOPICS,
  VERIFICATION_TIERS,
  type DemographicDimension,
  type MoodAggregate,
  type MoodBucket,
  type SentimentEvent,
  type SubmitSentimentRequest,
  type VerificationTier,
} from '@civic-voice/contracts';
import {
  applyAnonymityGate,
  DEFAULT_K,
  derivePseudonym,
  emptyRawBucket,
  inJurisdiction,
  notFound,
  forbidden,
  rollupAncestors,
  tierDivergence,
  tiersAtOrAbove,
  uuidv7,
  type RawBucket,
  type TopicSaltProvider,
} from '@civic-voice/core';
import type { CacheTier, CitizenProfile } from '@civic-voice/cache';
import type { Repositories } from '@civic-voice/db';
import type { EventBus } from '@civic-voice/stream';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * The sentiment write and read paths.
 *
 * Write: validate → quota → build event → append to the log → record the read-your-write overlay.
 * No Postgres write, no counter mutation. The append is the commit point (ADR-0003).
 *
 * Read: pre-computed marginals from the counter store → quarantine filter → k-anonymity gate. Every
 * published number passes through the gate, once, in one place (docs/PRIVACY.md §3).
 */

export interface SentimentDeps {
  repos: Repositories;
  cache: CacheTier;
  bus: EventBus;
  salts: TopicSaltProvider;
  metrics: Metrics;
  logger: Logger;
  kAnonymity?: number;
}

export interface SubmitResult {
  eventId: string;
  aggregate: MoodAggregate | null;
}

export class SentimentService {
  private readonly deps: SentimentDeps;

  constructor(deps: SentimentDeps) {
    this.deps = deps;
  }

  /**
   * Load the citizen's region path, tier and bands. Cached, because the write path must not depend
   * on Postgres per submission (ADR-0003); a miss is one point lookup on their own shard.
   */
  async profileFor(citizenId: string): Promise<CitizenProfile> {
    const cached = await this.deps.cache.profiles.get(citizenId);
    if (cached) return cached;

    const citizen = await this.deps.repos.citizens.findById(citizenId);
    if (!citizen) throw notFound('citizen not found');
    if (citizen.erased_at !== null) throw forbidden('this account has been erased');

    const profile: CitizenProfile = {
      region_path: citizen.region_path,
      verification_tier: citizen.verification_tier,
      demographics: citizen.demographics,
    };
    await this.deps.cache.profiles.put(citizenId, profile);
    return profile;
  }

  async submit(
    citizenId: string,
    input: SubmitSentimentRequest,
    profile: CitizenProfile,
  ): Promise<SubmitResult> {
    const topic = await this.deps.repos.catalogue.getTopic(input.topic_id);
    if (!topic) throw notFound(`no topic ${input.topic_id}`);

    // A citizen may only be counted on a topic that actually applies to them, or a state policy
    // would acquire a national mood.
    if (!inJurisdiction(profile.region_path, topic.jurisdiction_region_id)) {
      throw forbidden('this topic does not apply to your region');
    }

    const salt = await this.deps.salts.saltFor(input.topic_id);
    const event: SentimentEvent = {
      event_id: uuidv7(),
      // On the bus only: the worker needs it to route to this citizen's shard. It is stripped before
      // anything long-lived sees the event (`stripIdentity`).
      citizen_id: citizenId,
      occurred_at: new Date().toISOString(),
      topic_id: input.topic_id,
      region_path: rollupAncestors(profile.region_path),
      // The event carries a per-topic pseudonym, never the citizen id.
      pseudonym: derivePseudonym(salt, citizenId),
      verification_tier: profile.verification_tier,
      demographics: profile.demographics,
      mood: input.mood,
      intensity: input.intensity,
      reason_code: input.reason_code,
      delta: 1,
      // The worker resolves whether this replaces an earlier opinion, from `sentiment_current` on the
      // citizen's own shard. The API cannot know, and guessing would double-count (ADR-0003).
      replaces: null,
    };

    await this.deps.bus.producer.publish(EVENT_TOPICS.SENTIMENT, event, {
      // Keyed by topic so every event for a topic lands on one partition: the consumer aggregates
      // without cross-partition coordination.
      key: String(input.topic_id),
    });
    this.deps.metrics.inc('civic_sentiment_writes_total');

    // Read-your-write for the citizen's own opinion, which is the part they actually notice.
    await this.deps.cache.pending.put(citizenId, input.topic_id, {
      mood: input.mood,
      intensity: input.intensity,
      reason_code: input.reason_code,
      updated_at: event.occurred_at,
    });

    // Best-effort: the write has already committed, so a counter-store hiccup must not fail it.
    let aggregate: MoodAggregate | null = null;
    try {
      aggregate = await this.moodAggregate(input.topic_id, {});
    } catch (err) {
      this.deps.metrics.inc('civic_degraded_total', { component: 'counters' });
      this.deps.logger.warn({ err, topic_id: input.topic_id }, 'aggregate unavailable after write');
    }

    return { eventId: event.event_id, aggregate };
  }

  /**
   * A published mood aggregate.
   *
   * `regionId` defaults to the topic's own jurisdiction and must be inside it. `dimension` selects a
   * marginal; omitting it returns the total. `tier` is the minimum verification tier counted, and
   * defaults to T2+ — the default public view (ADR-0005).
   */
  async moodAggregate(
    topicId: number,
    query: { regionId?: number; dimension?: DemographicDimension; tier?: VerificationTier },
  ): Promise<MoodAggregate> {
    const topic = await this.deps.repos.catalogue.getTopic(topicId);
    if (!topic) throw notFound(`no topic ${topicId}`);

    const regionId = query.regionId ?? topic.jurisdiction_region_id;
    if (regionId !== topic.jurisdiction_region_id) {
      const region = await this.deps.repos.catalogue.getRegion(regionId);
      if (!region) throw notFound(`no region ${regionId}`);
      if (!inJurisdiction(region.path, topic.jurisdiction_region_id)) {
        throw forbidden('that region is outside this topic’s jurisdiction');
      }
    }

    const dim = query.dimension === undefined ? DIMENSION_TOTAL : dimensionIndex(query.dimension);
    const minTier = query.tier ?? DEFAULT_PUBLIC_TIER;
    const tiers = tiersAtOrAbove(minTier);

    const slice = await this.deps.cache.counters.readSlice({ topicId, regionId, dim, tiers });

    // Buckets the anomaly detectors quarantined are suppressed with a disclosed reason, never
    // silently dropped (docs/TRUST.md §4).
    const quarantined = new Set(
      (await this.deps.repos.catalogue.quarantinedBuckets(topicId, regionId, dim)).map((q) => q.bucket),
    );

    // Include every bucket the dimension can hold, so an absent one reads as zero rather than as
    // missing — otherwise "no women answered" and "we forgot to ask women" look identical.
    const expected = dim === DIMENSION_TOTAL ? ['all'] : (DIMENSION_BUCKETS_BY_INDEX[dim] ?? []);
    const bySeen = new Map(slice.buckets.map((b) => [b.bucket, b]));
    const buckets: RawBucket[] = expected.map((name) => bySeen.get(name) ?? emptyRawBucket(name));
    for (const seen of slice.buckets) if (!expected.includes(seen.bucket)) buckets.push(seen);

    const gated = applyAnonymityGate(slice.total, buckets, {
      k: this.deps.kAnonymity ?? DEFAULT_K,
      quarantined,
    });
    const suppressedCount = gated.buckets.filter((b) => b.suppressed).length;
    if (suppressedCount > 0) {
      this.deps.metrics.inc('civic_anonymity_suppressions_total', {}, suppressedCount);
    }

    return {
      topic_id: topicId,
      region_id: regionId,
      dimension: query.dimension ?? null,
      tier: minTier,
      total: gated.total,
      buckets: gated.buckets,
      staleness_seconds: slice.stalenessSeconds,
      tier_divergence: await this.divergence(topicId, regionId),
      computed_at: new Date().toISOString(),
    };
  }

  /**
   * How far the anonymous crowd diverges from the verified one. Published rather than hidden: a large
   * gap is not proof of manipulation, but it is the signal worth exposing (docs/TRUST.md §2).
   */
  private async divergence(topicId: number, regionId: number): Promise<number | null> {
    const [anonymous, verified] = await Promise.all([
      this.deps.cache.counters.readSlice({
        topicId, regionId, dim: DIMENSION_TOTAL, tiers: [VERIFICATION_TIERS.ANONYMOUS],
      }),
      this.deps.cache.counters.readSlice({
        topicId, regionId, dim: DIMENSION_TOTAL, tiers: tiersAtOrAbove(DEFAULT_PUBLIC_TIER),
      }),
    ]);
    // Both sides need enough people to mean anything, and k is the floor we already trust.
    const k = this.deps.kAnonymity ?? DEFAULT_K;
    if (anonymous.total.n < k || verified.total.n < k) return null;
    return tierDivergence(
      anonymous.total.sumMood / anonymous.total.n,
      verified.total.sumMood / verified.total.n,
    );
  }

  /** The citizen's own opinions, with the pending overlay applied (read-your-write). */
  async mySentiment(citizenId: string, topicIds?: readonly number[]) {
    const stored = await this.deps.repos.sentiment.listCurrent(citizenId, {
      ...(topicIds && topicIds.length > 0 ? { topicIds } : {}),
    });
    const byTopic = new Map(
      stored.map((row) => [
        row.topic_id,
        {
          topic_id: row.topic_id,
          mood: row.mood,
          intensity: row.intensity,
          reason_code: row.reason_code,
          updated_at: row.updated_at,
        },
      ]),
    );

    // Overlay wins: it is newer by construction — it is what the citizen just submitted.
    const wanted = topicIds && topicIds.length > 0 ? topicIds : [...byTopic.keys()];
    const pending = await this.deps.cache.pending.getMany(citizenId, wanted);
    for (const [topicId, opinion] of pending) {
      byTopic.set(topicId, { topic_id: topicId, ...opinion });
    }

    return [...byTopic.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
}

export type { MoodBucket };
