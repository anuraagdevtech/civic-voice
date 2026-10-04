import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FiscalCategory } from '@civic-voice/contracts';
import { emptyRawBucket, type RawBucket } from '../src/anonymity.ts';
import type { FiscalFigure } from '../src/finance.ts';
import {
  sectorNeedGroups,
  summariseSectors,
  UNMAPPED_NEEDS,
  type GroupFigures,
  type SectorTopicSlice,
} from '../src/sectors.ts';

const K = 25;
const fig = (category: FiscalCategory, amount: number, fy = '2025-26'): FiscalFigure => ({
  region_id: 1,
  fy,
  stage: 'BE',
  category,
  amount,
  source_name: 'Budget at a Glance',
  source_url: 'https://www.indiabudget.gov.in/',
  provenance: 'official',
});
const FIGURES = [
  fig('health', 100),
  fig('education', 200),
  fig('agriculture', 700),
  fig('interest', 5_000), // committed: never in the programme shares
  fig('gst', 9_000),
  fig('health', 80, '2024-25'),
];

/** A bucket of `n` opinions, all at `mood`. */
const raw = (bucket: string, n: number, mood: -2 | -1 | 0 | 1 | 2): RawBucket => {
  const b = emptyRawBucket(bucket);
  b.n = n;
  b.sumMood = n * mood;
  b.sumIntensity = n * 3;
  b.histogram[mood + 2] = n;
  return b;
};
const group = (voices: number, comments: number, negative = 0): GroupFigures => ({
  voices,
  comments,
  negative,
  neutral: comments - negative,
  positive: 0,
});
const topic = (
  topicId: number,
  sector: SectorTopicSlice['sector'],
  total: RawBucket | undefined,
  buckets: RawBucket[] = [],
): SectorTopicSlice => ({ topicId, sector, total, buckets, quarantined: new Set() });

describe('opinion against allocation: spending', () => {
  test('programme shares exclude committed spending and taxes, and carry last year', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [],
      expectedBuckets: null,
      k: K,
    });
    assert.equal(r.fy, '2025-26');
    const health = r.rows.find((x) => x.sector === 'health');
    assert.equal(health?.spending.amount, 100);
    assert.equal(health?.spending.share_of_programmes, 0.1);
    assert.equal(health?.spending.previous_amount, 80);
    assert.equal(r.rows.find((x) => x.sector === 'defence')?.spending.amount, null);
    assert.ok(!r.rows.some((x) => (x.sector as string) === 'interest'));
  });
});

describe('opinion against allocation: attention', () => {
  test('shares are of sector mentions, comparable with spending shares, and the gap is signed', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: {
        voices: 200,
        groups: {
          health: group(60, 60, 30),
          education: group(40, 40),
          agriculture: group(100, 100),
        },
      },
      slices: [],
      expectedBuckets: null,
      k: K,
    });
    const health = r.rows.find((x) => x.sector === 'health');
    assert.equal(health?.attention.share, 0.3);
    assert.equal(health?.attention.negative_share, 0.5);
    assert.ok(
      Math.abs((health?.attention_minus_spending ?? 0) - 0.2) < 1e-9,
      'raised 30%, funded 10%',
    );
    const agri = r.rows.find((x) => x.sector === 'agriculture');
    assert.ok((agri?.attention_minus_spending ?? 0) < 0, 'funded 70%, raised 50%');
  });

  test('a sector raised by fewer than k people is withheld — and so is a second, so it cannot be subtracted', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: {
        voices: 200,
        groups: { health: group(10, 12), education: group(30, 30), agriculture: group(160, 160) },
      },
      slices: [],
      expectedBuckets: null,
      k: K,
    });
    const by = (s: string) => r.rows.find((x) => x.sector === s)?.attention;
    assert.equal(by('health')?.suppressed, true);
    assert.equal(by('health')?.comments, null);
    assert.equal(by('education')?.suppressed, true, 'complementary: the next smallest goes too');
    assert.equal(by('agriculture')?.suppressed, false);
    assert.equal(by('police_justice')?.share, 0, 'nobody raised it: a zero identifies nobody');
  });

  test('without an analytical store, attention is suppressed rather than zero', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [],
      expectedBuckets: null,
      k: K,
    });
    assert.ok(r.rows.every((x) => x.attention.suppressed && x.attention.share === null));
  });

  test('needs with no budget head are reported beside the sectors, gated the same way', () => {
    assert.deepEqual(UNMAPPED_NEEDS, ['corruption', 'environment']);
    const groups = sectorNeedGroups();
    assert.deepEqual(groups['water_sanitation'], ['water', 'sanitation']);
    assert.deepEqual(groups['corruption'], ['corruption']);
    const r = summariseSectors({
      figures: FIGURES,
      comments: {
        voices: 130,
        groups: {
          corruption: group(40, 45),
          environment: group(3, 3),
          health: group(57, 57),
          education: group(30, 30),
        },
      },
      slices: [],
      expectedBuckets: null,
      k: K,
    });
    assert.equal(r.unmapped.find((u) => u.need === 'corruption')?.comments, 45);
    assert.equal(r.unmapped.find((u) => u.need === 'environment')?.comments, null);
    // Environment's three are withheld, and education — the smallest other group — with them.
    assert.equal(r.rows.find((x) => x.sector === 'education')?.attention.suppressed, true);
  });
});

describe('opinion against allocation: mood', () => {
  test('topics are gated one by one before they are combined', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [
        topic(1, 'health', raw('all', 40, -2)),
        topic(2, 'health', raw('all', 30, 2)),
        topic(3, 'health', raw('all', 10, -2)), // below k on its own: never enters the sum
        topic(4, 'health', undefined),
      ],
      expectedBuckets: null,
      k: K,
    });
    const mood = r.rows.find((x) => x.sector === 'health')?.mood;
    assert.equal(mood?.topics, 4);
    assert.equal(mood?.topics_counted, 2);
    assert.equal(mood?.total.n, 70);
    assert.equal(mood?.total.mean_mood, Math.round(((40 * -2 + 30 * 2) / 70) * 100) / 100);
    assert.deepEqual(mood?.buckets, []);
  });

  test('a bucket suppressed in its topic stays out of the sector, and the sector is gated again', () => {
    const young = (n: number, mood: -2 | 2) => raw('18-24', n, mood);
    const old = (n: number, mood: -2 | 2) => raw('65+', n, mood);
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [
        // Topic 1: 18-24 has 5 people — suppressed there, so it must not reappear in the sum.
        topic(1, 'education', raw('all', 60, 2), [young(5, -2), old(55, 2)]),
        topic(2, 'education', raw('all', 60, 2), [young(30, 2), old(30, 2)]),
      ],
      expectedBuckets: ['18-24', '25-34', '65+'],
      k: K,
    });
    const mood = r.rows.find((x) => x.sector === 'education')?.mood;
    const b = (name: string) => mood?.buckets.find((x) => x.bucket === name);
    // Topic 1's gate withheld 18-24 and, complementarily, 65+ — so only topic 2 contributes to either.
    assert.equal(b('18-24')?.n, 30);
    assert.equal(
      b('18-24')?.mean_mood,
      2,
      'the five unhappy young people in topic 1 are not in here',
    );
    assert.equal(b('65+')?.n, 30);
    assert.equal(mood?.total.n, 120);
  });

  test('a group withheld in every topic is withheld in the sector — never shown as zero', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [topic(1, 'health', raw('all', 40, 1), [raw('18-24', 30, 1), raw('65+', 10, 1)])],
      expectedBuckets: ['18-24', '65+'],
      k: K,
    });
    const mood = r.rows.find((x) => x.sector === 'health')?.mood;
    assert.equal(mood?.total.n, 40);
    for (const b of mood?.buckets ?? []) assert.equal(b.suppressed, true, b.bucket);
  });

  test('a sector whose counted opinions are below k publishes nothing', () => {
    const r = summariseSectors({
      figures: FIGURES,
      comments: null,
      slices: [topic(1, 'agriculture', raw('all', 12, 1))],
      expectedBuckets: null,
      k: K,
    });
    const mood = r.rows.find((x) => x.sector === 'agriculture')?.mood;
    assert.equal(mood?.total.suppressed, true);
    assert.equal(mood?.total.mean_mood, null);
  });
});
