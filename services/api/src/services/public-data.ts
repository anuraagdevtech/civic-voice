import {
  COHORTS,
  NEED_LABELS,
  NEEDS,
  type CohortId,
  type CohortInsight,
  type DocumentKind,
  type DocumentView,
  type FinanceResponse,
  type FiscalStage,
  type Indicator,
  type JobsSummary,
  type Need,
} from '@civic-voice/contracts';
import { availableYears, notFound, summariseFinance } from '@civic-voice/core';
import type { AnalyticsStore, CohortFilter, CommentInsightResult } from '@civic-voice/analytics';
import type { DocumentRow, Repositories } from '@civic-voice/db';
import type { RegionCache } from './regions.ts';

/**
 * Read models over public data: documents (GOs, projects, notifications, news links), the jobs board,
 * socio-economic indicators, and what cohorts — youth, farmers — are saying.
 *
 * Every figure here says where it came from (`provenance`, `source_*`), and development seed figures
 * are marked `sample` all the way to the screen.
 */
export interface PublicDataDeps {
  repos: Repositories;
  regions: RegionCache;
  analytics: AnalyticsStore | null;
  kAnonymity: number;
  now?: () => Date;
}

export class PublicDataService {
  private readonly deps: PublicDataDeps;
  private readonly now: () => Date;

  constructor(deps: PublicDataDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  private async pathOf(regionId: number): Promise<number[]> {
    const region = await this.deps.regions.one(regionId);
    if (!region) throw notFound(`no region ${regionId}`);
    return region.path;
  }

  private async views(rows: readonly DocumentRow[]): Promise<DocumentView[]> {
    const names = await this.deps.regions.many(
      rows.map((r) => r.primary_region_id).filter((id): id is number => id !== null),
    );
    return rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      subject: d.subject,
      title: d.title,
      url: d.url,
      published_on: d.published_on,
      snippet: d.snippet,
      go_number: d.go_number,
      department: d.department,
      amount_rupees: d.amount_rupees,
      vacancies: d.vacancies,
      closing_on: d.closing_on,
      jurisdiction_region_id: d.jurisdiction_region_id,
      primary_region_id: d.primary_region_id,
      primary_region_name:
        d.primary_region_id === null ? null : (names.get(d.primary_region_id)?.name ?? null),
      geo_confidence: d.geo_confidence,
      provenance: d.provenance,
      source_id: d.source_id,
      source_name: d.source_name,
      topic_id: d.topic_id,
    }));
  }

  async documents(
    regionId: number,
    opts: {
      kinds?: DocumentKind[];
      subject?: 'project' | 'scheme';
      limit: number;
      before?: { published_on: string | null; id: number } | null;
    },
  ): Promise<{ items: DocumentView[]; next_cursor: string | null }> {
    const rows = await this.deps.repos.documents.listForRegion(await this.pathOf(regionId), {
      ...opts,
      limit: opts.limit + 1,
    });
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: await this.views(page),
      next_cursor:
        rows.length > opts.limit && last ? `${last.published_on ?? ''}_${last.id}` : null,
    };
  }

  async document(id: number): Promise<DocumentView> {
    const row = await this.deps.repos.documents.getDocument(id);
    if (!row) throw notFound(`no document ${id}`);
    return (await this.views([row]))[0] as DocumentView;
  }

  /**
   * "How many government job notifications are there?" — open ones that apply to this region, and
   * the vacancies they state. A notification without a number is counted, not guessed, and the total
   * is labelled a lower bound because of it.
   */
  async jobs(regionId: number): Promise<JobsSummary> {
    const today = this.now().toISOString().slice(0, 10);
    const inAWeek = new Date(this.now().getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.deps.repos.documents.openJobs(await this.pathOf(regionId), today);
    const byJurisdiction = new Map<number, { notifications: number; vacancies: number }>();
    for (const r of rows) {
      const j = byJurisdiction.get(r.jurisdiction_region_id) ?? { notifications: 0, vacancies: 0 };
      j.notifications += 1;
      j.vacancies += r.vacancies ?? 0;
      byJurisdiction.set(r.jurisdiction_region_id, j);
    }
    const names = await this.deps.regions.many([...byJurisdiction.keys()]);
    return {
      as_of: today,
      open_notifications: rows.length,
      stated_vacancies: rows.reduce((sum, r) => sum + (r.vacancies ?? 0), 0),
      without_count: rows.filter((r) => r.vacancies === null).length,
      closing_within_7_days: rows.filter((r) => r.closing_on !== null && r.closing_on <= inAWeek)
        .length,
      by_jurisdiction: [...byJurisdiction]
        .map(([region_id, j]) => ({
          region_id,
          name: names.get(region_id)?.name ?? String(region_id),
          ...j,
        }))
        .sort((a, b) => b.vacancies - a.vacancies || b.notifications - a.notifications),
      items: await this.views(rows.slice(0, 50)),
      provenance: [...new Set(rows.map((r) => r.provenance))],
    };
  }

  /**
   * A government's public finances: taxes by category, spending by sector, and the gap. The region is
   * the government — the country for the Union, a state for itself — and a year or stage it has no
   * figures for is a null summary alongside what it does have, not an error.
   */
  async finance(regionId: number, fy?: string, stage?: FiscalStage): Promise<FinanceResponse> {
    const region = await this.deps.regions.one(regionId);
    if (!region) throw notFound(`no region ${regionId}`);
    const figures = await this.deps.repos.catalogue.fiscalLines(regionId);
    return {
      region_id: region.id,
      region_name: region.name,
      population: region.population,
      available: availableYears(figures),
      summary: summariseFinance(figures, {
        ...(fy ? { fy } : {}),
        ...(stage ? { stage } : {}),
        population: region.population,
      }),
    };
  }

  async indicators(regionId: number): Promise<Indicator[]> {
    const rows = await this.deps.repos.documents.indicators(await this.pathOf(regionId));
    const names = await this.deps.regions.many(rows.map((r) => r.region_id));
    const series = new Map<string, typeof rows>();
    for (const r of rows)
      series.set(`${r.code}:${r.region_id}`, [
        ...(series.get(`${r.code}:${r.region_id}`) ?? []),
        r,
      ]);
    return [...series.values()]
      .map((obs) => {
        const [latest, previous] = obs.sort((a, b) => b.period_start.localeCompare(a.period_start));
        const l = latest as (typeof obs)[number];
        return {
          code: l.code,
          name: l.name,
          category: l.category,
          unit: l.unit,
          region_id: l.region_id,
          region_name: names.get(l.region_id)?.name ?? null,
          period: l.period,
          value: l.value,
          previous: previous ? { period: previous.period, value: previous.value } : null,
          source_name: l.source_name,
          source_url: l.source_url,
          provenance: l.provenance,
          note: l.note,
        };
      })
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.code.localeCompare(b.code) ||
          a.region_id - b.region_id,
      );
  }

  /**
   * What a cohort in a region is saying: the needs it raises, and its tone, from comments in the
   * window. Gated like every other published slice: below k distinct voices, the cohort's figures are
   * suppressed, not shown small. The comparison with everyone is also withheld when "everyone minus
   * the cohort" would itself be a slice below k — two publishable numbers must not subtract to an
   * unpublishable one.
   */
  async cohort(cohortId: CohortId, regionId: number, windowDays: number): Promise<CohortInsight> {
    const cohort = COHORTS[cohortId];
    const k = this.deps.kAnonymity;
    await this.pathOf(regionId);
    const since = new Date(this.now().getTime() - windowDays * 86_400_000).toISOString();
    const definition = Object.entries(cohort.filter)
      .map(
        ([dim, bands]) => `${dim.replace('_', ' ')} ∈ {${(bands as readonly string[]).join(', ')}}`,
      )
      .join('; ');
    const method =
      'Needs and tone are labels the comment model assigned to each published comment (model-labelled, not self-reported). ' +
      `Figures are shown only when at least ${k} distinct voices contributed.`;

    const empty: CohortInsight = {
      cohort: cohortId,
      label: cohort.label,
      definition,
      region_id: regionId,
      window_days: windowDays,
      participants: null,
      suppressed: true,
      needs: [],
      sentiment: null,
      comparison: null,
      top_topics: [],
      method,
    };
    if (!this.deps.analytics) return empty;

    const [mine, everyone] = await Promise.all([
      this.deps.analytics.commentInsights({
        regionId,
        filter: cohort.filter as CohortFilter,
        since,
        topTopics: 5,
      }),
      this.deps.analytics.commentInsights({ regionId, filter: null, since, topTopics: 0 }),
    ]);
    if (mine.voices < k) return empty;

    const needs = (r: CommentInsightResult) =>
      NEEDS.map((need) => ({ need, comments: r.needs[need] ?? 0 }))
        .filter((n) => n.comments > 0)
        .map((n) => ({
          ...n,
          share: r.comments === 0 ? 0 : Math.round((n.comments / r.comments) * 1000) / 1000,
        }))
        .sort((a, b) => b.share - a.share);
    const cohortNeeds = needs(mine);
    const rest = everyone.voices - mine.voices;
    const comparable = rest === 0 || rest >= k;
    const everyoneShare = new Map<Need, number>(needs(everyone).map((n) => [n.need, n.share]));
    const topics = await this.deps.repos.catalogue.getTopics(mine.topTopics.map((t) => t.topicId));
    const titles = new Map(topics.map((t) => [t.id, t.title]));
    const total = mine.sentiment.negative + mine.sentiment.neutral + mine.sentiment.positive;
    const frac = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 1000);

    return {
      ...empty,
      participants: mine.voices,
      suppressed: false,
      needs: cohortNeeds.map((n) => ({
        need: n.need,
        label: NEED_LABELS[n.need],
        share: n.share,
        comments: n.comments,
      })),
      sentiment: {
        negative: frac(mine.sentiment.negative),
        neutral: frac(mine.sentiment.neutral),
        positive: frac(mine.sentiment.positive),
      },
      comparison: comparable
        ? cohortNeeds.slice(0, 8).map((n) => ({
            need: n.need,
            cohort_share: n.share,
            everyone_share: everyoneShare.get(n.need) ?? 0,
          }))
        : null,
      top_topics: mine.topTopics
        .filter((t) => titles.has(t.topicId))
        .map((t) => ({
          topic_id: t.topicId,
          title: titles.get(t.topicId) as string,
          comments: t.comments,
        })),
    };
  }
}
