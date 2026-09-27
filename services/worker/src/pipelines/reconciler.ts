import { DIMENSION_BUCKETS_BY_INDEX, type VerificationTier } from '@civic-voice/contracts';
import type { CacheTier } from '@civic-voice/cache';
import type { AnalyticsStore } from '@civic-voice/analytics';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * Rollup reconciliation.
 *
 * Redis counters are a *cache* of ClickHouse truth, not the record (docs/ARCHITECTURE.md §6). This job
 * recomputes a slice's marginals from the daily rollup rows and overwrites the cache, which is what
 * makes losing a Redis shard an availability event rather than a data-loss one — and what catches any
 * drift from a partial flush, a clamped negative counter, or a dropped pipeline.
 */
export interface ReconcilerDeps {
  cache: CacheTier;
  analytics: AnalyticsStore;
  metrics: Metrics;
  logger: Logger;
}

export interface ReconcileReport {
  slicesChecked: number;
  slicesRepaired: number;
  drift: Array<{ topicId: number; regionId: number; dim: number; tier: number; cached: number; truth: number }>;
}

export class Reconciler {
  private readonly deps: ReconcilerDeps;

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
  }

  /**
   * Reconcile every dimension and tier of one (topic, region). Called for the busiest slices nightly,
   * and on demand after a Redis incident.
   */
  async reconcile(
    topicId: number,
    regionId: number,
    tiers: readonly VerificationTier[] = [0, 1, 2, 3],
  ): Promise<ReconcileReport> {
    const report: ReconcileReport = { slicesChecked: 0, slicesRepaired: 0, drift: [] };

    for (const dim of Object.keys(DIMENSION_BUCKETS_BY_INDEX).map(Number)) {
      for (const tier of tiers) {
        const truth = await this.deps.analytics.recomputeSlice(topicId, regionId, dim, tier);
        const cached = await this.deps.cache.counters.readSlice({ topicId, regionId, dim, tiers: [tier] });
        report.slicesChecked += 1;

        const truthTotal = truth.reduce((sum, b) => sum + b.n, 0);
        const cachedTotal = cached.total.n;

        if (truthTotal !== cachedTotal) {
          report.drift.push({ topicId, regionId, dim, tier, cached: cachedTotal, truth: truthTotal });
          // Overwrite, not merge: the point is to discard the drifted value, not add to it.
          await this.deps.cache.counters.overwriteSlice(topicId, regionId, dim, tier, truth);
          report.slicesRepaired += 1;
          this.deps.logger.warn(
            { topicId, regionId, dim, tier, cached: cachedTotal, truth: truthTotal },
            'repaired counter drift from analytical truth',
          );
        }
      }
    }

    if (report.slicesRepaired > 0) {
      this.deps.metrics.inc('civic_degraded_total', { component: 'counter_drift' }, report.slicesRepaired);
    }
    return report;
  }
}
