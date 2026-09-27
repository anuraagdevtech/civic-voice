import {
  authoritySchema,
  cohortInsightSchema,
  commentViewSchema,
  digestSchema,
  documentViewSchema,
  financeResponseSchema,
  sectorInsightSchema,
  errorResponse,
  indicatorSchema,
  jobsSummarySchema,
  postCommentResponse,
  resolveLocationResponse,
  trendingItemSchema,
  type CohortId,
  type FiscalStage,
  type CommentSort,
  type DocumentKind,
  type RaiseIssueRequest,
  type ReportReason,
  moodAggregateSchema,
  mySentimentSchema,
  paged,
  regionSchema,
  registerCitizenResponse,
  rtiRequestView,
  submitSentimentResponse,
  taxUtilisationView,
  topicSchema,
  type DemographicDimension,
  type Demographics,
  type ErrorCode,
  type Locale,
  type Mood,
  type MoodQuery,
  type ReasonCode,
  type RtiState,
  type RtiTrack,
  type VerificationTier,
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
   *
   * Note that `cooldown_active` is deliberately **not** retryable, even though it is a 429 like
   * `rate_limited`. A cooldown means the citizen's opinion is *already recorded* and they are changing
   * it too fast; auto-replaying ten minutes later would apply a change they never saw land, and by
   * then may not hold. A `rate_limited` write genuinely did not happen, so replaying it is correct.
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    // Built as a string rather than through `new URL()`: the web app is served from the same origin
    // as the API and so configures an empty `baseUrl`, and `new URL('/v1/...')` with no base throws.
    // Relative and absolute bases both have to work.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const queryString = params.toString();
    const url = `${this.baseUrl}${path}${queryString.length > 0 ? `?${queryString}` : ''}`;

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
    /** From `resolveLocation`: marks the home region as confirmed by this device's location. */
    location_attestation?: string;
  }) {
    const result = await this.request('/v1/citizens', registerCitizenResponse, {
      method: 'POST',
      body: input,
    });
    this.setAccessToken(result.access_token);
    return result;
  }

  async updateProfile(input: {
    demographics?: Demographics;
    region_id?: number;
    locale?: Locale;
    location_attestation?: string;
  }) {
    return this.request('/v1/me', z.object({ ok: z.literal(true) }), {
      method: 'PATCH',
      body: input,
    });
  }

  async meta() {
    return this.request(
      '/v1/meta',
      z.object({
        demo: z.boolean(),
        k_anonymity: z.number().int(),
        attribution: z.array(z.string()),
      }),
    );
  }

  async me() {
    return this.request(
      '/v1/me',
      z.object({
        id: z.string().uuid(),
        region_id: z.number().int(),
        region_path: z.array(z.number().int()),
        region_basis: z.enum(['declared', 'device']),
        verification_tier: z.number().int(),
        locale: z.string(),
        demographics: z.record(z.string()),
        created_at: z.string(),
      }),
    );
  }

  /**
   * Which region is this point in? The coordinate is coarsened to three decimals (~110 m) here,
   * before it leaves the device, and sent in a request body so it lands in no URL or access log.
   */
  async resolveLocation(lat: number, lng: number) {
    const coarse = (v: number) => Math.round(v * 1000) / 1000;
    return this.request('/v1/geo/resolve', resolveLocationResponse, {
      method: 'POST',
      body: { lat: coarse(lat), lng: coarse(lng) },
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
    return this.request(
      `/v1/regions/${regionId}/children`,
      z.object({ items: z.array(regionSchema) }),
    );
  }

  async topics(query: { region_id?: number; kind?: string; limit?: number } = {}) {
    return this.request('/v1/topics', paged(topicSchema), { query });
  }

  async topic(topicId: number) {
    return this.request(`/v1/topics/${topicId}`, topicSchema);
  }

  async authority(authorityId: number) {
    return this.request(`/v1/authorities/${authorityId}`, authoritySchema);
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

  // ── Forum ──

  async comments(
    topicId: number,
    query: { sort?: CommentSort; limit?: number; cursor?: string; parent_id?: string } = {},
  ) {
    return this.request(
      `/v1/topics/${topicId}/comments`,
      z.object({
        items: z.array(commentViewSchema),
        next_cursor: z.string().nullable(),
        total: z.number().int(),
      }),
      { query },
    );
  }

  async postComment(
    topicId: number,
    input: { body: string; parent_id?: string | null },
    idempotencyKey: string,
  ) {
    return this.request(
      `/v1/topics/${topicId}/comments`,
      postCommentResponse.extend({ replayed: z.boolean() }),
      {
        method: 'POST',
        body: { body: input.body, parent_id: input.parent_id ?? null },
        idempotencyKey,
      },
    );
  }

  async myVotes(topicId: number, commentIds: readonly string[]) {
    return this.request(
      `/v1/topics/${topicId}/comments/mine/votes`,
      z.object({ upvoted: z.array(z.string()) }),
      {
        query: { ids: commentIds.join(',') },
      },
    );
  }

  async vote(topicId: number, commentId: string, on: boolean) {
    return this.request(
      `/v1/topics/${topicId}/comments/${commentId}/vote`,
      z.object({ upvotes: z.number().int(), upvoted: z.boolean() }),
      { method: on ? 'PUT' : 'DELETE' },
    );
  }

  async reportComment(topicId: number, commentId: string, reason: ReportReason) {
    return this.request(
      `/v1/topics/${topicId}/comments/${commentId}/reports`,
      z.object({ received: z.literal(true) }),
      {
        method: 'POST',
        body: { reason },
      },
    );
  }

  async deleteComment(topicId: number, commentId: string) {
    return this.request(
      `/v1/topics/${topicId}/comments/${commentId}`,
      z.object({ deleted: z.literal(true) }),
      {
        method: 'DELETE',
      },
    );
  }

  async myComments(limit = 50) {
    return this.request('/v1/me/comments', z.object({ items: z.array(commentViewSchema) }), {
      query: { limit },
    });
  }

  async digest(topicId: number) {
    return this.request(
      `/v1/topics/${topicId}/digest`,
      z.object({
        digest: digestSchema.nullable(),
        comments: z.number().int(),
        needed: z.number().int(),
      }),
    );
  }

  async trending(regionId: number, limit = 10) {
    return this.request('/v1/trending', z.object({ items: z.array(trendingItemSchema) }), {
      query: { region_id: regionId, limit },
    });
  }

  async raiseIssue(input: RaiseIssueRequest, idempotencyKey: string) {
    return this.request('/v1/issues', topicSchema, { method: 'POST', body: input, idempotencyKey });
  }

  // ── Documents, jobs, indicators, insights ──

  async documents(query: {
    region_id: number;
    kind?: readonly DocumentKind[];
    subject?: 'project' | 'scheme';
    limit?: number;
    cursor?: string;
  }) {
    return this.request(
      '/v1/documents',
      z.object({ items: z.array(documentViewSchema), next_cursor: z.string().nullable() }),
      {
        query: {
          region_id: query.region_id,
          kind: query.kind?.join(','),
          subject: query.subject,
          limit: query.limit,
          cursor: query.cursor,
        },
      },
    );
  }

  async jobs(regionId: number) {
    return this.request('/v1/jobs', jobsSummarySchema, { query: { region_id: regionId } });
  }

  async indicators(regionId: number) {
    return this.request('/v1/indicators', z.object({ items: z.array(indicatorSchema) }), {
      query: { region_id: regionId },
    });
  }

  /** A government's taxes by category, spending by sector, and the gap. Region = government. */
  async finance(regionId: number, opts: { fy?: string; stage?: FiscalStage } = {}) {
    return this.request('/v1/finance', financeResponseSchema, {
      query: { region_id: regionId, ...opts },
    });
  }

  /** Opinion against allocation, sector by sector, for one government. For researchers. */
  async sectorInsight(
    regionId: number,
    opts: {
      fy?: string;
      stage?: FiscalStage;
      days?: number;
      dimension?: DemographicDimension;
      tier?: VerificationTier;
    } = {},
  ) {
    return this.request('/v1/insights/sectors', sectorInsightSchema, {
      query: { region_id: regionId, ...opts },
    });
  }

  /** The same, as CSV, for a spreadsheet. The URL is edge-cacheable and needs no credentials. */
  sectorInsightCsvUrl(
    regionId: number,
    opts: {
      fy?: string;
      stage?: FiscalStage;
      days?: number;
      dimension?: DemographicDimension;
      tier?: VerificationTier;
    } = {},
  ): string {
    const q = new URLSearchParams({ region_id: String(regionId), format: 'csv' });
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    return `${this.baseUrl}/v1/insights/sectors?${q.toString()}`;
  }

  async cohortInsight(cohort: CohortId, regionId: number, days = 30) {
    return this.request('/v1/insights/cohort', cohortInsightSchema, {
      query: { cohort, region_id: regionId, days },
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
export function idempotencyKeyFor(
  citizenId: string,
  topicId: number,
  attemptToken: string,
): string {
  return `${citizenId}:${topicId}:${attemptToken}`;
}

/** A fresh idempotency key for a one-off write (a comment, an issue); reuse it on retry. */
export function newWriteKey(): string {
  return globalThis.crypto.randomUUID();
}

export * from '@civic-voice/contracts';
