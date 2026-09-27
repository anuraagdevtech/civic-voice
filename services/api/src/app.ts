import { createHash } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import underPressure from '@fastify/under-pressure';
import { z } from 'zod';
import {
  createRtiRequest,
  demographicDimensionSchema,
  moodQuery,
  registerCitizenRequest,
  rtiTransitionRequest,
  submitSentimentRequest,
  updateDemographicsRequest,
  type ErrorCode,
  type VerificationTier,
} from '@civic-voice/contracts';
import { badRequest, DomainError, notFound, unauthorized, uuidv7 } from '@civic-voice/core';
import type { CacheTier } from '@civic-voice/cache';
import type { Repositories } from '@civic-voice/db';
import type { EventBus } from '@civic-voice/stream';
import { createLogger, createMetrics, type Logger, type Metrics } from '@civic-voice/observability';
import type { ApiConfig } from './config.ts';
import { issueToken, principalFromHeader, type Principal } from './auth.ts';
import { DerivedTopicSaltProvider } from './services/salts.ts';
import { SentimentService } from './services/sentiment.ts';
import { RtiService } from './services/rti.ts';
import { TaxService } from './services/tax.ts';

export interface AppDeps {
  config: ApiConfig;
  repos: Repositories;
  cache: CacheTier;
  bus: EventBus;
  logger?: Logger;
  metrics?: Metrics;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export async function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger('api');
  const metrics = deps.metrics ?? createMetrics();
  const { config, repos, cache, bus } = deps;

  const salts = new DerivedTopicSaltProvider(config.pseudonymSaltRoot);
  const sentiment = new SentimentService({
    repos,
    cache,
    bus,
    salts,
    metrics,
    logger,
    kAnonymity: config.kAnonymity,
  });
  const rti = new RtiService(repos);
  const tax = new TaxService(repos, cache);

  const app = Fastify({
    loggerInstance: logger,
    // Behind a CDN and an ingress; trusting the proxy is what makes client IPs correct for the
    // edge-level budget, and it is safe only because nothing outside the ingress can reach us.
    trustProxy: true,
    bodyLimit: 64 * 1024,
    // Requests carry a `x-request-id` from the edge; generate one only when absent.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? uuidv7(),
    disableRequestLogging: config.env === 'production',
  });

  /**
   * Tolerate an empty body on a request that declares `application/json`.
   *
   * Fastify's default parser rejects that combination with a 400, but it is extremely common: many
   * HTTP clients set a default `content-type` on every request, including `DELETE /v1/me`, which has
   * no body to send. Failing a citizen's erasure request over a header they did not choose is not
   * acceptable.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        // A bare SyntaxError carries no status, so it would fall through to a 500 — and a 500 means
        // "we are broken", which would page someone for what is a client's malformed request.
        done(badRequest('request body is not valid JSON'), undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: false,
    // Clients must be able to send and read these, or idempotent retries break.
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['retry-after', 'x-request-id', 'x-aggregate-staleness'],
  });

  /**
   * Load shedding. At the spike load in docs/SCALING.md the correct behaviour under overload is to
   * reject fast with `Retry-After` so clients back off and replay with the same idempotency key —
   * accepting work we cannot finish just converts an overload into a timeout cascade.
   */
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    retryAfter: 5,
    healthCheckInterval: 5_000,
    healthCheck: async () => {
      await Promise.all([cache.ready(), repos.ready()]);
      return true;
    },
  });

  // ── Cross-cutting ──

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', String(request.id));
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    metrics.inc('civic_http_requests_total', {
      route,
      method: request.method,
      status: reply.statusCode,
    });
    metrics.observe('civic_http_duration_ms', reply.elapsedTime, { route });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retry_after_seconds: error.retryAfterSeconds }),
        },
      });
    }

    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'bad_request' satisfies ErrorCode,
          message: 'request did not match the schema',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // Fastify's own errors (body too large, unsupported media type). `statusCode` is not on the
    // base Error type, so narrow it rather than assuming it is there.
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status < 500) {
      return reply.status(status).send({
        error: {
          code: 'bad_request' satisfies ErrorCode,
          message: error instanceof Error ? error.message : 'bad request',
        },
      });
    }

    // Unexpected: log it with the request id, return nothing internal to the caller.
    logger.error({ err: error, req_id: request.id }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal' satisfies ErrorCode, message: 'internal error' },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found' satisfies ErrorCode, message: 'no such route' } }),
  );

  const authenticate = async (request: FastifyRequest): Promise<Principal> => {
    const principal = principalFromHeader(config.tokenSecret, request.headers.authorization);
    request.principal = principal;
    return principal;
  };

  /**
   * Public aggregate reads are the 98% of traffic that must terminate at the CDN
   * (docs/SCALING.md §2). `stale-while-revalidate` is what turns a 30s TTL into a near-100% hit rate:
   * the edge serves a slightly stale number instantly and refreshes behind the request, so an
   * expiring entry never becomes an origin stampede.
   */
  const cacheableAggregate = (reply: FastifyReply, stalenessSeconds: number) => {
    reply.header(
      'cache-control',
      `public, max-age=${config.aggregateCacheSeconds}, ` +
        `stale-while-revalidate=${config.aggregateStaleWhileRevalidateSeconds}`,
    );
    // Surfaced in a header as well as the body, so a cache or proxy can see it too.
    reply.header('x-aggregate-staleness', String(stalenessSeconds));
  };

  /** Private responses must never be cached by a shared cache. */
  const privateResponse = (reply: FastifyReply) => {
    reply.header('cache-control', 'private, no-store');
  };

  // ── Health and metrics ──

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    // Readiness is a real dependency check, not a liveness ping: the Redis client runs with the
    // offline queue disabled, so a pod that has not connected must not receive traffic.
    try {
      await Promise.all([cache.ready(), repos.ready()]);
      return { ready: true };
    } catch (err) {
      logger.warn({ err }, 'not ready');
      return reply.status(503).send({
        error: { code: 'degraded' satisfies ErrorCode, message: 'dependencies unavailable' },
      });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return metrics.render();
  });

  // ── Identity ──

  app.post('/v1/citizens', async (request, reply) => {
    const input = registerCitizenRequest.parse(request.body);
    const region = await repos.catalogue.getRegion(input.region_id);
    if (!region) throw notFound(`no region ${input.region_id}`);

    const id = uuidv7();
    // Tier 0. Device attestation would be verified here against Play Integrity / App Attest; a
    // missing attestation still registers, because participation is never blocked (ADR-0005).
    const citizen = await repos.citizens.create({
      id,
      region_id: region.id,
      region_path: region.path,
      locale: input.locale,
      demographics: input.demographics,
      verification_tier: 0,
    });

    privateResponse(reply);
    return reply.status(201).send({
      citizen: {
        id: citizen.id,
        region_id: citizen.region_id,
        verification_tier: citizen.verification_tier,
        locale: citizen.locale,
        demographics: citizen.demographics,
        created_at: citizen.created_at,
      },
      access_token: issueToken(config.tokenSecret, citizen.id, 0, config.tokenTtlSeconds),
      expires_in: config.tokenTtlSeconds,
    });
  });

  app.patch('/v1/me', async (request, reply) => {
    const principal = await authenticate(request);
    const input = updateDemographicsRequest.parse(request.body);

    const patch: Parameters<Repositories['citizens']['updateProfile']>[1] = {
      demographics: input.demographics,
    };
    if (input.locale !== undefined) patch.locale = input.locale;
    if (input.region_id !== undefined) {
      const region = await repos.catalogue.getRegion(input.region_id);
      if (!region) throw notFound(`no region ${input.region_id}`);
      patch.region_id = region.id;
      patch.region_path = region.path;
    }

    const updated = await repos.citizens.updateProfile(principal.citizenId, patch);
    if (!updated) throw notFound('citizen not found');
    // Or the next submission would be recorded against the bands they just changed away from.
    await cache.profiles.invalidate(principal.citizenId);

    privateResponse(reply);
    return { ok: true as const };
  });

  app.delete('/v1/me', async (request, reply) => {
    const principal = await authenticate(request);
    const erased = await repos.citizens.erase(principal.citizenId);
    if (!erased) throw notFound('citizen not found or already erased');
    await cache.profiles.invalidate(principal.citizenId);
    privateResponse(reply);
    return { erased: true as const };
  });

  // ── Catalogue ──

  app.get('/v1/regions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const region = await repos.catalogue.getRegion(id);
    if (!region) throw notFound(`no region ${id}`);
    // The catalogue is public and changes on the order of months.
    reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return region;
  });

  app.get('/v1/regions/:id/children', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return { items: await repos.catalogue.childRegions(id) };
  });

  app.get('/v1/topics', async (request, reply) => {
    const query = z
      .object({
        region_id: z.coerce.number().int().positive().optional(),
        kind: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query);

    const items = await repos.catalogue.listTopics({
      ...(query.region_id === undefined ? {} : { regionId: query.region_id }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      status: 'active',
      limit: query.limit,
    });
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return { items, next_cursor: null };
  });

  app.get('/v1/topics/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const topic = await repos.catalogue.getTopic(id);
    if (!topic) throw notFound(`no topic ${id}`);
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return topic;
  });

  app.get('/v1/authorities/:id', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const authority = await repos.catalogue.getAuthority(id);
    if (!authority) throw notFound(`no authority ${id}`);
    reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return authority;
  });

  // ── Sentiment: read ──

  app.get('/v1/topics/:id/mood', async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const query = moodQuery
      .extend({
        region_id: z.coerce.number().int().positive().optional(),
        dimension: demographicDimensionSchema.optional(),
        tier: z.coerce.number().int().min(0).max(3).optional(),
      })
      .parse(request.query);

    const aggregate = await sentiment.moodAggregate(id, {
      ...(query.region_id === undefined ? {} : { regionId: query.region_id }),
      ...(query.dimension === undefined ? {} : { dimension: query.dimension }),
      ...(query.tier === undefined ? {} : { tier: query.tier as VerificationTier }),
    });
    cacheableAggregate(reply, aggregate.staleness_seconds);
    return aggregate;
  });

  // ── Sentiment: write ──

  app.post('/v1/sentiment', async (request, reply) => {
    const principal = await authenticate(request);
    const input = submitSentimentRequest.parse(request.body);
    privateResponse(reply);

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      throw badRequest('an Idempotency-Key header of at least 8 characters is required for writes');
    }

    // Scope the key to the caller, so one client cannot collide with — or replay — another's write.
    const scopedKey = `${principal.citizenId}:${idempotencyKey}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 32);

    const claim = await cache.idempotency.claim(scopedKey, requestHash);
    if (!claim.claimed) {
      if (claim.conflict) {
        throw new DomainError(
          'conflict',
          'this Idempotency-Key was already used for a different submission',
        );
      }
      if (claim.response !== null) {
        metrics.inc('civic_sentiment_replayed_total');
        return reply.status(200).send({ ...JSON.parse(claim.response), replayed: true });
      }
      // The original is still in flight. Telling the client to retry is honest; guessing is not.
      throw new DomainError('conflict', 'an identical submission is still being processed', {
        status: 409,
        retryAfterSeconds: 2,
      });
    }

    try {
      const quota = await cache.quotas.checkAndConsume(principal.citizenId, input.topic_id);
      if (!quota.allowed) {
        metrics.inc('civic_quota_rejections_total', { reason: quota.reason ?? 'unknown' });
        // Release the key: the write never happened, so the same key must be usable again.
        await cache.idempotency.release(scopedKey);
        throw new DomainError(quota.reason ?? 'rate_limited', 'write quota exceeded', {
          status: 429,
          ...(quota.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: quota.retryAfterSeconds }),
        });
      }

      const profile = await sentiment.profileFor(principal.citizenId);
      const result = await sentiment.submit(principal.citizenId, input, profile);

      const body = {
        accepted: true,
        event_id: result.eventId,
        aggregate: result.aggregate,
        replayed: false,
      };
      await cache.idempotency.complete(scopedKey, JSON.stringify(body));
      return reply.status(202).send(body);
    } catch (err) {
      // Anything that prevented the append must free the key, or an honest retry would be refused
      // as a duplicate of a write that never happened.
      if (!(err instanceof DomainError) || err.code !== 'rate_limited') {
        await cache.idempotency.release(scopedKey).catch(() => {});
      }
      throw err;
    }
  });

  app.get('/v1/me/sentiment', async (request, reply) => {
    const principal = await authenticate(request);
    const query = z.object({ topic_ids: z.string().max(2000).optional() }).parse(request.query);

    const topicIds = query.topic_ids
      ?.split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);

    privateResponse(reply);
    return { items: await sentiment.mySentiment(principal.citizenId, topicIds) };
  });

  // ── RTI ──

  app.post('/v1/rti', async (request, reply) => {
    const principal = await authenticate(request);
    const input = createRtiRequest.parse(request.body);
    privateResponse(reply);
    return reply.status(201).send(await rti.create(principal.citizenId, input));
  });

  app.get('/v1/rti', async (request, reply) => {
    const principal = await authenticate(request);
    privateResponse(reply);
    return { items: await rti.list(principal.citizenId) };
  });

  app.get('/v1/rti/:id', async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    privateResponse(reply);
    return rti.get(principal.citizenId, id);
  });

  app.post('/v1/rti/:id/transitions', async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = rtiTransitionRequest.parse(request.body);
    privateResponse(reply);
    return rti.transition(principal.citizenId, id, input.to, input.on);
  });

  // ── Tax utilisation ──

  app.get('/v1/tax-utilisation', async (request, reply) => {
    const query = z
      .object({
        region_id: z.coerce.number().int().positive(),
        fy: z.string().regex(/^\d{4}-\d{2}$/),
      })
      .parse(request.query);
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return tax.view(query.region_id, query.fy);
  });

  return app;
}

export { unauthorized };
