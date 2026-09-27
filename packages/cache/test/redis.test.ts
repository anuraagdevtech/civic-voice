import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createRedisCacheTier, createRedisClient, waitUntilReady } from '../src/redis.ts';
import { runCacheTierContract } from './contract.ts';

/**
 * The Redis half of the conformance suite. Skipped unless a Redis is reachable, so `pnpm test` stays
 * daemon-free (ADR-0006) while CI runs this against the real engine on every PR.
 */
const url = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

const reachable = await (async () => {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 700,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
})();

if (!reachable) {
  describe('cache tier contract: redis', () => {
    test('skipped — no Redis reachable at REDIS_URL', (t) => t.skip());
  });
} else {
  runCacheTierContract('redis', () => createRedisCacheTier({ url }));

  // Behaviour that only exists on the real engine, and that the in-memory adapter cannot model.
  describe('redis-specific behaviour', () => {
    let redis: Redis;

    const openTier = async () => {
      const tier = createRedisCacheTier({ url });
      await tier.ready();
      return tier;
    };

    before(async () => {
      redis = createRedisClient({ url });
      await waitUntilReady(redis);
    });

    after(async () => {
      redis.disconnect();
    });

    test('the quota check is atomic under concurrency, not read-then-write', async () => {
      const tier = await openTier();
      try {
        const id = `race-${Math.random()}`;
        // Twelve concurrent writes against a burst of 10. A non-atomic implementation lets more
        // than 10 through, which is the hole a brigading script would drive at.
        const decisions = await Promise.all(
          Array.from({ length: 12 }, (_, i) => tier.quotas.checkAndConsume(id, i + 1)),
        );
        const allowed = decisions.filter((d) => d.allowed).length;
        assert.ok(allowed <= 10, `burst of 10 must not admit ${allowed} concurrent writes`);
        assert.ok(allowed >= 9, `expected close to the full burst, got ${allowed}`);
      } finally {
        await tier.close();
      }
    });

    test('exactly one of many concurrent claims on one idempotency key wins', async () => {
      const tier = await openTier();
      try {
        const key = `idem-race-${Math.random()}`;
        const claims = await Promise.all(
          Array.from({ length: 20 }, () => tier.idempotency.claim(key, 'same-hash')),
        );
        assert.equal(claims.filter((c) => c.claimed).length, 1);
      } finally {
        await tier.close();
      }
    });

    test('counter keys carry a TTL, so a cold slice cannot leak memory forever', async () => {
      const tier = await openTier();
      try {
        const topicId = 5_000_000 + Math.floor(Math.random() * 100_000);
        await tier.counters.apply([
          {
            key: { day: '2026-03-15', topicId, regionId: 105, dim: 0, bucket: 'all', tier: 2 },
            mood: 1,
            count: 1,
            intensity: 3,
          },
        ]);
        const ttl = await redis.ttl(`c:{${topicId}:105}:0:2`);
        assert.ok(ttl > 0, `expected a TTL, got ${ttl}`);
      } finally {
        await tier.close();
      }
    });

    test('a client that is already down closes without masking the original error', async () => {
      // `QUIT` is itself a command, so a naive close throws the very error that took us down.
      const tier = await openTier();
      await tier.close();
      await tier.close();
    });

    test('a slice’s tiers share a cluster slot, so one read is one round trip', () => {
      // The `{topic:region}` hash tag is what makes this true; without it a cluster read would fan
      // out across slots and cost a round trip per tier.
      const slots = new Set(
        [0, 1, 2, 3].map((tier) => {
          const key = `c:{900:105}:0:${tier}`;
          return key.slice(key.indexOf('{') + 1, key.indexOf('}'));
        }),
      );
      assert.equal(slots.size, 1, 'all tiers of a slice must hash to one slot');
    });

    test('readiness rejects loudly when there is nothing to connect to', async () => {
      // A service must fail its readiness probe rather than accept traffic it cannot serve.
      const dead = createRedisClient({ url: 'redis://127.0.0.1:6399' });
      await assert.rejects(() => waitUntilReady(dead, 800));
      dead.disconnect();
    });
  });
}
