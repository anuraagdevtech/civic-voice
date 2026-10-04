import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryRepositories,
  seedMemoryGeography,
  type MemoryRepositories,
} from '@civic-voice/db';
import { SOURCES, sourceById, type SourceSpec } from '@civic-voice/ingest';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import { Ingestor } from '../src/ingestor.ts';
import {
  indicatorFileSchema,
  loadIndicators,
  periodStart,
  SAMPLE_INDICATORS,
} from '../src/indicators.ts';

describe('ingestor (fixtures)', () => {
  let repos: MemoryRepositories;
  let ids: Map<string, number>;
  const id = (key: string) => ids.get(key) as number;

  beforeEach(() => {
    repos = createMemoryRepositories({ now: () => new Date('2026-09-27T12:00:00Z') });
    ids = seedMemoryGeography(repos.catalogue);
  });

  const ingestor = () =>
    Ingestor.create({
      repos,
      logger: createTestLogger(),
      metrics: createMetrics(),
      mode: 'fixtures',
    });

  test('every source ingests, and fixture documents are marked sample — never official', async () => {
    const ing = await ingestor();
    for (const spec of SOURCES) {
      const r = await ing.runSource(spec);
      assert.ok(r.health.items > 0, `${spec.id} yielded nothing`);
      assert.ok(
        r.documents.every((d) => d.provenance === 'sample'),
        `${spec.id} produced non-sample documents from fixtures`,
      );
    }
    assert.equal((await repos.documents.sourceHealth()).length, SOURCES.length);
  });

  test('a Telangana GO about Greater Hyderabad becomes a Greater Hyderabad topic', async () => {
    const ing = await ingestor();
    await ing.runSource(sourceById('tg-goir') as SourceSpec);
    assert.ok((await ing.promote()) >= 2);
    const topics = await repos.catalogue.listTopics({
      regionId: id('IN-TG-GHMC-khairatabad'),
      limit: 50,
    });
    const drains = topics.find((t) => t.title.startsWith('G.O.Ms.No.145'));
    assert.ok(drains, 'titled with its GO number');
    assert.equal(drains.kind, 'government_order');
    assert.equal(
      drains.jurisdiction_region_id,
      id('IN-TG-GHMC'),
      'scoped to the city, not the whole state',
    );
    // A resident of Warangal (Telangana, outside the city) is not asked about Hyderabad's drains…
    const stateOnly = await repos.catalogue.listTopics({ regionId: id('IN-TG'), limit: 50 });
    assert.ok(!stateOnly.some((t) => t.id === drains.id));
    // …but is asked about the statewide farmers' scheme.
    assert.ok(stateOnly.some((t) => t.title.startsWith('G.O.Ms.No.33')));
  });

  test('routine orders, tenders and job notifications are indexed but not put up for discussion', async () => {
    const ing = await ingestor();
    await ing.runSource(sourceById('tg-goir') as SourceSpec);
    await ing.runSource(sourceById('tg-tgpsc') as SourceSpec);
    await ing.promote();
    const topics = await repos.catalogue.listTopics({
      regionId: id('IN-TG-GHMC-khairatabad'),
      limit: 50,
    });
    assert.ok(!topics.some((t) => t.title.includes('Transfers and postings')));
    assert.ok(!topics.some((t) => t.title.includes('Group-IV')));
    const jobs = await repos.documents.openJobs([id('IN'), id('IN-TG')], '2026-09-27');
    assert.ok(jobs.some((j) => j.vacancies === 8180));
  });

  test('promotion is idempotent: a document becomes one topic however often it runs', async () => {
    const ing = await ingestor();
    await ing.runSource(sourceById('thehindu-hyderabad') as SourceSpec);
    const first = await ing.promote();
    await ing.runSource(sourceById('thehindu-hyderabad') as SourceSpec);
    assert.equal(await ing.promote(), 0);
    assert.ok(first > 0);
  });

  test('news topics carry the link and a short snippet, never the article', async () => {
    const ing = await ingestor();
    await ing.runSource(sourceById('thehindu-hyderabad') as SourceSpec);
    await ing.promote();
    const topics = await repos.catalogue.listTopics({
      regionId: id('IN-TG-GHMC'),
      kind: 'news',
      limit: 10,
    });
    assert.ok(topics.length > 0);
    for (const t of topics) {
      assert.ok((t.summary ?? '').length <= 281);
      assert.equal(t.source_refs.length, 1);
    }
  });
});

describe('indicators', () => {
  test('period labels sort by when they start; financial years start in April', () => {
    assert.equal(periodStart('2025-26'), '2025-04-01');
    assert.equal(periodStart('2026-08'), '2026-08-01');
    assert.equal(periodStart('2025'), '2025-01-01');
    assert.equal(periodStart('Q3 2026'), '2026-07-01');
    assert.throws(() => periodStart('FY26'));
  });

  test('every figure needs a source URL', () => {
    const bad = { indicators: [{ ...SAMPLE_INDICATORS.indicators[0], source_url: 'not a url' }] };
    assert.throws(() => indicatorFileSchema.parse(bad));
  });

  test('the sample set loads, every value marked sample, and the latest two per series come back', async () => {
    const repos = createMemoryRepositories();
    const ids = seedMemoryGeography(repos.catalogue);
    const { loaded, skipped } = await loadIndicators(repos, SAMPLE_INDICATORS);
    assert.ok(loaded > 10);
    assert.deepEqual(skipped, []);
    const rows = await repos.documents.indicators([
      ids.get('IN') as number,
      ids.get('IN-TG') as number,
    ]);
    assert.ok(rows.every((r) => r.provenance === 'sample'));
    const budget = rows.filter(
      (r) => r.code === 'budget_total_expenditure' && r.region_id === ids.get('IN-TG'),
    );
    assert.deepEqual(
      budget.map((r) => r.period),
      ['2026-27', '2025-26'],
    );
  });

  test('an observation for an unknown region is skipped and reported, not guessed', async () => {
    const repos = createMemoryRepositories();
    seedMemoryGeography(repos.catalogue);
    const file = indicatorFileSchema.parse({
      indicators: [
        {
          ...SAMPLE_INDICATORS.indicators[0],
          observations: [{ region: 'IN-XX', period: '2025-26', value: 1 }],
        },
      ],
    });
    const { loaded, skipped } = await loadIndicators(repos, file);
    assert.equal(loaded, 0);
    assert.equal(skipped[0]?.region, 'IN-XX');
  });
});
