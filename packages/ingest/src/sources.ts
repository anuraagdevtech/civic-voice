import type { DocumentKind } from '@civic-voice/contracts';
import type { ListSelectors } from './parsers/html-list.ts';

/**
 * The source registry: which public sources are read, how, and how often.
 *
 * Declarative on purpose. Adding a state is one entry plus a fixture; fixing a redesigned portal is a
 * selector change, not a code change. Structured feeds (RSS, APIs) are preferred wherever they exist,
 * because they survive redesigns; HTML listings are the fallback.
 *
 * **Verification status.** None of these sources has been verified against the live site from the
 * environment this was built in — outbound access to government and news hosts was blocked by network
 * policy. RSS entries are low-risk (the format is standard); HTML-listing selectors are best estimates
 * of each portal's structure and are expected to need adjustment on first live run. `pnpm ingest:check`
 * probes every source and reports exactly which parse and which need fixing, and the ingestor's health
 * check flags any source whose selectors stop matching.
 */

export type SourceFormat = 'rss' | 'html_list' | 'json_api';

export interface SourceSpec {
  id: string;
  name: string;
  publisher: string;
  /** ISO 3166-2 code of the issuing jurisdiction: 'IN', 'IN-TG', 'IN-AP', … */
  jurisdiction: string;
  /** Default kind for items; refined per item (a routine GO, a tender, a job notification). */
  kind: DocumentKind;
  format: SourceFormat;
  url: string;
  selectors?: ListSelectors;
  everyMinutes: number;
  language: 'en' | 'hi' | 'te' | 'mixed';
  provenance: 'official' | 'news';
  /**
   * News is linked, not republished: headline, link and a short snippet only. Government documents are
   * public records and their text is indexed so they can be searched and summarised.
   */
  linkOnly: boolean;
  /** Follow each item's link to fetch the document itself (usually a GO PDF) for full text. */
  fetchDocuments: boolean;
  verified: { at: string | null; notes: string };
  fixture: string;
}

export const SOURCES: SourceSpec[] = [
  // ─────────────────────────── Central government ───────────────────────────
  {
    id: 'pib-releases',
    name: 'Press Information Bureau — press releases',
    publisher: 'Press Information Bureau, Government of India',
    jurisdiction: 'IN',
    kind: 'press_release',
    format: 'rss',
    url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',
    everyMinutes: 30,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: {
      at: null,
      notes: 'RSS; standard format. Not reachable from the build environment.',
    },
    fixture: 'pib.rss.xml',
  },
  {
    id: 'rbi-press',
    name: 'Reserve Bank of India — press releases',
    publisher: 'Reserve Bank of India',
    jurisdiction: 'IN',
    kind: 'press_release',
    format: 'rss',
    url: 'https://www.rbi.org.in/pressreleases_rss.xml',
    everyMinutes: 120,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: { at: null, notes: 'RSS. Not reachable from the build environment.' },
    fixture: 'rbi.rss.xml',
  },
  {
    id: 'egazette-extraordinary',
    name: 'e-Gazette of India — extraordinary notifications',
    publisher: 'Department of Publication, Government of India',
    jurisdiction: 'IN',
    kind: 'gazette_notification',
    format: 'html_list',
    url: 'https://egazette.gov.in/',
    selectors: {
      item: 'table tr',
      link: 'a[href]',
      date: 'td:nth-child(4)',
      extra: ['td:nth-child(2)', 'td:nth-child(3)'],
    },
    everyMinutes: 180,
    language: 'mixed',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: true,
    verified: {
      at: null,
      notes: 'Listing is search-driven; selectors are an estimate and need a live check.',
    },
    fixture: 'egazette.html',
  },
  {
    id: 'employment-news',
    name: 'Employment News — latest notifications',
    publisher: 'Publications Division, Ministry of Information & Broadcasting',
    jurisdiction: 'IN',
    kind: 'job_notification',
    format: 'html_list',
    url: 'https://www.employmentnews.gov.in/',
    selectors: {
      item: '.job-list li, table.jobs tr',
      link: 'a[href]',
      date: '.date, td:nth-child(3)',
      extra: ['.org, td:nth-child(2)'],
    },
    everyMinutes: 360,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: { at: null, notes: 'Selectors are an estimate; needs a live check.' },
    fixture: 'employment-news.html',
  },
  {
    id: 'upsc-whats-new',
    name: 'UPSC — What’s New',
    publisher: 'Union Public Service Commission',
    jurisdiction: 'IN',
    kind: 'job_notification',
    format: 'html_list',
    url: 'https://upsc.gov.in/whats-new',
    selectors: {
      item: '.view-content .views-row, table tbody tr',
      link: 'a[href]',
      date: '.date-display-single, td:last-child',
    },
    everyMinutes: 360,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: { at: null, notes: 'Selectors are an estimate; needs a live check.' },
    fixture: 'upsc.html',
  },
  {
    id: 'data-gov-in',
    name: 'Open Government Data Platform — dataset updates',
    publisher: 'National Informatics Centre',
    jurisdiction: 'IN',
    kind: 'press_release',
    format: 'json_api',
    url: 'https://api.data.gov.in/lists?format=json&notfilters[source]=visualize.data.gov.in&sort[updated]=desc&limit=50',
    everyMinutes: 720,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: {
      at: null,
      notes: 'Requires an API key (CIVIC_DATA_GOV_IN_KEY). Endpoint shape unverified.',
    },
    fixture: 'data-gov-in.json',
  },

  // ─────────────────────────── Telangana ───────────────────────────
  {
    id: 'tg-goir',
    name: 'Telangana — Government Orders Issue Register',
    publisher: 'Government of Telangana',
    jurisdiction: 'IN-TG',
    kind: 'government_order',
    format: 'html_list',
    url: 'https://goir.telangana.gov.in/',
    selectors: {
      item: 'table#goList tbody tr, table.table tbody tr',
      title: 'td:nth-child(4)',
      link: 'a[href]',
      date: 'td:nth-child(3)',
      extra: ['td:nth-child(1)', 'td:nth-child(2)'],
    },
    everyMinutes: 60,
    language: 'mixed',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: true,
    verified: {
      at: null,
      notes: 'Portal lists GOs by department and date; selectors are an estimate.',
    },
    fixture: 'tg-goir.html',
  },
  {
    id: 'tg-tgpsc',
    name: 'Telangana Public Service Commission — notifications',
    publisher: 'Telangana State Public Service Commission',
    jurisdiction: 'IN-TG',
    kind: 'job_notification',
    format: 'html_list',
    url: 'https://www.tspsc.gov.in/',
    selectors: {
      item: '.notifications li, table tbody tr',
      link: 'a[href]',
      date: '.date, td:nth-child(3)',
    },
    everyMinutes: 240,
    language: 'en',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: {
      at: null,
      notes: 'The commission was renamed TGPSC in 2024; the host may redirect. Estimate.',
    },
    fixture: 'tgpsc.html',
  },
  {
    id: 'tg-ghmc',
    name: 'Greater Hyderabad Municipal Corporation — news and works',
    publisher: 'Greater Hyderabad Municipal Corporation',
    jurisdiction: 'IN-TG-GHMC',
    kind: 'project',
    format: 'html_list',
    url: 'https://www.ghmc.gov.in/',
    selectors: { item: '.news-list li, .latest-news li', link: 'a[href]', date: '.date' },
    everyMinutes: 120,
    language: 'mixed',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: false,
    verified: { at: null, notes: 'Selectors are an estimate; needs a live check.' },
    fixture: 'ghmc.html',
  },

  // ─────────────────────────── Andhra Pradesh ───────────────────────────
  {
    id: 'ap-goir',
    name: 'Andhra Pradesh — Government Orders Issue Register',
    publisher: 'Government of Andhra Pradesh',
    jurisdiction: 'IN-AP',
    kind: 'government_order',
    format: 'html_list',
    url: 'https://goir.ap.gov.in/',
    selectors: {
      item: 'table tbody tr',
      title: 'td:nth-child(4)',
      link: 'a[href]',
      date: 'td:nth-child(3)',
      extra: ['td:nth-child(1)', 'td:nth-child(2)'],
    },
    everyMinutes: 60,
    language: 'mixed',
    provenance: 'official',
    linkOnly: false,
    fetchDocuments: true,
    verified: { at: null, notes: 'Same register format as Telangana, by lineage; estimate.' },
    fixture: 'ap-goir.html',
  },

  // ─────────────────────────── News (linked, never republished) ───────────────────────────
  {
    id: 'thehindu-hyderabad',
    name: 'The Hindu — Hyderabad',
    publisher: 'The Hindu',
    jurisdiction: 'IN-TG-GHMC',
    kind: 'news',
    format: 'rss',
    url: 'https://www.thehindu.com/news/cities/Hyderabad/feeder/default.rss',
    everyMinutes: 30,
    language: 'en',
    provenance: 'news',
    linkOnly: true,
    fetchDocuments: false,
    verified: {
      at: null,
      notes: 'RSS; feed path follows the publisher’s documented pattern. Unverified here.',
    },
    fixture: 'news-hyderabad.rss.xml',
  },
  {
    id: 'indianexpress-hyderabad',
    name: 'The Indian Express — Hyderabad',
    publisher: 'The Indian Express',
    jurisdiction: 'IN-TG-GHMC',
    kind: 'news',
    format: 'rss',
    url: 'https://indianexpress.com/section/cities/hyderabad/feed/',
    everyMinutes: 30,
    language: 'en',
    provenance: 'news',
    linkOnly: true,
    fetchDocuments: false,
    verified: { at: null, notes: 'RSS. Unverified here.' },
    fixture: 'indianexpress-hyderabad.rss.xml',
  },
];

export function sourceById(id: string): SourceSpec | undefined {
  return SOURCES.find((s) => s.id === id);
}
