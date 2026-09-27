import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TOPICS, type SentimentEvent } from '@civic-voice/contracts';
import { createMemoryEventBus } from '../src/memory.ts';
import { eventTopics, PRODUCTION_PARTITIONS } from '../src/ports.ts';

const event = (over: Partial<SentimentEvent> = {}): SentimentEvent => ({
  event_id: `0194f0a0-0000-7000-8000-${String(Math.random()).slice(2, 14)}`,
  citizen_id: `0194f0a0-0000-7000-8000-${String(Math.random()).slice(2, 14)}`,
  occurred_at: new Date().toISOString(),
  topic_id: 7,
  region_path: [1, 10, 105, 1052],
  pseudonym: 'a'.repeat(32),
  verification_tier: 2,
  demographics: {},
  mood: 1,
  intensity: 3,
  reason_code: 'no_reason',
  delta: 1,
  replaces: null,
  ...over,
});

describe('topic specification', () => {
  test('defaults to the production partition counts when nothing is set', () => {
    const topics = eventTopics({});
    assert.equal(
      topics.find((t) => t.topic === EVENT_TOPICS.SENTIMENT)?.partitions,
      PRODUCTION_PARTITIONS.sentiment,
    );
    // An unset variable must give the RIGHT answer, not a convenient one: partition count is the
    // ceiling on consumer parallelism, and getting it wrong only shows up under load.
    assert.equal(PRODUCTION_PARTITIONS.sentiment, 256);
  });

  test('can be lowered for a single-node development broker', () => {
    const topics = eventTopics({ CIVIC_SENTIMENT_PARTITIONS: '8' });
    assert.equal(topics.find((t) => t.topic === EVENT_TOPICS.SENTIMENT)?.partitions, 8);
  });

  test('rejects a nonsensical override rather than silently defaulting', () => {
    assert.throws(() => eventTopics({ CIVIC_SENTIMENT_PARTITIONS: 'lots' }), RangeError);
    assert.throws(() => eventTopics({ CIVIC_SENTIMENT_PARTITIONS: '0' }), RangeError);
    assert.throws(() => eventTopics({ CIVIC_SENTIMENT_PARTITIONS: '-4' }), RangeError);
  });

  test('every topic the services use is declared', () => {
    const declared = new Set(eventTopics({}).map((t) => t.topic));
    for (const topic of Object.values(EVENT_TOPICS)) {
      assert.ok(declared.has(topic), `${topic} is used but never provisioned`);
    }
  });
});

describe('event bus', () => {
  test('keys by topic id, so one topic’s events land on one partition', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false, partitions: 8 });
    const partitions = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const result = await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });
      partitions.add(result.partition);
    }
    // This is what lets a consumer aggregate a topic's deltas with no cross-partition coordination.
    assert.equal(partitions.size, 1);
    await bus.close();
  });

  test('different topics spread across partitions', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false, partitions: 8 });
    const partitions = new Set<number>();
    for (let topicId = 1; topicId <= 40; topicId += 1) {
      const result = await bus.producer.publish(
        EVENT_TOPICS.SENTIMENT,
        event({ topic_id: topicId }),
        { key: String(topicId) },
      );
      partitions.add(result.partition);
    }
    assert.ok(partitions.size > 1, 'load must actually spread, or partitioning buys nothing');
    await bus.close();
  });

  test('delivers published events to a subscriber in order', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false });
    const seen: number[] = [];
    const consumer = bus.consumer('test-group');
    await consumer.subscribe<SentimentEvent>(EVENT_TOPICS.SENTIMENT, async (batch) => {
      for (const envelope of batch) seen.push(envelope.value.topic_id);
    });

    for (const topicId of [1, 2, 3]) {
      await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event({ topic_id: topicId }), {
        key: String(topicId),
      });
    }
    await bus.drain();
    assert.deepEqual(seen, [1, 2, 3]);
    await bus.close();
  });

  test('a new group starts at the head rather than replaying all history', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false });
    await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });

    let delivered = 0;
    const consumer = bus.consumer('late-group');
    await consumer.subscribe(EVENT_TOPICS.SENTIMENT, async (batch) => {
      delivered += batch.length;
    });
    await bus.drain();
    assert.equal(delivered, 0, 'a consumer joining mid-flight must not replay the whole log');
    await bus.close();
  });

  test('a throwing handler leaves the batch to be redelivered', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false });
    let attempts = 0;
    const consumer = bus.consumer('flaky');
    await consumer.subscribe(EVENT_TOPICS.SENTIMENT, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    });

    await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });
    // Offsets advance only after the handler resolves; this is the at-least-once behaviour the
    // dedupe layer exists to absorb.
    await assert.rejects(() => bus.drain());
    await bus.drain();
    assert.equal(attempts, 2);
    await bus.close();
  });

  test('reports lag for undelivered messages', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false, partitions: 4 });
    const consumer = bus.consumer('lagging');
    await consumer.subscribe(EVENT_TOPICS.SENTIMENT, async () => {});
    for (let i = 0; i < 5; i += 1) {
      await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });
    }
    const lag = await consumer.lag();
    assert.equal(
      [...lag.values()].reduce((a, b) => a + b, 0),
      5,
    );
    await bus.drain();
    assert.equal(
      [...(await consumer.lag()).values()].reduce((a, b) => a + b, 0),
      0,
    );
    await bus.close();
  });

  test('rewind replays from an offset, for testing redelivery explicitly', async () => {
    const bus = createMemoryEventBus({ autoDeliver: false });
    let delivered = 0;
    const consumer = bus.consumer('replayer');
    await consumer.subscribe(EVENT_TOPICS.SENTIMENT, async (batch) => {
      delivered += batch.length;
    });
    await bus.producer.publish(EVENT_TOPICS.SENTIMENT, event(), { key: '7' });
    await bus.drain();
    bus.rewind(EVENT_TOPICS.SENTIMENT, 'replayer', 0);
    await bus.drain();
    assert.equal(delivered, 2, 'the same event delivered twice, as a real redelivery would');
    await bus.close();
  });
});
