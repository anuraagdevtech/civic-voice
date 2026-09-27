import type { Locale, Mood, RtiState, VerificationTier } from '@civic-voice/contracts';
import {
  decodeDemographics,
  decodeReasonCode,
  encodeDemographics,
  encodeReasonCode,
} from '../codec.ts';
import { vshardFor } from '../shard.ts';
import type { Queryable, ShardRouter } from '../router.ts';
import { PgDocumentRepository, PgForumRepository } from './pg-forum.ts';
import type {
  AuthorityRow,
  BudgetLineRow,
  CatalogueRepository,
  CitizenRepository,
  CitizenRow,
  CreateCitizenInput,
  CurrentSentimentRow,
  NewTopic,
  QuarantineRow,
  RegionRow,
  Repositories,
  RtiRepository,
  RtiRequestRow,
  SentimentRepository,
  TopicRow,
  UpsertSentimentResult,
} from './ports.ts';

/** Postgres row shapes are `unknown`-typed at the driver boundary; narrow once, here. */
type Row = Record<string, unknown>;

const asDate = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v);
const asTimestamp = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const asNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toCitizen(row: Row): CitizenRow {
  return {
    id: String(row['id']),
    region_id: Number(row['region_id']),
    region_path: (row['region_path'] as (number | string)[]).map(Number),
    verification_tier: Number(row['verification_tier']) as VerificationTier,
    locale: String(row['locale']) as Locale,
    demographics: decodeDemographics({
      age_band: asNumber(row['age_band']),
      gender: asNumber(row['gender']),
      urbanity: asNumber(row['urbanity']),
      income_band: asNumber(row['income_band']),
      education_band: asNumber(row['education_band']),
      occupation_band: asNumber(row['occupation_band']),
      employment_status: asNumber(row['employment_status']),
    }),
    region_basis: Number(row['region_basis'] ?? 0) === 1 ? 'device' : 'declared',
    created_at: asTimestamp(row['created_at']),
    erased_at:
      row['erased_at'] === null || row['erased_at'] === undefined
        ? null
        : asTimestamp(row['erased_at']),
  };
}

const CITIZEN_COLUMNS = `id, region_id, region_path, verification_tier, locale,
  age_band, gender, urbanity, income_band, education_band, occupation_band, employment_status,
  region_basis,
  created_at, erased_at`;

export class PgCitizenRepository implements CitizenRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async create(input: CreateCitizenInput): Promise<CitizenRow> {
    const d = encodeDemographics(input.demographics);
    return this.router.withCitizenShard(input.id, async (db) => {
      const { rows } = await db.query<Row>(
        `INSERT INTO civic_shard.citizen
           (id, vshard, region_id, region_path, verification_tier, locale,
            age_band, gender, urbanity, income_band, education_band, occupation_band, region_basis,
            employment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING ${CITIZEN_COLUMNS}`,
        [
          input.id,
          vshardFor(input.id),
          input.region_id,
          input.region_path,
          input.verification_tier ?? 0,
          input.locale,
          d.age_band,
          d.gender,
          d.urbanity,
          d.income_band,
          d.education_band,
          d.occupation_band,
          input.region_basis === 'device' ? 1 : 0,
          d.employment_status,
        ],
      );
      return toCitizen(rows[0] as Row);
    });
  }

  async findById(citizenId: string): Promise<CitizenRow | null> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT ${CITIZEN_COLUMNS} FROM civic_shard.citizen WHERE id = $1`,
        [citizenId],
      );
      return rows[0] ? toCitizen(rows[0]) : null;
    });
  }

  async updateProfile(
    citizenId: string,
    patch: {
      demographics?: import('@civic-voice/contracts').Demographics;
      region_id?: number;
      region_path?: number[];
      region_basis?: import('@civic-voice/contracts').RegionBasis;
      locale?: Locale;
    },
  ): Promise<CitizenRow | null> {
    const d = patch.demographics ? encodeDemographics(patch.demographics) : null;
    // A new home region is `declared` unless this very patch says otherwise: a device confirmation of
    // the old region says nothing about the new one.
    const basis =
      patch.region_id !== undefined || patch.region_basis !== undefined
        ? patch.region_basis === 'device'
          ? 1
          : 0
        : null;
    return this.router.withCitizenShard(citizenId, async (db) => {
      // COALESCE keeps this a single statement: a partial patch leaves untouched columns alone
      // without the handler having to assemble dynamic SQL.
      const { rows } = await db.query<Row>(
        `UPDATE civic_shard.citizen SET
           region_id       = COALESCE($2, region_id),
           region_path     = COALESCE($3, region_path),
           locale          = COALESCE($4, locale),
           age_band        = CASE WHEN $5::boolean  THEN $6::smallint  ELSE age_band        END,
           gender          = CASE WHEN $5::boolean  THEN $7::smallint  ELSE gender          END,
           urbanity        = CASE WHEN $5::boolean  THEN $8::smallint  ELSE urbanity        END,
           income_band     = CASE WHEN $5::boolean  THEN $9::smallint  ELSE income_band     END,
           education_band  = CASE WHEN $5::boolean  THEN $10::smallint ELSE education_band  END,
           occupation_band = CASE WHEN $5::boolean  THEN $11::smallint ELSE occupation_band END,
           region_basis    = COALESCE($12::smallint, region_basis),
           employment_status = CASE WHEN $5::boolean THEN $13::smallint ELSE employment_status END,
           updated_at      = now()
         WHERE id = $1 AND erased_at IS NULL
         RETURNING ${CITIZEN_COLUMNS}`,
        [
          citizenId,
          patch.region_id ?? null,
          patch.region_path ?? null,
          patch.locale ?? null,
          d !== null,
          d?.age_band ?? null,
          d?.gender ?? null,
          d?.urbanity ?? null,
          d?.income_band ?? null,
          d?.education_band ?? null,
          d?.occupation_band ?? null,
          basis,
          d?.employment_status ?? null,
        ],
      );
      return rows[0] ? toCitizen(rows[0]) : null;
    });
  }

  async setVerificationTier(citizenId: string, tier: VerificationTier): Promise<CitizenRow | null> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `UPDATE civic_shard.citizen SET verification_tier = $2, updated_at = now()
         WHERE id = $1 AND erased_at IS NULL RETURNING ${CITIZEN_COLUMNS}`,
        [citizenId, tier],
      );
      return rows[0] ? toCitizen(rows[0]) : null;
    });
  }

  /**
   * Crypto-shredding (ADR-0004). Destroys the wrapped DEK and clears the demographic bands, then
   * tombstones the row. The row itself stays so shard accounting and aggregate counts remain
   * consistent; aggregates are not reversed, because they hold no personal data.
   */
  async erase(citizenId: string): Promise<boolean> {
    return this.router.withCitizenTransaction(citizenId, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE civic_shard.citizen SET
           dek_wrapped = NULL, age_band = NULL, gender = NULL, urbanity = NULL,
           income_band = NULL, education_band = NULL, occupation_band = NULL,
           employment_status = NULL,
           erased_at = now(), updated_at = now()
         WHERE id = $1 AND erased_at IS NULL`,
        [citizenId],
      );
      if ((rowCount ?? 0) === 0) return false;
      await db.query(`DELETE FROM civic_shard.sentiment_current WHERE citizen_id = $1`, [
        citizenId,
      ]);
      await db.query(`DELETE FROM civic_shard.follow WHERE citizen_id = $1`, [citizenId]);
      return true;
    });
  }
}

function toSentiment(row: Row): CurrentSentimentRow {
  return {
    citizen_id: String(row['citizen_id']),
    topic_id: Number(row['topic_id']),
    mood: Number(row['mood']) as Mood,
    intensity: Number(row['intensity']),
    reason_code: decodeReasonCode(Number(row['reason_code'])),
    event_id: String(row['event_id']),
    updated_at: asTimestamp(row['updated_at']),
  };
}

export class PgSentimentRepository implements SentimentRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async getCurrent(citizenId: string, topicId: number): Promise<CurrentSentimentRow | null> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_shard.sentiment_current WHERE citizen_id = $1 AND topic_id = $2`,
        [citizenId, topicId],
      );
      return rows[0] ? toSentiment(rows[0]) : null;
    });
  }

  async listCurrent(
    citizenId: string,
    opts: { limit?: number; topicIds?: readonly number[] } = {},
  ): Promise<CurrentSentimentRow[]> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      if (opts.topicIds && opts.topicIds.length > 0) {
        const { rows } = await db.query<Row>(
          `SELECT * FROM civic_shard.sentiment_current
           WHERE citizen_id = $1 AND topic_id = ANY($2::bigint[])`,
          [citizenId, [...opts.topicIds]],
        );
        return rows.map(toSentiment);
      }
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_shard.sentiment_current
         WHERE citizen_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [citizenId, Math.min(opts.limit ?? 50, 200)],
      );
      return rows.map(toSentiment);
    });
  }

  /**
   * Upsert the standing opinion and report what it replaced.
   *
   * The `previous` value is the whole point: it is what lets the aggregator emit a compensating `−1`
   * for the mood being left alongside the `+1` for the mood being adopted. Returning it from the
   * same statement (via the CTE below) keeps it atomic — a read-then-write would let two concurrent
   * events for one citizen each see the same `previous` and both emit the same retraction.
   *
   * `WHERE event_id <> excluded.event_id` makes a redelivered event a no-op, which is what
   * at-least-once delivery requires (docs/ARCHITECTURE.md §6).
   */
  async upsert(
    citizenId: string,
    row: Omit<CurrentSentimentRow, 'citizen_id' | 'updated_at'>,
  ): Promise<UpsertSentimentResult> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `WITH before AS (
           SELECT * FROM civic_shard.sentiment_current
           WHERE citizen_id = $1 AND topic_id = $2
           FOR UPDATE
         ), upserted AS (
           INSERT INTO civic_shard.sentiment_current
             (citizen_id, topic_id, mood, intensity, reason_code, event_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (citizen_id, topic_id) DO UPDATE SET
             mood = excluded.mood,
             intensity = excluded.intensity,
             reason_code = excluded.reason_code,
             event_id = excluded.event_id,
             updated_at = now()
           WHERE civic_shard.sentiment_current.event_id <> excluded.event_id
           RETURNING 1 AS changed
         )
         SELECT
           (SELECT count(*) FROM upserted) AS changed,
           b.citizen_id, b.topic_id, b.mood, b.intensity, b.reason_code, b.event_id, b.updated_at
         FROM (SELECT 1) AS one
         LEFT JOIN before b ON true`,
        [
          citizenId,
          row.topic_id,
          row.mood,
          row.intensity,
          encodeReasonCode(row.reason_code),
          row.event_id,
        ],
      );
      const result = rows[0] as Row | undefined;
      const applied = Number(result?.['changed'] ?? 0) > 0;
      const previous =
        result && result['citizen_id'] !== null && result['citizen_id'] !== undefined
          ? toSentiment(result)
          : null;
      // A redelivery of the event already stored: nothing changed and nothing was replaced.
      return { previous: applied ? previous : null, applied };
    });
  }

  async deleteForCitizen(citizenId: string): Promise<number> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rowCount } = await db.query(
        `DELETE FROM civic_shard.sentiment_current WHERE citizen_id = $1`,
        [citizenId],
      );
      return rowCount ?? 0;
    });
  }
}

const RTI_COLUMNS = `id, citizen_id, authority_id, topic_id, subject, track, state, filed_at,
  acknowledged_at, responded_at, first_appeal_at, fa_responded_at, fa_extended, second_appeal_at,
  created_at, updated_at`;

function toRti(row: Row): RtiRequestRow {
  return {
    id: String(row['id']),
    citizen_id: String(row['citizen_id']),
    authority_id: Number(row['authority_id']),
    topic_id:
      row['topic_id'] === null || row['topic_id'] === undefined ? null : Number(row['topic_id']),
    subject: String(row['subject']),
    track: String(row['track']) as RtiRequestRow['track'],
    state: String(row['state']) as RtiState,
    filed_at: asDate(row['filed_at']),
    acknowledged_at: asDate(row['acknowledged_at']),
    responded_at: asDate(row['responded_at']),
    first_appeal_at: asDate(row['first_appeal_at']),
    fa_responded_at: asDate(row['fa_responded_at']),
    fa_extended: Boolean(row['fa_extended']),
    second_appeal_at: asDate(row['second_appeal_at']),
    created_at: asTimestamp(row['created_at']),
    updated_at: asTimestamp(row['updated_at']),
  };
}

/** Which date column a transition stamps. Keeping this next to the SQL stops the two drifting. */
const STATE_DATE_COLUMN: Partial<Record<RtiState, string>> = {
  filed: 'filed_at',
  acknowledged: 'acknowledged_at',
  responded: 'responded_at',
  first_appeal: 'first_appeal_at',
  fa_responded: 'fa_responded_at',
  second_appeal: 'second_appeal_at',
};

export class PgRtiRepository implements RtiRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async create(
    input: Omit<RtiRequestRow, 'created_at' | 'updated_at' | 'state'> & { state?: RtiState },
  ): Promise<RtiRequestRow> {
    return this.router.withCitizenShard(input.citizen_id, async (db) => {
      const { rows } = await db.query<Row>(
        `INSERT INTO civic_shard.rti_request
           (id, citizen_id, authority_id, topic_id, subject, track, state, filed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${RTI_COLUMNS}`,
        [
          input.id,
          input.citizen_id,
          input.authority_id,
          input.topic_id,
          input.subject,
          input.track,
          input.state ?? (input.filed_at ? 'filed' : 'draft'),
          input.filed_at,
        ],
      );
      return toRti(rows[0] as Row);
    });
  }

  async findById(citizenId: string, id: string): Promise<RtiRequestRow | null> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      // Scoped by citizen_id as well as id: one citizen must not be able to read another's filing by
      // guessing an id, and the shard router would route the lookup to the wrong shard anyway.
      const { rows } = await db.query<Row>(
        `SELECT ${RTI_COLUMNS} FROM civic_shard.rti_request WHERE citizen_id = $1 AND id = $2`,
        [citizenId, id],
      );
      return rows[0] ? toRti(rows[0]) : null;
    });
  }

  async listByCitizen(citizenId: string, opts: { limit?: number } = {}): Promise<RtiRequestRow[]> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT ${RTI_COLUMNS} FROM civic_shard.rti_request
         WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [citizenId, Math.min(opts.limit ?? 50, 200)],
      );
      return rows.map(toRti);
    });
  }

  async transition(
    citizenId: string,
    id: string,
    to: RtiState,
    on: string | null,
  ): Promise<RtiRequestRow | null> {
    const dateColumn = STATE_DATE_COLUMN[to];
    return this.router.withCitizenShard(citizenId, async (db) => {
      // The column name comes from a closed map keyed by a validated enum, never from user input.
      const setDate = dateColumn
        ? `, ${dateColumn} = COALESCE($4::date, ${dateColumn}, CURRENT_DATE)`
        : '';
      const { rows } = await db.query<Row>(
        `UPDATE civic_shard.rti_request
         SET state = $3, updated_at = now()${setDate}
         WHERE citizen_id = $1 AND id = $2
         RETURNING ${RTI_COLUMNS}`,
        dateColumn ? [citizenId, id, to, on] : [citizenId, id, to],
      );
      return rows[0] ? toRti(rows[0]) : null;
    });
  }
}

function toRegion(row: Row): RegionRow {
  return {
    id: Number(row['id']),
    parent_id:
      row['parent_id'] === null || row['parent_id'] === undefined ? null : Number(row['parent_id']),
    kind: String(row['kind']),
    path: (row['path'] as (number | string)[]).map(Number),
    name: String(row['name']),
    names: (row['names'] ?? {}) as Record<string, string>,
    population: asNumber(row['population']),
    codes: (row['codes'] ?? {}) as Record<string, string>,
  };
}

function toTopic(row: Row): TopicRow {
  return {
    id: Number(row['id']),
    kind: String(row['kind']),
    status: String(row['status']),
    jurisdiction_region_id: Number(row['jurisdiction_region_id']),
    authority_id: asNumber(row['authority_id']),
    scheme_id: asNumber(row['scheme_id']),
    title: String(row['title']),
    summary:
      row['summary'] === null || row['summary'] === undefined ? null : String(row['summary']),
    effective_from: asDate(row['effective_from']),
    source_refs: (row['source_refs'] ?? []) as string[],
  };
}

function toBudgetLine(row: Row): BudgetLineRow {
  return {
    id: Number(row['id']),
    fy: String(row['fy']),
    scheme_id: Number(row['scheme_id']),
    scheme_name: String(row['scheme_name']),
    region_id: Number(row['region_id']),
    region_name: row['region_name'] === undefined ? null : String(row['region_name']),
    level: String(row['level']) as BudgetLineRow['level'],
    provenance: (row['provenance'] ?? 'official') as BudgetLineRow['provenance'],
    allocated_be: asNumber(row['allocated_be']),
    revised_re: asNumber(row['revised_re']),
    released: asNumber(row['released']),
    utilised: asNumber(row['utilised']),
    source_refs: (row['source_refs'] ?? []) as string[],
  };
}

export class PgCatalogueRepository implements CatalogueRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async getRegion(regionId: number): Promise<RegionRow | null> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(`SELECT * FROM civic_catalogue.region WHERE id = $1`, [
        regionId,
      ]);
      return rows[0] ? toRegion(rows[0]) : null;
    });
  }

  async regionByKey(key: string): Promise<RegionRow | null> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.region WHERE codes ->> 'key' = $1 AND codes ? 'key'`,
        [key],
      );
      return rows[0] ? toRegion(rows[0]) : null;
    });
  }

  async getRegions(regionIds: readonly number[]): Promise<RegionRow[]> {
    if (regionIds.length === 0) return [];
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.region WHERE id = ANY($1::bigint[])`,
        [[...regionIds]],
      );
      return rows.map(toRegion);
    });
  }

  async childRegions(parentId: number): Promise<RegionRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.region WHERE parent_id = $1 ORDER BY name`,
        [parentId],
      );
      return rows.map(toRegion);
    });
  }

  async getTopic(topicId: number): Promise<TopicRow | null> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(`SELECT * FROM civic_catalogue.topic WHERE id = $1`, [
        topicId,
      ]);
      return rows[0] ? toTopic(rows[0]) : null;
    });
  }

  async listTopics(opts: {
    regionId?: number;
    kind?: string;
    status?: string;
    limit?: number;
  }): Promise<TopicRow[]> {
    return this.router.catalogue(async (db) => {
      // "Topics that apply to me" is a path-containment test against the citizen's region: a topic
      // applies if its jurisdiction is one of that region's ancestors.
      const { rows } = await db.query<Row>(
        `SELECT t.* FROM civic_catalogue.topic t
         WHERE ($1::bigint IS NULL OR t.jurisdiction_region_id = ANY(
                  SELECT unnest(r.path) FROM civic_catalogue.region r WHERE r.id = $1))
           AND ($2::text IS NULL OR t.kind = $2)
           AND ($3::text IS NULL OR t.status = $3)
         ORDER BY t.effective_from DESC NULLS LAST, t.id DESC
         LIMIT $4`,
        [
          opts.regionId ?? null,
          opts.kind ?? null,
          opts.status ?? null,
          Math.min(opts.limit ?? 50, 200),
        ],
      );
      return rows.map(toTopic);
    });
  }

  async getTopics(topicIds: readonly number[]): Promise<TopicRow[]> {
    if (topicIds.length === 0) return [];
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.topic WHERE id = ANY($1::bigint[])`,
        [[...topicIds]],
      );
      const byId = new Map(rows.map((r) => [Number(r['id']), toTopic(r)]));
      return topicIds.map((id) => byId.get(id)).filter((t): t is TopicRow => t !== undefined);
    });
  }

  async createTopic(input: NewTopic): Promise<TopicRow> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `INSERT INTO civic_catalogue.topic
           (kind, status, jurisdiction_region_id, authority_id, scheme_id, title, summary,
            effective_from, source_refs)
         VALUES ($1, $9, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.kind,
          input.jurisdiction_region_id,
          input.authority_id ?? null,
          input.scheme_id ?? null,
          input.title,
          input.summary,
          input.effective_from,
          JSON.stringify(input.source_refs),
          input.status ?? 'active',
        ],
      );
      return toTopic(rows[0] as Row);
    });
  }

  async getAuthority(authorityId: number): Promise<AuthorityRow | null> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.authority WHERE id = $1`,
        [authorityId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row['id']),
        kind: String(row['kind']),
        name: String(row['name']),
        region_id: Number(row['region_id']),
        pio_contact: row['pio_contact'] === null ? null : String(row['pio_contact']),
        faa_contact: row['faa_contact'] === null ? null : String(row['faa_contact']),
      };
    });
  }

  async budgetLines(regionId: number, fy: string): Promise<BudgetLineRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT b.*, s.name AS scheme_name, r.name AS region_name
         FROM civic_catalogue.budget_line b
         JOIN civic_catalogue.scheme s ON s.id = b.scheme_id
         JOIN civic_catalogue.region r ON r.id = b.region_id
         WHERE b.region_id = $1 AND b.fy = $2
         ORDER BY b.allocated_be DESC NULLS LAST`,
        [regionId, fy],
      );
      return rows.map(toBudgetLine);
    });
  }

  async budgetLinesForPath(regionIds: readonly number[], fy: string): Promise<BudgetLineRow[]> {
    if (regionIds.length === 0) return [];
    return this.router.catalogue(async (db) => {
      // One query over the whole ancestor chain — at most five ids, so this stays an index scan.
      const { rows } = await db.query<Row>(
        `SELECT b.*, s.name AS scheme_name, r.name AS region_name, r.kind AS region_kind
         FROM civic_catalogue.budget_line b
         JOIN civic_catalogue.scheme s ON s.id = b.scheme_id
         JOIN civic_catalogue.region r ON r.id = b.region_id
         WHERE b.region_id = ANY($1::bigint[]) AND b.fy = $2
         ORDER BY array_length(r.path, 1) DESC, b.allocated_be DESC NULLS LAST`,
        [[...regionIds], fy],
      );
      return rows.map(toBudgetLine);
    });
  }

  async quarantinedBuckets(
    topicId: number,
    regionId: number,
    dim: number,
  ): Promise<QuarantineRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT topic_id, region_id, dim, bucket, reason FROM civic_catalogue.aggregate_quarantine
         WHERE topic_id = $1 AND region_id = $2 AND dim = $3`,
        [topicId, regionId, dim],
      );
      return rows.map((row) => ({
        topic_id: Number(row['topic_id']),
        region_id: Number(row['region_id']),
        dim: Number(row['dim']),
        bucket: String(row['bucket']),
        reason: String(row['reason']),
      }));
    });
  }

  async addQuarantine(row: QuarantineRow & { detail?: string }): Promise<void> {
    await this.router.catalogue(async (db) => {
      await db.query(
        `INSERT INTO civic_catalogue.aggregate_quarantine
           (topic_id, region_id, dim, bucket, reason, detail)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (topic_id, region_id, dim, bucket)
         DO UPDATE SET reason = excluded.reason, detail = excluded.detail`,
        [row.topic_id, row.region_id, row.dim, row.bucket, row.reason, row.detail ?? null],
      );
    });
  }
}

export function createPgRepositories(router: ShardRouter): Repositories {
  return {
    citizens: new PgCitizenRepository(router),
    sentiment: new PgSentimentRepository(router),
    rti: new PgRtiRepository(router),
    catalogue: new PgCatalogueRepository(router),
    forum: new PgForumRepository(router),
    documents: new PgDocumentRepository(router),
    ready: () => router.ping(),
    close: () => router.close(),
  };
}

export type { Queryable };
