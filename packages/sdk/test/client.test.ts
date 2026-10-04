import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CivicApiError, createClient, idempotencyKeyFor } from '../src/index.ts';

/**
 * The client's own behaviour, with `fetch` stubbed. What matters here is the boundary: URL building,
 * headers, error mapping, and refusing to hand back a response that does not match the contract.
 */
function stub(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const aggregate = {
  topic_id: 7,
  region_id: 105,
  dimension: null,
  tier: 2 as const,
  total: {
    bucket: 'all',
    n: 100,
    mean_mood: 0.5,
    mean_intensity: 3,
    histogram: [10, 20, 30, 20, 20],
    suppressed: false,
    suppression_reason: null,
  },
  buckets: [],
  staleness_seconds: 4,
  tier_divergence: null,
  computed_at: new Date().toISOString(),
};

describe('sdk client', () => {
  test('works with a RELATIVE base url, as the same-origin web app uses', async () => {
    // `new URL('/v1/...')` with no base throws, which would break the web app entirely.
    const { fetchImpl, calls } = stub(() => ({ status: 200, body: aggregate }));
    const client = createClient({ baseUrl: '', fetch: fetchImpl });
    await client.mood(7, { region_id: 105 });
    assert.equal(calls[0]?.url, '/v1/topics/7/mood?region_id=105');
  });

  test('works with an absolute base url, as the mobile app uses', async () => {
    const { fetchImpl, calls } = stub(() => ({ status: 200, body: aggregate }));
    const client = createClient({ baseUrl: 'https://api.example.org/', fetch: fetchImpl });
    await client.mood(7);
    assert.equal(calls[0]?.url, 'https://api.example.org/v1/topics/7/mood');
  });

  test('omits the query string entirely when there are no parameters', async () => {
    const { fetchImpl, calls } = stub(() => ({ status: 200, body: aggregate }));
    await createClient({ baseUrl: '', fetch: fetchImpl }).mood(7);
    assert.equal(calls[0]?.url, '/v1/topics/7/mood');
  });

  test('drops undefined query parameters rather than sending "undefined"', async () => {
    const { fetchImpl, calls } = stub(() => ({ status: 200, body: aggregate }));
    await createClient({ baseUrl: '', fetch: fetchImpl }).mood(7, {
      region_id: 105,
      dimension: undefined,
    });
    assert.equal(calls[0]?.url, '/v1/topics/7/mood?region_id=105');
  });

  test('sends the bearer token and the idempotency key on a write', async () => {
    const { fetchImpl, calls } = stub(() => ({
      status: 202,
      body: {
        accepted: true,
        event_id: '0194f0a0-0000-7000-8000-000000000001',
        aggregate: null,
        replayed: false,
      },
    }));
    const client = createClient({ baseUrl: '', accessToken: 'tok', fetch: fetchImpl });
    await client.submitSentiment({ topic_id: 7, mood: 1 }, 'idem-key-1');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer tok');
    assert.equal(headers['idempotency-key'], 'idem-key-1');
  });

  test('stores the token from registration so later calls are authenticated', async () => {
    let seen: string | undefined;
    const { fetchImpl } = stub((url, init) => {
      seen = (init.headers as Record<string, string>)['authorization'];
      if (url.endsWith('/v1/citizens')) {
        return {
          status: 201,
          body: {
            citizen: {
              id: '0194f0a0-0000-7000-8000-000000000001',
              region_id: 105,
              verification_tier: 0,
              locale: 'en',
              demographics: {},
              created_at: new Date().toISOString(),
            },
            access_token: 'fresh-token',
            expires_in: 3600,
          },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const client = createClient({ baseUrl: '', fetch: fetchImpl });
    await client.register({ region_id: 105 });
    await client.mySentiment();
    assert.equal(seen, 'Bearer fresh-token');
  });

  test('maps a structured error response to a typed error', async () => {
    const { fetchImpl } = stub(() => ({
      status: 429,
      body: { error: { code: 'cooldown_active', message: 'too soon', retry_after_seconds: 600 } },
    }));
    const client = createClient({ baseUrl: '', fetch: fetchImpl });
    await assert.rejects(
      () => client.submitSentiment({ topic_id: 7, mood: 1 }, 'k'),
      (err: unknown) => {
        assert.ok(err instanceof CivicApiError);
        assert.equal(err.code, 'cooldown_active');
        assert.equal(err.retryAfterSeconds, 600);
        // A cooldown means the opinion is already recorded and the citizen is changing it too fast.
        // Auto-replaying later would apply a change they never saw land.
        assert.equal(err.retryable, false, 'a cooldown must not be auto-retried');
        return true;
      },
    );
  });

  test('a validation error is not retryable, so a client does not loop on it', async () => {
    const { fetchImpl } = stub(() => ({
      status: 400,
      body: { error: { code: 'bad_request', message: 'nope' } },
    }));
    await assert.rejects(
      () =>
        createClient({ baseUrl: '', fetch: fetchImpl }).submitSentiment(
          { topic_id: 7, mood: 1 },
          'k',
        ),
      (err: unknown) => err instanceof CivicApiError && err.retryable === false,
    );
  });

  test('a response that violates the contract is rejected loudly, not returned half-parsed', async () => {
    const { fetchImpl } = stub(() => ({
      status: 200,
      body: { topic_id: 7, total: { n: 'lots' } },
    }));
    await assert.rejects(
      () => createClient({ baseUrl: '', fetch: fetchImpl }).mood(7),
      (err: unknown) =>
        err instanceof CivicApiError && /did not match the contract/.test(err.message),
    );
  });

  test('a rate-limited write IS retryable, because it genuinely did not happen', async () => {
    const { fetchImpl } = stub(() => ({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'slow down', retry_after_seconds: 30 } },
    }));
    await assert.rejects(
      () =>
        createClient({ baseUrl: '', fetch: fetchImpl }).submitSentiment(
          { topic_id: 7, mood: 1 },
          'k',
        ),
      (err: unknown) => err instanceof CivicApiError && err.retryable === true,
    );
  });

  test('a 503 is retryable, so a client queues rather than losing the submission', async () => {
    const { fetchImpl } = stub(() => ({
      status: 503,
      body: { error: { code: 'degraded', message: 'event log unavailable' } },
    }));
    await assert.rejects(
      () =>
        createClient({ baseUrl: '', fetch: fetchImpl }).submitSentiment(
          { topic_id: 7, mood: 1 },
          'k',
        ),
      (err: unknown) => err instanceof CivicApiError && err.retryable === true,
    );
  });

  test('idempotency keys are stable for one attempt and differ across attempts', () => {
    assert.equal(idempotencyKeyFor('c1', 7, 'a'), idempotencyKeyFor('c1', 7, 'a'));
    assert.notEqual(idempotencyKeyFor('c1', 7, 'a'), idempotencyKeyFor('c1', 7, 'b'));
    assert.notEqual(idempotencyKeyFor('c1', 7, 'a'), idempotencyKeyFor('c2', 7, 'a'));
  });
});
