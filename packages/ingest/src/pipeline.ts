import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentKind } from '@civic-voice/contracts';
import {
  extractAmounts,
  extractClosingDate,
  extractDepartment,
  extractGazetteNumbers,
  extractGoNumbers,
  extractVacancies,
  parseIndianDate,
} from './extract.ts';
import type { FetchOutcome, PoliteFetcher } from './fetcher.ts';
import type { Gazetteer, GeoTag } from './gazetteer.ts';
import { parseListing } from './parsers/html-list.ts';
import { pdfText } from './parsers/pdf.ts';
import { parseFeed } from './parsers/rss.ts';
import type { SourceSpec } from './sources.ts';

/**
 * From a source to normalised, geo-tagged, deduplicated documents.
 */

export interface IngestedDocument {
  sourceId: string;
  kind: DocumentKind;
  /** What it is about, when that is a project or a scheme — including GOs that sanction one. */
  subject: 'project' | 'scheme' | null;
  title: string;
  url: string;
  publishedOn: string | null;
  /** Short extract for display. For news this is all that is kept — the article is linked, not copied. */
  snippet: string | null;
  /** Full text of a public government document; always null for news. */
  text: string | null;
  goNumber: string | null;
  goType: 'Ms' | 'Rt' | 'P' | null;
  gazetteNumber: string | null;
  department: string | null;
  amountRupees: number | null;
  vacancies: number | null;
  closingOn: string | null;
  jurisdiction: string;
  primaryRegionId: number | null;
  primaryRegionPath: number[];
  geoConfidence: number;
  geoTags: GeoTag[];
  /** Whether this should become something citizens discuss (a policy GO, a project) or only be indexed. */
  discussable: boolean;
  provenance: 'official' | 'news';
  contentHash: string;
  needsOcr: boolean;
}

export interface SourceHealth {
  sourceId: string;
  fetchedAt: string;
  outcome: FetchOutcome['status'] | 'fixture';
  items: number;
  /** A source that normally yields items and yielded none: probably a redesign, not a quiet day. */
  suspectedLayoutChange: boolean;
  message: string | null;
}

export interface PipelineDeps {
  gazetteer: Gazetteer;
  /** ISO code → region path, root first. */
  jurisdictionPath: (iso: string) => number[] | null;
  now?: () => Date;
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref$|source$)/i;

/** One URL per document, however many tracking variants point at it. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\?$/, '');
  } catch {
    return raw;
  }
}

/**
 * The deduplication key. A GO is identified by its number within its jurisdiction — the same order
 * re-posted at a new URL is the same order. Everything else by canonical URL.
 */
export function contentHash(jurisdiction: string, url: string, goNumber: string | null): string {
  const identity = goNumber ? `${jurisdiction}|${goNumber}` : canonicalUrl(url);
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/** Refine the source's default kind from what the item actually is. */
const SCHEME =
  /\bscheme\b|yojana|\bassistance to\b|financial assistance|subsidy|\bpension\b|పథకం|योजना/;
const PROJECT =
  /\bproject|\bworks?\b|construction|widening|strengthening|sanction of rs|restoration|\bflyover|\bmetro\b/;

/**
 * The instrument a document is. A numbered GO is a government order whatever it orders — that is
 * what it can be cited as — and what it is *about* is `classifySubject`'s question.
 */
export function classifyKind(
  spec: SourceSpec,
  title: string,
  goType: 'Ms' | 'Rt' | 'P' | null,
): DocumentKind {
  const t = title.toLowerCase();
  if (/\btender|e-procurement|request for proposal|\brfp\b/.test(t)) return 'tender';
  if (
    spec.kind === 'job_notification' ||
    /\brecruitment|vacanc|\bposts?\b|notification no\./.test(t)
  ) {
    // A syllabus or an exam-date change on a commission's page is not itself a job notification.
    // Exam logistics on a commission's page — a syllabus, a timetable, a result — are not job notifications.
    if (
      /syllabus|answer key|admit card|hall ticket|result|time ?table|schedule of|interview schedule|cut-?off|marks of/.test(
        t,
      )
    ) {
      return spec.kind === 'job_notification' ? 'press_release' : spec.kind;
    }
    return 'job_notification';
  }
  if (goType) return 'government_order';
  if (SCHEME.test(t)) return 'scheme';
  if (spec.kind === 'project' || PROJECT.test(t)) return 'project';
  return spec.kind;
}

/**
 * What a document is about, independent of its instrument: a GO sanctioning drains is a project, a GO
 * releasing Rythu Bharosa instalments is a scheme. This is what "new projects" lists are built from,
 * so it looks only at the title, where a false positive is least likely.
 */
export function classifySubject(kind: DocumentKind, title: string): 'project' | 'scheme' | null {
  if (kind === 'project' || kind === 'scheme') return kind;
  if (kind === 'tender' || kind === 'job_notification') return null;
  const t = title.toLowerCase();
  if (SCHEME.test(t)) return 'scheme';
  if (PROJECT.test(t)) return 'project';
  return null;
}

/**
 * Should citizens be asked what they think of this? Policy GOs, projects, schemes, gazette
 * notifications and news — yes. Routine GOs (transfers, leave), tenders and job notifications — no:
 * they are indexed and searchable, and job notifications feed the jobs board instead.
 */
export function isDiscussable(kind: DocumentKind, goType: 'Ms' | 'Rt' | 'P' | null): boolean {
  if (kind === 'government_order') return goType !== 'Rt';
  return kind !== 'tender' && kind !== 'job_notification';
}

interface RawItem {
  title: string;
  link: string;
  dateText: string | null;
  summary: string | null;
  extra: string[];
}

export async function parseSource(
  spec: SourceSpec,
  body: string,
  baseUrl: string,
): Promise<RawItem[]> {
  if (spec.format === 'rss') {
    return parseFeed(body).map((item) => ({
      title: item.title,
      link: item.link,
      dateText: item.published,
      summary: item.summary,
      extra: [],
    }));
  }
  if (spec.format === 'html_list') {
    if (!spec.selectors) throw new Error(`${spec.id}: html_list source has no selectors`);
    return parseListing(body, spec.selectors, baseUrl).map((item) => ({
      title: item.title,
      link: item.link,
      dateText: item.dateText,
      summary: null,
      extra: item.extra,
    }));
  }
  // json_api: the data.gov.in list shape.
  const json = JSON.parse(body) as {
    records?: Array<{ title?: string; url?: string; updated?: string }>;
  };
  return (json.records ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({
      title: r.title as string,
      link: r.url as string,
      dateText: r.updated ?? null,
      summary: null,
      extra: [],
    }));
}

export function normalizeItem(
  spec: SourceSpec,
  item: RawItem,
  deps: PipelineDeps,
  documentText: { text: string; needsOcr: boolean } | null = null,
): IngestedDocument {
  const haystack = [item.title, ...item.extra, item.summary ?? '', documentText?.text ?? ''].join(
    ' \n ',
  );
  const go = extractGoNumbers(haystack)[0] ?? null;
  const kind = classifyKind(spec, item.title, go?.type ?? null);

  const jurisdictionPath = deps.jurisdictionPath(spec.jurisdiction) ?? [];
  const geoTags = deps.gazetteer.tag({
    title: item.title,
    body: spec.linkOnly
      ? item.summary
      : [item.summary, documentText?.text].filter(Boolean).join(' '),
    jurisdictionPath,
  });
  const primary = deps.gazetteer.primaryRegion(geoTags, jurisdictionPath);

  const amounts = extractAmounts(haystack);
  const snippetSource = item.summary ?? documentText?.text ?? null;
  const snippetLimit = spec.linkOnly ? 280 : 400;

  return {
    sourceId: spec.id,
    kind,
    subject: classifySubject(kind, item.title),
    title: item.title,
    url: canonicalUrl(item.link),
    publishedOn: item.dateText ? parseIndianDate(item.dateText) : null,
    snippet: snippetSource ? truncate(snippetSource, snippetLimit) : null,
    text: spec.linkOnly ? null : (documentText?.text ?? null),
    goNumber: go?.canonical ?? null,
    goType: go?.type ?? null,
    gazetteNumber: extractGazetteNumbers(haystack)[0] ?? null,
    department: extractDepartment(haystack),
    // The largest figure is the headline sanction; line items inside it are smaller.
    amountRupees: amounts.length > 0 ? Math.max(...amounts.map((a) => a.rupees)) : null,
    vacancies: kind === 'job_notification' ? extractVacancies(haystack) : null,
    closingOn: kind === 'job_notification' ? extractClosingDate(haystack) : null,
    jurisdiction: spec.jurisdiction,
    primaryRegionId: primary?.regionId ?? null,
    primaryRegionPath: primary?.path ?? jurisdictionPath,
    geoConfidence: primary?.confidence ?? 0,
    geoTags,
    discussable: isDiscussable(kind, go?.type ?? null),
    provenance: spec.provenance,
    contentHash: contentHash(spec.jurisdiction, item.link, go?.canonical ?? null),
    needsOcr: documentText?.needsOcr ?? false,
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Deduplicate within a run; across runs the database's unique content_hash does the same job. */
export function dedupe(documents: readonly IngestedDocument[]): IngestedDocument[] {
  const seen = new Map<string, IngestedDocument>();
  for (const doc of documents) if (!seen.has(doc.contentHash)) seen.set(doc.contentHash, doc);
  return [...seen.values()];
}

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures');

/** Run a source against its fixture. Offline, deterministic — used by tests and by the dev seed. */
export async function ingestFixture(
  spec: SourceSpec,
  deps: PipelineDeps,
): Promise<{ documents: IngestedDocument[]; health: SourceHealth }> {
  const body = await readFile(join(FIXTURES_DIR, spec.fixture), 'utf8');
  const items = await parseSource(spec, body, spec.url);
  const documents = dedupe(items.map((item) => normalizeItem(spec, item, deps)));
  return {
    documents,
    health: {
      sourceId: spec.id,
      fetchedAt: (deps.now?.() ?? new Date()).toISOString(),
      outcome: 'fixture',
      items: documents.length,
      suspectedLayoutChange: false,
      message: null,
    },
  };
}

/** Run a source live, politely. `previousItemCount` feeds the layout-change heuristic. */
export async function ingestLive(
  spec: SourceSpec,
  fetcher: PoliteFetcher,
  deps: PipelineDeps,
  options: { previousItemCount?: number; maxDocumentsToFetch?: number } = {},
): Promise<{ documents: IngestedDocument[]; health: SourceHealth }> {
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const listing = await fetcher.get(spec.url);

  if (listing.status !== 'ok') {
    return {
      documents: [],
      health: {
        sourceId: spec.id,
        fetchedAt,
        outcome: listing.status,
        items: 0,
        suspectedLayoutChange: false,
        message: listing.status === 'error' ? listing.message : null,
      },
    };
  }

  const items = await parseSource(spec, new TextDecoder().decode(listing.body), listing.url);
  const documents: IngestedDocument[] = [];
  let fetched = 0;

  for (const item of items) {
    let documentText: { text: string; needsOcr: boolean } | null = null;
    // Following links is where politeness matters most — one listing can point at fifty PDFs. The
    // fetcher paces them, and a cap bounds how much of one site a single run can touch.
    if (
      spec.fetchDocuments &&
      /\.pdf($|\?)/i.test(item.link) &&
      fetched < (options.maxDocumentsToFetch ?? 20)
    ) {
      fetched += 1;
      const doc = await fetcher.get(item.link);
      if (doc.status === 'ok') {
        try {
          documentText = await pdfText(doc.body);
        } catch {
          documentText = null;
        }
      }
    }
    documents.push(normalizeItem(spec, item, deps, documentText));
  }

  const unique = dedupe(documents);
  return {
    documents: unique,
    health: {
      sourceId: spec.id,
      fetchedAt,
      outcome: 'ok',
      items: unique.length,
      suspectedLayoutChange: unique.length === 0 && (options.previousItemCount ?? 0) > 0,
      message: unique.length === 0 ? 'listing parsed to zero items' : null,
    },
  };
}
