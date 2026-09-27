import type { DocumentKind } from '@civic-voice/contracts';
import type { NewDocument, Repositories } from '@civic-voice/db';
import { flattenRegions, gazetteerSeeds, GEOGRAPHY, type SeedRegion } from '@civic-voice/geo';
import {
  Gazetteer,
  ingestFixture,
  ingestLive,
  type IngestedDocument,
  type PipelineDeps,
  type PoliteFetcher,
  type SourceHealth,
  type SourceSpec,
} from '@civic-voice/ingest';
import { sectorFor } from '@civic-voice/nlp';
import type { Logger, Metrics } from '@civic-voice/observability';

/**
 * Turns what the scrapers find into what citizens see: catalogue documents (GOs, projects, job
 * notifications, news links), per-source health, and — for the documents worth discussing — topics,
 * scoped to the most specific place the document is about. A Telangana GO on drains in Greater
 * Hyderabad becomes a Greater Hyderabad topic, so it is Hyderabad residents who are asked.
 *
 * Two modes. `live` fetches politely (robots.txt, one request per host at a time, conditional GETs,
 * backoff, circuit breaker; see @civic-voice/ingest). `fixtures` parses the bundled synthetic pages
 * instead, and marks everything it produces `sample`, so a made-up GO can never be shown as an
 * official one.
 */
export type IngestMode = 'live' | 'fixtures';

/** What a discussable document becomes when it is put up for discussion. */
export const TOPIC_KIND_FOR: Partial<Record<DocumentKind, string>> = {
  government_order: 'government_order',
  project: 'project',
  scheme: 'scheme',
  gazette_notification: 'law',
  press_release: 'policy',
  news: 'news',
};

export interface SourceRunResult {
  health: SourceHealth;
  inserted: number;
  updated: number;
  skipped: number;
  /** What this run produced, as stored. */
  documents: NewDocument[];
}

export interface IngestorDeps {
  repos: Repositories;
  logger: Logger;
  metrics: Metrics;
  mode: IngestMode;
  fetcher?: PoliteFetcher;
  now?: () => Date;
}

export class Ingestor {
  private readonly deps: IngestorDeps;
  private readonly pipeline: PipelineDeps;
  private readonly idByKey: Map<string, number>;
  private readonly lastCounts = new Map<string, number>();

  private constructor(deps: IngestorDeps, idByKey: Map<string, number>) {
    this.deps = deps;
    this.idByKey = idByKey;
    const pathByKey = new Map(
      flattenRegions()
        .filter((r) => r.keyPath.every((k) => idByKey.has(k)))
        .map((r) => [r.key, r.keyPath.map((k) => idByKey.get(k) as number)]),
    );
    this.pipeline = {
      gazetteer: new Gazetteer(gazetteerSeeds(idByKey)),
      jurisdictionPath: (key) => pathByKey.get(key) ?? null,
      ...(deps.now ? { now: deps.now } : {}),
    };
  }

  /** Resolve every known region key to its catalogue id; the gazetteer is built over what exists. */
  static async create(deps: IngestorDeps, root: SeedRegion = GEOGRAPHY): Promise<Ingestor> {
    const idByKey = new Map<string, number>();
    for (const r of flattenRegions(root)) {
      const row = await deps.repos.catalogue.regionByKey(r.key);
      if (row) idByKey.set(r.key, row.id);
    }
    if (idByKey.size === 0) throw new Error('no regions in the catalogue; run `pnpm seed` first');
    deps.logger.info({ regions: idByKey.size }, 'gazetteer built from the catalogue');
    return new Ingestor(deps, idByKey);
  }

  private toNewDocument(doc: IngestedDocument, spec: SourceSpec): NewDocument | null {
    const jurisdiction = this.idByKey.get(doc.jurisdiction);
    if (jurisdiction === undefined) return null;
    return {
      content_hash: doc.contentHash,
      source_id: spec.id,
      source_name: spec.name,
      kind: doc.kind,
      subject: doc.subject,
      title: doc.title,
      url: doc.url,
      published_on: doc.publishedOn,
      snippet: doc.snippet,
      go_number: doc.goNumber,
      go_type: doc.goType,
      gazette_number: doc.gazetteNumber,
      department: doc.department,
      amount_rupees: doc.amountRupees,
      vacancies: doc.vacancies,
      closing_on: doc.closingOn,
      jurisdiction_region_id: jurisdiction,
      primary_region_id: doc.primaryRegionId,
      primary_region_path: doc.primaryRegionPath,
      geo_confidence: doc.geoConfidence,
      geo_region_ids: doc.geoTags.map((t) => t.regionId),
      discussable: doc.discussable,
      provenance: this.deps.mode === 'fixtures' ? 'sample' : doc.provenance,
      needs_ocr: doc.needsOcr,
    };
  }

  async runSource(spec: SourceSpec): Promise<SourceRunResult> {
    const started = Date.now();
    const result =
      this.deps.mode === 'live'
        ? await ingestLive(spec, this.requireFetcher(), this.pipeline, {
            ...(this.lastCounts.has(spec.id)
              ? { previousItemCount: this.lastCounts.get(spec.id) as number }
              : {}),
          })
        : await ingestFixture(spec, this.pipeline);

    const docs = result.documents.map((d) => this.toNewDocument(d, spec));
    const ready = docs.filter((d): d is NewDocument => d !== null);
    const { inserted, updated } =
      ready.length > 0
        ? await this.deps.repos.documents.upsertDocuments(ready)
        : { inserted: 0, updated: 0 };
    if (result.health.items > 0) this.lastCounts.set(spec.id, result.health.items);

    await this.deps.repos.documents.putSourceHealth({
      source_id: spec.id,
      fetched_at: result.health.fetchedAt,
      outcome: result.health.outcome,
      items: result.health.items,
      suspected_layout_change: result.health.suspectedLayoutChange,
      message: result.health.message,
    });
    this.deps.metrics.inc(
      'civic_ingest_documents_total',
      { source: spec.id, change: 'inserted' },
      inserted,
    );
    this.deps.metrics.inc(
      'civic_ingest_documents_total',
      { source: spec.id, change: 'updated' },
      updated,
    );
    this.deps.metrics.observe('civic_ingest_run_ms', Date.now() - started, { source: spec.id });
    if (result.health.suspectedLayoutChange) {
      this.deps.logger.warn(
        { source: spec.id },
        'source yielded nothing after yielding items before: selectors probably stale',
      );
    }
    return {
      health: result.health,
      inserted,
      updated,
      skipped: docs.length - ready.length,
      documents: ready,
    };
  }

  /**
   * Put discussable documents up as topics. The topic's jurisdiction is the document's primary region
   * — the narrowest scope its evidence supports — so who may discuss it follows what it is about.
   */
  async promote(limit = 100): Promise<number> {
    let created = 0;
    for (const doc of await this.deps.repos.documents.undiscussed(limit)) {
      const kind = TOPIC_KIND_FOR[doc.kind];
      if (!kind) continue;
      const scope = doc.primary_region_id ?? doc.jurisdiction_region_id;
      const title =
        doc.go_number && !doc.title.includes(doc.go_number)
          ? `${doc.go_number}: ${doc.title}`
          : doc.title;
      const topic = await this.deps.repos.catalogue.createTopic({
        kind,
        jurisdiction_region_id: scope,
        title: title.slice(0, 300),
        summary: doc.snippet,
        effective_from: doc.published_on,
        source_refs: [doc.url],
        sector: sectorFor(`${doc.title}. ${doc.snippet ?? ''}`),
      });
      await this.deps.repos.documents.linkTopic(doc.id, topic.id);
      created++;
    }
    if (created > 0) this.deps.metrics.inc('civic_ingest_topics_created_total', {}, created);
    return created;
  }

  private requireFetcher(): PoliteFetcher {
    if (!this.deps.fetcher) throw new Error('live mode needs a PoliteFetcher');
    return this.deps.fetcher;
  }
}
