import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCacheTier, type CacheTier } from '@civic-voice/cache';
import {
  createMemoryRepositories,
  seedMemoryGeography,
  type MemoryRepositories,
} from '@civic-voice/db';
import { createMemoryAnalyticsStore, type MemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus, type MemoryEventBus } from '@civic-voice/stream';
import { createMetrics, createTestLogger } from '@civic-voice/observability';
import {
  EVENT_TOPICS,
  type CommentAnalyticsEvent,
  type CommentEvent,
} from '@civic-voice/contracts';
import { uuidv7 } from '@civic-voice/core';
import { buildApp } from '../src/app.ts';
import { loadApiConfig } from '../src/config.ts';

/**
 * The forum, geolocation and public-data routes over HTTP, on the real region tree (Greater
 * Hyderabad and its wards) and in-memory adapters.
 */
describe('forum api', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repos: MemoryRepositories;
  let bus: MemoryEventBus;
  let cache: CacheTier;
  let analytics: MemoryAnalyticsStore;
  let ids: Map<string, number>;
  const id = (key: string) => ids.get(key) as number;
  let cityTopic: number;
  let nationalTopic: number;

  // Coordinates of landmarks inside known wards (see packages/geo tests).
  const KHAIRATABAD = { lat: 17.4119, lng: 78.4618 };
  const UPPAL = { lat: 17.3985, lng: 78.559 };

  before(async () => {
    repos = createMemoryRepositories({ now: () => new Date('2026-09-27T12:00:00Z') });
    ids = seedMemoryGeography(repos.catalogue);
    cityTopic = (
      await repos.catalogue.createTopic({
        kind: 'government_order',
        jurisdiction_region_id: id('IN-TG-GHMC'),
        title: 'G.O.Ms.No.145: storm water drains in Greater Hyderabad',
        summary: null,
        effective_from: '2026-09-12',
        source_refs: [],
      })
    ).id;
    nationalTopic = (
      await repos.catalogue.createTopic({
        kind: 'scheme',
        jurisdiction_region_id: id('IN'),
        title: 'Jal Jeevan Mission extension',
        summary: null,
        effective_from: '2026-09-17',
        source_refs: [],
      })
    ).id;
    bus = createMemoryEventBus({ autoDeliver: false });
    cache = createMemoryCacheTier();
    analytics = createMemoryAnalyticsStore();
    app = await buildApp({
      config: loadApiConfig({ ...process.env, CIVIC_TOKEN_SECRET: 't'.repeat(40) }),
      repos,
      cache,
      bus,
      analytics,
      now: () => new Date('2026-09-27T12:00:00Z'),
      logger: createTestLogger(),
      metrics: createMetrics(),
    });
  });

  after(async () => {
    await app.close();
  });

  const register = async (regionKey: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/citizens',
      payload: {
        region_id: id(regionKey),
        locale: 'te',
        demographics: { age_band: '18-24' },
        ...extra,
      },
    });
    const body = res.json() as {
      access_token: string;
      citizen: { id: string; region_basis: string };
    };
    return { status: res.statusCode, token: body.access_token, citizen: body.citizen, raw: body };
  };
  const auth = (token: string, idem?: string) => ({
    authorization: `Bearer ${token}`,
    ...(idem ? { 'idempotency-key': idem } : {}),
  });
  const postComment = (
    token: string,
    topicId: number,
    body: string,
    idem = `k-${Math.random()}`,
    parent_id: string | null = null,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/topics/${topicId}/comments`,
      headers: auth(token, idem),
      payload: { body, parent_id },
    });

  describe('where am I', () => {
    test('a point in Khairatabad resolves to the ward, with its path and an attestation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/geo/resolve',
        payload: KHAIRATABAD,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'private, no-store');
      const body = res.json();
      assert.equal(body.region.key, 'IN-TG-GHMC-khairatabad');
      assert.deepEqual(body.region.path_names, [
        'India',
        'Telangana',
        'Greater Hyderabad',
        'Khairatabad',
      ]);
      assert.ok(body.attestation);
      assert.match(body.attribution, /OpenStreetMap/);
      assert.ok(!JSON.stringify(body).includes('17.41'), 'the coordinate is not echoed');
    });

    test('an unmapped point in India and a point abroad say why they did not resolve', async () => {
      const mumbai = (
        await app.inject({
          method: 'POST',
          url: '/v1/geo/resolve',
          payload: { lat: 18.94, lng: 72.83 },
        })
      ).json();
      assert.equal(mumbai.region, null);
      assert.equal(mumbai.unresolved_reason, 'unmapped');
      const london = (
        await app.inject({
          method: 'POST',
          url: '/v1/geo/resolve',
          payload: { lat: 51.5, lng: -0.12 },
        })
      ).json();
      assert.equal(london.unresolved_reason, 'outside_india');
    });

    test('the location is not accepted as a query string', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/geo/resolve?lat=17.41&lng=78.46' });
      assert.equal(res.statusCode, 404);
    });

    test('registering with an attestation marks the home region as device-confirmed', async () => {
      const { attestation } = (
        await app.inject({ method: 'POST', url: '/v1/geo/resolve', payload: KHAIRATABAD })
      ).json();
      const r = await register('IN-TG-GHMC-khairatabad', { location_attestation: attestation });
      assert.equal(r.status, 201);
      assert.equal(r.citizen.region_basis, 'device');
    });

    test('an attestation for one ward cannot confirm another', async () => {
      const { attestation } = (
        await app.inject({ method: 'POST', url: '/v1/geo/resolve', payload: KHAIRATABAD })
      ).json();
      const r = await register('IN-TG-GHMC-uppal', { location_attestation: attestation });
      assert.equal(r.status, 400);
      const forged = await register('IN-TG-GHMC-uppal', {
        location_attestation: `${attestation.split('.')[0]}.AAAA`,
      });
      assert.equal(forged.status, 400);
    });

    test('moving home clears device confirmation unless the new region is attested too', async () => {
      const { attestation } = (
        await app.inject({ method: 'POST', url: '/v1/geo/resolve', payload: KHAIRATABAD })
      ).json();
      const r = await register('IN-TG-GHMC-khairatabad', { location_attestation: attestation });
      await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(r.token),
        payload: { demographics: {}, region_id: id('IN-TG-GHMC-uppal') },
      });
      assert.equal(
        (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(r.token) })).json()
          .region_basis,
        'declared',
      );
      const uppal = (
        await app.inject({ method: 'POST', url: '/v1/geo/resolve', payload: UPPAL })
      ).json();
      await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: auth(r.token),
        payload: { demographics: {}, location_attestation: uppal.attestation },
      });
      assert.equal(
        (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(r.token) })).json()
          .region_basis,
        'device',
      );
    });
  });

  describe('comments', () => {
    test('a resident posts; the comment goes on the log with a per-topic handle and their ward', async () => {
      const { token, citizen } = await register('IN-TG-GHMC-khairatabad');
      const res = await postComment(
        token,
        cityTopic,
        'The drains on our road overflow every monsoon.',
      );
      assert.equal(res.statusCode, 202);
      const body = res.json();
      assert.equal(body.state, 'pending');
      assert.match(body.handle, /^Citizen [0-9A-F]{6}$/);
      const event = bus
        .published<CommentEvent>(EVENT_TOPICS.COMMENT)
        .find((e) => e.comment_id === body.comment_id);
      assert.ok(event);
      assert.equal(event.area, 'Khairatabad', 'one level below the city');
      assert.equal(event.citizen_id, citizen.id, 'on the log only, for the author index');
      assert.deepEqual(event.demographics, { age_band: '18-24' });
    });

    test('Hyderabad questions are for Hyderabad residents', async () => {
      const { token } = await register('IN-UP-lucknow-cantt');
      const res = await postComment(
        token,
        cityTopic,
        'Drains are a problem everywhere, not only Hyderabad.',
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'not_local');
      assert.match(res.json().error.message, /Greater Hyderabad/);
      // …while a national topic is everyone's.
      assert.equal(
        (await postComment(token, nationalTopic, 'Tap water reached our village last year.'))
          .statusCode,
        202,
      );
    });

    test('a phone number is refused before anything is published, without being echoed back', async () => {
      const { token } = await register('IN-TG-GHMC-khairatabad');
      const res = await postComment(
        token,
        cityTopic,
        'Call the AE on 9876543210, he knows about the drain.',
      );
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'content_rejected');
      assert.match(res.json().error.message, /phone number/);
      assert.ok(!res.body.includes('9876543210'));
    });

    test('a retried post with the same key is one comment', async () => {
      const { token } = await register('IN-TG-GHMC-khairatabad');
      const before = bus.published(EVENT_TOPICS.COMMENT).length;
      const first = await postComment(
        token,
        cityTopic,
        'Please clear the nala before June.',
        'same-key-123',
      );
      const again = await postComment(
        token,
        cityTopic,
        'Please clear the nala before June.',
        'same-key-123',
      );
      assert.equal(first.statusCode, 202);
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().replayed, true);
      assert.equal(again.json().comment_id, first.json().comment_id);
      assert.equal(bus.published(EVENT_TOPICS.COMMENT).length, before + 1);
    });

    test('posting is rate limited per person', async () => {
      const { token } = await register('IN-TG-GHMC-khairatabad');
      let last = 0;
      for (let i = 0; i < 21; i++)
        last = (await postComment(token, cityTopic, `Comment number ${i} about the drains.`))
          .statusCode;
      assert.equal(last, 429);
    });

    test('listing, voting, reporting and deleting', async () => {
      const author = await register('IN-TG-GHMC-khairatabad');
      const voter = await register('IN-TG-GHMC-uppal');
      const outsider = await register('IN-UP-lucknow-cantt');
      const commentId = uuidv7();
      await repos.forum.insertComment(author.citizen.id, {
        topic_id: cityTopic,
        id: commentId,
        parent_id: null,
        pseudonym: 'f'.repeat(32),
        handle: 'Citizen FFFFFF',
        body: 'Desilting must be done ward-wise before the monsoon.',
        language: 'en',
        area: 'Khairatabad',
        located: true,
        verification_tier: 0,
        state: 'published',
        moderation_reasons: [],
        sentiment: -1,
        needs: ['sanitation'],
        suggestion: true,
        model: 'nb-lr-test',
        created_at: new Date().toISOString(),
      });

      const list = await app.inject({
        method: 'GET',
        url: `/v1/topics/${cityTopic}/comments?sort=top`,
      });
      assert.equal(list.statusCode, 200);
      assert.match(String(list.headers['cache-control']), /public, max-age=15/);
      const listed = list.json().items.find((c: { id: string }) => c.id === commentId);
      assert.deepEqual(listed.analysis, {
        sentiment: 'negative',
        needs: ['sanitation'],
        suggestion: true,
        model: 'nb-lr-test',
      });
      assert.equal(listed.state, undefined, 'moderation state is the author’s business');

      const vote = () =>
        app.inject({
          method: 'PUT',
          url: `/v1/topics/${cityTopic}/comments/${commentId}/vote`,
          headers: auth(voter.token),
        });
      assert.equal((await vote()).json().upvotes, 1);
      assert.equal((await vote()).json().upvotes, 1, 'one vote per person');
      const mine = await app.inject({
        method: 'GET',
        url: `/v1/topics/${cityTopic}/comments/mine/votes?ids=${commentId}`,
        headers: auth(voter.token),
      });
      assert.deepEqual(mine.json().upvoted, [commentId]);
      const outsiderVote = await app.inject({
        method: 'PUT',
        url: `/v1/topics/${cityTopic}/comments/${commentId}/vote`,
        headers: auth(outsider.token),
      });
      assert.equal(outsiderVote.statusCode, 403);

      const report = await app.inject({
        method: 'POST',
        url: `/v1/topics/${cityTopic}/comments/${commentId}/reports`,
        headers: auth(voter.token),
        payload: { reason: 'spam' },
      });
      assert.equal(report.statusCode, 202);

      const notMine = await app.inject({
        method: 'DELETE',
        url: `/v1/topics/${cityTopic}/comments/${commentId}`,
        headers: auth(voter.token),
      });
      assert.equal(notMine.statusCode, 404);
      const own = await app.inject({
        method: 'GET',
        url: '/v1/me/comments',
        headers: auth(author.token),
      });
      assert.equal(own.json().items[0].state, 'published');
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/topics/${cityTopic}/comments/${commentId}`,
        headers: auth(author.token),
      });
      assert.equal(deleted.statusCode, 200);
      assert.equal((await repos.forum.getComment(cityTopic, commentId))?.body, '');
    });

    test('erasing an account blanks its comments everywhere', async () => {
      const author = await register('IN-TG-GHMC-khairatabad');
      const commentId = uuidv7();
      await repos.forum.insertComment(author.citizen.id, {
        topic_id: nationalTopic,
        id: commentId,
        parent_id: null,
        pseudonym: 'e'.repeat(32),
        handle: 'Citizen EEEEEE',
        body: 'Our taps run dry by noon.',
        language: 'en',
        area: 'Telangana',
        located: false,
        verification_tier: 0,
        state: 'published',
        moderation_reasons: [],
        sentiment: -1,
        needs: ['water'],
        suggestion: false,
        model: 'nb-lr-test',
        created_at: new Date().toISOString(),
      });
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: auth(author.token),
      });
      assert.equal(res.statusCode, 200);
      const after = await repos.forum.getComment(nationalTopic, commentId);
      assert.equal(after?.state, 'deleted');
      assert.equal(after?.body, '');
    });
  });

  describe('local issues', () => {
    test('a resident raises an issue in their own ward; the details become the first comment', async () => {
      const { token } = await register('IN-TG-GHMC-khairatabad');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/issues',
        headers: auth(token, 'issue-key-1'),
        payload: {
          title: 'Streetlights out on the lake road for two weeks',
          details: 'Women avoid walking there after dark.',
          scope: 'ward',
        },
      });
      assert.equal(res.statusCode, 201);
      const topic = res.json();
      assert.equal(topic.kind, 'local_issue');
      assert.equal(topic.jurisdiction_region_id, id('IN-TG-GHMC-khairatabad'));
      assert.ok(
        bus
          .published<CommentEvent>(EVENT_TOPICS.COMMENT)
          .some((e) => e.topic_id === topic.id && e.body.startsWith('Women avoid')),
      );
    });

    test('city scope reaches the whole corporation; a state has no ward', async () => {
      const resident = await register('IN-TG-GHMC-uppal');
      const city = await app.inject({
        method: 'POST',
        url: '/v1/issues',
        headers: auth(resident.token, 'issue-key-2'),
        payload: { title: 'Bus frequency on the Uppal–Mehdipatnam route', scope: 'city' },
      });
      assert.equal(city.json().jurisdiction_region_id, id('IN-TG-GHMC'));
      const apResident = await register('IN-AP');
      const noWard = await app.inject({
        method: 'POST',
        url: '/v1/issues',
        headers: auth(apResident.token, 'issue-key-3'),
        payload: { title: 'Something in my ward that needs fixing', scope: 'ward' },
      });
      assert.equal(noWard.statusCode, 400);
    });
  });

  describe('trending', () => {
    test('lists what is being discussed in a region, with comment counts', async () => {
      await cache.trending.bump(
        cityTopic,
        [id('IN'), id('IN-TG'), id('IN-TG-GHMC')],
        9,
        3,
        new Date(),
      );
      const res = await app.inject({
        method: 'GET',
        url: `/v1/trending?region_id=${id('IN-TG-GHMC')}`,
      });
      const [first] = res.json().items;
      assert.equal(first.topic_id, cityTopic);
      assert.equal(first.jurisdiction_name, 'Greater Hyderabad');
      assert.equal(first.comments_24h, 3);
    });
  });

  describe('documents and jobs', () => {
    test('a ward resident sees city and state documents, and open jobs with a lower-bound total', async () => {
      const ghmc = id('IN-TG-GHMC');
      const tg = id('IN-TG');
      const base = {
        source_id: 'tg-goir',
        source_name: 'Telangana GO register',
        subject: null,
        snippet: null,
        go_number: null,
        go_type: null,
        gazette_number: null,
        department: null,
        amount_rupees: null,
        vacancies: null,
        closing_on: null,
        geo_confidence: 0.9,
        geo_region_ids: [],
        discussable: false,
        provenance: 'official' as const,
        needs_ocr: false,
        url: 'https://example.gov.in/doc',
        published_on: '2026-09-20',
      };
      await repos.documents.upsertDocuments([
        {
          ...base,
          content_hash: 'd1',
          kind: 'project',
          subject: 'project',
          title: 'Drains in Greater Hyderabad',
          jurisdiction_region_id: tg,
          primary_region_id: ghmc,
          primary_region_path: [id('IN'), tg, ghmc],
          amount_rupees: 12_500_000_000,
        },
        {
          ...base,
          content_hash: 'j1',
          kind: 'job_notification',
          title: 'Group-IV: 8,180 posts',
          jurisdiction_region_id: tg,
          primary_region_id: tg,
          primary_region_path: [id('IN'), tg],
          vacancies: 8180,
          closing_on: '2026-10-30',
        },
        {
          ...base,
          content_hash: 'j2',
          kind: 'job_notification',
          title: 'Staff nurse walk-in',
          jurisdiction_region_id: tg,
          primary_region_id: tg,
          primary_region_path: [id('IN'), tg],
          published_on: '2026-09-25',
        },
        {
          ...base,
          content_hash: 'j3',
          kind: 'job_notification',
          title: 'Closed last month',
          jurisdiction_region_id: tg,
          primary_region_id: tg,
          primary_region_path: [id('IN'), tg],
          vacancies: 900,
          closing_on: '2026-08-30',
        },
      ]);
      const docs = await app.inject({
        method: 'GET',
        url: `/v1/documents?region_id=${id('IN-TG-GHMC-khairatabad')}&kind=project`,
      });
      assert.equal(docs.json().items[0].primary_region_name, 'Greater Hyderabad');

      const jobs = (
        await app.inject({
          method: 'GET',
          url: `/v1/jobs?region_id=${id('IN-TG-GHMC-khairatabad')}`,
        })
      ).json();
      assert.equal(jobs.open_notifications, 2);
      assert.equal(jobs.stated_vacancies, 8180);
      assert.equal(jobs.without_count, 1, 'the walk-in states no number and is not guessed');
    });
  });

  describe('cohort insights', () => {
    const row = (
      i: number,
      age: '18-24' | '45-54',
      needs: CommentAnalyticsEvent['needs'],
    ): CommentAnalyticsEvent => ({
      dedupe_key: i.toString(16).padStart(32, '0'),
      author_key: (i + 1_000_000).toString(16).padStart(32, '0'),
      hour: '2026-09-27T11:00:00.000Z',
      topic_id: cityTopic,
      region_path: [id('IN'), id('IN-TG'), id('IN-TG-GHMC'), id('IN-TG-GHMC-khairatabad')],
      verification_tier: 0,
      demographics: { age_band: age },
      sentiment: 'negative',
      needs,
      suggestion: false,
      language: 'en',
    });

    test('below k voices the cohort is suppressed, not shown small', async () => {
      await analytics.insertCommentEvents(
        Array.from({ length: 10 }, (_, i) => row(i, '18-24', ['employment'])),
      );
      const res = (
        await app.inject({
          method: 'GET',
          url: `/v1/insights/cohort?cohort=youth&region_id=${id('IN-TG-GHMC')}`,
        })
      ).json();
      assert.equal(res.suppressed, true);
      assert.equal(res.participants, null);
      assert.deepEqual(res.needs, []);
    });

    test('at k voices it shows what youth raise, and withholds a comparison that would expose the rest', async () => {
      await analytics.insertCommentEvents(
        Array.from({ length: 30 }, (_, i) => row(100 + i, '18-24', ['employment', 'education'])),
      );
      // Five older voices: everyone − youth would be a slice of 5, below k.
      await analytics.insertCommentEvents(
        Array.from({ length: 5 }, (_, i) => row(500 + i, '45-54', ['water'])),
      );
      const res = (
        await app.inject({
          method: 'GET',
          url: `/v1/insights/cohort?cohort=youth&region_id=${id('IN-TG-GHMC')}`,
        })
      ).json();
      assert.equal(res.suppressed, false);
      assert.equal(res.participants, 40);
      assert.equal(res.needs[0].need, 'employment');
      assert.equal(res.comparison, null);

      await analytics.insertCommentEvents(
        Array.from({ length: 30 }, (_, i) => row(700 + i, '45-54', ['water'])),
      );
      const now = (
        await app.inject({
          method: 'GET',
          url: `/v1/insights/cohort?cohort=youth&region_id=${id('IN-TG-GHMC')}`,
        })
      ).json();
      assert.ok(Array.isArray(now.comparison));
      const employment = now.comparison.find((c: { need: string }) => c.need === 'employment');
      assert.ok(employment.cohort_share > employment.everyone_share);
    });
  });
});
