import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TOPICS, type SentimentEvent } from '@civic-voice/contracts';
import { uuidv7 } from '@civic-voice/core';
import { createMemoryCacheTier, type CacheTier } from '@civic-voice/cache';
import { createMemoryRepositories, type MemoryRepositories } from '@civic-voice/db';
import { createMemoryAnalyticsStore, type MemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus, type MemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import { Aggregator } from '../src/pipelines/aggregator.ts';

/**
 * The aggregation pipeline, end to end, with in-memory adapters (ADR-0006).
 *
 * The cases here are the ones that decide whether the published numbers are true: a changed opinion
 * must not inflate a cohort, a redelivered event must not double count, and identity must not reach
 * the analytical store.
 */
describe('aggregator', () => {
  let repos: MemoryRepositories;
  let cache: CacheTier;
  let analytics: MemoryAnalyticsStore;
  let bus: MemoryEventBus;
  let aggregator: Aggregator;

  const citizenId = uuidv7();

  beforeEach(async () => {
    repos = createMemoryRepositories();
    cache = createMemoryCacheTier();
    analytics = createMemoryAnalyticsStore();
    bus = createMemoryEventBus({ autoDeliver: false });
    aggregator = new Aggregator({
      repos, cache, analytics, bus,
      metrics: createMetrics(),
      logger: createTestLogger(),
    });
    await repos.citizens.create({
      id: citizenId,
      region_id: 1052,
      region_path: [1, 10, 105, 1052],
      locale: 'hi',
      demographics: { age_band: '25-34', gender: 'female' },
    });
  });

  const event = (over: Partial<SentimentEvent> = {}): SentimentEvent => ({
    event_id: uuidv7(),
    citizen_id: citizenId,
    occurred_at: '2026-03-15T10:00:00.000Z',
    topic_id: 7,
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

  const deliver = (...events: SentimentEvent[]) =>
    aggregator.handleBatch(
      events.map((value, i) => ({
        topic: EVENT_TOPICS.SENTIMENT,
        partition: 0,
        offset: String(i),
        key: String(value.topic_id),
        value,
      })),
    );

  const totalFor = (topicId: number, regionId: number) =>
    cache.counters.readSlice({ topicId, regionId, dim: 0, tiers: [2] });

  test('applies a first opinion to every rollup level', async () => {
    const stats = await deliver(event());
    assert.equal(stats.applied, 1);
    assert.equal(stats.mutations, 4 * 3, '4 regions × (total + 2 dimensions)');

    for (const regionId of [1, 10, 105, 1052]) {
      const slice = await totalFor(7, regionId);
      assert.equal(slice.total.n, 1, `region ${regionId}`);
      assert.deepEqual(slice.total.histogram, [0, 1, 0, 0, 0]);
    }
  });

  test('records the standing opinion on the citizen’s shard', async () => {
    await deliver(event());
    const current = await repos.sentiment.getCurrent(citizenId, 7);
    assert.equal(current?.mood, -1);
    assert.equal(current?.reason_code, 'poor_implementation');
  });

  test('CORRECTNESS: a changed opinion moves the histogram without growing the cohort', async () => {
    await deliver(event({ mood: -2, intensity: 5 }));
    // Note the second event carries `replaces: null`, exactly as the API emits it — resolving the
    // replacement is the worker's job, and this is the test that it does it.
    await deliver(event({ mood: 2, intensity: 3 }));

    const slice = await totalFor(7, 105);
    assert.equal(slice.total.n, 1, 'one citizen is still one citizen');
    assert.deepEqual(slice.total.histogram, [0, 0, 0, 0, 1], 'moved from angry to satisfied');
    assert.equal(slice.total.sumIntensity, 3, 'and carries the new intensity, not the sum of both');
  });

  test('a changed opinion is corrected in every demographic marginal too', async () => {
    await deliver(event({ mood: -2, intensity: 5 }));
    await deliver(event({ mood: 2, intensity: 3 }));

    const byAge = await cache.counters.readSlice({ topicId: 7, regionId: 105, dim: 1, tiers: [2] });
    const bucket = byAge.buckets.find((b) => b.bucket === '25-34');
    assert.equal(bucket?.n, 1);
    assert.deepEqual(bucket?.histogram, [0, 0, 0, 0, 1]);
  });

  test('REDELIVERY: the same event twice is applied once', async () => {
    const e = event();
    const first = await deliver(e);
    const second = await deliver(e);

    assert.equal(first.applied, 1);
    assert.equal(second.applied, 0);
    assert.equal(second.deduped, 1);
    assert.equal((await totalFor(7, 105)).total.n, 1, 'at-least-once delivery must not double count');
  });

  test('REDELIVERY: a duplicate inside one batch is applied once', async () => {
    const e = event();
    const stats = await deliver(e, e);
    assert.equal(stats.received, 2);
    assert.equal(stats.applied, 1);
    assert.equal((await totalFor(7, 105)).total.n, 1);
  });

  test('a redelivery that outlives the dedupe window is caught by the shard', async () => {
    const e = event();
    await deliver(e);
    // Simulate the dedupe entry having expired: the shard's stored event_id is the second line of
    // defence, and it is the authoritative one.
    await cache.dedupe.markApplied('unrelated');
    const replayed = await aggregator.handleBatch([
      { topic: EVENT_TOPICS.SENTIMENT, partition: 0, offset: '9', key: '7', value: e },
    ]);
    assert.equal(replayed.applied, 0);
    assert.equal((await totalFor(7, 105)).total.n, 1);
  });

  test('PRIVACY: the analytical store never receives a citizen id', async () => {
    await deliver(event());
    assert.equal(analytics.events.length, 1);
    const stored = analytics.events[0] as Record<string, unknown>;
    assert.equal('citizen_id' in stored, false);
    assert.equal(stored['pseudonym'], 'a'.repeat(32), 'only the per-topic pseudonym survives');
    // And nothing anywhere in the serialised row resembles the citizen id.
    assert.equal(JSON.stringify(analytics.events).includes(citizenId), false);
  });

  test('persists daily rollup rows for the time series', async () => {
    await deliver(event());
    assert.equal(analytics.rollups.length, 12, 'one row per counter touched');
    assert.ok(analytics.rollups.every((r) => r.day === '2026-03-15'));
    const total = analytics.rollups.filter((r) => r.dim === 0);
    assert.equal(total.length, 4, 'one total row per region level');
    assert.ok(total.every((r) => r.n === 1));
  });

  test('a changed opinion records the compensating pair in the daily rows', async () => {
    await deliver(event({ mood: -2, intensity: 5 }));
    analytics.rollups.length = 0;
    await deliver(event({ mood: 2, intensity: 3 }));

    const countryTotal = analytics.rollups.filter((r) => r.dim === 0 && r.regionId === 1);
    // SummingMergeTree sums these, so the day's net must be zero for the cohort and +1/−1 across the
    // histogram — otherwise the series would show a phantom extra participant.
    const netN = countryTotal.reduce((sum, r) => sum + r.n, 0);
    assert.equal(netN, 0, 'the day nets to no new participants');
    const netHistogram = [0, 1, 2, 3, 4].map((i) =>
      countryTotal.reduce((sum, r) => sum + (r.histogram[i] as number), 0),
    );
    assert.deepEqual(netHistogram, [-1, 0, 0, 0, 1], 'one left angry, one arrived satisfied');
  });

  test('merges a spike so the counter store sees far fewer writes than events', async () => {
    // 50 citizens, same topic, same region, same bands: the shape of a real spike.
    const events: SentimentEvent[] = [];
    for (let i = 0; i < 50; i += 1) {
      const id = uuidv7();
      await repos.citizens.create({
        id, region_id: 1052, region_path: [1, 10, 105, 1052], locale: 'hi',
        demographics: { age_band: '25-34', gender: 'female' },
      });
      events.push(event({ citizen_id: id, mood: -2, intensity: 5 }));
    }
    const stats = await deliver(...events);
    assert.equal(stats.applied, 50);
    assert.equal(stats.mutations, 50 * 12);
    assert.equal(stats.mergedKeys, 12, '600 mutations collapse to 12 counter writes');
    assert.equal((await totalFor(7, 105)).total.n, 50, 'and the count is still exact');
  });

  test('an empty batch is a no-op', async () => {
    const stats = await aggregator.handleBatch([]);
    assert.deepEqual(stats, { received: 0, deduped: 0, applied: 0, mutations: 0, mergedKeys: 0 });
  });

  test('tiers are kept separate, so the default public view can exclude the unverified', async () => {
    const anonymous = uuidv7();
    await repos.citizens.create({
      id: anonymous, region_id: 1052, region_path: [1, 10, 105, 1052], locale: 'en', demographics: {},
    });
    await deliver(event({ mood: 2 }), event({ citizen_id: anonymous, verification_tier: 0, mood: -2 }));

    const verified = await cache.counters.readSlice({ topicId: 7, regionId: 105, dim: 0, tiers: [2, 3] });
    const everyone = await cache.counters.readSlice({ topicId: 7, regionId: 105, dim: 0, tiers: [0, 1, 2, 3] });
    assert.equal(verified.total.n, 1);
    assert.equal(everyone.total.n, 2);
  });

  test('consuming through the bus reaches the same result as a direct batch', async () => {
    await aggregator.start();
    await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });
    await bus.drain();
    assert.equal((await totalFor(7, 105)).total.n, 1);
    await aggregator.stop();
  });
});
