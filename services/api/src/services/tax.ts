import { DEFAULT_PUBLIC_TIER, DIMENSION_TOTAL, type TaxUtilisationView } from '@civic-voice/contracts';
import { notFound, tiersAtOrAbove } from '@civic-voice/core';
import type { CacheTier } from '@civic-voice/cache';
import type { Repositories } from '@civic-voice/db';

/**
 * Tax utilisation (docs/DATA_MODEL.md §2).
 *
 * The join that makes this platform more than a mood ring: what a region was allocated, what was
 * actually spent, and what the region thinks of the scheme, in one response.
 *
 * Per-capita figures are derived at query time from `region.population` rather than stored, so a
 * census update does not require a backfill of every budget line ever recorded.
 */
export class TaxService {
  private readonly repos: Repositories;
  private readonly cache: CacheTier;

  constructor(repos: Repositories, cache: CacheTier) {
    this.repos = repos;
    this.cache = cache;
  }

  async view(regionId: number, fy: string): Promise<TaxUtilisationView> {
    const region = await this.repos.catalogue.getRegion(regionId);
    if (!region) throw notFound(`no region ${regionId}`);

    const lines = await this.repos.catalogue.budgetLines(regionId, fy);
    const population = region.population;

    // One catalogue query for every topic that applies to this region, then at most one counter read
    // per budget line. Bounded by the number of schemes in a region (tens) — nothing here grows with
    // the number of users.
    const topicsByScheme = new Map<number, number>();
    if (lines.length > 0) {
      const topics = await this.repos.catalogue.listTopics({ regionId, status: 'active', limit: 200 });
      for (const topic of topics) {
        if (topic.scheme_id !== null) topicsByScheme.set(topic.scheme_id, topic.id);
      }
    }

    const enriched = await Promise.all(
      lines.map(async (line) => {
        const topicId = topicsByScheme.get(line.scheme_id);
        let meanMood: number | null = null;

        if (topicId !== undefined) {
          const slice = await this.cache.counters.readSlice({
            topicId,
            regionId,
            dim: DIMENSION_TOTAL,
            tiers: tiersAtOrAbove(DEFAULT_PUBLIC_TIER),
          });
          // The k-anonymity floor applies here too: a mood figure attached to a budget line is still
          // a published cohort statistic.
          meanMood =
            slice.total.n >= 25 ? Math.round((slice.total.sumMood / slice.total.n) * 100) / 100 : null;
        }

        return {
          ...line,
          // Utilisation is measured against what was actually released, not against the estimate:
          // "80% utilised" means something different if only half the money ever arrived.
          utilisation_rate:
            line.released !== null && line.released > 0 && line.utilised !== null
              ? Math.round((line.utilised / line.released) * 1000) / 1000
              : null,
          per_capita_utilised:
            population !== null && population > 0 && line.utilised !== null
              ? Math.round((line.utilised / population) * 100) / 100
              : null,
          mean_mood: meanMood,
        };
      }),
    );

    const allocated = enriched.reduce((sum, l) => sum + (l.allocated_be ?? 0), 0);
    const utilised = enriched.reduce((sum, l) => sum + (l.utilised ?? 0), 0);
    const released = enriched.reduce((sum, l) => sum + (l.released ?? 0), 0);

    return {
      region_id: regionId,
      fy,
      population,
      lines: enriched,
      totals: {
        allocated_be: allocated,
        utilised,
        utilisation_rate: released > 0 ? Math.round((utilised / released) * 1000) / 1000 : null,
        per_capita_utilised:
          population !== null && population > 0
            ? Math.round((utilised / population) * 100) / 100
            : null,
      },
    };
  }
}
