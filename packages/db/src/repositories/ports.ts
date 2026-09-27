import type {
  Demographics,
  Locale,
  Mood,
  ReasonCode,
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
  level: string;
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

export interface CatalogueRepository {
  getRegion(regionId: number): Promise<RegionRow | null>;
  getRegions(regionIds: readonly number[]): Promise<RegionRow[]>;
  childRegions(parentId: number): Promise<RegionRow[]>;
  getTopic(topicId: number): Promise<TopicRow | null>;
  listTopics(opts: {
    regionId?: number;
    kind?: string;
    status?: string;
    limit?: number;
  }): Promise<TopicRow[]>;
  getAuthority(authorityId: number): Promise<AuthorityRow | null>;
  budgetLines(regionId: number, fy: string): Promise<BudgetLineRow[]>;
  quarantinedBuckets(topicId: number, regionId: number, dim: number): Promise<QuarantineRow[]>;
  addQuarantine(row: QuarantineRow & { detail?: string }): Promise<void>;
}

export interface Repositories {
  citizens: CitizenRepository;
  sentiment: SentimentRepository;
  rti: RtiRepository;
  catalogue: CatalogueRepository;
  ready(): Promise<void>;
  close(): Promise<void>;
}
