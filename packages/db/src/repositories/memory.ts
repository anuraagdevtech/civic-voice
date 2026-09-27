import type {
  Demographics,
  Locale,
  RegionBasis,
  RtiState,
  VerificationTier,
} from '@civic-voice/contracts';
import { MemoryDocumentRepository, MemoryForumRepository } from './memory-forum.ts';
import type {
  AuthorityRow,
  BudgetLineRow,
  FiscalLineRow,
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

/**
 * In-memory repositories.
 *
 * These let the API and worker be exercised end to end in a unit test with no Postgres running
 * (ADR-0006). They implement the same semantics the SQL does — including the ones that are easy to
 * get wrong and that the tests specifically check: `upsert` returning the replaced value, a
 * redelivered event being a no-op, erase being a tombstone rather than a delete, and reads being
 * scoped by citizen so one citizen cannot fetch another's row by guessing an id.
 *
 * Both implementations are held to the one conformance suite in `test/repositories.contract.ts`.
 */

const nowIso = () => new Date().toISOString();

export class MemoryCitizenRepository implements CitizenRepository {
  readonly rows = new Map<string, CitizenRow>();
  /**
   * Erasure cascade. The SQL version clears `sentiment_current` and `follow` inside the same
   * transaction as the tombstone; this hook is how the in-memory version matches that, wired by
   * `createMemoryRepositories`. Without it the two implementations disagree, which the shared
   * conformance suite catches.
   */
  private readonly onErase: (citizenId: string) => Promise<void>;

  constructor(onErase: (citizenId: string) => Promise<void> = async () => {}) {
    this.onErase = onErase;
  }

  async create(input: CreateCitizenInput): Promise<CitizenRow> {
    if (this.rows.has(input.id)) throw new Error(`citizen ${input.id} already exists`);
    const row: CitizenRow = {
      id: input.id,
      region_id: input.region_id,
      region_path: [...input.region_path],
      verification_tier: input.verification_tier ?? 0,
      locale: input.locale,
      demographics: { ...input.demographics },
      region_basis: input.region_basis ?? 'declared',
      created_at: nowIso(),
      erased_at: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findById(citizenId: string): Promise<CitizenRow | null> {
    const row = this.rows.get(citizenId);
    return row ? { ...row, demographics: { ...row.demographics } } : null;
  }

  async updateProfile(
    citizenId: string,
    patch: {
      demographics?: Demographics;
      region_id?: number;
      region_path?: number[];
      region_basis?: RegionBasis;
      locale?: Locale;
    },
  ): Promise<CitizenRow | null> {
    const row = this.rows.get(citizenId);
    if (!row || row.erased_at !== null) return null;
    // A supplied `demographics` replaces the set wholesale, matching the SQL's CASE behaviour — so
    // declining a dimension you previously gave actually clears it.
    if (patch.demographics) row.demographics = { ...patch.demographics };
    if (patch.region_id !== undefined) row.region_id = patch.region_id;
    if (patch.region_path !== undefined) row.region_path = [...patch.region_path];
    // A new home region is `declared` unless this very patch says otherwise: a device confirmation
    // of the old region says nothing about the new one.
    if (patch.region_id !== undefined || patch.region_basis !== undefined) {
      row.region_basis = patch.region_basis ?? 'declared';
    }
    if (patch.locale !== undefined) row.locale = patch.locale;
    return { ...row, demographics: { ...row.demographics } };
  }

  async setVerificationTier(citizenId: string, tier: VerificationTier): Promise<CitizenRow | null> {
    const row = this.rows.get(citizenId);
    if (!row || row.erased_at !== null) return null;
    row.verification_tier = tier;
    return { ...row };
  }

  async erase(citizenId: string): Promise<boolean> {
    const row = this.rows.get(citizenId);
    if (!row || row.erased_at !== null) return false;
    row.demographics = {};
    row.erased_at = nowIso();
    await this.onErase(citizenId);
    return true;
  }
}

export class MemorySentimentRepository implements SentimentRepository {
  /** `${citizenId}:${topicId}` → row */
  readonly rows = new Map<string, CurrentSentimentRow>();

  private key(citizenId: string, topicId: number) {
    return `${citizenId}:${topicId}`;
  }

  async getCurrent(citizenId: string, topicId: number): Promise<CurrentSentimentRow | null> {
    const row = this.rows.get(this.key(citizenId, topicId));
    return row ? { ...row } : null;
  }

  async listCurrent(
    citizenId: string,
    opts: { limit?: number; topicIds?: readonly number[] } = {},
  ): Promise<CurrentSentimentRow[]> {
    let rows = [...this.rows.values()].filter((r) => r.citizen_id === citizenId);
    if (opts.topicIds && opts.topicIds.length > 0) {
      const wanted = new Set(opts.topicIds);
      rows = rows.filter((r) => wanted.has(r.topic_id));
      return rows.map((r) => ({ ...r }));
    }
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return rows.slice(0, Math.min(opts.limit ?? 50, 200)).map((r) => ({ ...r }));
  }

  async upsert(
    citizenId: string,
    row: Omit<CurrentSentimentRow, 'citizen_id' | 'updated_at'>,
  ): Promise<UpsertSentimentResult> {
    const k = this.key(citizenId, row.topic_id);
    const existing = this.rows.get(k);

    // A redelivery of the event already stored must be a no-op, not a second application.
    if (existing && existing.event_id === row.event_id) {
      return { previous: null, applied: false };
    }

    this.rows.set(k, { ...row, citizen_id: citizenId, updated_at: nowIso() });
    return { previous: existing ? { ...existing } : null, applied: true };
  }

  async deleteForCitizen(citizenId: string): Promise<number> {
    let deleted = 0;
    for (const [k, row] of [...this.rows]) {
      if (row.citizen_id === citizenId) {
        this.rows.delete(k);
        deleted += 1;
      }
    }
    return deleted;
  }
}

const RTI_DATE_FIELD: Partial<Record<RtiState, keyof RtiRequestRow>> = {
  filed: 'filed_at',
  acknowledged: 'acknowledged_at',
  responded: 'responded_at',
  first_appeal: 'first_appeal_at',
  fa_responded: 'fa_responded_at',
  second_appeal: 'second_appeal_at',
};

export class MemoryRtiRepository implements RtiRepository {
  readonly rows = new Map<string, RtiRequestRow>();

  async create(
    input: Omit<RtiRequestRow, 'created_at' | 'updated_at' | 'state'> & { state?: RtiState },
  ): Promise<RtiRequestRow> {
    const row: RtiRequestRow = {
      ...input,
      state: input.state ?? (input.filed_at ? 'filed' : 'draft'),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findById(citizenId: string, id: string): Promise<RtiRequestRow | null> {
    const row = this.rows.get(id);
    // Scoped by citizen: guessing an id must not reveal another citizen's filing.
    return row && row.citizen_id === citizenId ? { ...row } : null;
  }

  async listByCitizen(citizenId: string, opts: { limit?: number } = {}): Promise<RtiRequestRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.citizen_id === citizenId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Math.min(opts.limit ?? 50, 200))
      .map((r) => ({ ...r }));
  }

  async transition(
    citizenId: string,
    id: string,
    to: RtiState,
    on: string | null,
  ): Promise<RtiRequestRow | null> {
    const row = this.rows.get(id);
    if (!row || row.citizen_id !== citizenId) return null;
    row.state = to;
    row.updated_at = nowIso();
    const dateField = RTI_DATE_FIELD[to];
    if (dateField) {
      const current = row[dateField] as string | null;
      // COALESCE($date, existing, CURRENT_DATE), same precedence as the SQL.
      (row as unknown as Record<string, string | null>)[dateField] =
        on ?? current ?? nowIso().slice(0, 10);
    }
    return { ...row };
  }
}

export class MemoryCatalogueRepository implements CatalogueRepository {
  readonly regions = new Map<number, RegionRow>();
  readonly topics = new Map<number, TopicRow>();
  readonly authorities = new Map<number, AuthorityRow>();
  readonly budget = new Map<string, BudgetLineRow[]>();
  readonly fiscal = new Map<string, FiscalLineRow>();
  readonly quarantine = new Map<string, QuarantineRow & { detail?: string }>();

  async getRegion(regionId: number): Promise<RegionRow | null> {
    const r = this.regions.get(regionId);
    return r ? { ...r, path: [...r.path] } : null;
  }

  async regionByKey(key: string): Promise<RegionRow | null> {
    for (const r of this.regions.values())
      if (r.codes['key'] === key) return { ...r, path: [...r.path] };
    return null;
  }

  async getRegions(regionIds: readonly number[]): Promise<RegionRow[]> {
    return regionIds
      .map((id) => this.regions.get(id))
      .filter((r): r is RegionRow => r !== undefined)
      .map((r) => ({ ...r, path: [...r.path] }));
  }

  async childRegions(parentId: number): Promise<RegionRow[]> {
    return [...this.regions.values()]
      .filter((r) => r.parent_id === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ ...r, path: [...r.path] }));
  }

  async getTopic(topicId: number): Promise<TopicRow | null> {
    const t = this.topics.get(topicId);
    return t ? { ...t } : null;
  }

  async listTopics(opts: {
    regionId?: number;
    kind?: string;
    status?: string;
    limit?: number;
  }): Promise<TopicRow[]> {
    let topics = [...this.topics.values()];
    if (opts.regionId !== undefined) {
      const region = this.regions.get(opts.regionId);
      const ancestors = new Set(region?.path ?? []);
      // A topic applies when its jurisdiction is one of the region's ancestors — the same
      // path-containment test the SQL performs.
      topics = topics.filter((t) => ancestors.has(t.jurisdiction_region_id));
    }
    if (opts.kind !== undefined) topics = topics.filter((t) => t.kind === opts.kind);
    if (opts.status !== undefined) topics = topics.filter((t) => t.status === opts.status);
    topics.sort((a, b) => {
      const byDate = (b.effective_from ?? '').localeCompare(a.effective_from ?? '');
      return byDate !== 0 ? byDate : b.id - a.id;
    });
    return topics.slice(0, Math.min(opts.limit ?? 50, 200)).map((t) => ({ ...t }));
  }

  async getTopics(topicIds: readonly number[]): Promise<TopicRow[]> {
    return topicIds
      .map((id) => this.topics.get(id))
      .filter((t): t is TopicRow => t !== undefined)
      .map((t) => ({ ...t }));
  }

  async createTopic(input: NewTopic): Promise<TopicRow> {
    const id = Math.max(0, ...this.topics.keys()) + 1;
    const row: TopicRow = {
      id,
      kind: input.kind,
      status: input.status ?? 'active',
      jurisdiction_region_id: input.jurisdiction_region_id,
      authority_id: input.authority_id ?? null,
      scheme_id: input.scheme_id ?? null,
      title: input.title,
      summary: input.summary,
      effective_from: input.effective_from,
      source_refs: [...input.source_refs],
    };
    this.topics.set(id, row);
    return { ...row };
  }

  async getAuthority(authorityId: number): Promise<AuthorityRow | null> {
    const a = this.authorities.get(authorityId);
    return a ? { ...a } : null;
  }

  async budgetLines(regionId: number, fy: string): Promise<BudgetLineRow[]> {
    return (this.budget.get(`${regionId}:${fy}`) ?? [])
      .map((b) => ({ ...b }))
      .sort((a, b) => (b.allocated_be ?? -1) - (a.allocated_be ?? -1));
  }

  async budgetLinesForPath(regionIds: readonly number[], fy: string): Promise<BudgetLineRow[]> {
    const depthOf = (id: number) => this.regions.get(id)?.path.length ?? 0;
    return regionIds
      .flatMap((id) => this.budget.get(`${id}:${fy}`) ?? [])
      .map((b) => ({ ...b }))
      .sort((a, b) => {
        const byDepth = depthOf(b.region_id) - depthOf(a.region_id);
        return byDepth !== 0 ? byDepth : (b.allocated_be ?? -1) - (a.allocated_be ?? -1);
      });
  }

  async fiscalLines(regionId: number): Promise<FiscalLineRow[]> {
    return [...this.fiscal.values()]
      .filter((f) => f.region_id === regionId)
      .map((f) => ({ ...f }))
      .sort(
        (a, b) =>
          b.fy.localeCompare(a.fy) ||
          a.stage.localeCompare(b.stage) ||
          a.category.localeCompare(b.category),
      );
  }

  async upsertFiscalLines(rows: readonly FiscalLineRow[]): Promise<void> {
    for (const r of rows) {
      if (!this.regions.has(r.region_id)) throw new Error(`no region ${r.region_id}`);
      if (!(r.amount >= 0)) throw new RangeError(`negative amount for ${r.category}`);
      this.fiscal.set(`${r.region_id}:${r.fy}:${r.stage}:${r.category}`, { ...r });
    }
  }

  async quarantinedBuckets(
    topicId: number,
    regionId: number,
    dim: number,
  ): Promise<QuarantineRow[]> {
    return [...this.quarantine.values()].filter(
      (q) => q.topic_id === topicId && q.region_id === regionId && q.dim === dim,
    );
  }

  async addQuarantine(row: QuarantineRow & { detail?: string }): Promise<void> {
    this.quarantine.set(`${row.topic_id}:${row.region_id}:${row.dim}:${row.bucket}`, { ...row });
  }

  // ── Seeding helpers, for tests and the local fixture ──
  putRegion(row: RegionRow): void {
    this.regions.set(row.id, row);
  }
  putTopic(row: TopicRow): void {
    this.topics.set(row.id, row);
  }
  putAuthority(row: AuthorityRow): void {
    this.authorities.set(row.id, row);
  }
  putBudgetLines(regionId: number, fy: string, rows: BudgetLineRow[]): void {
    this.budget.set(`${regionId}:${fy}`, rows);
  }
}

export interface MemoryRepositories extends Repositories {
  citizens: MemoryCitizenRepository;
  sentiment: MemorySentimentRepository;
  rti: MemoryRtiRepository;
  catalogue: MemoryCatalogueRepository;
  forum: MemoryForumRepository;
  documents: MemoryDocumentRepository;
}

export { MemoryDocumentRepository, MemoryForumRepository };

export function createMemoryRepositories(opts: { now?: () => Date } = {}): MemoryRepositories {
  const sentiment = new MemorySentimentRepository();
  const follows = new Set<string>();
  return {
    // Erase cascades to opinions, matching the single transaction the SQL version runs.
    citizens: new MemoryCitizenRepository(async (citizenId) => {
      await sentiment.deleteForCitizen(citizenId);
      for (const key of [...follows]) if (key.startsWith(`${citizenId}:`)) follows.delete(key);
    }),
    sentiment,
    rti: new MemoryRtiRepository(),
    catalogue: new MemoryCatalogueRepository(),
    forum: new MemoryForumRepository(),
    documents: new MemoryDocumentRepository(opts.now),
    async ready() {},
    async close() {},
  };
}
