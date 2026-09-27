import type {
  CommentState,
  Digest,
  DocumentKind,
  Need,
  ReportReason,
  VerificationTier,
} from '@civic-voice/contracts';
import type { Queryable, ShardRouter } from '../router.ts';
import { vshardForTopic } from '../shard.ts';
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

type Row = Record<string, unknown>;

const ts = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const day = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toComment(row: Row): CommentRow {
  const sentiment = num(row['sentiment']);
  return {
    topic_id: Number(row['topic_id']),
    id: String(row['id']),
    parent_id: str(row['parent_id']),
    pseudonym: String(row['pseudonym']),
    handle: String(row['handle']),
    body: String(row['body']),
    language: String(row['language']),
    area: str(row['area']),
    located: Boolean(row['located']),
    verification_tier: Number(row['verification_tier']) as VerificationTier,
    state: String(row['state']) as CommentState,
    moderation_reasons: (row['moderation_reasons'] ?? []) as string[],
    sentiment: sentiment === null ? null : (sentiment as -1 | 0 | 1),
    needs: (row['needs'] ?? []) as Need[],
    suggestion: Boolean(row['suggestion']),
    model: str(row['model']),
    upvotes: Number(row['upvotes']),
    reply_count: Number(row['reply_count']),
    report_count: Number(row['report_count']),
    created_at: ts(row['created_at']),
  };
}

/**
 * Forum storage (ADR-0008). A thread's rows live on its topic's shard; the author's index lives on
 * theirs. The two are never written in one transaction — there is no distributed commit anywhere in
 * the system — so every multi-shard operation is ordered to be safely re-runnable instead:
 *
 *  - insert: comment first (idempotent on its key), then the author's index (idempotent too). A crash
 *    between them leaves a comment its author cannot list, and the redelivered event fills the gap.
 *  - erase: blank every comment the index names, then drop the index. A crash between them leaves
 *    the index, so the retried erasure finds everything again.
 */
export class PgForumRepository implements ForumRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async insertComment(citizenId: string, row: NewComment): Promise<{ inserted: boolean }> {
    const inserted = await this.router.withTopicTransaction(row.topic_id, async (db) => {
      const res = await db.query(
        `INSERT INTO civic_shard.comment
           (topic_id, id, vshard, parent_id, pseudonym, handle, body, language, area, located,
            verification_tier, state, moderation_reasons, sentiment, needs, suggestion, model, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (topic_id, id) DO NOTHING`,
        [
          row.topic_id,
          row.id,
          vshardForTopic(row.topic_id),
          row.parent_id,
          row.pseudonym,
          row.handle,
          row.body,
          row.language,
          row.area,
          row.located,
          row.verification_tier,
          row.state,
          row.moderation_reasons,
          row.sentiment,
          row.needs,
          row.suggestion,
          row.model,
          row.created_at,
        ],
      );
      const fresh = (res.rowCount ?? 0) > 0;
      if (fresh && row.parent_id && row.state === 'published') {
        await db.query(
          `UPDATE civic_shard.comment SET reply_count = reply_count + 1 WHERE topic_id = $1 AND id = $2`,
          [row.topic_id, row.parent_id],
        );
      }
      return fresh;
    });
    // Unconditionally: if the comment landed but the index write was lost, the redelivery repairs it.
    await this.router.withCitizenShard(citizenId, (db) =>
      db.query(
        `INSERT INTO civic_shard.my_comment (citizen_id, comment_id, topic_id, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [citizenId, row.id, row.topic_id, row.created_at],
      ),
    );
    return { inserted };
  }

  async getComment(topicId: number, commentId: string): Promise<CommentRow | null> {
    return this.router.withTopicShard(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_shard.comment WHERE topic_id = $1 AND id = $2`,
        [topicId, commentId],
      );
      return rows[0] ? toComment(rows[0]) : null;
    });
  }

  async listComments(
    topicId: number,
    opts: { sort: 'top' | 'new'; limit: number; cursor?: string | null; parentId?: string | null },
  ): Promise<CommentPage> {
    const cursor = decodeCursor(opts.cursor);
    const parentId = opts.parentId ?? null;
    const limit = Math.min(Math.max(opts.limit, 1), 100);
    return this.router.withTopicShard(topicId, async (db) => {
      let rows: Row[];
      if (parentId) {
        // Replies read oldest first, as a conversation.
        ({ rows } = await db.query<Row>(
          `SELECT * FROM civic_shard.comment
           WHERE topic_id = $1 AND parent_id = $2 AND state = 'published'
             AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
           ORDER BY created_at, id LIMIT $5`,
          [topicId, parentId, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
        ));
      } else if (opts.sort === 'top') {
        ({ rows } = await db.query<Row>(
          `SELECT * FROM civic_shard.comment
           WHERE topic_id = $1 AND parent_id IS NULL AND state = 'published'
             AND ($2::integer IS NULL OR (upvotes, created_at, id) < ($2::integer, $3::timestamptz, $4::uuid))
           ORDER BY upvotes DESC, created_at DESC, id DESC LIMIT $5`,
          [
            topicId,
            cursor?.upvotes ?? null,
            cursor?.created_at ?? null,
            cursor?.id ?? null,
            limit + 1,
          ],
        ));
      } else {
        ({ rows } = await db.query<Row>(
          `SELECT * FROM civic_shard.comment
           WHERE topic_id = $1 AND parent_id IS NULL AND state = 'published'
             AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
           ORDER BY created_at DESC, id DESC LIMIT $4`,
          [topicId, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1],
        ));
      }
      const items = rows.slice(0, limit).map(toComment);
      const last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > limit && last
            ? encodeCursor({
                ...(opts.sort === 'top' && !parentId ? { upvotes: last.upvotes } : {}),
                created_at: last.created_at,
                id: last.id,
              })
            : null,
      };
    });
  }

  async commentsForDigest(topicId: number, limit: number): Promise<CommentRow[]> {
    return this.router.withTopicShard(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_shard.comment WHERE topic_id = $1 AND state = 'published'
         ORDER BY upvotes DESC, created_at DESC, id DESC LIMIT $2`,
        [topicId, limit],
      );
      return rows.map(toComment);
    });
  }

  async countPublished(topicId: number): Promise<number> {
    return this.router.withTopicShard(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT count(*) AS n FROM civic_shard.comment WHERE topic_id = $1 AND state = 'published'`,
        [topicId],
      );
      return Number(rows[0]?.['n'] ?? 0);
    });
  }

  async setVote(
    topicId: number,
    commentId: string,
    pseudonym: string,
    on: boolean,
  ): Promise<{ upvotes: number; changed: boolean } | null> {
    return this.router.withTopicTransaction(topicId, async (db) => {
      // Lock the comment row first: the vote and the counter must move together.
      const { rows } = await db.query<Row>(
        `SELECT upvotes, state FROM civic_shard.comment WHERE topic_id = $1 AND id = $2 FOR UPDATE`,
        [topicId, commentId],
      );
      const current = rows[0];
      if (!current || current['state'] !== 'published') return null;
      const res = on
        ? await db.query(
            `INSERT INTO civic_shard.comment_vote (topic_id, comment_id, pseudonym) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [topicId, commentId, pseudonym],
          )
        : await db.query(
            `DELETE FROM civic_shard.comment_vote WHERE topic_id = $1 AND comment_id = $2 AND pseudonym = $3`,
            [topicId, commentId, pseudonym],
          );
      if ((res.rowCount ?? 0) === 0) return { upvotes: Number(current['upvotes']), changed: false };
      const { rows: updated } = await db.query<Row>(
        `UPDATE civic_shard.comment SET upvotes = GREATEST(0, upvotes + $3)
         WHERE topic_id = $1 AND id = $2 RETURNING upvotes`,
        [topicId, commentId, on ? 1 : -1],
      );
      return { upvotes: Number(updated[0]?.['upvotes'] ?? 0), changed: true };
    });
  }

  async votedBy(
    topicId: number,
    commentIds: readonly string[],
    pseudonym: string,
  ): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    return this.router.withTopicShard(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT comment_id FROM civic_shard.comment_vote
         WHERE topic_id = $1 AND pseudonym = $2 AND comment_id = ANY($3::uuid[])`,
        [topicId, pseudonym, [...commentIds]],
      );
      return new Set(rows.map((r) => String(r['comment_id'])));
    });
  }

  async report(
    topicId: number,
    commentId: string,
    pseudonym: string,
    reason: ReportReason,
  ): Promise<{ counted: boolean; held: boolean } | null> {
    return this.router.withTopicTransaction(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT state FROM civic_shard.comment WHERE topic_id = $1 AND id = $2 FOR UPDATE`,
        [topicId, commentId],
      );
      if (!rows[0]) return null;
      const res = await db.query(
        `INSERT INTO civic_shard.comment_report (topic_id, comment_id, pseudonym, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [topicId, commentId, pseudonym, reason],
      );
      if ((res.rowCount ?? 0) === 0) return { counted: false, held: rows[0]['state'] === 'held' };
      const { rows: updated } = await db.query<Row>(
        `UPDATE civic_shard.comment SET
           report_count = report_count + 1,
           state = CASE WHEN state = 'published' AND report_count + 1 >= $3 THEN 'held' ELSE state END,
           moderation_reasons = CASE WHEN state = 'published' AND report_count + 1 >= $3
                                     THEN array_append(moderation_reasons, 'reported') ELSE moderation_reasons END
         WHERE topic_id = $1 AND id = $2 RETURNING state`,
        [topicId, commentId, REPORTS_TO_HOLD],
      );
      return { counted: true, held: updated[0]?.['state'] === 'held' };
    });
  }

  async setState(
    topicId: number,
    commentId: string,
    state: CommentState,
    reasons?: string[],
  ): Promise<boolean> {
    return this.router.withTopicShard(topicId, async (db) => {
      const res = await db.query(
        `UPDATE civic_shard.comment SET state = $3, moderation_reasons = COALESCE($4, moderation_reasons)
         WHERE topic_id = $1 AND id = $2`,
        [topicId, commentId, state, reasons ?? null],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  private async authored(
    citizenId: string,
    limit: number | null,
  ): Promise<Array<{ topicId: number; commentId: string }>> {
    return this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT topic_id, comment_id FROM civic_shard.my_comment WHERE citizen_id = $1
         ORDER BY created_at DESC ${limit === null ? '' : 'LIMIT $2'}`,
        limit === null ? [citizenId] : [citizenId, limit],
      );
      return rows.map((r) => ({
        topicId: Number(r['topic_id']),
        commentId: String(r['comment_id']),
      }));
    });
  }

  async myComments(citizenId: string, limit: number): Promise<CommentRow[]> {
    const refs = await this.authored(citizenId, limit);
    const byTopic = new Map<number, string[]>();
    for (const r of refs) byTopic.set(r.topicId, [...(byTopic.get(r.topicId) ?? []), r.commentId]);
    // One query per topic shard touched; `limit` bounds how many that can be.
    const rows = (
      await Promise.all(
        [...byTopic].map(([topicId, ids]) =>
          this.router.withTopicShard(topicId, async (db) => {
            const res = await db.query<Row>(
              `SELECT * FROM civic_shard.comment WHERE topic_id = $1 AND id = ANY($2::uuid[])`,
              [topicId, ids],
            );
            return res.rows.map(toComment);
          }),
        ),
      )
    ).flat();
    return rows.sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
  }

  /** Within a topic-shard transaction: lock, blank, and keep the parent's reply count honest. */
  private async blank(db: Queryable, topicId: number, commentId: string): Promise<boolean> {
    const { rows } = await db.query<Row>(
      `SELECT state, parent_id FROM civic_shard.comment WHERE topic_id = $1 AND id = $2 FOR UPDATE`,
      [topicId, commentId],
    );
    const prior = rows[0];
    if (!prior || prior['state'] === 'deleted') return false;
    await db.query(
      `UPDATE civic_shard.comment SET body = '', state = 'deleted', needs = '{}', suggestion = false
       WHERE topic_id = $1 AND id = $2`,
      [topicId, commentId],
    );
    if (prior['state'] === 'published' && prior['parent_id']) {
      await db.query(
        `UPDATE civic_shard.comment SET reply_count = GREATEST(0, reply_count - 1) WHERE topic_id = $1 AND id = $2`,
        [topicId, prior['parent_id']],
      );
    }
    return true;
  }

  async deleteOwn(citizenId: string, topicId: number, commentId: string): Promise<boolean> {
    const owns = await this.router.withCitizenShard(citizenId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT 1 FROM civic_shard.my_comment WHERE citizen_id = $1 AND comment_id = $2 AND topic_id = $3`,
        [citizenId, commentId, topicId],
      );
      return rows.length > 0;
    });
    if (!owns) return false;
    return this.router.withTopicTransaction(topicId, (db) => this.blank(db, topicId, commentId));
  }

  async eraseAuthor(citizenId: string): Promise<number> {
    let erased = 0;
    for (const { topicId, commentId } of await this.authored(citizenId, null)) {
      if (
        await this.router.withTopicTransaction(topicId, (db) => this.blank(db, topicId, commentId))
      )
        erased++;
    }
    await this.router.withCitizenShard(citizenId, (db) =>
      db.query(`DELETE FROM civic_shard.my_comment WHERE citizen_id = $1`, [citizenId]),
    );
    return erased;
  }

  async getDigest(topicId: number): Promise<Digest | null> {
    return this.router.withTopicShard(topicId, async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT digest FROM civic_shard.topic_digest WHERE topic_id = $1`,
        [topicId],
      );
      return rows[0] ? (rows[0]['digest'] as Digest) : null;
    });
  }

  async putDigest(digest: Digest): Promise<void> {
    await this.router.withTopicShard(digest.topic_id, (db) =>
      db.query(
        `INSERT INTO civic_shard.topic_digest (topic_id, vshard, digest, based_on, generated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (topic_id) DO UPDATE SET digest = excluded.digest, based_on = excluded.based_on,
           generated_at = excluded.generated_at`,
        [
          digest.topic_id,
          vshardForTopic(digest.topic_id),
          JSON.stringify(digest),
          digest.based_on_comments,
          digest.generated_at,
        ],
      ),
    );
  }
}

function toDocument(row: Row): DocumentRow {
  return {
    id: Number(row['id']),
    content_hash: String(row['content_hash']),
    source_id: String(row['source_id']),
    source_name: String(row['source_name']),
    kind: String(row['kind']) as DocumentKind,
    subject: str(row['subject']) as DocumentRow['subject'],
    title: String(row['title']),
    url: String(row['url']),
    published_on: day(row['published_on']),
    snippet: str(row['snippet']),
    go_number: str(row['go_number']),
    go_type: str(row['go_type']) as DocumentRow['go_type'],
    gazette_number: str(row['gazette_number']),
    department: str(row['department']),
    amount_rupees: num(row['amount_rupees']),
    vacancies: num(row['vacancies']),
    closing_on: day(row['closing_on']),
    jurisdiction_region_id: Number(row['jurisdiction_region_id']),
    primary_region_id: num(row['primary_region_id']),
    primary_region_path: ((row['primary_region_path'] ?? []) as (number | string)[]).map(Number),
    geo_confidence: Number(row['geo_confidence']),
    geo_region_ids: ((row['geo_region_ids'] ?? []) as (number | string)[]).map(Number),
    discussable: Boolean(row['discussable']),
    provenance: String(row['provenance']) as DocumentRow['provenance'],
    needs_ocr: Boolean(row['needs_ocr']),
    topic_id: num(row['topic_id']),
    first_seen_at: ts(row['first_seen_at']),
  };
}

const DOCUMENT_COLUMNS = [
  'content_hash',
  'source_id',
  'source_name',
  'kind',
  'subject',
  'title',
  'url',
  'published_on',
  'snippet',
  'go_number',
  'go_type',
  'gazette_number',
  'department',
  'amount_rupees',
  'vacancies',
  'closing_on',
  'jurisdiction_region_id',
  'primary_region_id',
  'primary_region_path',
  'geo_confidence',
  'geo_region_ids',
  'discussable',
  'provenance',
  'needs_ocr',
] as const;

/**
 * Kept from the first sighting when a document is seen again: the same notification carried by two
 * sources stays attributed to the one that published it first, rather than to whichever ran last.
 */
const FIRST_SEEN_COLUMNS = new Set<string>(['content_hash', 'source_id', 'source_name']);

export class PgDocumentRepository implements DocumentRepository {
  private readonly router: ShardRouter;

  constructor(router: ShardRouter) {
    this.router = router;
  }

  async upsertDocuments(
    docs: readonly NewDocument[],
  ): Promise<{ inserted: number; updated: number; ids: Map<string, number> }> {
    const ids = new Map<string, number>();
    let inserted = 0;
    let updated = 0;
    await this.router.catalogue(async (db) => {
      for (const d of docs) {
        const values = DOCUMENT_COLUMNS.map((c) => d[c]);
        const { rows } = await db.query<Row>(
          `INSERT INTO civic_catalogue.document (${DOCUMENT_COLUMNS.join(', ')})
           VALUES (${DOCUMENT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
           ON CONFLICT (content_hash) DO UPDATE SET
             ${DOCUMENT_COLUMNS.filter((c) => !FIRST_SEEN_COLUMNS.has(c))
               .map((c) => `${c} = excluded.${c}`)
               .join(', ')},
             updated_at = now()
           RETURNING id, (xmax = 0) AS fresh`,
          values,
        );
        const row = rows[0] as Row;
        ids.set(d.content_hash, Number(row['id']));
        if (row['fresh']) inserted++;
        else updated++;
      }
    });
    return { inserted, updated, ids };
  }

  async getDocument(id: number): Promise<DocumentRow | null> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(`SELECT * FROM civic_catalogue.document WHERE id = $1`, [
        id,
      ]);
      return rows[0] ? toDocument(rows[0]) : null;
    });
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
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.document
         WHERE (primary_region_id = ANY($1::bigint[]) OR geo_region_ids && ARRAY[$2::bigint])
           AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
           AND ($4::text IS NULL OR subject = $4)
           AND ($5::bigint IS NULL OR (coalesce(published_on, '0001-01-01'), id) < (coalesce($6::date, '0001-01-01'), $5::bigint))
         ORDER BY coalesce(published_on, '0001-01-01') DESC, id DESC
         LIMIT $7`,
        [
          [...regionPath],
          regionPath.at(-1) ?? 0,
          opts.kinds ? [...opts.kinds] : null,
          opts.subject ?? null,
          opts.before?.id ?? null,
          opts.before?.published_on ?? null,
          Math.min(opts.limit, 100),
        ],
      );
      return rows.map(toDocument);
    });
  }

  async openJobs(regionPath: readonly number[], today: string): Promise<DocumentRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.document
         WHERE kind = 'job_notification'
           AND (primary_region_id = ANY($1::bigint[]) OR geo_region_ids && ARRAY[$2::bigint])
           AND (closing_on >= $3::date
                OR (closing_on IS NULL AND coalesce(published_on, first_seen_at::date) >= $3::date - 60))
         ORDER BY closing_on ASC NULLS LAST, id DESC
         LIMIT 500`,
        [[...regionPath], regionPath.at(-1) ?? 0, today],
      );
      return rows.map(toDocument);
    });
  }

  async linkTopic(documentId: number, topicId: number): Promise<void> {
    await this.router.catalogue((db) =>
      db.query(`UPDATE civic_catalogue.document SET topic_id = $2 WHERE id = $1`, [
        documentId,
        topicId,
      ]),
    );
  }

  async undiscussed(limit: number): Promise<DocumentRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.document WHERE discussable AND topic_id IS NULL ORDER BY id LIMIT $1`,
        [limit],
      );
      return rows.map(toDocument);
    });
  }

  async putSourceHealth(row: SourceHealthRow): Promise<void> {
    await this.router.catalogue((db) =>
      db.query(
        `INSERT INTO civic_catalogue.source_health (source_id, fetched_at, outcome, items, suspected_layout_change, message)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id) DO UPDATE SET fetched_at = excluded.fetched_at, outcome = excluded.outcome,
           items = excluded.items, suspected_layout_change = excluded.suspected_layout_change, message = excluded.message`,
        [
          row.source_id,
          row.fetched_at,
          row.outcome,
          row.items,
          row.suspected_layout_change,
          row.message,
        ],
      ),
    );
  }

  async sourceHealth(): Promise<SourceHealthRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT * FROM civic_catalogue.source_health ORDER BY source_id`,
      );
      return rows.map((r) => ({
        source_id: String(r['source_id']),
        fetched_at: ts(r['fetched_at']),
        outcome: String(r['outcome']),
        items: Number(r['items']),
        suspected_layout_change: Boolean(r['suspected_layout_change']),
        message: str(r['message']),
      }));
    });
  }

  async upsertIndicators(rows: readonly IndicatorRow[]): Promise<void> {
    await this.router.catalogue(async (db) => {
      for (const r of rows) {
        await db.query(
          `INSERT INTO civic_catalogue.indicator (code, name, category, unit, source_name, source_url, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (code) DO UPDATE SET name = excluded.name, category = excluded.category, unit = excluded.unit,
             source_name = excluded.source_name, source_url = excluded.source_url, note = excluded.note`,
          [r.code, r.name, r.category, r.unit, r.source_name, r.source_url, r.note],
        );
        await db.query(
          `INSERT INTO civic_catalogue.indicator_observation (code, region_id, period, period_start, value, provenance)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (code, region_id, period) DO UPDATE SET value = excluded.value, provenance = excluded.provenance,
             period_start = excluded.period_start, fetched_at = now()`,
          [r.code, r.region_id, r.period, r.period_start, r.value, r.provenance],
        );
      }
    });
  }

  async indicators(regionPath: readonly number[]): Promise<IndicatorRow[]> {
    return this.router.catalogue(async (db) => {
      const { rows } = await db.query<Row>(
        `SELECT i.*, o.region_id, o.period, o.period_start, o.value, o.provenance
         FROM civic_catalogue.indicator i
         JOIN LATERAL (
           SELECT * FROM civic_catalogue.indicator_observation o
           WHERE o.code = i.code AND o.region_id = ANY($1::bigint[])
         ) o ON true
         WHERE (SELECT count(*) FROM civic_catalogue.indicator_observation newer
                WHERE newer.code = o.code AND newer.region_id = o.region_id AND newer.period_start > o.period_start) < 2
         ORDER BY i.category, i.code, o.region_id, o.period_start DESC`,
        [[...regionPath]],
      );
      return rows.map((r) => ({
        code: String(r['code']),
        name: String(r['name']),
        category: String(r['category']) as IndicatorRow['category'],
        unit: String(r['unit']),
        source_name: String(r['source_name']),
        source_url: String(r['source_url']),
        note: str(r['note']),
        region_id: Number(r['region_id']),
        period: String(r['period']),
        period_start: day(r['period_start']) as string,
        value: Number(r['value']),
        provenance: String(r['provenance']) as IndicatorRow['provenance'],
      }));
    });
  }
}
