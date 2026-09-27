import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { incrementsFrom, mutationsFor, rollupKeyString, type RollupKey } from '../src/rollup.ts';
import type { SentimentEvent } from '@civic-voice/contracts';

/**
 * The merge is where a whole batch's arithmetic can go quietly wrong, so it is tested on its own.
 */
const key = (over: Partial<RollupKey> = {}): RollupKey => ({
  day: '2026-03-15',
  topicId: 1,
  regionId: 105,
  dim: 0,
  bucket: 'all',
  tier: 2,
  ...over,
});

const mut = (k: RollupKey, mood: number, intensity: number, delta: 1 | -1) => ({
  key: k,
  eventId: 'e',
  mood,
  intensity,
  delta,
});

describe('increment accumulation', () => {
  test('sums counts and intensity for the same key and mood', () => {
    const [inc] = incrementsFrom([mut(key(), 1, 3, 1), mut(key(), 1, 5, 1), mut(key(), 1, 4, 1)]);
    assert.equal(inc?.count, 3);
    assert.equal(inc?.intensity, 12, 'exact sum, not an average');
  });

  test('keeps different moods on the same key apart', () => {
    const out = incrementsFrom([mut(key(), 1, 3, 1), mut(key(), -2, 5, 1)]);
    assert.equal(out.length, 2, 'different histogram slots must not be merged');
    assert.deepEqual(out.map((i) => i.mood).sort(), [-2, 1]);
  });

  test('keeps different keys apart', () => {
    const out = incrementsFrom([
      mut(key({ regionId: 1 }), 1, 3, 1),
      mut(key({ regionId: 10 }), 1, 3, 1),
    ]);
    assert.equal(out.length, 2);
  });

  test('a cancelling pair with equal intensity drops out entirely', () => {
    assert.deepEqual(incrementsFrom([mut(key(), 1, 3, 1), mut(key(), 1, 3, -1)]), []);
  });

  test('a mood held at a NEW intensity still moves the mean', () => {
    // The lossy version of this merge threw the residual away, so a citizen who kept their mood but
    // raised their intensity silently had no effect.
    const out = incrementsFrom([mut(key(), 1, 5, 1), mut(key(), 1, 2, -1)]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.count, 0, 'the cohort did not change size');
    assert.equal(out[0]?.intensity, 3, 'but 5 − 2 of intensity was added');
  });

  test('a net-negative accumulation is representable', () => {
    const out = incrementsFrom([mut(key(), 1, 3, -1), mut(key(), 1, 3, -1)]);
    assert.equal(out[0]?.count, -2);
    assert.equal(out[0]?.intensity, -6);
  });

  test('a changed opinion across 28 keys merges to 56 increments, not 28', () => {
    const event: SentimentEvent = {
      event_id: '01a0e05b-1a3e-741e-aba4-0c6b30f05b83',
      citizen_id: '01a0e05b-1a3e-741e-aba4-0c6b30f05b84',
      occurred_at: '2026-03-15T10:00:00.000Z',
      topic_id: 1,
      region_path: [1, 10, 105, 1052],
      pseudonym: 'a'.repeat(32),
      verification_tier: 2,
      demographics: {
        age_band: '25-34',
        gender: 'female',
        urbanity: 'rural',
        income_band: 'middle',
        education_band: 'graduate',
        occupation_band: 'agriculture',
      },
      mood: 2,
      intensity: 3,
      reason_code: 'benefits_me',
      delta: 1,
      replaces: { mood: -2, intensity: 5, reason_code: 'no_reason' },
    };
    const out = incrementsFrom(mutationsFor(event));
    // Two distinct moods per key, so the 56 mutations collapse to 56 increments — nothing to merge.
    assert.equal(out.length, 56);
    const retractions = out.filter((i) => i.count === -1);
    const additions = out.filter((i) => i.count === 1);
    assert.equal(retractions.length, 28);
    assert.equal(additions.length, 28);
    assert.ok(retractions.every((i) => i.mood === -2 && i.intensity === -5));
    assert.ok(additions.every((i) => i.mood === 2 && i.intensity === 3));
  });

  test('a spike of identical submissions collapses hard — the headroom the worker gains', () => {
    // 500 citizens, same topic, same region, same bands, same mood: 500 × 28 = 14,000 mutations.
    const mutations = [];
    for (let i = 0; i < 500; i += 1) {
      for (const regionId of [1, 10, 105, 1052]) {
        for (const dim of [0, 1, 2, 3, 4, 5, 6]) {
          mutations.push(mut(key({ regionId, dim, bucket: dim === 0 ? 'all' : 'b' }), -2, 5, 1));
        }
      }
    }
    assert.equal(mutations.length, 14_000);
    const merged = incrementsFrom(mutations);
    assert.equal(merged.length, 28, 'collapses to one increment per counter slot');
    assert.equal(merged[0]?.count, 500, 'and carries the full count');
    assert.equal(merged[0]?.intensity, 2_500);
  });

  test('an empty batch produces nothing', () => {
    assert.deepEqual(incrementsFrom([]), []);
  });

  test('increments keep their key identity intact', () => {
    const k = key({ topicId: 42, dim: 3, bucket: 'urban' });
    const [inc] = incrementsFrom([mut(k, 0, 3, 1)]);
    assert.equal(rollupKeyString(inc?.key as RollupKey), rollupKeyString(k));
  });
});
