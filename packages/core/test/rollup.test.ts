import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  maxKeysPerEvent,
  mutationsFor,
  parseRollupKey,
  presentDimensions,
  rollupKeyString,
  rollupKeysFor,
  TOTAL_BUCKET,
} from '../src/rollup.ts';
import { applyDelta, netApproval, polarisation, fromHistogram } from '../src/mood.ts';
import { emptyRawBucket } from '../src/anonymity.ts';
import { rollupAncestors, inJurisdiction, toLtree, fromLtree } from '../src/geo.ts';
import type { SentimentEvent } from '@civic-voice/contracts';

const fullEvent = (over: Partial<SentimentEvent> = {}): SentimentEvent => ({
  event_id: '0194f0a0-0000-7000-8000-000000000001',
  citizen_id: '0194f0a0-0000-7000-8000-000000000002',
  occurred_at: '2026-03-15T10:30:00.000Z',
  topic_id: 42,
  // country, state, district, constituency, ward — 5 deep
  region_path: [1, 10, 105, 1052, 10521],
  pseudonym: 'a'.repeat(32),
  verification_tier: 2,
  demographics: {
    age_band: '25-34',
    gender: 'female',
    urbanity: 'rural',
    income_band: 'lower_middle',
    education_band: 'graduate',
    occupation_band: 'agriculture',
  },
  mood: -1,
  intensity: 4,
  reason_code: 'poor_implementation',
  delta: 1,
  replaces: null,
  ...over,
});

describe('rollup fan-out', () => {
  test('a fully-specified event touches exactly 28 counters', () => {
    const keys = rollupKeysFor(fullEvent());
    assert.equal(keys.length, 28, 'the number docs/SCALING.md §5 is built on');
    assert.equal(maxKeysPerEvent(), 28);
  });

  test('fan-out stops at constituency: a ward is never a rollup level', () => {
    const regions = new Set(rollupKeysFor(fullEvent()).map((k) => k.regionId));
    assert.deepEqual(
      [...regions].sort((a, b) => a - b),
      [1, 10, 105, 1052],
    );
    assert.ok(!regions.has(10521), 'ward-level slices are k-suppressed anyway');
  });

  test('each region level gets one total bucket plus one bucket per dimension', () => {
    const keys = rollupKeysFor(fullEvent());
    for (const regionId of [1, 10, 105, 1052]) {
      const forRegion = keys.filter((k) => k.regionId === regionId);
      assert.equal(forRegion.length, 7);
      assert.equal(forRegion.filter((k) => k.dim === 0).length, 1);
      assert.equal(forRegion.find((k) => k.dim === 0)?.bucket, TOTAL_BUCKET);
      assert.equal(new Set(forRegion.map((k) => k.dim)).size, 7, 'dimensions must not collide');
    }
  });

  test('a declined dimension contributes to the total but to no bucket', () => {
    const keys = rollupKeysFor(fullEvent({ demographics: { age_band: '25-34', gender: 'male' } }));
    assert.equal(keys.length, 4 * 3, '4 regions × (total + 2 dimensions)');
    assert.equal(keys.filter((k) => k.dim === 0).length, 4);
  });

  test('a citizen who declined everything still counts in the totals', () => {
    const keys = rollupKeysFor(fullEvent({ demographics: {} }));
    assert.equal(keys.length, 4);
    assert.ok(keys.every((k) => k.dim === 0 && k.bucket === TOTAL_BUCKET));
  });

  test('a shallow region path produces proportionally fewer keys', () => {
    const keys = rollupKeysFor(fullEvent({ region_path: [1, 10] }));
    assert.equal(keys.length, 2 * 7);
  });

  test('the day bucket comes from the event time in UTC, not from now', () => {
    const keys = rollupKeysFor(fullEvent({ occurred_at: '2026-03-15T23:59:59.000Z' }));
    assert.ok(keys.every((k) => k.day === '2026-03-15'));
    const next = rollupKeysFor(fullEvent({ occurred_at: '2026-03-16T00:00:01.000Z' }));
    assert.ok(next.every((k) => k.day === '2026-03-16'));
  });

  test('keys round-trip through their string form', () => {
    for (const key of rollupKeysFor(fullEvent())) {
      assert.deepEqual(parseRollupKey(rollupKeyString(key)), key);
    }
  });

  test('presentDimensions reports only the bands the citizen supplied', () => {
    assert.deepEqual(presentDimensions({ gender: 'male', urbanity: 'urban' }), [
      'gender',
      'urbanity',
    ]);
    assert.deepEqual(presentDimensions({}), []);
  });
});

describe('rollup mutations', () => {
  test('a first-time opinion is a single +1 per key', () => {
    const mutations = mutationsFor(fullEvent());
    assert.equal(mutations.length, 28);
    assert.ok(mutations.every((m) => m.delta === 1));
  });

  test('a changed opinion emits a compensating pair, so nothing double-counts', () => {
    const mutations = mutationsFor(
      fullEvent({ mood: 2, replaces: { mood: -1, intensity: 4, reason_code: 'no_reason' } }),
    );
    assert.equal(mutations.length, 56, 'two mutations per key');

    const retractions = mutations.filter((m) => m.delta === -1);
    const additions = mutations.filter((m) => m.delta === 1);
    assert.equal(retractions.length, 28);
    assert.equal(additions.length, 28);
    assert.ok(
      retractions.every((m) => m.mood === -1),
      'retraction carries the OLD mood',
    );
    assert.ok(
      additions.every((m) => m.mood === 2),
      'addition carries the NEW mood',
    );
  });

  test('applying a change leaves the cohort size unchanged and moves the histogram', () => {
    let b = emptyRawBucket('all');
    // 3 people: two angry, one hopeful.
    b = applyDelta(b, -2, 5, 1);
    b = applyDelta(b, -2, 5, 1);
    b = applyDelta(b, 1, 3, 1);
    assert.equal(b.n, 3);
    assert.deepEqual(b.histogram, [2, 0, 0, 1, 0]);

    // One of the angry two changes their mind to satisfied: −1 old, +1 new.
    b = applyDelta(b, -2, 5, -1);
    b = applyDelta(b, 2, 4, 1);
    assert.equal(b.n, 3, 'the cohort did not grow');
    assert.deepEqual(b.histogram, [1, 0, 0, 1, 1]);
  });

  test('every mutation carries its event id, so redelivery can be deduped', () => {
    const event = fullEvent();
    assert.ok(mutationsFor(event).every((m) => m.eventId === event.event_id));
  });

  test('counters never go negative, even on a spurious retraction', () => {
    const b = applyDelta(emptyRawBucket('all'), 0, 3, -1);
    assert.equal(b.n, 0);
    assert.deepEqual(b.histogram, [0, 0, 0, 0, 0]);
  });
});

describe('mood arithmetic', () => {
  test('net approval is positive share minus negative share', () => {
    assert.equal(netApproval([0, 0, 0, 5, 5]), 1);
    assert.equal(netApproval([5, 5, 0, 0, 0]), -1);
    assert.equal(netApproval([0, 0, 10, 0, 0]), 0);
    assert.equal(netApproval([2, 2, 2, 2, 2]), 0);
    assert.equal(netApproval([0, 0, 0, 0, 0]), null);
  });

  test('polarisation separates "indifferent" from "split down the middle"', () => {
    // Both have a mean of 0, and they are opposite findings.
    const indifferent = [0, 0, 100, 0, 0] as const;
    const split = [50, 0, 0, 0, 50] as const;
    assert.equal(netApproval([...indifferent]), netApproval([...split]));
    assert.equal(polarisation([...indifferent]), 0);
    assert.equal(polarisation([...split]), 1);
  });

  test('a bucket can be rebuilt from its histogram, which is how drift gets repaired', () => {
    const rebuilt = fromHistogram('all', [2, 1, 0, 3, 4]);
    assert.equal(rebuilt.n, 10);
    assert.equal(rebuilt.sumMood, 2 * -2 + 1 * -1 + 3 * 1 + 4 * 2);
  });
});

describe('geo helpers', () => {
  test('rollup ancestors are the first four of the chain', () => {
    assert.deepEqual(rollupAncestors([1, 10, 105, 1052, 10521]), [1, 10, 105, 1052]);
    assert.deepEqual(rollupAncestors([1, 10]), [1, 10]);
    assert.deepEqual(rollupAncestors([]), []);
  });

  test('jurisdiction is an ancestor test, so a state policy cannot acquire a national mood', () => {
    const citizen = [1, 10, 105, 1052];
    assert.ok(inJurisdiction(citizen, 1), 'a national policy applies');
    assert.ok(inJurisdiction(citizen, 10), 'their own state applies');
    assert.equal(inJurisdiction(citizen, 11), false, 'another state does not');
  });

  test('ltree paths round-trip', () => {
    assert.equal(toLtree([1, 10, 105]), 'r1.r10.r105');
    assert.deepEqual(fromLtree('r1.r10.r105'), [1, 10, 105]);
    assert.deepEqual(fromLtree(''), []);
  });
});
