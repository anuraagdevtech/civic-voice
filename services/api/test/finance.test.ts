import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCacheTier } from '@civic-voice/cache';
import {
  createMemoryRepositories,
  seedMemoryGeography,
  type MemoryRepositories,
} from '@civic-voice/db';
import { createMemoryAnalyticsStore, type MemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import {
  financeResponseSchema,
  sectorInsightSchema,
  type CommentAnalyticsEvent,
  type Need,
  type VerificationTier,
} from '@civic-voice/contracts';
import { buildApp } from '../src/app.ts';
import { loadApiConfig } from '../src/config.ts';
import { loadFinance, SAMPLE_FINANCE } from '../../ingestor/src/finance.ts';

/** Public finances over HTTP: taxes by category, spending by sector, and the gap. */
describe('finance api', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repos: MemoryRepositories;
  let ids: Map<string, number>;
  let analytics: MemoryAnalyticsStore;
  const id = (key: string) => ids.get(key) as number;

  before(async () => {
    repos = createMemoryRepositories({ now: () => new Date('2026-09-27T12:00:00Z') });
    ids = seedMemoryGeography(repos.catalogue);
    await loadFinance(repos, SAMPLE_FINANCE);
    app = await buildApp({
      config: loadApiConfig({ ...process.env, CIVIC_TOKEN_SECRET: 't'.repeat(40) }),
      repos,
      cache: createMemoryCacheTier(),
      bus: createMemoryEventBus({ autoDeliver: false }),
      analytics: (analytics = createMemoryAnalyticsStore()),
      now: () => new Date('2026-09-27T12:00:00Z'),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });
  });

  after(async () => {
    await app.close();
  });

  const get = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/v1/finance?${query}` });
    return { status: res.statusCode, headers: res.headers, body: res.json() };
  };

  test('the Union: latest year, taxes by category, spending by sector, and the gap', async () => {
    const { status, headers, body } = await get(`region_id=${id('IN')}`);
    assert.equal(status, 200);
    const parsed = financeResponseSchema.parse(body);
    assert.equal(parsed.region_name, 'India');
    assert.deepEqual(parsed.available, [
      { fy: '2025-26', stages: ['BE'] },
      { fy: '2024-25', stages: ['RE'] },
    ]);
    const s = parsed.summary;
    assert.ok(s);
    assert.equal(s.fy, '2025-26');
    assert.equal(s.stage, 'BE');
    assert.equal(s.taxes.items[0]?.category, 'income_tax');
    assert.deepEqual(
      new Set(s.taxes.items.map((i) => i.category)),
      new Set(['income_tax', 'corporate_tax', 'gst', 'customs', 'excise', 'other_tax']),
    );
    for (const sector of [
      'infrastructure',
      'health',
      'education',
      'defence',
      'rural_development',
      'subsidies_welfare',
    ])
      assert.ok(
        s.spending.items.some((i) => i.category === sector),
        sector,
      );
    assert.equal(s.gap.amount, s.spending.total - s.taxes.total);
    assert.equal(s.gap.reconciles, true);
    assert.ok(s.gap.taxes_cover > 0.5 && s.gap.taxes_cover < 0.8);
    assert.ok(s.taxes.per_capita && s.taxes.per_capita > 10_000, 'rupees per person, not crore');
    assert.deepEqual(s.provenance, ['sample']);
    assert.equal(s.taxes.items[0]?.previous?.fy, '2024-25');
    assert.match(String(headers['cache-control']), /public, max-age=3600/);
  });

  test('a state: its own taxes, the Union’s share shown as a transfer, not as its tax', async () => {
    const { body } = await get(`region_id=${id('IN-TG')}`);
    const s = financeResponseSchema.parse(body).summary;
    assert.ok(s);
    assert.ok(!s.taxes.items.some((i) => i.category === 'income_tax'));
    assert.ok(s.gap.per_rupee.some((p) => p.group === 'from_union'));
  });

  test('an earlier year and stage on request; a missing one is a null summary, not an error', async () => {
    const earlier = financeResponseSchema.parse(
      (await get(`region_id=${id('IN')}&fy=2024-25&stage=RE`)).body,
    );
    assert.equal(earlier.summary?.fy, '2024-25');
    assert.equal(earlier.summary?.taxes.items[0]?.previous, null, 'no year before it loaded');

    const missing = await get(`region_id=${id('IN')}&fy=2024-25&stage=actual`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.summary, null);
    assert.equal(missing.body.available.length, 2);
  });

  test('a region with no figures says so; a malformed year is refused; an unknown region is 404', async () => {
    const ward = await get(`region_id=${id('IN-TG-GHMC-khairatabad')}`);
    assert.equal(ward.status, 200);
    assert.equal(ward.body.summary, null);
    assert.deepEqual(ward.body.available, []);

    assert.equal((await get(`region_id=${id('IN')}&fy=2025`)).status, 400);
    assert.equal((await get(`region_id=${id('IN')}&stage=vote`)).status, 400);
    assert.equal((await get('region_id=999999999')).status, 404);
  });

  describe('opinion against allocation', () => {
    let health: number[];
    let author = 0;
    const comment = (needs: Need[], sentiment: CommentAnalyticsEvent['sentiment']) => {
      author += 1;
      return {
        dedupe_key: author.toString(16).padStart(32, '0'),
        author_key: (author + 5_000_000).toString(16).padStart(32, '0'),
        hour: '2026-09-20T10:00:00.000Z',
        topic_id: 1,
        region_path: [id('IN'), id('IN-TG'), id('IN-TG-GHMC'), id('IN-TG-GHMC-khairatabad')],
        verification_tier: 2 as VerificationTier,
        demographics: {},
        sentiment,
        needs,
        suggestion: false,
        language: 'en',
      } satisfies CommentAnalyticsEvent;
    };
    /** `n` current opinions at one mood, as the worker's daily rollups record them. */
    const opinions = async (
      topicId: number,
      n: number,
      mood: -2 | 2,
      tier: VerificationTier,
      byAge?: Record<string, number>,
    ) => {
      const histogram = (count: number) =>
        [0, 1, 2, 3, 4].map((i) => (i === mood + 2 ? count : 0)) as [
          number,
          number,
          number,
          number,
          number,
        ];
      await analytics.insertRollups([
        {
          day: '2026-09-20',
          topicId,
          regionId: id('IN'),
          dim: 0,
          bucket: 'all',
          tier,
          n,
          sumIntensity: n * 3,
          histogram: histogram(n),
        },
        ...Object.entries(byAge ?? {}).map(([bucket, count]) => ({
          day: '2026-09-20',
          topicId,
          regionId: id('IN'),
          dim: 1,
          bucket,
          tier,
          n: count,
          sumIntensity: count * 3,
          histogram: histogram(count),
        })),
      ]);
    };

    before(async () => {
      health = [];
      for (const title of ['Ayushman Bharat above 70', 'New AIIMS in Hyderabad'])
        health.push(
          (
            await repos.catalogue.createTopic({
              kind: 'policy',
              jurisdiction_region_id: id('IN'),
              title,
              summary: null,
              effective_from: '2026-01-01',
              source_refs: [],
              sector: 'health',
            })
          ).id,
        );
      // A state decision: not the Union's, so not in the Union's mood.
      const stateTopic = await repos.catalogue.createTopic({
        kind: 'decision',
        jurisdiction_region_id: id('IN-TG'),
        title: 'Telangana: district hospitals',
        summary: null,
        effective_from: '2026-01-01',
        source_refs: [],
        sector: 'health',
      });
      await opinions(health[0] as number, 90, -2, 2, { '18-24': 30, '25-34': 30, '65+': 30 });
      // 18-24 is five people here: withheld, and 65+ with it (complementary suppression).
      await opinions(health[1] as number, 60, 2, 2, { '18-24': 5, '25-34': 30, '65+': 25 });
      await opinions(stateTopic.id, 500, 2, 2);
      await opinions(health[1] as number, 400, 2, 0); // anonymous: outside the default public view

      await analytics.insertCommentEvents([
        ...Array.from({ length: 60 }, () => comment(['health'], 'negative')),
        ...Array.from({ length: 30 }, () => comment(['water', 'sanitation'], 'neutral')),
        ...Array.from({ length: 40 }, () => comment(['employment'], 'negative')),
        ...Array.from({ length: 6 }, () => comment(['education'], 'neutral')),
        ...Array.from({ length: 30 }, () => comment(['corruption'], 'negative')),
      ]);
    });

    const sectors = async (query: string) => {
      const res = await app.inject({ method: 'GET', url: `/v1/insights/sectors?${query}` });
      return { status: res.statusCode, headers: res.headers, text: res.body };
    };

    test('spending, attention and mood, side by side, for one government', async () => {
      const { status, text } = await sectors(`region_id=${id('IN')}`);
      assert.equal(status, 200);
      const r = sectorInsightSchema.parse(JSON.parse(text));
      assert.equal(r.fy, '2025-26');
      assert.equal(r.tier, 2);
      const row = (s: string) => r.sectors.find((x) => x.sector === s);
      const h = row('health');
      assert.ok(h?.spending.share_of_programmes && h.spending.share_of_programmes < 0.1);
      assert.equal(h?.attention.voices, 60);
      assert.equal(h?.attention.negative_share, 1);
      assert.ok((h?.attention_minus_spending ?? 0) > 0.3, 'raised far more than funded');
      // Mood: the two Union topics at T2+, not the state's decision and not the anonymous crowd.
      assert.equal(h?.mood.topics, 2);
      assert.equal(h?.mood.topics_counted, 2);
      assert.equal(h?.mood.total.n, 150);
      assert.equal(h?.mood.total.mean_mood, -0.4);
      // Education: six voices — withheld, with a second group suppressed alongside it.
      assert.equal(row('education')?.attention.suppressed, true);
      assert.equal(r.sectors.filter((x) => x.attention.suppressed).length >= 2, true);
      assert.equal(r.unmapped.find((u) => u.need === 'corruption')?.comments, 30);
      assert.ok(r.method.some((m) => /associations, not causes/.test(m)));
      assert.deepEqual(r.provenance, ['sample']);
    });

    test('by a dimension, each topic gated before the sector is', async () => {
      const r = sectorInsightSchema.parse(
        JSON.parse((await sectors(`region_id=${id('IN')}&dimension=age_band`)).text),
      );
      const mood = r.sectors.find((x) => x.sector === 'health')?.mood;
      const b = (name: string) => mood?.buckets.find((x) => x.bucket === name);
      // Topic 2's five 18-24s are withheld there, so only topic 1's thirty reach the sector.
      assert.equal(b('18-24')?.n, 30);
      assert.equal(b('18-24')?.mean_mood, -2);
      assert.equal(b('25-34')?.n, 60);
      assert.equal(b('65+')?.n, 30, "topic 2's complementary-suppressed 65+ stays out too");
    });

    test('including unverified opinions is a choice the caller makes, and the response says so', async () => {
      const r = sectorInsightSchema.parse(
        JSON.parse((await sectors(`region_id=${id('IN')}&tier=0`)).text),
      );
      assert.equal(r.tier, 0);
      assert.equal(r.sectors.find((x) => x.sector === 'health')?.mood.total.n, 550);
    });

    test('as CSV: one row per sector, withheld cells empty rather than zero', async () => {
      const { status, headers, text } = await sectors(`region_id=${id('IN')}&format=csv`);
      assert.equal(status, 200);
      assert.match(String(headers['content-type']), /text\/csv/);
      const [header, ...rows] = text.trim().split('\n');
      assert.match(header ?? '', /^region_id,region,fy,stage,sector,spending_crore/);
      assert.equal(rows.length, 12);
      const education = rows.find((r) => r.split(',')[4] === 'education')?.split(',');
      assert.equal(education?.[7], '', 'attention share withheld, not 0');
    });

    test('bad parameters are refused; an unknown region is 404', async () => {
      assert.equal((await sectors(`region_id=${id('IN')}&dimension=caste`)).status, 400);
      assert.equal((await sectors(`region_id=${id('IN')}&days=3`)).status, 400);
      assert.equal((await sectors('region_id=999999999')).status, 404);
    });
  });
});
