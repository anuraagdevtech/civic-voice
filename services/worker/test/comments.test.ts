import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import type { CommentEvent } from '@civic-voice/contracts';
import { handleFor, uuidv7 } from '@civic-voice/core';
import { createMemoryCacheTier, type CacheTier } from '@civic-voice/cache';
import { createMemoryRepositories, type MemoryRepositories } from '@civic-voice/db';
import { createMemoryAnalyticsStore, type MemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import { ClaudeAnalyzer, trainSeedModel, type TrainedModel } from '@civic-voice/nlp';
import { CommentPipeline } from '../src/pipelines/comments.ts';

/**
 * The comment pipeline end to end on in-memory adapters: what gets published, what is held, what the
 * analytics store may and may not see, and that redelivery changes nothing.
 */
describe('comment pipeline', () => {
  let model: TrainedModel;
  let repos: MemoryRepositories;
  let cache: CacheTier;
  let analytics: MemoryAnalyticsStore;
  const TOPIC = 31;
  const PATH = [1, 10, 100, 1001];
  const NOW = new Date('2026-09-27T12:00:00Z');

  before(() => {
    model = trainSeedModel();
  });

  beforeEach(() => {
    repos = createMemoryRepositories();
    cache = createMemoryCacheTier();
    analytics = createMemoryAnalyticsStore();
    repos.catalogue.putRegion({
      id: 1,
      parent_id: null,
      kind: 'country',
      path: [1],
      name: 'India',
      population: null,
      codes: {},
    });
    repos.catalogue.putRegion({
      id: 10,
      parent_id: 1,
      kind: 'state',
      path: [1, 10],
      name: 'Telangana',
      population: null,
      codes: {},
    });
    repos.catalogue.putRegion({
      id: 100,
      parent_id: 10,
      kind: 'city',
      path: [1, 10, 100],
      name: 'Greater Hyderabad',
      population: null,
      codes: {},
    });
    repos.catalogue.putTopic({
      id: TOPIC,
      kind: 'government_order',
      status: 'active',
      jurisdiction_region_id: 100,
      authority_id: null,
      scheme_id: null,
      title: 'Storm water drains in Greater Hyderabad',
      summary: null,
      effective_from: '2026-09-12',
      source_refs: [],
    });
  });

  const pipeline = (claude: ClaudeAnalyzer | null = null, escalationsPerMinute?: number) =>
    new CommentPipeline({
      ...(escalationsPerMinute === undefined ? {} : { escalationsPerMinute }),
      repos,
      cache,
      analytics,
      bus: createMemoryEventBus({ autoDeliver: false }),
      model,
      claude,
      analyticsKey: 'test-analytics-key-at-least-32-characters',
      metrics: createMetrics(),
      logger: createTestLogger(),
      now: () => NOW,
    });

  let seq = 0;
  const event = (body: string, over: Partial<CommentEvent> = {}): CommentEvent => {
    const pseudonym = (++seq).toString(16).padStart(32, '0');
    return {
      comment_id: uuidv7(),
      citizen_id: uuidv7(),
      topic_id: TOPIC,
      parent_id: null,
      occurred_at: '2026-09-27T11:47:13.512Z',
      body,
      pseudonym,
      handle: handleFor(pseudonym),
      region_path: PATH,
      area_region_id: 1001,
      area: 'Khairatabad',
      region_basis: 'device',
      verification_tier: 1,
      demographics: { age_band: '18-24', occupation_band: 'student' },
      ...over,
    };
  };
  const envelopes = (events: CommentEvent[]) =>
    events.map((value, i) => ({
      topic: 'civic.comment.v1',
      partition: 0,
      offset: String(i),
      key: String(value.topic_id),
      value,
    }));

  test('publishes an ordinary comment with its analysis and author area', async () => {
    const e = event(
      'The drains near our colony overflow every monsoon and nobody from GHMC comes to clean them.',
    );
    const stats = await pipeline().handleBatch(envelopes([e]));
    assert.deepEqual(stats, { inserted: 1, published: 1, held: 0, rejected: 0 });
    const stored = await repos.forum.getComment(TOPIC, e.comment_id);
    assert.equal(stored?.state, 'published');
    assert.equal(stored?.area, 'Khairatabad');
    assert.equal(stored?.located, true);
    assert.equal(stored?.sentiment, -1);
    assert.ok(stored?.needs.includes('sanitation'), `needs were ${stored?.needs}`);
  });

  test('a comment with personal information is rejected and its text not kept', async () => {
    // The API refuses these synchronously; this is the backstop for anything that slips past it.
    const e = event(
      'Call the contractor directly on 9876543210, he never picks up for the ward office.',
    );
    await pipeline().handleBatch(envelopes([e]));
    const stored = await repos.forum.getComment(TOPIC, e.comment_id);
    assert.equal(stored?.state, 'rejected');
    assert.equal(stored?.body, '');
    assert.equal(
      analytics.commentEvents.size,
      0,
      'refused comments say nothing about public opinion',
    );
  });

  test('the analytics row carries no body, no comment id, no pseudonym, and only the hour', async () => {
    const e = event(
      'We need more buses on the Ameerpet route, students wait an hour every morning.',
    );
    await pipeline().handleBatch(envelopes([e]));
    const [row] = [...analytics.commentEvents.values()];
    assert.ok(row);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(e.comment_id));
    assert.ok(!serialised.includes(e.pseudonym));
    assert.ok(!serialised.includes(e.citizen_id));
    assert.ok(!serialised.includes('Ameerpet route'));
    assert.equal(row.hour, '2026-09-27T11:00:00.000Z');
    assert.deepEqual(row.demographics, { age_band: '18-24', occupation_band: 'student' });
  });

  test('redelivery changes nothing: one comment, one analytics row, one trending bump', async () => {
    const e = event(
      'Please desilt the nala before June, every year the same flooding on the main road.',
    );
    const p = pipeline();
    await p.handleBatch(envelopes([e]));
    const second = await p.handleBatch(envelopes([e]));
    assert.equal(second.inserted, 0);
    assert.equal(await repos.forum.countPublished(TOPIC), 1);
    assert.equal(analytics.commentEvents.size, 1);
    const counts = await cache.trending.commentsLast24h([TOPIC], NOW);
    assert.equal(counts.get(TOPIC), 1);
  });

  test('trending is bumped in every region on the topic’s jurisdiction path', async () => {
    await pipeline().handleBatch(
      envelopes([event('Roads in our ward are full of potholes after the rains, please repair.')]),
    );
    for (const region of [1, 10, 100]) {
      assert.equal(
        (await cache.trending.top(region, 5, NOW))[0]?.topicId,
        TOPIC,
        `region ${region}`,
      );
    }
    assert.deepEqual(await cache.trending.top(20, 5, NOW), [], 'not in another state');
  });

  test('a digest appears once the thread is large enough, and says how it was made', async () => {
    const p = pipeline();
    const bodies = [
      'The drains overflow every monsoon, GHMC must desilt them before June.',
      'Waterlogging on the main road for three days, nobody came.',
      'Garbage blocks the nala, that is why it floods. Clear it regularly.',
      'Good that money is sanctioned but last year work was not completed.',
      'Sewage mixes with drinking water during floods, children fall sick.',
      'Please publish the contractor list and completion dates ward-wise.',
      'Drains near the school are open, it is dangerous for kids.',
      'Every year the same story, sanction then nothing happens on ground.',
      'The new drain on our street is good work, finished on time.',
    ];
    await p.handleBatch(envelopes(bodies.map((b) => event(b))));
    await p.drain();
    assert.equal(
      await repos.forum.getDigest(TOPIC),
      null,
      `${bodies.length} comments is below the threshold`,
    );

    await p.handleBatch(
      envelopes([event('We need proper drainage in Khairatabad, the roads become rivers.')]),
    );
    await p.drain();
    const digest = await repos.forum.getDigest(TOPIC);
    assert.ok(digest);
    assert.equal(digest.method, 'extractive');
    assert.equal(digest.model, null);
    assert.equal(digest.based_on_comments, 10);
    assert.ok(
      digest.sentiment.negative > 0.5,
      `mostly critical, got ${JSON.stringify(digest.sentiment)}`,
    );
    assert.equal(digest.needs[0]?.need, 'sanitation');
  });

  test('uncertain comments are escalated, and the large model’s labels win', async () => {
    const requests: unknown[] = [];
    const fetchStub = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ content: string }>;
      };
      requests.push(body);
      const ids = [
        ...String(body.messages[0]?.content ?? '').matchAll(/<comment id="([^"]+)">/g),
      ].map((m) => m[1]);
      const results = ids.map((id) => ({
        id,
        sentiment: 'positive',
        needs: ['education'],
        suggestion: true,
        suggestion_text: 'More libraries',
      }));
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: JSON.stringify({ results }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const claude = new ClaudeAnalyzer({
      client: new Anthropic({ apiKey: 'test-key', fetch: fetchStub, maxRetries: 0 }),
      model: 'claude-test',
    });
    // Too short and too unfamiliar for the in-house model to be sure of; a clear complaint is not.
    const unsure = event('hmm ok');
    const clear = event(
      'The drains overflow every monsoon and nobody from the corporation comes to clean them.',
    );
    await pipeline(claude).handleBatch(envelopes([unsure, clear]));
    assert.equal(requests.length, 1, 'one batched request');
    const sent = JSON.stringify(requests[0]);
    assert.ok(
      sent.includes(unsure.comment_id) && !sent.includes(clear.comment_id),
      'only the uncertain comment is sent',
    );
    const stored = await repos.forum.getComment(TOPIC, unsure.comment_id);
    assert.equal(stored?.sentiment, 1);
    assert.deepEqual(stored?.needs, ['education']);
    assert.match(stored?.model ?? '', /\+claude-test$/);
  });

  test('escalation stops at the budget; the rest keep their in-house labels', async () => {
    let sent = 0;
    const counting = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages: Array<{ content: string }>;
      };
      const ids = [
        ...String(body.messages[0]?.content ?? '').matchAll(/<comment id="([^"]+)">/g),
      ].map((m) => m[1]);
      sent += ids.length;
      const results = ids.map((id) => ({
        id,
        sentiment: 'neutral',
        needs: [],
        suggestion: false,
        suggestion_text: null,
      }));
      return new Response(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: JSON.stringify({ results }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const claude = new ClaudeAnalyzer({
      client: new Anthropic({ apiKey: 'test-key', fetch: counting, maxRetries: 0 }),
      model: 'claude-test',
    });
    const events = Array.from({ length: 5 }, () => event('hmm ok'));
    const stats = await pipeline(claude, 2).handleBatch(envelopes(events));
    assert.equal(stats.inserted, 5, 'every comment is still stored');
    assert.equal(sent, 2);
  });

  test('an unavailable large model changes nothing but the label source', async () => {
    const failing = (async () =>
      new Response('overloaded', { status: 529 })) as unknown as typeof fetch;
    const claude = new ClaudeAnalyzer({
      client: new Anthropic({ apiKey: 'test-key', fetch: failing, maxRetries: 0 }),
      model: 'claude-test',
    });
    const e = event('hmm ok');
    const stats = await pipeline(claude).handleBatch(envelopes([e]));
    assert.equal(stats.inserted, 1);
    assert.match((await repos.forum.getComment(TOPIC, e.comment_id))?.model ?? '', /^nb-lr-/);
  });
});
