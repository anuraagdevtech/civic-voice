import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '@civic-voice/core';
import type { NewComment, NewDocument, Repositories } from '../src/repositories/ports.ts';
import { REPORTS_TO_HOLD } from '../src/repositories/ports.ts';

/**
 * Forum and document semantics, held to by both implementations (ADR-0006, ADR-0008). As with the
 * citizen contract, the cases are the ones easy to get subtly different: redelivery being a no-op,
 * one vote per pseudonym, reports holding a comment at the threshold, erasure reaching every thread.
 */
export function runForumContract(name: string, open: () => Promise<Repositories>) {
  // Topic ids far apart, so on Postgres they hash to different vshards.
  let topicSeq = 900_000 + Math.floor(Math.random() * 1_000_000);
  const nextTopic = () => (topicSeq += 7919);
  const pseudo = (n: number) => n.toString(16).padStart(32, '0');

  const comment = (topicId: number, overrides: Partial<NewComment> = {}): NewComment => ({
    topic_id: topicId,
    id: uuidv7(),
    parent_id: null,
    pseudonym: pseudo(1),
    handle: 'Citizen 000001',
    body: 'The storm drains in our ward overflow every monsoon.',
    language: 'en',
    area: 'Khairatabad',
    located: true,
    verification_tier: 1,
    state: 'published',
    moderation_reasons: [],
    sentiment: -1,
    needs: ['sanitation'],
    suggestion: false,
    model: 'nb-lr-test',
    created_at: new Date().toISOString(),
    ...overrides,
  });

  describe(`forum contract: ${name}`, () => {
    test('a redelivered comment is a no-op', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const c = comment(topic);
        assert.deepEqual(await repos.forum.insertComment(uuidv7(), c), { inserted: true });
        assert.deepEqual(await repos.forum.insertComment(uuidv7(), c), { inserted: false });
        assert.equal(await repos.forum.countPublished(topic), 1);
      } finally {
        await repos.close();
      }
    });

    test('threads list published top-level comments only, newest first, and page without overlap', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const base = Date.parse('2026-09-01T00:00:00Z');
        const ids: string[] = [];
        for (let i = 0; i < 7; i++) {
          const c = comment(topic, {
            created_at: new Date(base + i * 60_000).toISOString(),
            pseudonym: pseudo(i + 1),
          });
          ids.push(c.id);
          await repos.forum.insertComment(uuidv7(), c);
        }
        await repos.forum.insertComment(uuidv7(), comment(topic, { state: 'held' }));
        await repos.forum.insertComment(uuidv7(), comment(topic, { parent_id: ids[0] as string }));

        const first = await repos.forum.listComments(topic, { sort: 'new', limit: 4 });
        assert.equal(first.items.length, 4);
        assert.ok(first.next_cursor);
        const second = await repos.forum.listComments(topic, {
          sort: 'new',
          limit: 4,
          cursor: first.next_cursor,
        });
        const seen = [...first.items, ...second.items].map((c) => c.id);
        assert.deepEqual(seen, [...ids].reverse());
        assert.equal(second.next_cursor, null);
      } finally {
        await repos.close();
      }
    });

    test('replies are listed under their parent, oldest first, and counted on it', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const parent = comment(topic);
        await repos.forum.insertComment(uuidv7(), parent);
        const t0 = Date.parse('2026-09-02T00:00:00Z');
        const r1 = comment(topic, { parent_id: parent.id, created_at: new Date(t0).toISOString() });
        const r2 = comment(topic, {
          parent_id: parent.id,
          created_at: new Date(t0 + 1000).toISOString(),
        });
        await repos.forum.insertComment(uuidv7(), r2);
        await repos.forum.insertComment(uuidv7(), r1);
        const replies = await repos.forum.listComments(topic, {
          sort: 'new',
          limit: 10,
          parentId: parent.id,
        });
        assert.deepEqual(
          replies.items.map((c) => c.id),
          [r1.id, r2.id],
        );
        assert.equal((await repos.forum.getComment(topic, parent.id))?.reply_count, 2);
      } finally {
        await repos.close();
      }
    });

    test('one upvote per pseudonym, and un-voting is idempotent', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const c = comment(topic);
        await repos.forum.insertComment(uuidv7(), c);
        assert.deepEqual(await repos.forum.setVote(topic, c.id, pseudo(9), true), {
          upvotes: 1,
          changed: true,
        });
        assert.deepEqual(await repos.forum.setVote(topic, c.id, pseudo(9), true), {
          upvotes: 1,
          changed: false,
        });
        assert.deepEqual(await repos.forum.setVote(topic, c.id, pseudo(10), true), {
          upvotes: 2,
          changed: true,
        });
        assert.deepEqual(await repos.forum.setVote(topic, c.id, pseudo(9), false), {
          upvotes: 1,
          changed: true,
        });
        assert.deepEqual(await repos.forum.setVote(topic, c.id, pseudo(9), false), {
          upvotes: 1,
          changed: false,
        });
        assert.deepEqual([...(await repos.forum.votedBy(topic, [c.id], pseudo(10)))], [c.id]);
        assert.equal(
          await repos.forum.setVote(topic, uuidv7(), pseudo(9), true),
          null,
          'no such comment',
        );
      } finally {
        await repos.close();
      }
    });

    test('"top" orders by upvotes', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const quiet = comment(topic);
        const popular = comment(topic);
        await repos.forum.insertComment(uuidv7(), quiet);
        await repos.forum.insertComment(uuidv7(), popular);
        for (let i = 0; i < 3; i++)
          await repos.forum.setVote(topic, popular.id, pseudo(100 + i), true);
        const top = await repos.forum.listComments(topic, { sort: 'top', limit: 10 });
        assert.deepEqual(
          top.items.map((c) => c.id),
          [popular.id, quiet.id],
        );
      } finally {
        await repos.close();
      }
    });

    test(`reports from ${REPORTS_TO_HOLD} different people hold a comment; one person reporting twice counts once`, async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const c = comment(topic);
        await repos.forum.insertComment(uuidv7(), c);
        assert.deepEqual(await repos.forum.report(topic, c.id, pseudo(1), 'spam'), {
          counted: true,
          held: false,
        });
        assert.deepEqual(await repos.forum.report(topic, c.id, pseudo(1), 'spam'), {
          counted: false,
          held: false,
        });
        for (let i = 2; i < REPORTS_TO_HOLD; i++)
          await repos.forum.report(topic, c.id, pseudo(i), 'abuse');
        assert.deepEqual(await repos.forum.report(topic, c.id, pseudo(99), 'abuse'), {
          counted: true,
          held: true,
        });
        assert.equal(
          (await repos.forum.listComments(topic, { sort: 'new', limit: 10 })).items.length,
          0,
        );
        assert.ok(
          (await repos.forum.getComment(topic, c.id))?.moderation_reasons.includes('reported'),
        );
      } finally {
        await repos.close();
      }
    });

    test('an author can delete their own comment and no one else can', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        const author = uuidv7();
        const c = comment(topic);
        await repos.forum.insertComment(author, c);
        assert.equal(await repos.forum.deleteOwn(uuidv7(), topic, c.id), false);
        assert.equal(await repos.forum.deleteOwn(author, topic, c.id), true);
        const after = await repos.forum.getComment(topic, c.id);
        assert.equal(after?.state, 'deleted');
        assert.equal(after?.body, '');
        assert.equal(await repos.forum.deleteOwn(author, topic, c.id), false, 'already deleted');
      } finally {
        await repos.close();
      }
    });

    test('erasure blanks the author’s comments in every thread and is safe to re-run', async () => {
      const repos = await open();
      try {
        const author = uuidv7();
        const [t1, t2] = [nextTopic(), nextTopic()];
        const a = comment(t1);
        const b = comment(t2);
        const other = comment(t1, { pseudonym: pseudo(77) });
        await repos.forum.insertComment(author, a);
        await repos.forum.insertComment(author, b);
        await repos.forum.insertComment(uuidv7(), other);
        assert.equal((await repos.forum.myComments(author, 10)).length, 2);

        assert.equal(await repos.forum.eraseAuthor(author), 2);
        assert.equal((await repos.forum.getComment(t1, a.id))?.body, '');
        assert.equal((await repos.forum.getComment(t2, b.id))?.state, 'deleted');
        assert.equal(
          (await repos.forum.getComment(t1, other.id))?.body,
          other.body,
          'others are untouched',
        );
        assert.equal((await repos.forum.myComments(author, 10)).length, 0);
        assert.equal(await repos.forum.eraseAuthor(author), 0);
      } finally {
        await repos.close();
      }
    });

    test('digests round-trip', async () => {
      const repos = await open();
      try {
        const topic = nextTopic();
        assert.equal(await repos.forum.getDigest(topic), null);
        const digest = {
          topic_id: topic,
          what_people_think: 'Most residents say the drains are not cleared before the monsoon.',
          main_concerns: ['Waterlogging'],
          what_needs_to_be_done: [
            { action: 'Desilt drains before June', support: 'many' as const },
          ],
          overall_tone: 'mostly_negative' as const,
          sentiment: { negative: 0.7, neutral: 0.2, positive: 0.1 },
          needs: [{ need: 'sanitation' as const, share: 0.8 }],
          based_on_comments: 12,
          method: 'extractive' as const,
          model: null,
          generated_at: new Date().toISOString(),
        };
        await repos.forum.putDigest(digest);
        assert.deepEqual(await repos.forum.getDigest(topic), digest);
      } finally {
        await repos.close();
      }
    });
  });

  describe(`document contract: ${name}`, () => {
    const doc = (overrides: Partial<NewDocument>): NewDocument => ({
      content_hash: `h-${uuidv7()}`,
      source_id: 'tg-goir',
      source_name: 'Telangana GO register',
      kind: 'government_order',
      subject: null,
      title: 'An order',
      url: 'https://example.gov.in/go.pdf',
      published_on: '2026-09-10',
      snippet: null,
      go_number: null,
      go_type: 'Ms',
      gazette_number: null,
      department: null,
      amount_rupees: null,
      vacancies: null,
      closing_on: null,
      jurisdiction_region_id: 1,
      primary_region_id: 1,
      primary_region_path: [1],
      geo_confidence: 0.5,
      geo_region_ids: [],
      discussable: true,
      provenance: 'official',
      needs_ocr: false,
      ...overrides,
    });

    test('upsert is idempotent by content hash and keeps the topic link', async () => {
      const repos = await open();
      try {
        const d = doc({});
        const first = await repos.documents.upsertDocuments([d]);
        assert.equal(first.inserted, 1);
        const id = first.ids.get(d.content_hash) as number;
        await repos.documents.linkTopic(id, 42);
        const again = await repos.documents.upsertDocuments([
          { ...d, title: 'An order (corrigendum)', source_id: 'mirror', source_name: 'A mirror' },
        ]);
        assert.equal(again.updated, 1);
        const row = await repos.documents.getDocument(id);
        assert.equal(row?.title, 'An order (corrigendum)');
        assert.equal(row?.topic_id, 42);
        assert.equal(row?.source_id, 'tg-goir', 'attribution stays with the first source');
      } finally {
        await repos.close();
      }
    });

    test('a region sees what is scoped to its path, and what names it — not its neighbours', async () => {
      const repos = await open();
      try {
        // Needs region rows for the foreign keys; Postgres covers this path in the seeded e2e run.
        if (name === 'postgres') return;
        // Region ids unique to this run, so a shared database's other rows cannot interfere.
        const base = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
        const [india, tg, ghmc, ward, otherWard] = [base, base + 1, base + 2, base + 3, base + 4];
        const mine = [india, tg, ghmc, ward];
        const { ids } = await repos.documents.upsertDocuments([
          doc({
            content_hash: `a${base}`,
            title: 'City drains',
            primary_region_id: ghmc,
            primary_region_path: [india, tg, ghmc],
            jurisdiction_region_id: tg,
          }),
          doc({
            content_hash: `b${base}`,
            title: 'Other ward road',
            primary_region_id: otherWard,
            primary_region_path: [india, tg, ghmc, otherWard],
            jurisdiction_region_id: tg,
          }),
          doc({
            content_hash: `c${base}`,
            title: 'Names my ward',
            primary_region_id: tg,
            primary_region_path: [india, tg],
            jurisdiction_region_id: tg,
            geo_region_ids: [ward],
          }),
        ]);
        void ids;
        const titles = (await repos.documents.listForRegion(mine, { limit: 10 }))
          .map((d) => d.title)
          .sort();
        assert.deepEqual(titles, ['City drains', 'Names my ward']);
      } finally {
        await repos.close();
      }
    });

    test('open jobs: closing today or later, or undated and recent', async () => {
      const repos = await open();
      try {
        if (name === 'postgres') return;
        await repos.documents.upsertDocuments([
          doc({
            kind: 'job_notification',
            title: 'Open',
            closing_on: '2026-10-30',
            vacancies: 100,
          }),
          doc({
            kind: 'job_notification',
            title: 'Closed',
            closing_on: '2026-09-01',
            vacancies: 50,
          }),
          doc({ kind: 'job_notification', title: 'Undated recent', published_on: '2026-09-15' }),
          doc({ kind: 'job_notification', title: 'Undated stale', published_on: '2026-05-01' }),
          doc({ kind: 'government_order', title: 'Not a job' }),
        ]);
        const open = (await repos.documents.openJobs([1], '2026-09-27')).map((d) => d.title).sort();
        assert.deepEqual(open, ['Open', 'Undated recent']);
      } finally {
        await repos.close();
      }
    });
  });
}
