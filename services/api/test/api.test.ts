import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCacheTier } from '@civic-voice/cache';
import { createMemoryRepositories, type MemoryRepositories } from '@civic-voice/db';
import { createMemoryEventBus, type MemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import { EVENT_TOPICS, type SentimentEvent } from '@civic-voice/contracts';
import { buildApp } from '../src/app.ts';
import { loadApiConfig } from '../src/config.ts';

/**
 * HTTP-level tests via `app.inject` — no port, no infrastructure, real routing and real validation.
 *
 * These cover the boundary behaviour that the service tests cannot: status codes, headers, cache
 * directives, and what an unauthenticated or malformed request gets back.
 */
describe('api', () => {
  // Inferred rather than annotated as `FastifyInstance`: passing a concrete pino logger narrows the
  // instance's generics, and the annotation would be a less precise, incompatible type.
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repos: MemoryRepositories;
  let bus: MemoryEventBus;

  const REGION = {
    id: 1052,
    parent_id: 105,
    kind: 'constituency',
    path: [1, 10, 105, 1052],
    name: 'Test AC',
    population: 500_000,
    codes: {},
  };
  const TOPIC = {
    id: 7,
    kind: 'policy',
    status: 'active',
    jurisdiction_region_id: 1,
    authority_id: 1,
    scheme_id: null,
    title: 'A national policy',
    summary: null,
    effective_from: '2026-01-01',
    source_refs: [],
  };

  before(async () => {
    repos = createMemoryRepositories();
    repos.catalogue.putRegion({
      id: 1,
      parent_id: null,
      kind: 'country',
      path: [1],
      name: 'India',
      population: 1_400_000_000,
      codes: {},
    });
    repos.catalogue.putRegion({
      id: 10,
      parent_id: 1,
      kind: 'state',
      path: [1, 10],
      name: 'Test State',
      population: 100_000_000,
      codes: {},
    });
    repos.catalogue.putRegion({
      id: 105,
      parent_id: 10,
      kind: 'district',
      path: [1, 10, 105],
      name: 'Test District',
      population: 4_000_000,
      codes: {},
    });
    repos.catalogue.putRegion(REGION);
    repos.catalogue.putRegion({
      id: 2000,
      parent_id: 1,
      kind: 'state',
      path: [1, 2000],
      name: 'Other State',
      population: 30_000_000,
      codes: {},
    });
    repos.catalogue.putTopic(TOPIC);
    repos.catalogue.putTopic({
      ...TOPIC,
      id: 8,
      jurisdiction_region_id: 2000,
      title: 'Another state’s policy',
    });
    repos.catalogue.putAuthority({
      id: 1,
      kind: 'union_ministry',
      name: 'Ministry of Test',
      region_id: 1,
      pio_contact: 'pio@test.gov.in',
      faa_contact: 'faa@test.gov.in',
    });

    bus = createMemoryEventBus({ autoDeliver: false });
    app = await buildApp({
      config: loadApiConfig({
        ...process.env,
        CIVIC_TOKEN_SECRET: 't'.repeat(40),
        CIVIC_TOPIC_COOLDOWN_SECONDS: '600',
      }),
      repos,
      cache: createMemoryCacheTier(),
      bus,
      logger: createTestLogger(),
      metrics: createMetrics(),
    });
  });

  after(async () => {
    await app.close();
  });

  const register = async (over: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/citizens',
      payload: { region_id: REGION.id, locale: 'hi', demographics: { age_band: '25-34' }, ...over },
    });
    return {
      status: res.statusCode,
      body: res.json() as { access_token: string; citizen: { id: string } },
    };
  };

  const submit = (token: string, payload: Record<string, unknown>, idem = `k-${Math.random()}`) =>
    app.inject({
      method: 'POST',
      url: '/v1/sentiment',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': idem },
      payload,
    });

  describe('health', () => {
    test('healthz is unauthenticated and cheap', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
    });

    test('readyz reports dependency health', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
    });

    test('metrics are exposed in Prometheus text format', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      assert.match(res.headers['content-type'] as string, /text\/plain/);
      assert.match(res.body, /# TYPE civic_http_requests_total counter/);
    });

    test('an unknown route returns a structured error, not an HTML page', async () => {
      const res = await app.inject({ method: 'GET', url: '/nope' });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, 'not_found');
    });
  });

  describe('registration', () => {
    test('registers a citizen and returns a token', async () => {
      const { status, body } = await register();
      assert.equal(status, 201);
      assert.ok(body.access_token.length > 20);
      assert.equal(body.citizen.id.length, 36);
    });

    test('a registration response must not be cached by a shared cache', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/citizens',
        payload: { region_id: REGION.id },
      });
      assert.match(res.headers['cache-control'] as string, /private|no-store/);
    });

    test('an unknown region is rejected', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/citizens',
        payload: { region_id: 999_999 },
      });
      assert.equal(res.statusCode, 404);
    });

    test('a bad demographic band is rejected with the offending path', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/citizens',
        payload: { region_id: REGION.id, demographics: { age_band: 'toddler' } },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'bad_request');
      assert.match(JSON.stringify(res.json().error.details), /age_band/);
    });
  });

  describe('authentication', () => {
    test('a write without a token is rejected', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sentiment',
        payload: { topic_id: 7, mood: 0 },
      });
      assert.equal(res.statusCode, 401);
    });

    test('a tampered token is rejected', async () => {
      const { body } = await register();
      const tampered = `${body.access_token.slice(0, -4)}AAAA`;
      const res = await submit(tampered, { topic_id: 7, mood: 0 });
      assert.equal(res.statusCode, 401);
    });

    test('a token without the Bearer scheme is rejected', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sentiment',
        headers: { authorization: body.access_token, 'idempotency-key': 'abcdefgh' },
        payload: { topic_id: 7, mood: 0 },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  describe('sentiment write', () => {
    test('accepts a submission with 202 and publishes exactly one event', async () => {
      const { body } = await register();
      const before = bus.published<SentimentEvent>(EVENT_TOPICS.SENTIMENT).length;
      const res = await submit(body.access_token, { topic_id: 7, mood: -2, intensity: 5 });

      assert.equal(res.statusCode, 202, res.body);
      assert.equal(res.json().accepted, true);
      const published = bus.published<SentimentEvent>(EVENT_TOPICS.SENTIMENT);
      assert.equal(published.length, before + 1);
      const event = published.at(-1) as SentimentEvent;
      assert.equal(event.topic_id, 7);
      assert.equal(event.mood, -2);
      assert.deepEqual(event.region_path, [1, 10, 105, 1052], 'the citizen’s rollup ancestors');
      assert.equal(event.pseudonym.length, 32);
      assert.equal(event.replaces, null, 'the worker resolves replacement, not the API');
    });

    test('the event’s pseudonym differs per topic for the same citizen', async () => {
      const { body } = await register();
      await submit(body.access_token, { topic_id: 7, mood: 1 });
      // A second topic, to compare pseudonyms. The cooldown is per topic, so this is allowed.
      repos.catalogue.putTopic({ ...TOPIC, id: 9, title: 'Another national policy' });
      await submit(body.access_token, { topic_id: 9, mood: 1 });

      const published = bus.published<SentimentEvent>(EVENT_TOPICS.SENTIMENT);
      const forSeven = published.filter((e) => e.topic_id === 7).at(-1);
      const forNine = published.filter((e) => e.topic_id === 9).at(-1);
      assert.notEqual(forSeven?.pseudonym, forNine?.pseudonym);
    });

    test('a write requires an idempotency key', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/sentiment',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { topic_id: 7, mood: 0 },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error.message, /Idempotency-Key/);
    });

    test('an unknown topic is rejected', async () => {
      const { body } = await register();
      assert.equal(
        (await submit(body.access_token, { topic_id: 999_999, mood: 0 })).statusCode,
        404,
      );
    });

    test('a topic outside the citizen’s jurisdiction is refused', async () => {
      const { body } = await register();
      const res = await submit(body.access_token, { topic_id: 8, mood: 1 });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'forbidden');
    });

    test('an out-of-range mood is rejected before anything is published', async () => {
      const { body } = await register();
      const before = bus.published(EVENT_TOPICS.SENTIMENT).length;
      assert.equal((await submit(body.access_token, { topic_id: 7, mood: 7 })).statusCode, 400);
      assert.equal(bus.published(EVENT_TOPICS.SENTIMENT).length, before);
    });

    test('replaying an idempotency key does not publish a second event', async () => {
      const { body } = await register();
      const key = `replay-${Math.random()}`;
      const first = await submit(body.access_token, { topic_id: 7, mood: 1 }, key);
      const before = bus.published(EVENT_TOPICS.SENTIMENT).length;
      const second = await submit(body.access_token, { topic_id: 7, mood: 1 }, key);

      assert.equal(first.statusCode, 202);
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().replayed, true);
      assert.equal(second.json().event_id, first.json().event_id);
      assert.equal(
        bus.published(EVENT_TOPICS.SENTIMENT).length,
        before,
        'nothing new was published',
      );
    });

    test('reusing a key for a different body is a conflict', async () => {
      const { body } = await register();
      const key = `conflict-${Math.random()}`;
      await submit(body.access_token, { topic_id: 7, mood: 1 }, key);
      const res = await submit(body.access_token, { topic_id: 7, mood: -1 }, key);
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'conflict');
    });

    test('the per-topic cooldown rejects a rapid change with a Retry-After', async () => {
      const { body } = await register();
      await submit(body.access_token, { topic_id: 7, mood: 1 });
      const res = await submit(body.access_token, { topic_id: 7, mood: -1 });
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().error.code, 'cooldown_active');
      assert.ok(Number(res.headers['retry-after']) > 0);
    });

    test('a quota rejection frees the idempotency key, since no write happened', async () => {
      const { body } = await register();
      await submit(body.access_token, { topic_id: 7, mood: 1 });
      const key = `freed-${Math.random()}`;
      const blocked = await submit(body.access_token, { topic_id: 7, mood: -1 }, key);
      assert.equal(blocked.statusCode, 429);
      // The same key must be usable again: refusing it would mean a write that never happened is
      // permanently blocking an honest retry.
      repos.catalogue.putTopic({ ...TOPIC, id: 11, title: 'Yet another policy' });
      const retried = await submit(body.access_token, { topic_id: 11, mood: 1 }, key);
      assert.equal(retried.statusCode, 202, retried.body);
    });
  });

  describe('sentiment read', () => {
    test('an aggregate read is cacheable with stale-while-revalidate', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/topics/7/mood' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['cache-control'] as string, /public/);
      assert.match(res.headers['cache-control'] as string, /stale-while-revalidate=\d+/);
      assert.ok(res.headers['x-aggregate-staleness'] !== undefined);
    });

    test('an aggregate read needs no authentication — it is public data', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/v1/topics/7/mood' })).statusCode, 200);
    });

    test('a region outside the topic’s jurisdiction is refused', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/topics/8/mood?region_id=1052' });
      assert.equal(res.statusCode, 403);
    });

    test('an unknown dimension is rejected rather than silently ignored', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/topics/7/mood?dimension=caste' });
      assert.equal(res.statusCode, 400);
    });

    test('a dimension read enumerates every bucket, so absent reads as zero', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/topics/7/mood?dimension=age_band&tier=0',
      });
      assert.equal(res.json().buckets.length, 6);
    });

    test('the citizen’s own opinions are private and uncacheable', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/sentiment',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['cache-control'] as string, /private|no-store/);
    });
  });

  describe('profile and erasure', () => {
    test('a profile update invalidates the cached bands', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { demographics: { age_band: '65+', gender: 'other' } },
      });
      assert.equal(res.statusCode, 200);
      const stored = await repos.citizens.findById(body.citizen.id);
      assert.deepEqual(stored?.demographics, { age_band: '65+', gender: 'other' });
    });

    test('DELETE /v1/me works even with a content-type header and no body', async () => {
      // Many clients set a default content-type on every request. Failing an erasure request over a
      // header the citizen did not choose is not acceptable.
      const { body } = await register();
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: {
          authorization: `Bearer ${body.access_token}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().erased, true);
    });

    test('an erased citizen cannot write', async () => {
      const { body } = await register();
      await app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      const res = await submit(body.access_token, { topic_id: 7, mood: 1 });
      assert.equal(res.statusCode, 403);
    });

    test('erasing twice is a 404, not a silent success', async () => {
      const { body } = await register();
      const headers = { authorization: `Bearer ${body.access_token}` };
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/v1/me', headers })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/v1/me', headers })).statusCode,
        404,
      );
    });
  });

  describe('rti', () => {
    test('files a request and returns its statutory deadlines', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/rti',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: {
          authority_id: 1,
          subject: 'Details of tap connections completed this year',
          filed_at: '2026-01-01',
        },
      });
      assert.equal(res.statusCode, 201, res.body);
      const view = res.json();
      assert.equal(view.deadlines[0].due_on, '2026-01-31');
      assert.match(view.deadlines[0].statute, /§7\(1\)/);
    });

    test('an unknown authority is rejected', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/rti',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { authority_id: 999, subject: 'A sufficiently long subject line for validation' },
      });
      assert.equal(res.statusCode, 404);
    });

    test('a too-short subject is rejected', async () => {
      const { body } = await register();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/rti',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { authority_id: 1, subject: 'short' },
      });
      assert.equal(res.statusCode, 400);
    });

    test('an illegal transition is refused with the states named', async () => {
      const { body } = await register();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/rti',
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { authority_id: 1, subject: 'A sufficiently long subject line for validation' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/v1/rti/${created.json().request.id}/transitions`,
        headers: { authorization: `Bearer ${body.access_token}` },
        payload: { to: 'second_appeal' },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'invalid_transition');
    });

    test('one citizen cannot read another’s filing', async () => {
      const a = await register();
      const b = await register();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/rti',
        headers: { authorization: `Bearer ${a.body.access_token}` },
        payload: { authority_id: 1, subject: 'A sufficiently long subject line for validation' },
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/rti/${created.json().request.id}`,
        headers: { authorization: `Bearer ${b.body.access_token}` },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('request hygiene', () => {
    test('every response carries a request id', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.ok(res.headers['x-request-id']);
    });

    test('an inbound request id is preserved, so a trace spans the edge and the origin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'edge-abc-123' },
      });
      assert.equal(res.headers['x-request-id'], 'edge-abc-123');
    });

    test('malformed JSON is a 400, not a 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/citizens',
        headers: { 'content-type': 'application/json' },
        payload: '{"region_id": ',
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'bad_request');
    });

    test('an oversized body is rejected', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/citizens',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ region_id: 1052, pad: 'x'.repeat(100_000) }),
      });
      assert.ok(res.statusCode === 400 || res.statusCode === 413, `got ${res.statusCode}`);
    });
  });
});
