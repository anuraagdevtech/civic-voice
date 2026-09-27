import { crawlDelaySeconds, isAllowed, parseRobots, type RobotsPolicy } from './robots.ts';

/**
 * A polite HTTP fetcher for government and news sources.
 *
 * The defaults are set for fragile government servers, not for throughput:
 *
 *  - **One request at a time per host**, and at least `minIntervalMs` between them (raised to the
 *    site's `Crawl-delay` when it asks for more).
 *  - **robots.txt is fetched, cached for a day, and obeyed.** A disallowed URL is not fetched, full stop.
 *  - **Conditional GET.** `ETag` / `Last-Modified` are remembered and sent back, so an unchanged listing
 *    page costs the server a 304 and us nothing.
 *  - **Back off on 429/503**, honouring `Retry-After`, and **open a circuit** after repeated failures so
 *    a struggling site is left alone rather than retried into the ground.
 *  - An **identifying User-Agent** with a contact URL, so an administrator who objects can say so.
 *
 * Throughput comes from covering many hosts in parallel, never from hitting one host harder.
 */

export interface FetcherOptions {
  userAgent: string;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  failuresBeforeOpen?: number;
  circuitOpenMs?: number;
  robotsTtlMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FetchOutcome =
  | {
      status: 'ok';
      url: string;
      body: Uint8Array;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
    }
  | { status: 'not_modified'; url: string }
  | { status: 'disallowed'; url: string }
  | { status: 'circuit_open'; url: string; retryAtMs: number }
  | { status: 'error'; url: string; httpStatus: number | null; message: string };

interface HostState {
  queue: Promise<void>;
  lastRequestAt: number;
  consecutiveFailures: number;
  openUntil: number;
  retryAfterUntil: number;
  robots: { policy: RobotsPolicy; fetchedAt: number } | null;
}

export class PoliteFetcher {
  private readonly options: Required<Omit<FetcherOptions, 'fetch' | 'now' | 'sleep'>>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly hosts = new Map<string, HostState>();
  /** url → validators from the last 200, for conditional GET. */
  private readonly validators = new Map<
    string,
    { etag: string | null; lastModified: string | null }
  >();

  constructor(options: FetcherOptions) {
    this.options = {
      userAgent: options.userAgent,
      minIntervalMs: options.minIntervalMs ?? 5_000,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: options.maxBytes ?? 15 * 1024 * 1024,
      failuresBeforeOpen: options.failuresBeforeOpen ?? 3,
      circuitOpenMs: options.circuitOpenMs ?? 30 * 60_000,
      robotsTtlMs: options.robotsTtlMs ?? 24 * 60 * 60_000,
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private host(origin: string): HostState {
    let state = this.hosts.get(origin);
    if (!state) {
      state = {
        queue: Promise.resolve(),
        lastRequestAt: -Infinity,
        consecutiveFailures: 0,
        openUntil: 0,
        retryAfterUntil: 0,
        robots: null,
      };
      this.hosts.set(origin, state);
    }
    return state;
  }

  /** Serialise work per host: each request waits for the previous one on the same host to finish. */
  private exclusive<T>(state: HostState, work: () => Promise<T>): Promise<T> {
    const run = state.queue.then(work, work);
    state.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pace(state: HostState, extraDelayMs: number): Promise<void> {
    const interval = Math.max(this.options.minIntervalMs, extraDelayMs);
    const earliest = Math.max(state.lastRequestAt + interval, state.retryAfterUntil);
    const wait = earliest - this.now();
    if (wait > 0) await this.sleep(wait);
    state.lastRequestAt = this.now();
  }

  private async robotsFor(origin: string, state: HostState): Promise<RobotsPolicy> {
    if (state.robots && this.now() - state.robots.fetchedAt < this.options.robotsTtlMs) {
      return state.robots.policy;
    }
    await this.pace(state, 0);
    let policy: RobotsPolicy = { groups: [], sitemaps: [] };
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { 'user-agent': this.options.userAgent },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (res.ok) {
        policy = parseRobots(await res.text());
      } else if (res.status >= 500) {
        // RFC 9309 §2.3.1.4: an unreachable robots.txt means assume complete disallow. A server
        // that cannot serve robots.txt is not a server to crawl right now.
        policy = parseRobots('User-agent: *\nDisallow: /');
      }
      // 4xx means "no robots.txt": everything is allowed (§2.3.1.3).
    } catch {
      policy = parseRobots('User-agent: *\nDisallow: /');
    }
    state.robots = { policy, fetchedAt: this.now() };
    return policy;
  }

  async get(url: string): Promise<FetchOutcome> {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const state = this.host(origin);

    return this.exclusive(state, async () => {
      if (state.openUntil > this.now()) {
        return { status: 'circuit_open', url, retryAtMs: state.openUntil };
      }

      const robots = await this.robotsFor(origin, state);
      if (!isAllowed(robots, this.options.userAgent, parsed.pathname + parsed.search)) {
        return { status: 'disallowed', url };
      }

      const delay = crawlDelaySeconds(robots, this.options.userAgent);
      await this.pace(state, delay === null ? 0 : delay * 1000);

      const headers: Record<string, string> = {
        'user-agent': this.options.userAgent,
        accept:
          'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/pdf,application/json;q=0.9,*/*;q=0.5',
      };
      const known = this.validators.get(url);
      if (known?.etag) headers['if-none-match'] = known.etag;
      if (known?.lastModified) headers['if-modified-since'] = known.lastModified;

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (err) {
        this.fail(state);
        return { status: 'error', url, httpStatus: null, message: (err as Error).message };
      }

      if (res.status === 304) {
        state.consecutiveFailures = 0;
        return { status: 'not_modified', url };
      }

      if (res.status === 429 || res.status === 503) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.now());
        state.retryAfterUntil = this.now() + (retryAfter ?? 60_000);
        this.fail(state);
        return {
          status: 'error',
          url,
          httpStatus: res.status,
          message: 'server asked us to slow down',
        };
      }

      if (!res.ok) {
        // A 404 is the page's problem, not the host's health: it does not count toward the circuit.
        if (res.status >= 500) this.fail(state);
        return { status: 'error', url, httpStatus: res.status, message: res.statusText };
      }

      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > this.options.maxBytes) {
        return {
          status: 'error',
          url,
          httpStatus: res.status,
          message: `body of ${declared} bytes exceeds the limit`,
        };
      }
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > this.options.maxBytes) {
        return { status: 'error', url, httpStatus: res.status, message: 'body exceeds the limit' };
      }

      state.consecutiveFailures = 0;
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag || lastModified) this.validators.set(url, { etag, lastModified });

      return {
        status: 'ok',
        url: res.url || url,
        body,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        etag,
        lastModified,
      };
    });
  }

  private fail(state: HostState): void {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.options.failuresBeforeOpen) {
      state.openUntil = this.now() + this.options.circuitOpenMs;
      state.consecutiveFailures = 0;
    }
  }
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export const CIVIC_USER_AGENT =
  'CivicVoiceBot/0.1 (+https://github.com/anuraagdevtech/civic-voice; public-records indexing; contact via repository issues)';
