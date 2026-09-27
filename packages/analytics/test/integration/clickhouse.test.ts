import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CommentAnalyticsEvent } from '@civic-voice/contracts';
import { createClickHouseAnalyticsStore } from '../../src/clickhouse.ts';
import { createMemoryAnalyticsStore } from '../../src/memory.ts';
import type { RawBucket } from '@civic-voice/core';
import type { AnalyticsStore, CommentInsightQuery, DailyRollupRow } from '../../src/ports.ts';

/**
 * Cohort insights on real ClickHouse, compared with the in-memory store on the same rows. The two must
 * agree exactly: the k-anonymity gate is applied to `voices`, so a disagreement is a privacy bug, not
 * a rounding difference.
 */
const store = createClickHouseAnalyticsStore();
const reachable = await store
  .ready()
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  describe('comment insights and topic slices: clickhouse', () => {
    test('skipped — no migrated ClickHouse reachable (run node packages/analytics/src/cli/migrate.ts)', (t) =>
      t.skip());
  });
} else {
  describe('comment insights: clickhouse', () => {
    // Region ids unique to this run, so rows from earlier runs cannot be counted.
    const base = 900_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const [india, state, city, ward] = [base, base + 1, base + 2, base + 3];
    const hex = (n: number) => n.toString(16).padStart(32, '0');
    const row = (i: number, over: Partial<CommentAnalyticsEvent> = {}): CommentAnalyticsEvent => ({
      dedupe_key: hex(base * 1000 + i),
      author_key: hex(base * 1000 + 500 + (i % 30)),
      hour: '2026-09-27T11:00:00.000Z',
      topic_id: 7_000 + (i % 3),
      region_path: [india, state, city, ward],
      verification_tier: 1,
      demographics:
        i % 2 === 0
          ? { age_band: '18-24', occupation_band: 'student' }
          : { age_band: '45-54', occupation_band: 'agriculture' },
      sentiment: i % 5 === 0 ? 'positive' : 'negative',
      needs: i % 2 === 0 ? ['employment', 'education'] : ['agriculture'],
      suggestion: i % 4 === 0,
      language: 'en',
      ...over,
    });
    const rows = Array.from({ length: 60 }, (_, i) => row(i));

    const both = async (query: CommentInsightQuery) => {
      const memory: AnalyticsStore = createMemoryAnalyticsStore();
      await memory.insertCommentEvents(rows);
      return { ch: await store.commentInsights(query), mem: await memory.commentInsights(query) };
    };

    test('inserts, and redelivery is counted once', async () => {
      await store.insertCommentEvents(rows);
      await store.insertCommentEvents(rows.slice(0, 10)); // redelivered, not yet merged away
      const { ch } = await both({ regionId: city, filter: null, since: '2026-09-01T00:00:00Z' });
      assert.equal(ch.comments, 60);
    });

    test('agrees with the in-memory store: everyone, by region level', async () => {
      for (const regionId of [india, state, city, ward]) {
        const { ch, mem } = await both({
          regionId,
          filter: null,
          since: '2026-09-01T00:00:00Z',
          topTopics: 3,
        });
        assert.deepEqual(ch, mem, `region level ${regionId - base}`);
      }
    });

    test('agrees on a cohort: youth, and farmers', async () => {
      for (const filter of [
        { age_band: ['18-24', '25-34'] },
        { occupation_band: ['agriculture'] },
      ]) {
        const { ch, mem } = await both({
          regionId: city,
          filter,
          since: '2026-09-01T00:00:00Z',
          topTopics: 5,
        });
        assert.deepEqual(ch, mem, JSON.stringify(filter));
        assert.ok(ch.voices > 0 && ch.voices <= 30);
      }
    });

    test('agrees on need groups: voices, comments and tone per sector, in the same scan', async () => {
      const needGroups = {
        education: ['education'],
        agriculture: ['agriculture'],
        labour_employment: ['employment'],
        water_sanitation: ['water', 'sanitation'],
      } as const;
      const { ch, mem } = await both({
        regionId: state,
        filter: null,
        since: '2026-09-01T00:00:00Z',
        needGroups,
      });
      assert.deepEqual(ch.groups, mem.groups);
      assert.equal(ch.groups['water_sanitation']?.comments, 0);
      assert.ok((ch.groups['agriculture']?.voices ?? 0) > 0);
    });

    test('the time window excludes older hours', async () => {
      const { ch } = await both({ regionId: city, filter: null, since: '2026-09-27T12:00:00Z' });
      assert.equal(ch.comments, 0);
    });
  });

  describe('topic slices: clickhouse', () => {
    const topicBase = 800_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const regionId = topicBase + 7;
    const rollup = (
      topicId: number,
      dim: number,
      bucket: string,
      tier: 0 | 2,
      h: [number, number, number, number, number],
    ): DailyRollupRow => ({
      day: '2026-09-27',
      topicId,
      regionId,
      dim,
      bucket,
      tier,
      n: h.reduce((a, b) => a + b, 0),
      sumIntensity: 3 * h.reduce((a, b) => a + b, 0),
      histogram: h,
    });
    const rows = [
      rollup(topicBase, 0, 'all', 2, [10, 0, 0, 5, 20]),
      rollup(topicBase, 0, 'all', 0, [0, 0, 7, 0, 0]),
      rollup(topicBase, 1, '18-24', 2, [10, 0, 0, 0, 0]),
      rollup(topicBase, 1, '65+', 2, [0, 0, 0, 5, 20]),
      rollup(topicBase + 1, 0, 'all', 2, [1, 1, 1, 1, 1]),
      // Another day for the same slice: summed, as the rollup is.
      { ...rollup(topicBase + 1, 0, 'all', 2, [1, 0, 0, 0, 0]), day: '2026-09-26' },
    ];

    test('agrees with the in-memory store, across topics, tiers and days', async () => {
      await store.insertRollups(rows);
      const memory = createMemoryAnalyticsStore();
      await memory.insertRollups(rows);
      for (const [dim, tiers] of [
        [0, [2, 3]],
        [0, [0, 1, 2, 3]],
        [1, [2, 3]],
      ] as const) {
        const query = { topicIds: [topicBase, topicBase + 1, topicBase + 2], regionId, dim, tiers };
        const sort = (m: Map<number, RawBucket[]>) =>
          [...m]
            .sort(([a], [b]) => a - b)
            .map(([t, bs]) => [t, [...bs].sort((a, b) => a.bucket.localeCompare(b.bucket))]);
        assert.deepEqual(
          sort(await store.topicSlices(query)),
          sort(await memory.topicSlices(query)),
          `dim ${dim}, tiers ${tiers.join('')}`,
        );
      }
      const all = await store.topicSlices({
        topicIds: [topicBase, topicBase + 1],
        regionId,
        dim: 0,
        tiers: [2, 3],
      });
      assert.equal(all.get(topicBase)?.[0]?.n, 35);
      assert.equal(all.get(topicBase + 1)?.[0]?.n, 6);
    });
  });
}
