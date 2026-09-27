import { DEFAULT_PUBLIC_TIER, DIMENSION_TOTAL, type VerificationTier } from '@civic-voice/contracts';
import {
  detectHomogeneityAnomaly,
  detectPopulationShareViolation,
  detectVelocityAnomaly,
  shouldQuarantine,
  tiersAtOrAbove,
  today,
  type Anomaly,
} from '@civic-voice/core';
import type { CacheTier } from '@civic-voice/cache';
import type { Repositories } from '@civic-voice/db';
import type { AnalyticsStore } from '@civic-voice/analytics';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * Anomaly detection (docs/TRUST.md §4).
 *
 * Runs off the hot path and quarantines **aggregates, never people**. A flagged window is excluded
 * from the default public view with the exclusion disclosed in the API response, rather than silently
 * dropped — and no account is ever banned on an automated signal alone.
 */
export interface SentinelDeps {
  repos: Repositories;
  cache: CacheTier;
  analytics: AnalyticsStore;
  metrics: Metrics;
  logger: Logger;
}

export interface SentinelFinding {
  topicId: number;
  regionId: number;
  anomalies: Anomaly[];
  quarantined: boolean;
}

export class Sentinel {
  private readonly deps: SentinelDeps;
  /** Trailing participation per (topic, region), for the velocity baseline. */
  private readonly baseline = new Map<string, number[]>();

  constructor(deps: SentinelDeps) {
    this.deps = deps;
  }

  async inspect(
    topicId: number,
    regionId: number,
    opts: { day?: string; tiers?: readonly VerificationTier[] } = {},
  ): Promise<SentinelFinding> {
    const day = opts.day ?? today();
    const tiers = opts.tiers ?? tiersAtOrAbove(DEFAULT_PUBLIC_TIER);

    const [slice, region, participants] = await Promise.all([
      this.deps.cache.counters.readSlice({ topicId, regionId, dim: DIMENSION_TOTAL, tiers }),
      this.deps.repos.catalogue.getRegion(regionId),
      this.deps.analytics.participants(topicId, regionId, day),
    ]);

    const anomalies: Anomaly[] = [];

    const velocity = detectVelocityAnomaly({
      regionId,
      topicId,
      observed: participants,
      baselineMedian: this.baselineFor(topicId, regionId),
      windowSeconds: 86_400,
    });
    if (velocity) anomalies.push(velocity);

    if (region?.population) {
      const share = detectPopulationShareViolation(participants, region.population);
      if (share) anomalies.push(share);
    }

    const homogeneity = detectHomogeneityAnomaly(slice.total.histogram);
    if (homogeneity) anomalies.push(homogeneity);

    this.recordBaseline(topicId, regionId, participants);

    const quarantined = shouldQuarantine(anomalies);
    if (quarantined) {
      const reason = anomalies.find((a) => a.severity === 'quarantine');
      await this.deps.repos.catalogue.addQuarantine({
        topic_id: topicId,
        region_id: regionId,
        dim: DIMENSION_TOTAL,
        bucket: 'all',
        reason: reason?.kind ?? 'unknown',
        ...(reason?.detail === undefined ? {} : { detail: reason.detail }),
      });
      this.deps.logger.warn({ topicId, regionId, anomalies }, 'aggregate quarantined');
    } else if (anomalies.length > 0) {
      // Watch-level findings are logged and left visible. Over-suppressing a genuinely surprising
      // result would be its own kind of censorship.
      this.deps.logger.info({ topicId, regionId, anomalies }, 'anomaly on watch');
    }

    return { topicId, regionId, anomalies, quarantined };
  }

  private baselineFor(topicId: number, regionId: number): number {
    const history = this.baseline.get(`${topicId}:${regionId}`) ?? [];
    if (history.length === 0) return 0;
    const sorted = [...history].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  private recordBaseline(topicId: number, regionId: number, observed: number): void {
    const key = `${topicId}:${regionId}`;
    const history = this.baseline.get(key) ?? [];
    history.push(observed);
    // A rolling window: an attack sustained long enough would otherwise become the new normal.
    if (history.length > 14) history.shift();
    this.baseline.set(key, history);
  }
}
