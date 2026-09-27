import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCacheTier } from '@civic-voice/cache';
import {
  createMemoryRepositories,
  seedMemoryGeography,
  type MemoryRepositories,
} from '@civic-voice/db';
import { createMemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import { financeResponseSchema } from '@civic-voice/contracts';
import { buildApp } from '../src/app.ts';
import { loadApiConfig } from '../src/config.ts';
import { loadFinance, SAMPLE_FINANCE } from '../../ingestor/src/finance.ts';

/** Public finances over HTTP: taxes by category, spending by sector, and the gap. */
describe('finance api', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repos: MemoryRepositories;
  let ids: Map<string, number>;
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
      analytics: createMemoryAnalyticsStore(),
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
});
