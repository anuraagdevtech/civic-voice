import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { incrementsFrom, mutationsFor } from '@civic-voice/core';
import type { SentimentEvent } from '@civic-voice/contracts';
import type { CacheTier } from '../src/ports.ts';

/**
 * One conformance suite, run against **both** the in-memory and the Redis implementations.
 *
 * ADR-0006 accepts in-memory adapters only on the condition that they are held to the same
 * behavioural contract as the real ones — an adapter that quietly diverges from Redis is worse than
 * no adapter, because it makes the test suite actively misleading.
 */
export function runCacheTierContract(name: string, make: () => Promise<CacheTier> | CacheTier) {
  /** Every tier must be ready before use; the Redis one is not usable the instant it is created. */
  const makeTier = async (): Promise<CacheTier> => {
    const tier = await make();
    await tier.ready();
    return tier;
  };

  /**
   * Topic ids are namespaced per run. A real Redis persists between runs, so fixed ids would make
   * counters accumulate across invocations and the suite would pass once and then fail forever.
   */
  const ns = Math.floor(Math.random() * 1_000_000) * 100;
  const T = (n: number) => ns + n;

  const event = (over: Partial<SentimentEvent> = {}): SentimentEvent => ({
    event_id: `0194f0a0-0000-7000-8000-${String(Math.random()).slice(2, 14)}`,
    citizen_id: `0194f0a0-0000-7000-8000-${String(Math.random()).slice(2, 14)}`,
    occurred_at: new Date().toISOString(),
    topic_id: T(0),
    region_path: [1, 10, 105, 1052],
    pseudonym: 'a'.repeat(32),
    verification_tier: 2,
    demographics: { age_band: '25-34', gender: 'female' },
    mood: -1,
    intensity: 4,
    reason_code: 'poor_implementation',
    delta: 1,
    replaces: null,
    ...over,
  });

  describe(`cache tier contract: ${name}`, () => {
    describe('counter store', () => {
      test('derives n and mean mood from the histogram it stores', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(1), mood: -1, intensity: 4 }))),
          );
          const slice = await tier.counters.readSlice({
            topicId: T(1),
            regionId: 105,
            dim: 0,
            tiers: [2],
          });
          assert.equal(slice.total.n, 1);
          assert.equal(slice.total.sumMood, -1);
          assert.equal(slice.total.sumIntensity, 4);
          assert.deepEqual(slice.total.histogram, [0, 1, 0, 0, 0]);
        } finally {
          await tier.close();
        }
      });

      test('accumulates across many submissions at every region level', async () => {
        const tier = await makeTier();
        try {
          for (let i = 0; i < 5; i += 1) {
            await tier.counters.apply(
              incrementsFrom(mutationsFor(event({ topic_id: T(2), mood: 2, intensity: 5 }))),
            );
          }
          for (const regionId of [1, 10, 105, 1052]) {
            const slice = await tier.counters.readSlice({
              topicId: T(2),
              regionId,
              dim: 0,
              tiers: [2],
            });
            assert.equal(slice.total.n, 5, `region ${regionId}`);
            assert.equal(slice.total.sumMood, 10);
          }
        } finally {
          await tier.close();
        }
      });

      test('a changed opinion does not inflate the cohort', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(3), mood: -2, intensity: 5 }))),
          );
          await tier.counters.apply(
            incrementsFrom(
              mutationsFor(
                event({
                  topic_id: T(3),
                  mood: 2,
                  intensity: 3,
                  replaces: { mood: -2, intensity: 5, reason_code: 'no_reason' },
                }),
              ),
            ),
          );
          const slice = await tier.counters.readSlice({
            topicId: T(3),
            regionId: 105,
            dim: 0,
            tiers: [2],
          });
          assert.equal(slice.total.n, 1, 'still one person');
          assert.deepEqual(slice.total.histogram, [0, 0, 0, 0, 1], 'moved to satisfied');
          assert.equal(slice.total.sumIntensity, 3);
        } finally {
          await tier.close();
        }
      });

      test('sums the requested tiers and only those', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(4), verification_tier: 0 }))),
          );
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(4), verification_tier: 2 }))),
          );
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(4), verification_tier: 3 }))),
          );

          const publicView = await tier.counters.readSlice({
            topicId: T(4),
            regionId: 105,
            dim: 0,
            tiers: [2, 3],
          });
          assert.equal(publicView.total.n, 2, 'default public view is T2+');

          const everyone = await tier.counters.readSlice({
            topicId: T(4),
            regionId: 105,
            dim: 0,
            tiers: [0, 1, 2, 3],
          });
          assert.equal(everyone.total.n, 3);
        } finally {
          await tier.close();
        }
      });

      test('keeps demographic dimensions separate and consistent with the total', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(
            incrementsFrom(
              mutationsFor(
                event({ topic_id: T(5), demographics: { age_band: '25-34', gender: 'female' } }),
              ),
            ),
          );
          await tier.counters.apply(
            incrementsFrom(
              mutationsFor(
                event({ topic_id: T(5), demographics: { age_band: '65+', gender: 'female' } }),
              ),
            ),
          );

          const age = await tier.counters.readSlice({
            topicId: T(5),
            regionId: 105,
            dim: 1,
            tiers: [2],
          });
          assert.equal(age.buckets.length, 2);
          assert.equal(age.buckets.find((b) => b.bucket === '25-34')?.n, 1);
          assert.equal(age.buckets.find((b) => b.bucket === '65+')?.n, 1);

          const gender = await tier.counters.readSlice({
            topicId: T(5),
            regionId: 105,
            dim: 2,
            tiers: [2],
          });
          assert.equal(gender.buckets.find((b) => b.bucket === 'female')?.n, 2);

          const total = await tier.counters.readSlice({
            topicId: T(5),
            regionId: 105,
            dim: 0,
            tiers: [2],
          });
          assert.equal(total.total.n, 2, 'marginals must agree with the total');
          assert.equal(age.total.n, total.total.n);
        } finally {
          await tier.close();
        }
      });

      test('an unknown slice reads empty rather than throwing', async () => {
        const tier = await makeTier();
        try {
          const slice = await tier.counters.readSlice({
            topicId: T(99),
            regionId: 1,
            dim: 0,
            tiers: [2],
          });
          assert.equal(slice.total.n, 0);
          assert.deepEqual(slice.buckets, []);
        } finally {
          await tier.close();
        }
      });

      test('reports staleness, and it is zero for a slice just written', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(incrementsFrom(mutationsFor(event({ topic_id: T(6) }))));
          const slice = await tier.counters.readSlice({
            topicId: T(6),
            regionId: 105,
            dim: 0,
            tiers: [2],
          });
          assert.ok(slice.stalenessSeconds >= 0 && slice.stalenessSeconds < 5);
        } finally {
          await tier.close();
        }
      });

      test('overwriteSlice replaces rather than merges, so reconciliation can repair drift', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply(
            incrementsFrom(mutationsFor(event({ topic_id: T(7), mood: -2 }))),
          );
          await tier.counters.overwriteSlice(T(7), 105, 0, 2, [
            {
              bucket: 'all',
              n: 500,
              sumMood: 250,
              sumIntensity: 1500,
              histogram: [0, 0, 250, 250, 0],
            },
          ]);
          const slice = await tier.counters.readSlice({
            topicId: T(7),
            regionId: 105,
            dim: 0,
            tiers: [2],
          });
          assert.equal(slice.total.n, 500, 'drifted value must be gone, not added to');
          assert.deepEqual(slice.total.histogram, [0, 0, 250, 250, 0]);
        } finally {
          await tier.close();
        }
      });

      test('applying nothing is a no-op, not an error', async () => {
        const tier = await makeTier();
        try {
          await tier.counters.apply([]);
        } finally {
          await tier.close();
        }
      });
    });

    describe('quota store', () => {
      test('allows a first write and then holds the topic on cooldown', async () => {
        const tier = await makeTier();
        try {
          const id = `citizen-${Math.random()}`;
          assert.equal((await tier.quotas.checkAndConsume(id, 1)).allowed, true);
          const second = await tier.quotas.checkAndConsume(id, 1);
          assert.equal(second.allowed, false);
          assert.equal(second.reason, 'cooldown_active');
          assert.ok((second.retryAfterSeconds ?? 0) > 0, 'must tell the client when to retry');
        } finally {
          await tier.close();
        }
      });

      test('the cooldown is per topic, so other topics stay open', async () => {
        const tier = await makeTier();
        try {
          const id = `citizen-${Math.random()}`;
          assert.equal((await tier.quotas.checkAndConsume(id, 1)).allowed, true);
          assert.equal((await tier.quotas.checkAndConsume(id, 2)).allowed, true);
        } finally {
          await tier.close();
        }
      });

      test('the token bucket runs out after the burst allowance', async () => {
        const tier = await makeTier();
        try {
          const id = `citizen-${Math.random()}`;
          let allowed = 0;
          let limited = 0;
          for (let topicId = 1; topicId <= 20; topicId += 1) {
            const d = await tier.quotas.checkAndConsume(id, topicId);
            if (d.allowed) allowed += 1;
            else if (d.reason === 'rate_limited') limited += 1;
          }
          assert.ok(allowed <= 11, `burst of 10 should not permit ${allowed} writes`);
          assert.ok(limited > 0, 'the bucket must actually run dry');
        } finally {
          await tier.close();
        }
      });

      test('quotas are per citizen, so one busy account does not block another', async () => {
        const tier = await makeTier();
        try {
          const a = `citizen-a-${Math.random()}`;
          const b = `citizen-b-${Math.random()}`;
          for (let topicId = 1; topicId <= 20; topicId += 1)
            await tier.quotas.checkAndConsume(a, topicId);
          assert.equal((await tier.quotas.checkAndConsume(b, 1)).allowed, true);
        } finally {
          await tier.close();
        }
      });
    });

    describe('idempotency store', () => {
      test('exactly one caller wins a key', async () => {
        const tier = await makeTier();
        try {
          const key = `idem-${Math.random()}`;
          const first = await tier.idempotency.claim(key, 'hash-1');
          assert.equal(first.claimed, true);
          const second = await tier.idempotency.claim(key, 'hash-1');
          assert.equal(second.claimed, false);
        } finally {
          await tier.close();
        }
      });

      test('replays the stored response to the loser once the winner completes', async () => {
        const tier = await makeTier();
        try {
          const key = `idem-${Math.random()}`;
          await tier.idempotency.claim(key, 'hash-1');
          await tier.idempotency.complete(key, '{"accepted":true}');
          const replay = await tier.idempotency.claim(key, 'hash-1');
          assert.equal(replay.claimed, false);
          assert.equal(replay.claimed === false && replay.response, '{"accepted":true}');
        } finally {
          await tier.close();
        }
      });

      test('a loser that arrives mid-flight gets no response yet, rather than a wrong one', async () => {
        const tier = await makeTier();
        try {
          const key = `idem-${Math.random()}`;
          await tier.idempotency.claim(key, 'hash-1');
          const inFlight = await tier.idempotency.claim(key, 'hash-1');
          assert.equal(inFlight.claimed === false && inFlight.response, null);
        } finally {
          await tier.close();
        }
      });

      test('flags a key reused for a different body instead of replaying the wrong answer', async () => {
        const tier = await makeTier();
        try {
          const key = `idem-${Math.random()}`;
          await tier.idempotency.claim(key, 'hash-1');
          const mismatched = await tier.idempotency.claim(key, 'hash-2');
          assert.equal(mismatched.claimed === false && mismatched.conflict, true);
        } finally {
          await tier.close();
        }
      });

      test('a released key can be claimed again, which is how a failed write is retried', async () => {
        const tier = await makeTier();
        try {
          const key = `idem-${Math.random()}`;
          await tier.idempotency.claim(key, 'hash-1');
          await tier.idempotency.release(key);
          assert.equal((await tier.idempotency.claim(key, 'hash-1')).claimed, true);
        } finally {
          await tier.close();
        }
      });
    });

    describe('pending opinion overlay', () => {
      test('round-trips the citizen’s own submission for read-your-write', async () => {
        const tier = await makeTier();
        try {
          const id = `citizen-${Math.random()}`;
          const opinion = {
            mood: 2 as const,
            intensity: 4,
            reason_code: 'benefits_me' as const,
            updated_at: new Date().toISOString(),
          };
          await tier.pending.put(id, 77, opinion);
          assert.deepEqual(await tier.pending.get(id, 77), opinion);
        } finally {
          await tier.close();
        }
      });

      test('returns null for a topic with nothing pending', async () => {
        const tier = await makeTier();
        try {
          assert.equal(await tier.pending.get(`citizen-${Math.random()}`, 77), null);
        } finally {
          await tier.close();
        }
      });

      test('getMany returns only the topics that have something pending', async () => {
        const tier = await makeTier();
        try {
          const id = `citizen-${Math.random()}`;
          const opinion = {
            mood: 0 as const,
            intensity: 3,
            reason_code: 'no_reason' as const,
            updated_at: new Date().toISOString(),
          };
          await tier.pending.put(id, 1, opinion);
          await tier.pending.put(id, 3, opinion);
          const many = await tier.pending.getMany(id, [1, 2, 3]);
          assert.deepEqual([...many.keys()].sort(), [1, 3]);
        } finally {
          await tier.close();
        }
      });

      test('getMany with no topics does not round-trip at all', async () => {
        const tier = await makeTier();
        try {
          assert.equal((await tier.pending.getMany('anyone', [])).size, 0);
        } finally {
          await tier.close();
        }
      });
    });

    describe('dedupe store', () => {
      test('marks an event once, so a redelivery is a no-op', async () => {
        const tier = await makeTier();
        try {
          const id = `event-${Math.random()}`;
          assert.equal(await tier.dedupe.markApplied(id), true);
          assert.equal(await tier.dedupe.markApplied(id), false, 'redelivery must not re-apply');
        } finally {
          await tier.close();
        }
      });

      test('markManyApplied returns only the ids that were new', async () => {
        const tier = await makeTier();
        try {
          const a = `event-a-${Math.random()}`;
          const b = `event-b-${Math.random()}`;
          await tier.dedupe.markApplied(a);
          assert.deepEqual(await tier.dedupe.markManyApplied([a, b]), [b]);
        } finally {
          await tier.close();
        }
      });

      test('an empty batch is a no-op', async () => {
        const tier = await makeTier();
        try {
          assert.deepEqual(await tier.dedupe.markManyApplied([]), []);
        } finally {
          await tier.close();
        }
      });
    });

    describe('trending', () => {
      test('scores decay with age, so a burst an hour ago outranks a bigger one a day ago', async () => {
        const tier = await makeTier();
        try {
          const region = T(51);
          const now = new Date('2026-09-27T12:30:00Z');
          const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
          await tier.trending.bump(T(1), [region], 10, 3, hoursAgo(1));
          await tier.trending.bump(T(2), [region], 30, 10, hoursAgo(20));
          await tier.trending.bump(T(3), [region], 100, 30, hoursAgo(30)); // outside the window
          const top = await tier.trending.top(region, 10, now);
          assert.deepEqual(
            top.map((t) => t.topicId),
            [T(1), T(2)],
          );
          assert.ok(Math.abs((top[0]?.score ?? 0) - 10 * 0.5 ** (1 / 6)) < 1e-6);
        } finally {
          await tier.close();
        }
      });

      test('one bump counts in every region on the path, and nowhere else', async () => {
        const tier = await makeTier();
        try {
          const now = new Date('2026-09-27T12:30:00Z');
          const [india, state, city, elsewhere] = [T(61), T(62), T(63), T(64)];
          await tier.trending.bump(T(5), [india, state, city], 3, 1, now);
          for (const r of [india, state, city])
            assert.equal((await tier.trending.top(r, 5, now))[0]?.topicId, T(5));
          assert.deepEqual(await tier.trending.top(elsewhere, 5, now), []);
        } finally {
          await tier.close();
        }
      });

      test('comments in the last 24 hours', async () => {
        const tier = await makeTier();
        try {
          const now = new Date('2026-09-27T12:30:00Z');
          await tier.trending.bump(T(7), [T(71)], 3, 2, new Date(now.getTime() - 2 * 3_600_000));
          await tier.trending.bump(T(7), [T(71)], 3, 1, now);
          await tier.trending.bump(T(7), [T(71)], 3, 5, new Date(now.getTime() - 26 * 3_600_000));
          const counts = await tier.trending.commentsLast24h([T(7), T(8)], now);
          assert.equal(counts.get(T(7)), 3);
          assert.equal(counts.get(T(8)), 0);
        } finally {
          await tier.close();
        }
      });
    });

    describe('forum limits', () => {
      test('allows up to the limit in a window, then refuses with a retry-after', async () => {
        const tier = await makeTier();
        try {
          const citizen = `c-${Math.random()}`;
          for (let i = 0; i < 3; i++)
            assert.equal(
              (await tier.forumLimits.consume(citizen, 'comment', 3, 3600)).allowed,
              true,
            );
          const refused = await tier.forumLimits.consume(citizen, 'comment', 3, 3600);
          assert.equal(refused.allowed, false);
          assert.ok(
            (refused.retryAfterSeconds ?? 0) > 0 && (refused.retryAfterSeconds ?? 0) <= 3600,
          );
          // Actions are budgeted separately.
          assert.equal((await tier.forumLimits.consume(citizen, 'report', 3, 3600)).allowed, true);
        } finally {
          await tier.close();
        }
      });
    });
  });
}
