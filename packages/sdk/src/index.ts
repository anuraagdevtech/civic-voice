import {
  errorResponse,
  moodAggregateSchema,
  mySentimentSchema,
  paged,
  regionSchema,
  registerCitizenResponse,
  rtiRequestView,
  submitSentimentResponse,
  taxUtilisationView,
  topicSchema,
  type Demographics,
  type ErrorCode,
  type Locale,
  type Mood,
  type MoodQuery,
  type ReasonCode,
  type RtiState,
  type RtiTrack,
} from '@civic-voice/contracts';
import { z } from 'zod';

/**
 * The typed client used by both the web app and the mobile app.
 *
 * Responses are parsed against the same Zod schemas the API validates against, so a server change
 * that breaks the contract surfaces as a parse error with a useful message rather than as
 * `undefined` three components deep. And because both clients import these types, a breaking API
 * change fails `pnpm typecheck` at the call site (ADR-0006).
 */

export class CivicApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    opts: { retryAfterSeconds?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'CivicApiError';
    this.code = code;
    this.status = status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.details !== undefined) this.details = opts.details;
  }

  /**
   * Whether replaying the same request with the same idempotency key is safe and likely to help.
   * Mobile clients queue on this rather than surfacing an error the citizen can do nothing about.
   */
  get retryable(): boolean {
    return this.status >= 500 || this.code === 'degraded' || this.code === 'rate_limited';
  }
}

export interface ClientOptions {
  baseUrl: string;
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
  /** Defaults to 10s. A civic app is used on patchy mobile networks; unbounded waits are not kind. */
  timeoutMs?: number;
  onTokenChange?: (token: string | null) => void;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Set on writes so a retry over a flaky connection cannot double-submit. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class CivicVoiceClient {
  private readonly baseUrl: string;
  private accessToken: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly onTokenChange?: (token: string | null) => void;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.accessToken = opts.accessToken ?? null;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.onTokenChange) this.onTokenChange = opts.onTokenChange;
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
    this.onTokenChange?.(token);
  }

  private async request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    opts: RequestOptions = {},
  ): Promise<z.infer<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.accessToken) headers['authorization'] = `Bearer ${this.accessToken}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    // Own timeout, combined with any caller signal, so a hung socket cannot pin a UI forever.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    const response = await this.fetchImpl(url, {
      method: opts.method ?? 'GET',
      headers,
      signal,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });

    const text = await response.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
      const parsed = errorResponse.safeParse(json);
      if (parsed.success) {
        const { code, message, details, retry_after_seconds } = parsed.data.error;
        throw new CivicApiError(code, message, response.status, {
          ...(retry_after_seconds === undefined ? {} : { retryAfterSeconds: retry_after_seconds }),
          ...(details === undefined ? {} : { details }),
        });
      }
      throw new CivicApiError('internal', `HTTP ${response.status}`, response.status);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // A contract violation, not a network error. Say so loudly — a silently wrong shape is worse.
      throw new CivicApiError(
        'internal',
        `response did not match the contract for ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        response.status,
      );
    }
    return parsed.data;
  }

  // ── Identity ──

  async register(input: {
    region_id: number;
    locale?: Locale;
    demographics?: Demographics;
    attestation?: string;
  }) {
    const result = await this.request('/v1/citizens', registerCitizenResponse, {
      method: 'POST',
      body: input,
    });
    this.setAccessToken(result.access_token);
    return result;
  }

  async updateProfile(input: { demographics?: Demographics; region_id?: number; locale?: Locale }) {
    return this.request('/v1/me', z.object({ ok: z.literal(true) }), {
      method: 'PATCH',
      body: input,
    });
  }

  /** Consent withdrawal and erasure (ADR-0004). Irreversible, and the UI says so before calling. */
  async eraseMe() {
    return this.request('/v1/me', z.object({ erased: z.literal(true) }), { method: 'DELETE' });
  }

  // ── Catalogue ──

  async region(regionId: number) {
    return this.request(`/v1/regions/${regionId}`, regionSchema);
  }

  async childRegions(regionId: number) {
    return this.request(`/v1/regions/${regionId}/children`, z.object({ items: z.array(regionSchema) }));
  }

  async topics(query: { region_id?: number; kind?: string; limit?: number } = {}) {
    return this.request('/v1/topics', paged(topicSchema), { query });
  }

  async topic(topicId: number) {
    return this.request(`/v1/topics/${topicId}`, topicSchema);
  }

  // ── Sentiment ──

  async mood(topicId: number, query: MoodQuery = {}) {
    return this.request(`/v1/topics/${topicId}/mood`, moodAggregateSchema, { query });
  }

  async submitSentiment(
    input: { topic_id: number; mood: Mood; intensity?: number; reason_code?: ReasonCode },
    idempotencyKey: string,
  ) {
    return this.request('/v1/sentiment', submitSentimentResponse, {
      method: 'POST',
      body: input,
      idempotencyKey,
    });
  }

  async mySentiment(topicIds?: readonly number[]) {
    return this.request('/v1/me/sentiment', z.object({ items: z.array(mySentimentSchema) }), {
      ...(topicIds && topicIds.length > 0 ? { query: { topic_ids: topicIds.join(',') } } : {}),
    });
  }

  // ── RTI ──

  async createRtiRequest(input: {
    authority_id: number;
    subject: string;
    topic_id?: number | null;
    track?: RtiTrack;
    filed_at?: string;
  }) {
    return this.request('/v1/rti', rtiRequestView, { method: 'POST', body: input });
  }

  async rtiRequests() {
    return this.request('/v1/rti', z.object({ items: z.array(rtiRequestView) }));
  }

  async rtiRequest(id: string) {
    return this.request(`/v1/rti/${id}`, rtiRequestView);
  }

  async transitionRti(id: string, to: RtiState, on?: string, note?: string) {
    return this.request(`/v1/rti/${id}/transitions`, rtiRequestView, {
      method: 'POST',
      body: { to, on, note },
    });
  }

  // ── Tax utilisation ──

  async taxUtilisation(regionId: number, fy: string) {
    return this.request('/v1/tax-utilisation', taxUtilisationView, {
      query: { region_id: regionId, fy },
    });
  }
}

export function createClient(opts: ClientOptions): CivicVoiceClient {
  return new CivicVoiceClient(opts);
}

/**
 * Idempotency keys for the write path. A key is derived from the citizen, the topic and a client-side
 * attempt token, so a retry after a timeout carries the SAME key and cannot double-submit — which on
 * a patchy mobile network is the normal case, not the edge case.
 */
export function idempotencyKeyFor(citizenId: string, topicId: number, attemptToken: string): string {
  return `${citizenId}:${topicId}:${attemptToken}`;
}

export * from '@civic-voice/contracts';
