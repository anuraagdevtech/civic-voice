import type { CommentState, Digest, DocumentKind, ReportReason } from '@civic-voice/contracts';
import { decodeCursor, encodeCursor } from './forum-cursor.ts';
import {
  REPORTS_TO_HOLD,
  type CommentPage,
  type CommentRow,
  type DocumentRepository,
  type DocumentRow,
  type ForumRepository,
  type IndicatorRow,
  type NewComment,
  type NewDocument,
  type SourceHealthRow,
} from './ports.ts';

const copy = (c: CommentRow): CommentRow => ({
  ...c,
  needs: [...c.needs],
  moderation_reasons: [...c.moderation_reasons],
});

/** Newest first, then by id — the same total order the SQL index uses. */
const byNew = (a: CommentRow, b: CommentRow) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
const byTop = (a: CommentRow, b: CommentRow) => b.upvotes - a.upvotes || byNew(a, b);

export class MemoryForumRepository implements ForumRepository {
  /** topic → comment id → row */
  private readonly threads = new Map<number, Map<string, CommentRow>>();
  private readonly votes = new Set<string>();
  private readonly reports = new Set<string>();
  private readonly digests = new Map<number, Digest>();
  /** citizen → their comments' coordinates (the `my_comment` index) */
  private readonly authored = new Map<
    string,
    Array<{ topicId: number; commentId: string; createdAt: string }>
  >();

  private thread(topicId: number): Map<string, CommentRow> {
    let t = this.threads.get(topicId);
    if (!t) {
      t = new Map();
      this.threads.set(topicId, t);
    }
    return t;
  }

  async insertComment(citizenId: string, row: NewComment): Promise<{ inserted: boolean }> {
    const thread = this.thread(row.topic_id);
    if (thread.has(row.id)) return { inserted: false };
    thread.set(row.id, {
      ...row,
      needs: [...row.needs],
      moderation_reasons: [...row.moderation_reasons],
      upvotes: 0,
      reply_count: 0,
      report_count: 0,
    });
    if (row.parent_id && row.state === 'published') {
      const parent = thread.get(row.parent_id);
      if (parent) parent.reply_count += 1;
    }
    const mine = this.authored.get(citizenId) ?? [];
    mine.push({ topicId: row.topic_id, commentId: row.id, createdAt: row.created_at });
    this.authored.set(citizenId, mine);
    return { inserted: true };
  }

  async getComment(topicId: number, commentId: string): Promise<CommentRow | null> {
    const c = this.threads.get(topicId)?.get(commentId);
    return c ? copy(c) : null;
  }

  async listComments(
    topicId: number,
    opts: { sort: 'top' | 'new'; limit: number; cursor?: string | null; parentId?: string | null },
  ): Promise<CommentPage> {
    const parentId = opts.parentId ?? null;
    const order = parentId
      ? (a: CommentRow, b: CommentRow) => -byNew(a, b)
      : opts.sort === 'top'
        ? byTop
        : byNew;
    let rows = [...(this.threads.get(topicId)?.values() ?? [])]
      .filter((c) => c.state === 'published' && c.parent_id === parentId)
      .sort(order);
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      const at = rows.findIndex((c) => c.id === cursor.id);
      if (at >= 0) rows = rows.slice(at + 1);
      else {
        // The cursor's row has gone (deleted, held): resume after where it would have sorted.
        const probe = {
          ...(rows[0] as CommentRow),
          upvotes: cursor.upvotes ?? 0,
          created_at: cursor.created_at,
          id: cursor.id,
        };
        rows = rows.filter((c) => order(probe, c) < 0);
      }
    }
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      items: page.map(copy),
      next_cursor:
        rows.length > opts.limit && last
          ? encodeCursor({
              ...(opts.sort === 'top' && !parentId ? { upvotes: last.upvotes } : {}),
              created_at: last.created_at,
              id: last.id,
            })
          : null,
    };
  }

  async commentsForDigest(topicId: number, limit: number): Promise<CommentRow[]> {
    return [...(this.threads.get(topicId)?.values() ?? [])]
      .filter((c) => c.state === 'published')
      .sort(byTop)
      .slice(0, limit)
      .map(copy);
  }

  async countPublished(topicId: number): Promise<number> {
    let n = 0;
    for (const c of this.threads.get(topicId)?.values() ?? []) if (c.state === 'published') n++;
    return n;
  }

  async setVote(
    topicId: number,
    commentId: string,
    pseudonym: string,
    on: boolean,
  ): Promise<{ upvotes: number; changed: boolean } | null> {
    const c = this.threads.get(topicId)?.get(commentId);
    if (!c || c.state !== 'published') return null;
    const key = `${topicId}:${commentId}:${pseudonym}`;
    const had = this.votes.has(key);
    if (on === had) return { upvotes: c.upvotes, changed: false };
    if (on) this.votes.add(key);
    else this.votes.delete(key);
    c.upvotes = Math.max(0, c.upvotes + (on ? 1 : -1));
    return { upvotes: c.upvotes, changed: true };
  }

  async votedBy(
    topicId: number,
    commentIds: readonly string[],
    pseudonym: string,
  ): Promise<Set<string>> {
    return new Set(commentIds.filter((id) => this.votes.has(`${topicId}:${id}:${pseudonym}`)));
  }

  async report(
    topicId: number,
    commentId: string,
    pseudonym: string,
    _reason: ReportReason,
  ): Promise<{ counted: boolean; held: boolean } | null> {
    const c = this.threads.get(topicId)?.get(commentId);
    if (!c) return null;
    const key = `${topicId}:${commentId}:${pseudonym}`;
    if (this.reports.has(key)) return { counted: false, held: c.state === 'held' };
    this.reports.add(key);
    c.report_count += 1;
    if (c.state === 'published' && c.report_count >= REPORTS_TO_HOLD) {
      c.state = 'held';
      c.moderation_reasons = [...c.moderation_reasons, 'reported'];
      return { counted: true, held: true };
    }
    return { counted: true, held: c.state === 'held' };
  }

  async setState(
    topicId: number,
    commentId: string,
    state: CommentState,
    reasons?: string[],
  ): Promise<boolean> {
    const c = this.threads.get(topicId)?.get(commentId);
    if (!c) return false;
    c.state = state;
    if (reasons) c.moderation_reasons = [...reasons];
    return true;
  }

  async myComments(citizenId: string, limit: number): Promise<CommentRow[]> {
    return (this.authored.get(citizenId) ?? [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ topicId, commentId }) => this.threads.get(topicId)?.get(commentId))
      .filter((c): c is CommentRow => c !== undefined)
      .map(copy);
  }

  private blank(c: CommentRow) {
    if (c.state === 'published' && c.parent_id) {
      const parent = this.threads.get(c.topic_id)?.get(c.parent_id);
      if (parent) parent.reply_count = Math.max(0, parent.reply_count - 1);
    }
    c.body = '';
    c.state = 'deleted';
    c.needs = [];
    c.suggestion = false;
  }

  async deleteOwn(citizenId: string, topicId: number, commentId: string): Promise<boolean> {
    const owns = (this.authored.get(citizenId) ?? []).some(
      (a) => a.topicId === topicId && a.commentId === commentId,
    );
    const c = this.threads.get(topicId)?.get(commentId);
    if (!owns || !c || c.state === 'deleted') return false;
    this.blank(c);
    return true;
  }

  async eraseAuthor(citizenId: string): Promise<number> {
    let n = 0;
    for (const { topicId, commentId } of this.authored.get(citizenId) ?? []) {
      const c = this.threads.get(topicId)?.get(commentId);
      if (c && c.state !== 'deleted') {
        this.blank(c);
        n++;
      }
    }
    this.authored.delete(citizenId);
    return n;
  }

  async getDigest(topicId: number): Promise<Digest | null> {
    const d = this.digests.get(topicId);
    return d ? structuredClone(d) : null;
  }

  async putDigest(digest: Digest): Promise<void> {
    this.digests.set(digest.topic_id, structuredClone(digest));
  }
}

const ageInDays = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export class MemoryDocumentRepository implements DocumentRepository {
  private readonly docs = new Map<number, DocumentRow>();
  private readonly byHash = new Map<string, number>();
  private readonly health = new Map<string, SourceHealthRow>();
  private readonly observations = new Map<string, IndicatorRow>();
  private nextId = 1;
  /** Injected so "open" and "new" can be tested at a fixed date. */
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async upsertDocuments(
    docs: readonly NewDocument[],
  ): Promise<{ inserted: number; updated: number; ids: Map<string, number> }> {
    let inserted = 0;
    let updated = 0;
    const ids = new Map<string, number>();
    for (const d of docs) {
      const existing = this.byHash.get(d.content_hash);
      if (existing !== undefined) {
        const row = this.docs.get(existing) as DocumentRow;
        // Attribution stays with the first source to publish it, as in the SQL.
        this.docs.set(existing, {
          ...row,
          ...d,
          id: existing,
          source_id: row.source_id,
          source_name: row.source_name,
          topic_id: row.topic_id,
          first_seen_at: row.first_seen_at,
        });
        ids.set(d.content_hash, existing);
        updated++;
      } else {
        const id = this.nextId++;
        this.docs.set(id, { ...d, id, topic_id: null, first_seen_at: this.now().toISOString() });
        this.byHash.set(d.content_hash, id);
        ids.set(d.content_hash, id);
        inserted++;
      }
    }
    return { inserted, updated, ids };
  }

  async getDocument(id: number): Promise<DocumentRow | null> {
    const d = this.docs.get(id);
    return d ? structuredClone(d) : null;
  }

  private concerns(d: DocumentRow, path: readonly number[]): boolean {
    const own = path.at(-1);
    return (
      (d.primary_region_id !== null && path.includes(d.primary_region_id)) ||
      (own !== undefined && d.geo_region_ids.includes(own))
    );
  }

  async listForRegion(
    regionPath: readonly number[],
    opts: {
      kinds?: readonly DocumentKind[];
      subject?: 'project' | 'scheme';
      limit: number;
      before?: { published_on: string | null; id: number } | null;
    },
  ): Promise<DocumentRow[]> {
    const order = (a: DocumentRow, b: DocumentRow) =>
      (b.published_on ?? '').localeCompare(a.published_on ?? '') || b.id - a.id;
    let rows = [...this.docs.values()].filter(
      (d) =>
        this.concerns(d, regionPath) &&
        (!opts.kinds || opts.kinds.includes(d.kind)) &&
        (!opts.subject || d.subject === opts.subject),
    );
    rows.sort(order);
    if (opts.before) {
      const probe = { published_on: opts.before.published_on, id: opts.before.id } as DocumentRow;
      rows = rows.filter((d) => order(probe, d) < 0);
    }
    return rows.slice(0, opts.limit).map((d) => structuredClone(d));
  }

  async openJobs(regionPath: readonly number[], today: string): Promise<DocumentRow[]> {
    return [...this.docs.values()]
      .filter(
        (d) =>
          d.kind === 'job_notification' &&
          this.concerns(d, regionPath) &&
          (d.closing_on !== null
            ? d.closing_on >= today
            : ageInDays(d.published_on ?? d.first_seen_at.slice(0, 10), today) <= 60),
      )
      .sort((a, b) => (a.closing_on ?? '9999').localeCompare(b.closing_on ?? '9999') || b.id - a.id)
      .map((d) => structuredClone(d));
  }

  async linkTopic(documentId: number, topicId: number): Promise<void> {
    const d = this.docs.get(documentId);
    if (d) d.topic_id = topicId;
  }

  async undiscussed(limit: number): Promise<DocumentRow[]> {
    return [...this.docs.values()]
      .filter((d) => d.discussable && d.topic_id === null)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }

  async putSourceHealth(row: SourceHealthRow): Promise<void> {
    this.health.set(row.source_id, { ...row });
  }

  async sourceHealth(): Promise<SourceHealthRow[]> {
    return [...this.health.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
  }

  async upsertIndicators(rows: readonly IndicatorRow[]): Promise<void> {
    for (const r of rows) this.observations.set(`${r.code}:${r.region_id}:${r.period}`, { ...r });
  }

  async indicators(regionPath: readonly number[]): Promise<IndicatorRow[]> {
    const latest = new Map<string, IndicatorRow[]>();
    for (const r of this.observations.values()) {
      if (!regionPath.includes(r.region_id)) continue;
      const key = `${r.code}:${r.region_id}`;
      latest.set(key, [...(latest.get(key) ?? []), r]);
    }
    return [...latest.values()].flatMap((rows) =>
      rows
        .sort((a, b) => b.period_start.localeCompare(a.period_start))
        .slice(0, 2)
        .map((r) => ({ ...r })),
    );
  }
}
