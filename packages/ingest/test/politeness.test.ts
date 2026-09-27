import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crawlDelaySeconds, isAllowed, parseRobots } from '../src/robots.ts';
import { PoliteFetcher, parseRetryAfter } from '../src/fetcher.ts';

const UA = 'CivicVoiceBot/0.1 (+https://example.org)';

describe('robots.txt (RFC 9309)', () => {
  test('the longest matching rule wins', () => {
    const p = parseRobots('User-agent: *\nDisallow: /orders/\nAllow: /orders/public/');
    assert.equal(isAllowed(p, UA, '/orders/secret.pdf'), false);
    assert.equal(isAllowed(p, UA, '/orders/public/go-45.pdf'), true);
  });

  test('on an equal-length tie, Allow wins', () => {
    const p = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page');
    assert.equal(isAllowed(p, UA, '/page'), true);
  });

  test('wildcards and end anchors', () => {
    const p = parseRobots('User-agent: *\nDisallow: /*.php$\nDisallow: /search*');
    assert.equal(isAllowed(p, UA, '/index.php'), false);
    assert.equal(isAllowed(p, UA, '/index.php?x=1'), true, '$ anchors the end');
    assert.equal(isAllowed(p, UA, '/searchresults'), false);
  });

  test('a specific user-agent group overrides the wildcard group', () => {
    const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: civicvoicebot\nAllow: /');
    assert.equal(isAllowed(p, UA, '/anything'), true);
    assert.equal(isAllowed(p, 'OtherBot/1.0', '/anything'), false);
  });

  test('consecutive user-agent lines share one group', () => {
    const p = parseRobots('User-agent: a\nUser-agent: civicvoicebot\nDisallow: /private');
    assert.equal(isAllowed(p, UA, '/private/x'), false);
  });

  test('an empty Disallow allows everything', () => {
    assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), UA, '/x'), true);
  });

  test('no applicable group means allowed', () => {
    assert.equal(isAllowed(parseRobots('User-agent: googlebot\nDisallow: /'), UA, '/x'), true);
  });

  test('reads Crawl-delay, which many Indian government sites set', () => {
    assert.equal(crawlDelaySeconds(parseRobots('User-agent: *\nCrawl-delay: 10'), UA), 10);
  });

  test('comments and blank lines are ignored', () => {
    const p = parseRobots('# hello\n\nUser-agent: * # everyone\nDisallow: /x # no\n');
    assert.equal(isAllowed(p, UA, '/x'), false);
  });
});

/** A scripted server with a controllable clock, so pacing is tested without real waiting. */
function harness(routes: Record<string, (req: { headers: Headers }) => Response>) {
  let clock = 1_000_000;
  const requests: Array<{ url: string; at: number; headers: Headers }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, at: clock, headers });
    const path = new URL(url).pathname + new URL(url).search;
    const route = routes[path] ?? routes['*'];
    return route ? route({ headers }) : new Response('not found', { status: 404 });
  }) as typeof fetch;
  const fetcher = new PoliteFetcher({
    userAgent: UA,
    minIntervalMs: 5_000,
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    failuresBeforeOpen: 3,
    circuitOpenMs: 60_000,
  });
  return { fetcher, requests, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe('polite fetcher', () => {
  test('fetches robots.txt first and refuses a disallowed URL without requesting it', async () => {
    const h = harness({
      '/robots.txt': () => new Response('User-agent: *\nDisallow: /admin/'),
      '*': () => new Response('ok'),
    });
    const out = await h.fetcher.get('https://gov.example/admin/panel');
    assert.equal(out.status, 'disallowed');
    assert.deepEqual(
      h.requests.map((r) => new URL(r.url).pathname),
      ['/robots.txt'],
    );
  });

  test('spaces requests to one host by the minimum interval', async () => {
    const h = harness({ '/robots.txt': () => new Response(''), '*': () => new Response('ok') });
    await h.fetcher.get('https://gov.example/a');
    await h.fetcher.get('https://gov.example/b');
    const pages = h.requests.filter((r) => !r.url.endsWith('robots.txt'));
    assert.ok((pages[1]?.at ?? 0) - (pages[0]?.at ?? 0) >= 5_000, 'second request came too soon');
  });

  test('honours a Crawl-delay longer than the default interval', async () => {
    const h = harness({
      '/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 20'),
      '*': () => new Response('ok'),
    });
    await h.fetcher.get('https://gov.example/a');
    await h.fetcher.get('https://gov.example/b');
    const pages = h.requests.filter((r) => !r.url.endsWith('robots.txt'));
    assert.ok((pages[1]?.at ?? 0) - (pages[0]?.at ?? 0) >= 20_000);
  });

  test('concurrent requests to one host are serialised, never parallel', async () => {
    const h = harness({ '/robots.txt': () => new Response(''), '*': () => new Response('ok') });
    await Promise.all(['a', 'b', 'c'].map((p) => h.fetcher.get(`https://gov.example/${p}`)));
    const times = h.requests.filter((r) => !r.url.endsWith('robots.txt')).map((r) => r.at);
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(
        (times[i] as number) - (times[i - 1] as number) >= 5_000,
        `requests ${i - 1} and ${i} overlapped`,
      );
    }
  });

  test('different hosts are not held behind each other', async () => {
    const h = harness({ '/robots.txt': () => new Response(''), '*': () => new Response('ok') });
    await h.fetcher.get('https://one.example/a');
    // host one has just been used, so another request to it would wait 5s. Host two must not.
    const start = h.now();
    await h.fetcher.get('https://two.example/a');
    const firstToTwo = h.requests.find((r) => r.url.startsWith('https://two.example'));
    assert.equal(
      firstToTwo?.at,
      start,
      'a different host should not wait on the first one’s interval',
    );
  });

  test('sends validators back, and a 304 costs nothing', async () => {
    let served = 0;
    const h = harness({
      '/robots.txt': () => new Response(''),
      '/list': ({ headers }) => {
        if (headers.get('if-none-match') === '"v1"') return new Response(null, { status: 304 });
        served += 1;
        return new Response('page', { headers: { etag: '"v1"' } });
      },
    });
    assert.equal((await h.fetcher.get('https://gov.example/list')).status, 'ok');
    assert.equal((await h.fetcher.get('https://gov.example/list')).status, 'not_modified');
    assert.equal(served, 1);
  });

  test('backs off after a 429 for as long as Retry-After says', async () => {
    let calls = 0;
    const h = harness({
      '/robots.txt': () => new Response(''),
      '/list': () => {
        calls += 1;
        return calls === 1
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
          : new Response('ok');
      },
    });
    await h.fetcher.get('https://gov.example/list');
    const before = h.now();
    await h.fetcher.get('https://gov.example/list');
    const last = h.requests.at(-1);
    assert.ok((last?.at ?? 0) - before >= 115_000, 'must wait out the Retry-After window');
  });

  test('opens a circuit after repeated server failures and leaves the host alone', async () => {
    const h = harness({
      '/robots.txt': () => new Response(''),
      '*': () => new Response('down', { status: 502 }),
    });
    for (let i = 0; i < 3; i += 1) await h.fetcher.get(`https://gov.example/p${i}`);
    const requestsBefore = h.requests.length;
    const out = await h.fetcher.get('https://gov.example/p9');
    assert.equal(out.status, 'circuit_open');
    assert.equal(h.requests.length, requestsBefore, 'an open circuit must not send a request');
  });

  test('a 404 does not count toward the circuit — it is a page problem, not a host problem', async () => {
    const h = harness({
      '/robots.txt': () => new Response(''),
      '*': () => new Response('gone', { status: 404 }),
    });
    for (let i = 0; i < 5; i += 1) await h.fetcher.get(`https://gov.example/p${i}`);
    assert.notEqual((await h.fetcher.get('https://gov.example/x')).status, 'circuit_open');
  });

  test('an unreachable robots.txt is treated as disallow-all (RFC 9309 §2.3.1.4)', async () => {
    const h = harness({
      '/robots.txt': () => new Response('err', { status: 500 }),
      '*': () => new Response('ok'),
    });
    assert.equal((await h.fetcher.get('https://gov.example/a')).status, 'disallowed');
  });

  test('a missing robots.txt (404) allows crawling', async () => {
    const h = harness({ '*': () => new Response('ok') });
    assert.equal((await h.fetcher.get('https://gov.example/a')).status, 'ok');
  });

  test('identifies itself on every request', async () => {
    const h = harness({ '/robots.txt': () => new Response(''), '*': () => new Response('ok') });
    await h.fetcher.get('https://gov.example/a');
    assert.ok(h.requests.every((r) => r.headers.get('user-agent') === UA));
  });

  test('refuses an oversized body', async () => {
    const h = harness({
      '/robots.txt': () => new Response(''),
      '*': () => new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } }),
    });
    assert.equal((await h.fetcher.get('https://gov.example/huge.pdf')).status, 'error');
  });

  test('parses Retry-After in both seconds and HTTP-date forms', () => {
    assert.equal(parseRetryAfter('30', 0), 30_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now), 60_000);
    assert.equal(parseRetryAfter('garbage', 0), null);
  });
});
