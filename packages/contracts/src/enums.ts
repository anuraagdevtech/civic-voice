/**
 * Closed vocabularies shared by every tier of the system.
 *
 * These are plain `as const` objects rather than TypeScript `enum`s on purpose: the codebase
 * runs directly under Node's type stripping (ADR-0006), which requires erasable syntax only.
 *
 * Demographics are deliberately *bands*, never values. A birth date or an exact income that was
 * never collected cannot leak, be subpoenaed, or be correlated (see docs/PRIVACY.md).
 */

export const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const GENDERS = ['female', 'male', 'other'] as const;
export type Gender = (typeof GENDERS)[number];

export const URBANITY = ['urban', 'rural'] as const;
export type Urbanity = (typeof URBANITY)[number];

/** Indexed to per-capita income deciles rather than absolute rupees, so bands survive inflation. */
export const INCOME_BANDS = [
  'lowest',
  'lower_middle',
  'middle',
  'upper_middle',
  'highest',
] as const;
export type IncomeBand = (typeof INCOME_BANDS)[number];

export const EDUCATION_BANDS = [
  'none_primary',
  'secondary',
  'higher_secondary',
  'graduate',
  'postgraduate',
] as const;
export type EducationBand = (typeof EDUCATION_BANDS)[number];

export const OCCUPATION_BANDS = [
  'agriculture',
  'informal_labour',
  'salaried_private',
  'government',
  'self_employed',
  'student',
  'homemaker',
  'retired_other',
] as const;
export type OccupationBand = (typeof OCCUPATION_BANDS)[number];

/**
 * Employment status, which occupation does not capture: a graduate in a private job and one who has
 * been looking for a year share an occupation band and nothing else. Coarse, after the activity
 * status of the Periodic Labour Force Survey — in regular work, in irregular or part-time work,
 * unemployed and looking, not in the labour force (studying, caring, retired).
 */
export const EMPLOYMENT_STATUSES = [
  'employed_regular',
  'employed_irregular',
  'unemployed_seeking',
  'not_in_labour_force',
] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/**
 * The seven demographic dimensions, in a fixed order. The index is part of the storage format
 * (`mood_rollup.dim`), where 0 is reserved for "total, undifferentiated" — so a new dimension is
 * appended, never inserted.
 *
 * Crossing these would be 28,800 combinations per (topic, region, day, tier). We maintain
 * marginals instead — 7 dimensions + 1 total — see ADR-0002.
 */
export const DEMOGRAPHIC_DIMENSIONS = [
  'age_band',
  'gender',
  'urbanity',
  'income_band',
  'education_band',
  'occupation_band',
  'employment_status',
] as const;
export type DemographicDimension = (typeof DEMOGRAPHIC_DIMENSIONS)[number];

export const DIMENSION_TOTAL = 0 as const;

/** Storage index for a dimension: 1-based, because 0 means "total". */
export function dimensionIndex(dim: DemographicDimension): number {
  return DEMOGRAPHIC_DIMENSIONS.indexOf(dim) + 1;
}

export function dimensionFromIndex(index: number): DemographicDimension | null {
  return DEMOGRAPHIC_DIMENSIONS[index - 1] ?? null;
}

/** The allowed bucket values for each dimension, keyed by dimension name. */
export const DIMENSION_BUCKETS = {
  age_band: AGE_BANDS,
  gender: GENDERS,
  urbanity: URBANITY,
  income_band: INCOME_BANDS,
  education_band: EDUCATION_BANDS,
  occupation_band: OCCUPATION_BANDS,
  employment_status: EMPLOYMENT_STATUSES,
} as const satisfies Record<DemographicDimension, readonly string[]>;

/**
 * Buckets by storage index, so a read path can enumerate every bucket a dimension can hold. That
 * matters for honesty in the output: an absent bucket must be published as zero, not omitted —
 * otherwise "nobody in this cohort answered" and "we failed to record this cohort" look identical.
 */
export const DIMENSION_BUCKETS_BY_INDEX: Record<number, readonly string[]> = {
  [DIMENSION_TOTAL]: ['all'],
  ...Object.fromEntries(DEMOGRAPHIC_DIMENSIONS.map((dim, i) => [i + 1, DIMENSION_BUCKETS[dim]])),
};

/**
 * Verification tiers. Participation is never blocked; it is labelled (ADR-0005).
 * The default public view counts T2 and above.
 */
export const VERIFICATION_TIERS = {
  ANONYMOUS: 0,
  PHONE: 1,
  IDENTITY: 2,
  IDENTITY_ADDRESS: 3,
} as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[keyof typeof VERIFICATION_TIERS];

export const DEFAULT_PUBLIC_TIER: VerificationTier = VERIFICATION_TIERS.IDENTITY;

/**
 * India's administrative hierarchy: country → state → district *or city* → constituency *or ward*.
 *
 * A `city` is a municipal corporation (Greater Hyderabad) — not a district, since it can span several,
 * and it is who answers for its wards' drains and roads. It sits at district depth, so the levels of
 * the tree are positions rather than kinds (ADR-0010).
 */
export const REGION_KINDS = [
  'country',
  'state',
  'district',
  'city',
  'constituency',
  'ward',
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

/**
 * Levels of a region's ancestor chain touched per event: the first four. Drives the capacity model in
 * docs/SCALING.md, and fixed at 4 whatever the kinds at those levels are.
 *
 * Level 4 is a constituency, or a ward of a city. A city ward (~50,000 people in Greater Hyderabad) is
 * large enough for demographic slices to clear the k-anonymity gate; a village ward below a
 * constituency (~1,000 people) would not be, which is why rollups stop at the fourth level and a
 * rural ward is stored (it attests where someone lives) but never aggregated on its own.
 */
export const ROLLUP_FANOUT = 4;

/**
 * `government_order` and `news` topics are created by the ingestor from discussable documents;
 * `local_issue` topics are raised by residents, scoped to their own ward or city.
 */
export const TOPIC_KINDS = [
  'policy',
  'decision',
  'scheme',
  'law',
  'budget_line',
  'project',
  'government_order',
  'news',
  'local_issue',
] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export const TOPIC_STATUSES = ['proposed', 'active', 'amended', 'lapsed', 'withdrawn'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/**
 * The mood scale. Stored as a signed integer so that a mean is meaningful and a change of
 * opinion is a pair of compensating deltas rather than a recount.
 */
export const MOODS = {
  ANGRY: -2,
  CONCERNED: -1,
  NEUTRAL: 0,
  HOPEFUL: 1,
  SATISFIED: 2,
} as const;
export type Mood = (typeof MOODS)[keyof typeof MOODS];
export const MOOD_VALUES = [-2, -1, 0, 1, 2] as const;

export const MOOD_LABELS: Record<Mood, string> = {
  [-2]: 'angry',
  [-1]: 'concerned',
  [0]: 'neutral',
  [1]: 'hopeful',
  [2]: 'satisfied',
};

/**
 * Why the citizen feels that way. A closed vocabulary rather than free text, because the ingest
 * path must stay a fixed-size append (docs/SCALING.md §10) and because free text is a
 * re-identification vector in a small cohort.
 */
export const REASON_CODES = [
  'unaware',
  'not_consulted',
  'poor_implementation',
  'corruption_suspected',
  'benefits_me',
  'benefits_community',
  'too_costly',
  'wrong_priority',
  'good_intent_poor_delivery',
  'no_reason',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** RTI Act 2005 request lifecycle. Transitions are validated in @civic-voice/core. */
export const RTI_STATES = [
  'draft',
  'filed',
  'acknowledged',
  'responded',
  'deemed_refused',
  'satisfied',
  'first_appeal',
  'fa_responded',
  'second_appeal',
  'sic_responded',
  'closed',
  'withdrawn',
] as const;
export type RtiState = (typeof RTI_STATES)[number];

/** Which statutory response window applies to a request (RTI Act §7(1), §6(3), §11). */
export const RTI_TRACKS = ['standard', 'life_liberty', 'transferred', 'third_party'] as const;
export type RtiTrack = (typeof RTI_TRACKS)[number];

export const AUTHORITY_KINDS = [
  'union_ministry',
  'state_department',
  'psu',
  'municipal_body',
  'panchayat',
  'regulator',
  'court_registry',
  'other',
] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

/** The 22 scheduled languages plus English. */
export const LOCALES = [
  'en',
  'hi',
  'bn',
  'mr',
  'te',
  'ta',
  'gu',
  'ur',
  'kn',
  'or',
  'ml',
  'pa',
  'as',
  'mai',
  'sat',
  'ks',
  'ne',
  'sd',
  'kok',
  'doi',
  'mni',
  'brx',
  'sa',
] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * What an ingested public document is. The distinction matters for what happens next: a policy GO
 * becomes a discussion topic, a routine transfer order does not; a job notification feeds the jobs
 * board; news is linked and summarised, never republished.
 */
export const DOCUMENT_KINDS = [
  'government_order',
  'gazette_notification',
  'press_release',
  'project',
  'scheme',
  'tender',
  'job_notification',
  'news',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Where a figure or document came from. `sample` marks development seed data so it can never be
 * mistaken for an official statistic — the UI badges it on every figure.
 */
export const PROVENANCE_KINDS = ['official', 'news', 'sample'] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/**
 * What people say they need, in a closed taxonomy so that "what do farmers need" is a count, not a
 * reading of free text. Assigned to comments by the NLP model (packages/nlp), never by the author.
 */
export const NEEDS = [
  'employment',
  'education',
  'health',
  'agriculture',
  'water',
  'roads_transport',
  'housing',
  'electricity',
  'sanitation',
  'safety',
  'corruption',
  'prices',
  'welfare',
  'environment',
] as const;
export type Need = (typeof NEEDS)[number];

export const NEED_LABELS: Record<Need, string> = {
  employment: 'Jobs & employment',
  education: 'Education & exams',
  health: 'Health care',
  agriculture: 'Farming & crop prices',
  water: 'Drinking water',
  roads_transport: 'Roads & transport',
  housing: 'Housing',
  electricity: 'Electricity',
  sanitation: 'Drainage, garbage & flooding',
  safety: 'Safety & policing',
  corruption: 'Corruption',
  prices: 'Prices & cost of living',
  welfare: 'Pensions, ration & welfare',
  environment: 'Environment & pollution',
};
