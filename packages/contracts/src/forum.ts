/**
 * The discussion forum, local geography, public documents and cohort insights.
 *
 * Same rule as schemas.ts: these Zod schemas are both the runtime validation and the static types on
 * every side of the wire.
 */
import { z } from 'zod';
import { DOCUMENT_KINDS, NEEDS, PROVENANCE_KINDS, REGION_KINDS } from './enums.ts';
import {
  demographicsSchema,
  isoDate,
  isoDateTime,
  regionId,
  topicId,
  uuid,
  verificationTierSchema,
} from './schemas.ts';

// ─────────────────────────────── Where people are ───────────────────────────────

/**
 * How a citizen's home region is known. `declared`: they picked it. `device`: they picked it after
 * their device's location resolved inside it. Neither is proof — a location can be spoofed and people
 * comment from the office — but `device` is a stronger signal than a dropdown, and is shown as such.
 * Tier-3 verification (an attested address) remains the strong form.
 */
export const REGION_BASES = ['declared', 'device'] as const;
export type RegionBasis = (typeof REGION_BASES)[number];

/** Coordinates are coarsened to 3 decimals (~110 m) in the client before they are sent. */
export const resolveLocationRequest = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type ResolveLocationRequest = z.infer<typeof resolveLocationRequest>;

export const resolvedRegionSchema = z.object({
  id: regionId,
  key: z.string(),
  name: z.string(),
  kind: z.enum(REGION_KINDS),
  path: z.array(regionId),
  /** Names of the path, root first, for "Khairatabad · Greater Hyderabad · Telangana". */
  path_names: z.array(z.string()),
});
export type ResolvedRegion = z.infer<typeof resolvedRegionSchema>;

export const resolveLocationResponse = z.object({
  region: resolvedRegionSchema.nullable(),
  /**
   * Short-lived proof that the device resolved inside `region`. Sent back with PATCH /v1/me to mark
   * the home region `device`-confirmed; carries the region, never the coordinate.
   */
  attestation: z.string().nullable(),
  /** Why `region` is null: no boundary data for this area yet, or the point is outside India. */
  unresolved_reason: z.enum(['unmapped', 'outside_india']).nullable(),
  attribution: z.string(),
});
export type ResolveLocationResponse = z.infer<typeof resolveLocationResponse>;

// ─────────────────────────────── Comments ───────────────────────────────

export const COMMENT_MAX_CHARS = 2000;

/**
 * `pending` exists only between the API accepting a comment and the worker publishing it (seconds).
 * `held`: published to no one until a moderator looks. `rejected`: failed an automatic check.
 * `removed`: taken down after review. `deleted`: withdrawn by its author, or erased with their account.
 */
export const COMMENT_STATES = [
  'pending',
  'published',
  'held',
  'rejected',
  'removed',
  'deleted',
] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

export const REPORT_REASONS = [
  'abuse',
  'hate',
  'threat',
  'spam',
  'personal_info',
  'misinformation',
  'off_topic',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const COMMENT_SORTS = ['top', 'new'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

export const SENTIMENT_LABELS = ['negative', 'neutral', 'positive'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

export const postCommentRequest = z.object({
  body: z.string().trim().min(3).max(COMMENT_MAX_CHARS),
  parent_id: uuid.nullable().default(null),
});
export type PostCommentRequest = z.infer<typeof postCommentRequest>;

export const commentAnalysisSchema = z.object({
  sentiment: z.enum(SENTIMENT_LABELS),
  needs: z.array(z.enum(NEEDS)),
  suggestion: z.boolean(),
  /** `nb-lr-…` for the in-house model, or the large model's id when it was escalated. */
  model: z.string(),
});
export type CommentAnalysis = z.infer<typeof commentAnalysisSchema>;

export const commentViewSchema = z.object({
  id: uuid,
  topic_id: topicId,
  parent_id: uuid.nullable(),
  /** Per-topic handle ("Citizen 7F3A2"): stable within a topic, unlinkable across topics. */
  handle: z.string(),
  body: z.string(),
  language: z.string(),
  /** Where the author lives, one level below the topic's jurisdiction ("Khairatabad" on a GHMC topic). */
  area: z.string().nullable(),
  /** The author's home region was confirmed by device location, not only declared. */
  located: z.boolean(),
  verification_tier: verificationTierSchema,
  analysis: commentAnalysisSchema.nullable(),
  upvotes: z.number().int().nonnegative(),
  reply_count: z.number().int().nonnegative(),
  created_at: isoDateTime,
  /** Only on the author's own view of their comments. */
  state: z.enum(COMMENT_STATES).optional(),
  /** Whether the viewer has upvoted it; only on authenticated reads. */
  upvoted: z.boolean().optional(),
});
export type CommentView = z.infer<typeof commentViewSchema>;

export const postCommentResponse = z.object({
  comment_id: uuid,
  state: z.literal('pending'),
  handle: z.string(),
});

export const reportCommentRequest = z.object({ reason: z.enum(REPORT_REASONS) });

/**
 * What goes on the log for a comment. Like the sentiment event it carries `citizen_id`, because the
 * worker writes the author's own index on the citizen's shard; the long-lived stores never see it.
 */
export const commentEventSchema = z.object({
  comment_id: uuid,
  citizen_id: uuid,
  topic_id: topicId,
  parent_id: uuid.nullable(),
  occurred_at: isoDateTime,
  body: z.string().max(COMMENT_MAX_CHARS),
  pseudonym: z.string().length(32),
  handle: z.string(),
  region_path: z.array(regionId).min(1).max(5),
  area_region_id: regionId.nullable(),
  area: z.string().nullable(),
  region_basis: z.enum(REGION_BASES),
  verification_tier: verificationTierSchema,
  demographics: demographicsSchema,
});
export type CommentEvent = z.infer<typeof commentEventSchema>;

/**
 * The analytics projection of a comment: what it says about needs and mood, and who (in bands) said
 * it — with no body, no comment id, no pseudonym, and the time coarsened to the hour, so an analytics
 * row cannot be joined back to the public comment it came from.
 *
 * `dedupe_key` is a keyed hash of the comment id: stable across redelivery, useless for finding the
 * comment. `author_key` is a keyed hash of the per-topic pseudonym, so a cohort can be k-gated on
 * distinct voices rather than comments — one person posting thirty times is one voice — while staying
 * per-topic like the pseudonym it comes from, and unjoinable to the public handle without the key.
 */
export const commentAnalyticsEventSchema = z.object({
  dedupe_key: z.string().length(32),
  author_key: z.string().length(32),
  hour: isoDateTime,
  topic_id: topicId,
  region_path: z.array(regionId).min(1).max(5),
  verification_tier: verificationTierSchema,
  demographics: demographicsSchema,
  sentiment: z.enum(SENTIMENT_LABELS),
  needs: z.array(z.enum(NEEDS)),
  suggestion: z.boolean(),
  language: z.string(),
});
export type CommentAnalyticsEvent = z.infer<typeof commentAnalyticsEventSchema>;

// ─────────────────────────────── What the public thinks ───────────────────────────────

export const digestSchema = z.object({
  topic_id: topicId,
  what_people_think: z.string(),
  main_concerns: z.array(z.string()),
  what_needs_to_be_done: z.array(
    z.object({ action: z.string(), support: z.enum(['many', 'some', 'few']) }),
  ),
  overall_tone: z.enum(['mostly_negative', 'mixed', 'mostly_positive', 'neutral']),
  sentiment: z.object({ negative: z.number(), neutral: z.number(), positive: z.number() }),
  needs: z.array(z.object({ need: z.enum(NEEDS), share: z.number() })),
  based_on_comments: z.number().int().nonnegative(),
  /** `claude`: written by the large model from the comments. `extractive`: assembled from the model's labels and the most-upvoted suggestions, no generation. */
  method: z.enum(['claude', 'extractive']),
  model: z.string().nullable(),
  generated_at: isoDateTime,
});
export type Digest = z.infer<typeof digestSchema>;

/** A digest is not shown until a topic has this many published comments: fewer is an anecdote. */
export const DIGEST_MIN_COMMENTS = 10;

export const raiseIssueRequest = z.object({
  title: z.string().trim().min(10).max(140),
  details: z.string().trim().max(COMMENT_MAX_CHARS).default(''),
  /** How far up their own ancestry the issue reaches: their ward, or their whole city. */
  scope: z.enum(['ward', 'city', 'district', 'state']),
});
export type RaiseIssueRequest = z.infer<typeof raiseIssueRequest>;

export const trendingItemSchema = z.object({
  topic_id: topicId,
  title: z.string(),
  kind: z.string(),
  jurisdiction_region_id: regionId,
  jurisdiction_name: z.string().nullable(),
  score: z.number(),
  comments_24h: z.number().int().nonnegative(),
});
export type TrendingItem = z.infer<typeof trendingItemSchema>;

// ─────────────────────────────── Documents, jobs, indicators ───────────────────────────────

export const documentViewSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(DOCUMENT_KINDS),
  subject: z.enum(['project', 'scheme']).nullable(),
  title: z.string(),
  url: z.string().url(),
  published_on: isoDate.nullable(),
  snippet: z.string().nullable(),
  go_number: z.string().nullable(),
  department: z.string().nullable(),
  amount_rupees: z.number().nullable(),
  vacancies: z.number().int().nullable(),
  closing_on: isoDate.nullable(),
  jurisdiction_region_id: regionId,
  primary_region_id: regionId.nullable(),
  primary_region_name: z.string().nullable(),
  geo_confidence: z.number(),
  provenance: z.enum(PROVENANCE_KINDS),
  source_id: z.string(),
  source_name: z.string(),
  topic_id: topicId.nullable(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

export const jobsSummarySchema = z.object({
  as_of: isoDate,
  open_notifications: z.number().int().nonnegative(),
  /** Sum of vacancies where a notification states them. */
  stated_vacancies: z.number().int().nonnegative(),
  /** Open notifications that do not state a number — why `stated_vacancies` is a lower bound. */
  without_count: z.number().int().nonnegative(),
  closing_within_7_days: z.number().int().nonnegative(),
  by_jurisdiction: z.array(
    z.object({
      region_id: regionId,
      name: z.string(),
      notifications: z.number().int(),
      vacancies: z.number().int(),
    }),
  ),
  items: z.array(documentViewSchema),
  provenance: z.array(z.enum(PROVENANCE_KINDS)),
});
export type JobsSummary = z.infer<typeof jobsSummarySchema>;

export const INDICATOR_CATEGORIES = ['public_finance', 'economy', 'jobs', 'agriculture'] as const;

export const indicatorSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: z.enum(INDICATOR_CATEGORIES),
  unit: z.string(),
  region_id: regionId,
  region_name: z.string().nullable(),
  period: z.string(),
  value: z.number(),
  previous: z.object({ period: z.string(), value: z.number() }).nullable(),
  source_name: z.string(),
  source_url: z.string().url(),
  provenance: z.enum(PROVENANCE_KINDS),
  note: z.string().nullable(),
});
export type Indicator = z.infer<typeof indicatorSchema>;

// ─────────────────────────────── Cohort insights ───────────────────────────────

/**
 * Named cohorts, defined in demographic bands. "Youth" is 18–34 because the bands are 18–24 and
 * 25–34; India's National Youth Policy says 15–29, and the response says which definition it used.
 * "Job seekers" is the PLFS sense of unemployed: without work and looking for it, self-reported.
 */
export const COHORTS = {
  youth: { label: 'Youth (18–34)', filter: { age_band: ['18-24', '25-34'] } },
  farmers: { label: 'Farmers', filter: { occupation_band: ['agriculture'] } },
  women: { label: 'Women', filter: { gender: ['female'] } },
  students: { label: 'Students', filter: { occupation_band: ['student'] } },
  jobseekers: { label: 'Job seekers', filter: { employment_status: ['unemployed_seeking'] } },
} as const;
export type CohortId = keyof typeof COHORTS;
export const COHORT_IDS = Object.keys(COHORTS) as CohortId[];

export const cohortInsightSchema = z.object({
  cohort: z.string(),
  label: z.string(),
  definition: z.string(),
  region_id: regionId,
  window_days: z.number().int().positive(),
  /** Null when the cohort in this region is below the k-anonymity threshold. */
  participants: z.number().int().nonnegative().nullable(),
  suppressed: z.boolean(),
  needs: z.array(
    z.object({
      need: z.enum(NEEDS),
      label: z.string(),
      share: z.number(),
      comments: z.number().int(),
    }),
  ),
  sentiment: z
    .object({ negative: z.number(), neutral: z.number(), positive: z.number() })
    .nullable(),
  comparison: z
    .array(z.object({ need: z.enum(NEEDS), cohort_share: z.number(), everyone_share: z.number() }))
    .nullable(),
  top_topics: z.array(
    z.object({ topic_id: topicId, title: z.string(), comments: z.number().int() }),
  ),
  method: z.string(),
});
export type CohortInsight = z.infer<typeof cohortInsightSchema>;
