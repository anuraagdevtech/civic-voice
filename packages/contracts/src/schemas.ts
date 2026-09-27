/**
 * The wire contract. These Zod schemas are the single source of both runtime validation (in the
 * API) and static types (in the API, the worker, the web app and the mobile app), so a breaking
 * change fails `pnpm typecheck` at the call site instead of in production (ADR-0006).
 */
import { z } from 'zod';
import {
  AGE_BANDS,
  AUTHORITY_KINDS,
  DEMOGRAPHIC_DIMENSIONS,
  EDUCATION_BANDS,
  EMPLOYMENT_STATUSES,
  GENDERS,
  INCOME_BANDS,
  LOCALES,
  MOOD_VALUES,
  OCCUPATION_BANDS,
  REASON_CODES,
  REGION_KINDS,
  RTI_STATES,
  RTI_TRACKS,
  TOPIC_KINDS,
  TOPIC_STATUSES,
  URBANITY,
} from './enums.ts';

export const uuid = z.string().uuid();
/** Region and topic ids are numeric for compactness: they ride on every event and rollup key. */
export const regionId = z.number().int().positive();
export const topicId = z.number().int().positive();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });

export const verificationTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const moodSchema = z.union([
  z.literal(-2),
  z.literal(-1),
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);

export const intensitySchema = z.number().int().min(1).max(5);

export const demographicDimensionSchema = z.enum(DEMOGRAPHIC_DIMENSIONS);

/**
 * A citizen's demographic bands. Every field is optional: a citizen may decline any of them and
 * still participate. A declined dimension simply contributes to the total but to no bucket.
 */
export const demographicsSchema = z.object({
  age_band: z.enum(AGE_BANDS).optional(),
  gender: z.enum(GENDERS).optional(),
  urbanity: z.enum(URBANITY).optional(),
  income_band: z.enum(INCOME_BANDS).optional(),
  education_band: z.enum(EDUCATION_BANDS).optional(),
  occupation_band: z.enum(OCCUPATION_BANDS).optional(),
  employment_status: z.enum(EMPLOYMENT_STATUSES).optional(),
});
export type Demographics = z.infer<typeof demographicsSchema>;

// ─────────────────────────────── Citizen ───────────────────────────────

export const citizenSchema = z.object({
  id: uuid,
  region_id: regionId,
  /** How the home region is known; see REGION_BASES in forum.ts. */
  region_basis: z.enum(['declared', 'device']).optional(),
  verification_tier: verificationTierSchema,
  locale: z.enum(LOCALES),
  demographics: demographicsSchema,
  created_at: isoDateTime,
});
export type Citizen = z.infer<typeof citizenSchema>;

export const registerCitizenRequest = z.object({
  region_id: regionId,
  locale: z.enum(LOCALES).default('en'),
  demographics: demographicsSchema.default({}),
  /** Play Integrity / App Attest token, or a proof-of-work token on web. Establishes tier 0. */
  attestation: z.string().min(16).max(8192).optional(),
  /** From POST /v1/geo/resolve: marks the home region as confirmed by device location. */
  location_attestation: z.string().max(512).optional(),
});
export type RegisterCitizenRequest = z.infer<typeof registerCitizenRequest>;

export const registerCitizenResponse = z.object({
  citizen: citizenSchema,
  access_token: z.string(),
  expires_in: z.number().int().positive(),
});

export const updateDemographicsRequest = z.object({
  /** Replaces the stored bands wholesale when present; absent leaves them as they are. */
  demographics: demographicsSchema.optional(),
  region_id: regionId.optional(),
  locale: z.enum(LOCALES).optional(),
  /** From POST /v1/geo/resolve: marks the new home region as confirmed by device location. */
  location_attestation: z.string().max(512).optional(),
});

// ─────────────────────────────── Regions & topics ───────────────────────────────

export const regionSchema = z.object({
  id: regionId,
  parent_id: regionId.nullable(),
  kind: z.enum(REGION_KINDS),
  /** Materialised ancestor path, root first, inclusive of self. */
  path: z.array(regionId),
  name: z.string(),
  population: z.number().int().nonnegative().nullable(),
  codes: z.record(z.string()).default({}),
});
export type Region = z.infer<typeof regionSchema>;

export const topicSchema = z.object({
  id: topicId,
  kind: z.enum(TOPIC_KINDS),
  status: z.enum(TOPIC_STATUSES),
  jurisdiction_region_id: regionId,
  authority_id: z.number().int().positive().nullable(),
  scheme_id: z.number().int().positive().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  effective_from: isoDate.nullable(),
  source_refs: z.array(z.string().url()).default([]),
});
export type Topic = z.infer<typeof topicSchema>;

export const authoritySchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(AUTHORITY_KINDS),
  name: z.string(),
  region_id: regionId,
  pio_contact: z.string().nullable(),
  faa_contact: z.string().nullable(),
});
export type Authority = z.infer<typeof authoritySchema>;

// ─────────────────────────────── Sentiment ───────────────────────────────

export const submitSentimentRequest = z.object({
  topic_id: topicId,
  mood: moodSchema,
  intensity: intensitySchema.default(3),
  reason_code: z.enum(REASON_CODES).default('no_reason'),
});
export type SubmitSentimentRequest = z.infer<typeof submitSentimentRequest>;

/** A histogram over the five mood values, indexed −2..+2 by position. */
export const moodHistogramSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type MoodHistogram = z.infer<typeof moodHistogramSchema>;

/**
 * One published bucket. `suppressed` is not an error: it means the cohort was smaller than k, and
 * the counts are withheld rather than rounded (see docs/PRIVACY.md §3).
 */
export const moodBucketSchema = z.object({
  bucket: z.string(),
  n: z.number().int().nonnegative(),
  mean_mood: z.number().nullable(),
  mean_intensity: z.number().nullable(),
  histogram: moodHistogramSchema.nullable(),
  suppressed: z.boolean(),
  suppression_reason: z.enum(['below_k', 'complementary', 'quarantined']).nullable(),
});
export type MoodBucket = z.infer<typeof moodBucketSchema>;

export const moodAggregateSchema = z.object({
  topic_id: topicId,
  region_id: regionId,
  dimension: demographicDimensionSchema.nullable(),
  tier: verificationTierSchema,
  total: moodBucketSchema,
  buckets: z.array(moodBucketSchema),
  /**
   * How stale this aggregate may be, in seconds. Surfaced rather than hidden: a stale number is
   * acceptable, a number that lies about being fresh is not (ADR-0003).
   */
  staleness_seconds: z.number().int().nonnegative(),
  /** Absolute difference between the T0 and T2+ mean mood. A brigading signal (docs/TRUST.md). */
  tier_divergence: z.number().nullable(),
  computed_at: isoDateTime,
});
export type MoodAggregate = z.infer<typeof moodAggregateSchema>;

export const submitSentimentResponse = z.object({
  accepted: z.boolean(),
  event_id: uuid,
  /** Present unless the counter store was degraded, in which case the write still succeeded. */
  aggregate: moodAggregateSchema.nullable(),
  replayed: z.boolean(),
});

export const mySentimentSchema = z.object({
  topic_id: topicId,
  mood: moodSchema,
  intensity: intensitySchema,
  reason_code: z.enum(REASON_CODES),
  updated_at: isoDateTime,
});
export type MySentiment = z.infer<typeof mySentimentSchema>;

export const moodQuery = z.object({
  region_id: regionId.optional(),
  dimension: demographicDimensionSchema.optional(),
  tier: verificationTierSchema.optional(),
  /** Inclusive day range for a series query; omitted means "current". */
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type MoodQuery = z.infer<typeof moodQuery>;

// ─────────────────────────────── RTI ───────────────────────────────

export const rtiRequestSchema = z.object({
  id: uuid,
  authority_id: z.number().int().positive(),
  topic_id: topicId.nullable(),
  subject: z.string().min(10).max(500),
  track: z.enum(RTI_TRACKS),
  state: z.enum(RTI_STATES),
  filed_at: isoDate.nullable(),
  acknowledged_at: isoDate.nullable(),
  responded_at: isoDate.nullable(),
  first_appeal_at: isoDate.nullable(),
  fa_responded_at: isoDate.nullable(),
  second_appeal_at: isoDate.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type RtiRequest = z.infer<typeof rtiRequestSchema>;

export const createRtiRequest = z.object({
  authority_id: z.number().int().positive(),
  topic_id: topicId.nullable().default(null),
  subject: z.string().min(10).max(500),
  track: z.enum(RTI_TRACKS).default('standard'),
  filed_at: isoDate.optional(),
});

export const rtiTransitionRequest = z.object({
  to: z.enum(RTI_STATES),
  on: isoDate.optional(),
  note: z.string().max(2000).optional(),
});

export const rtiDeadlineSchema = z.object({
  label: z.string(),
  due_on: isoDate,
  statute: z.string(),
  breached: z.boolean(),
  days_remaining: z.number().int(),
});
export type RtiDeadline = z.infer<typeof rtiDeadlineSchema>;

export const rtiNextActionSchema = z.object({
  action: z.enum([
    'await_response',
    'file_first_appeal',
    'await_fa_response',
    'file_second_appeal',
    'await_sic_response',
    'close',
    'none',
  ]),
  deadline: rtiDeadlineSchema.nullable(),
  explanation: z.string(),
});
export type RtiNextAction = z.infer<typeof rtiNextActionSchema>;

export const rtiRequestView = z.object({
  request: rtiRequestSchema,
  deadlines: z.array(rtiDeadlineSchema),
  next_action: rtiNextActionSchema,
});

export const authorityScorecardSchema = z.object({
  authority_id: z.number().int().positive(),
  window_days: z.number().int().positive(),
  requests: z.number().int().nonnegative(),
  on_time_rate: z.number().min(0).max(1).nullable(),
  median_response_days: z.number().nullable(),
  deemed_refusal_rate: z.number().min(0).max(1).nullable(),
  first_appeal_rate: z.number().min(0).max(1).nullable(),
  appeal_overturn_rate: z.number().min(0).max(1).nullable(),
  suppressed: z.boolean(),
});
export type AuthorityScorecard = z.infer<typeof authorityScorecardSchema>;

// ─────────────────────────────── Tax utilisation ───────────────────────────────

export const budgetLineSchema = z.object({
  id: z.number().int().positive(),
  fy: z.string().regex(/^\d{4}-\d{2}$/, 'expected FY as YYYY-YY'),
  scheme_id: z.number().int().positive(),
  scheme_name: z.string(),
  region_id: regionId,
  /** The region this figure was published against — the level it actually belongs to. */
  region_name: z.string().nullable().default(null),
  level: z.enum(['union', 'state', 'district', 'local']),
  allocated_be: z.number().nonnegative().nullable(),
  revised_re: z.number().nonnegative().nullable(),
  released: z.number().nonnegative().nullable(),
  utilised: z.number().nonnegative().nullable(),
  /** Every monetary figure carries provenance. No number appears without a source. */
  source_refs: z.array(z.string()).default([]),
  /** `sample` for development seed figures, badged wherever they appear. */
  provenance: z.enum(['official', 'news', 'sample']).default('official'),
});
export type BudgetLine = z.infer<typeof budgetLineSchema>;

export const taxUtilisationView = z.object({
  region_id: regionId,
  fy: z.string(),
  population: z.number().int().nonnegative().nullable(),
  lines: z.array(
    budgetLineSchema.extend({
      utilisation_rate: z.number().min(0).nullable(),
      per_capita_utilised: z.number().nonnegative().nullable(),
      /** Mean mood on the scheme's topic in this region, when one exists and passes the k-gate. */
      mean_mood: z.number().nullable(),
    }),
  ),
  totals: z.object({
    allocated_be: z.number().nonnegative(),
    utilised: z.number().nonnegative(),
    utilisation_rate: z.number().min(0).nullable(),
    per_capita_utilised: z.number().nonnegative().nullable(),
  }),
});
export type TaxUtilisationView = z.infer<typeof taxUtilisationView>;

// ─────────────────────────────── Errors & envelopes ───────────────────────────────

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'cooldown_active',
  'invalid_transition',
  'k_anonymity_suppressed',
  'degraded',
  'internal',
  /** A comment refused before it was accepted (personal information in it, say); `details` says why. */
  'content_rejected',
  /** A local question, and the caller does not live there. */
  'not_local',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorResponse = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
    retry_after_seconds: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export function paged<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}

// ─────────────────────────────── Internal event envelope ───────────────────────────────

/**
 * What goes on the event log.
 *
 * This carries `citizen_id`, and that is deliberate: the worker has to upsert `sentiment_current` on
 * the citizen's own shard to work out whether this submission *replaces* an earlier opinion, and it
 * cannot route to a shard it cannot identify. The log is short-lived (7 days) and access-controlled.
 *
 * The **analytics** event is a different type — `analyticsEventSchema` below — with `citizen_id`
 * removed. `stripIdentity()` is the only way to produce one, and `AnalyticsStore.insertEvents` accepts
 * only that type, so inserting identity into the long-lived, broadly-queryable store is not an
 * omission someone has to remember: it does not typecheck (docs/PRIVACY.md §6).
 *
 * The region path and demographic bands are denormalised onto the event so that every analytical
 * query is a single-table scan with no route back to identity.
 */
export const sentimentEventSchema = z.object({
  event_id: uuid,
  /** Present on the bus only. Never reaches ClickHouse — see `analyticsEventSchema`. */
  citizen_id: uuid,
  occurred_at: isoDateTime,
  topic_id: topicId,
  region_path: z.array(regionId).min(1).max(5),
  pseudonym: z.string().length(32),
  verification_tier: verificationTierSchema,
  demographics: demographicsSchema,
  mood: moodSchema,
  intensity: intensitySchema,
  reason_code: z.enum(REASON_CODES),
  /** +1 for a new or replacing opinion, −1 for the compensating retraction of a previous one. */
  delta: z.union([z.literal(1), z.literal(-1)]),
  /** Set on a replacement event so the consumer can emit the compensating pair atomically. */
  replaces: z
    .object({ mood: moodSchema, intensity: intensitySchema, reason_code: z.enum(REASON_CODES) })
    .nullable()
    .default(null),
});
export type SentimentEvent = z.infer<typeof sentimentEventSchema>;

/**
 * The analytics projection of an event: everything except the citizen's identity. The only route to
 * this type is `stripIdentity`, and the analytical store accepts nothing else.
 */
export const analyticsEventSchema = sentimentEventSchema.omit({ citizen_id: true });
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** Drop identity before anything long-lived sees the event. */
export function stripIdentity(event: SentimentEvent): AnalyticsEvent {
  const { citizen_id: _citizenId, ...rest } = event;
  return rest;
}

export const EVENT_TOPICS = {
  SENTIMENT: 'civic.sentiment.v1',
  RTI_TRANSITION: 'civic.rti.v1',
  MODERATION: 'civic.moderation.v1',
  COMMENT: 'civic.comment.v1',
} as const;
