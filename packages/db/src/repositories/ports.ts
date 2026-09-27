import type {
  CommentState,
  Demographics,
  Digest,
  DocumentKind,
  Locale,
  Mood,
  Need,
  ProvenanceKind,
  ReasonCode,
  RegionBasis,
  ReportReason,
  RtiState,
  RtiTrack,
  VerificationTier,
} from '@civic-voice/contracts';

/**
 * Repository ports. Postgres and in-memory implementations both satisfy these, and both are held to
 * one conformance suite (ADR-0006).
 *
 * Note what the signatures make impossible: every citizen-scoped method takes `citizenId` as its
 * first argument, so there is no way to write a query that does not know its shard (ADR-0007).
 */

export interface CitizenRow {
  id: string;
  region_id: number;
  region_path: number[];
  verification_tier: VerificationTier;
  locale: Locale;
  demographics: Demographics;
  region_basis: RegionBasis;
  created_at: string;
  erased_at: string | null;
}

export interface CreateCitizenInput {
  id: string;
  region_id: number;
  region_path: number[];
  locale: Locale;
  demographics: Demographics;
  verification_tier?: VerificationTier;
  region_basis?: RegionBasis;
}

export interface CitizenRepository {
  create(input: CreateCitizenInput): Promise<CitizenRow>;
  findById(citizenId: string): Promise<CitizenRow | null>;
  updateProfile(
    citizenId: string,
    patch: {
      demographics?: Demographics;
      region_id?: number;
      region_path?: number[];
      region_basis?: RegionBasis;
      locale?: Locale;
    },
  ): Promise<CitizenRow | null>;
  setVerificationTier(citizenId: string, tier: VerificationTier): Promise<CitizenRow | null>;
  /** Crypto-shredding: destroy the wrapped DEK and tombstone the row (ADR-0004). */
  erase(citizenId: string): Promise<boolean>;
}

export interface CurrentSentimentRow {
  citizen_id: string;
  topic_id: number;
  mood: Mood;
  intensity: number;
  reason_code: ReasonCode;
  event_id: string;
  updated_at: string;
}

export interface UpsertSentimentResult {
  /** The opinion this replaced, if any. Drives the compensating −1 in the rollups. */
  previous: CurrentSentimentRow | null;
  /** False when this exact event had already been applied — an at-least-once redelivery. */
  applied: boolean;
}

export interface SentimentRepository {
  getCurrent(citizenId: string, topicId: number): Promise<CurrentSentimentRow | null>;
  listCurrent(
    citizenId: string,
    opts?: { limit?: number; topicIds?: readonly number[] },
  ): Promise<CurrentSentimentRow[]>;
  upsert(
    citizenId: string,
    row: Omit<CurrentSentimentRow, 'citizen_id' | 'updated_at'>,
  ): Promise<UpsertSentimentResult>;
  deleteForCitizen(citizenId: string): Promise<number>;
}

export interface RtiRequestRow {
  id: string;
  citizen_id: string;
  authority_id: number;
  topic_id: number | null;
  subject: string;
  track: RtiTrack;
  state: RtiState;
  filed_at: string | null;
  acknowledged_at: string | null;
  responded_at: string | null;
  first_appeal_at: string | null;
  fa_responded_at: string | null;
  fa_extended: boolean;
  second_appeal_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RtiRepository {
  create(
    input: Omit<RtiRequestRow, 'created_at' | 'updated_at' | 'state'> & { state?: RtiState },
  ): Promise<RtiRequestRow>;
  findById(citizenId: string, id: string): Promise<RtiRequestRow | null>;
  listByCitizen(citizenId: string, opts?: { limit?: number }): Promise<RtiRequestRow[]>;
  /**
   * Record a transition. Legality is enforced in @civic-voice/core and checked at the API boundary;
   * this persists the new state and stamps the matching date column.
   */
  transition(
    citizenId: string,
    id: string,
    to: RtiState,
    on: string | null,
  ): Promise<RtiRequestRow | null>;
}

export interface RegionRow {
  id: number;
  parent_id: number | null;
  kind: string;
  path: number[];
  name: string;
  /** Names in other scripts, by language code. */
  names?: Record<string, string>;
  population: number | null;
  codes: Record<string, string>;
}

export interface TopicRow {
  id: number;
  kind: string;
  status: string;
  jurisdiction_region_id: number;
  authority_id: number | null;
  scheme_id: number | null;
  title: string;
  summary: string | null;
  effective_from: string | null;
  source_refs: string[];
}

export interface AuthorityRow {
  id: number;
  kind: string;
  name: string;
  region_id: number;
  pio_contact: string | null;
  faa_contact: string | null;
}

export interface BudgetLineRow {
  id: number;
  fy: string;
  scheme_id: number;
  scheme_name: string;
  region_id: number;
  /** Which region this money was published against — the level the figure actually belongs to. */
  region_name: string | null;
  /** Narrowed to the values the column's CHECK constraint permits, so callers need no cast. */
  level: 'union' | 'state' | 'district' | 'local';
  /** `sample` for development seed figures, which the UI badges on every number. */
  provenance: ProvenanceKind;
  allocated_be: number | null;
  revised_re: number | null;
  released: number | null;
  utilised: number | null;
  source_refs: string[];
}

export interface QuarantineRow {
  topic_id: number;
  region_id: number;
  dim: number;
  bucket: string;
  reason: string;
}

export interface NewTopic {
  kind: string;
  /** Defaults to `active`. `proposed` is listed nowhere until a moderator promotes it. */
  status?: 'active' | 'proposed';
  jurisdiction_region_id: number;
  title: string;
  summary: string | null;
  effective_from: string | null;
  source_refs: string[];
  authority_id?: number | null;
  scheme_id?: number | null;
}

export interface CatalogueRepository {
  getRegion(regionId: number): Promise<RegionRow | null>;
  /** By stable key (`codes.key`), which data files and the geolocation resolver use. */
  regionByKey(key: string): Promise<RegionRow | null>;
  getRegions(regionIds: readonly number[]): Promise<RegionRow[]>;
  childRegions(parentId: number): Promise<RegionRow[]>;
  getTopic(topicId: number): Promise<TopicRow | null>;
  listTopics(opts: {
    regionId?: number;
    kind?: string;
    status?: string;
    limit?: number;
  }): Promise<TopicRow[]>;
  getTopics(topicIds: readonly number[]): Promise<TopicRow[]>;
  createTopic(input: NewTopic): Promise<TopicRow>;
  getAuthority(authorityId: number): Promise<AuthorityRow | null>;
  budgetLines(regionId: number, fy: string): Promise<BudgetLineRow[]>;
  /**
   * Budget lines for a region **and its ancestors**.
   *
   * Public spending is published at whichever level administers it — a central scheme at state level,
   * a road at district level, a drain at ward level. A citizen in a constituency asking "where did my
   * money go" must be shown all of it, not an empty panel because nothing happens to be recorded
   * against their exact region.
   */
  budgetLinesForPath(regionIds: readonly number[], fy: string): Promise<BudgetLineRow[]>;
  quarantinedBuckets(topicId: number, regionId: number, dim: number): Promise<QuarantineRow[]>;
  addQuarantine(row: QuarantineRow & { detail?: string }): Promise<void>;
}

// ─────────────────────────────── Forum (ADR-0008) ───────────────────────────────

export interface CommentRow {
  topic_id: number;
  id: string;
  parent_id: string | null;
  pseudonym: string;
  handle: string;
  body: string;
  language: string;
  area: string | null;
  located: boolean;
  verification_tier: VerificationTier;
  state: CommentState;
  moderation_reasons: string[];
  sentiment: -1 | 0 | 1 | null;
  needs: Need[];
  suggestion: boolean;
  model: string | null;
  upvotes: number;
  reply_count: number;
  report_count: number;
  created_at: string;
}

export type NewComment = Omit<CommentRow, 'upvotes' | 'reply_count' | 'report_count'>;

export interface CommentPage {
  items: CommentRow[];
  /** Opaque; pass back to continue. Null at the end. */
  next_cursor: string | null;
}

/** Reports from this many distinct people hold a comment for review until a moderator looks. */
export const REPORTS_TO_HOLD = 5;

export interface ForumRepository {
  /**
   * Store a processed comment on its topic's shard and index it on its author's shard. Idempotent on
   * the comment id: a redelivered event changes nothing and returns `inserted: false`. A published
   * reply bumps its parent's reply count in the same transaction.
   */
  insertComment(citizenId: string, row: NewComment): Promise<{ inserted: boolean }>;
  getComment(topicId: number, commentId: string): Promise<CommentRow | null>;
  /** Published top-level comments (or the replies to `parentId`), in `sort` order. */
  listComments(
    topicId: number,
    opts: { sort: 'top' | 'new'; limit: number; cursor?: string | null; parentId?: string | null },
  ): Promise<CommentPage>;
  /** Published comments, most upvoted first — the input to a digest. */
  commentsForDigest(topicId: number, limit: number): Promise<CommentRow[]>;
  countPublished(topicId: number): Promise<number>;
  /** Idempotent: voting twice is one vote, un-voting what was never voted is a no-op. */
  setVote(
    topicId: number,
    commentId: string,
    pseudonym: string,
    on: boolean,
  ): Promise<{ upvotes: number; changed: boolean } | null>;
  votedBy(topicId: number, commentIds: readonly string[], pseudonym: string): Promise<Set<string>>;
  /** One report per pseudonym. Reaching REPORTS_TO_HOLD moves a published comment to `held`. */
  report(
    topicId: number,
    commentId: string,
    pseudonym: string,
    reason: ReportReason,
  ): Promise<{ counted: boolean; held: boolean } | null>;
  setState(
    topicId: number,
    commentId: string,
    state: CommentState,
    reasons?: string[],
  ): Promise<boolean>;
  /** The author's own comments, newest first, in every state. */
  myComments(citizenId: string, limit: number): Promise<CommentRow[]>;
  /** Withdraw one's own comment: the body is blanked and it leaves every listing. */
  deleteOwn(citizenId: string, topicId: number, commentId: string): Promise<boolean>;
  /** Erasure: blank every comment the citizen wrote, then drop their index. Safe to re-run. */
  eraseAuthor(citizenId: string): Promise<number>;
  getDigest(topicId: number): Promise<Digest | null>;
  putDigest(digest: Digest): Promise<void>;
}

// ─────────────────────────────── Documents, jobs, indicators ───────────────────────────────

export interface DocumentRow {
  id: number;
  content_hash: string;
  source_id: string;
  source_name: string;
  kind: DocumentKind;
  subject: 'project' | 'scheme' | null;
  title: string;
  url: string;
  published_on: string | null;
  snippet: string | null;
  go_number: string | null;
  go_type: 'Ms' | 'Rt' | 'P' | null;
  gazette_number: string | null;
  department: string | null;
  amount_rupees: number | null;
  vacancies: number | null;
  closing_on: string | null;
  jurisdiction_region_id: number;
  primary_region_id: number | null;
  primary_region_path: number[];
  geo_confidence: number;
  geo_region_ids: number[];
  discussable: boolean;
  provenance: ProvenanceKind;
  needs_ocr: boolean;
  topic_id: number | null;
  first_seen_at: string;
}

export type NewDocument = Omit<DocumentRow, 'id' | 'topic_id' | 'first_seen_at'>;

export interface IndicatorRow {
  code: string;
  name: string;
  category: 'public_finance' | 'economy' | 'jobs' | 'agriculture';
  unit: string;
  source_name: string;
  source_url: string;
  note: string | null;
  region_id: number;
  period: string;
  period_start: string;
  value: number;
  provenance: ProvenanceKind;
}

export interface SourceHealthRow {
  source_id: string;
  fetched_at: string;
  outcome: string;
  items: number;
  suspected_layout_change: boolean;
  message: string | null;
}

export interface DocumentRepository {
  /** Insert new documents and refresh known ones (by content hash). Returns ids by content hash. */
  upsertDocuments(
    docs: readonly NewDocument[],
  ): Promise<{ inserted: number; updated: number; ids: Map<string, number> }>;
  getDocument(id: number): Promise<DocumentRow | null>;
  /**
   * Documents that concern someone at `regionPath`: those scoped to any region on the path (a
   * national scheme, a state GO, a city project, their ward's drain), plus any that name their own
   * region. Newest first.
   */
  listForRegion(
    regionPath: readonly number[],
    opts: {
      kinds?: readonly DocumentKind[];
      subject?: 'project' | 'scheme';
      limit: number;
      before?: { published_on: string | null; id: number } | null;
    },
  ): Promise<DocumentRow[]>;
  /** Job notifications still open on `today` (closing on or after it, or undated and under 60 days old). */
  openJobs(regionPath: readonly number[], today: string): Promise<DocumentRow[]>;
  linkTopic(documentId: number, topicId: number): Promise<void>;
  /** Discussable documents not yet put up as topics. */
  undiscussed(limit: number): Promise<DocumentRow[]>;
  putSourceHealth(row: SourceHealthRow): Promise<void>;
  sourceHealth(): Promise<SourceHealthRow[]>;
  upsertIndicators(rows: readonly IndicatorRow[]): Promise<void>;
  /** The latest two observations of each indicator for each region on the path. */
  indicators(regionPath: readonly number[]): Promise<IndicatorRow[]>;
}

export interface Repositories {
  citizens: CitizenRepository;
  sentiment: SentimentRepository;
  rti: RtiRepository;
  catalogue: CatalogueRepository;
  forum: ForumRepository;
  documents: DocumentRepository;
  ready(): Promise<void>;
  close(): Promise<void>;
}
