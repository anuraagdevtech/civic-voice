import { createHash } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COHORT_IDS,
  COMMENT_SORTS,
  DOCUMENT_KINDS,
  FISCAL_STAGES,
  postCommentRequest,
  raiseIssueRequest,
  reportCommentRequest,
  resolveLocationRequest,
  type CohortId,
} from '@civic-voice/contracts';
import { badRequest, DomainError } from '@civic-voice/core';
import type { CacheTier } from '@civic-voice/cache';
import type { Principal } from '../auth.ts';
import type { ForumService } from '../services/forum.ts';
import type { LocationService } from '../services/location.ts';
import type { PublicDataService } from '../services/public-data.ts';
import type { Logger, Metrics } from '@civic-voice/observability';

/** The app as buildApp constructs it — with the service's pino logger, not Fastify's base type. */
type App = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;

export interface ForumRouteContext {
  authenticate(request: FastifyRequest): Promise<Principal>;
  privateResponse(reply: FastifyReply): void;
  forum: ForumService;
  location: LocationService;
  publicData: PublicDataService;
  cache: CacheTier;
  metrics: Metrics;
}

const topicParams = z.object({ id: z.coerce.number().int().positive() });
const commentParams = z.object({
  id: z.coerce.number().int().positive(),
  commentId: z.string().uuid(),
});
const regionQuery = z.object({ region_id: z.coerce.number().int().positive() });

/** Public reads that change as people post: short edge TTL, served stale while refreshing. */
const liveCache = (reply: FastifyReply, seconds: number) =>
  reply.header(
    'cache-control',
    `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`,
  );

export function registerForumRoutes(app: App, ctx: ForumRouteContext): void {
  const { authenticate, privateResponse, forum, location, publicData, cache } = ctx;

  /**
   * The write-once discipline the opinion endpoint uses, for comments: the same Idempotency-Key with
   * the same body replays the first response; with a different body it is a conflict.
   */
  const idempotent = async <T>(
    request: FastifyRequest,
    principal: Principal,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<{ body: T; replayed: boolean }> => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw badRequest('an Idempotency-Key header of at least 8 characters is required for writes');
    }
    const scoped = `${principal.citizenId}:${key}`;
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
    const claim = await cache.idempotency.claim(scoped, hash);
    if (!claim.claimed) {
      if (claim.conflict)
        throw new DomainError(
          'conflict',
          'this Idempotency-Key was already used for a different request',
        );
      if (claim.response !== null) return { body: JSON.parse(claim.response) as T, replayed: true };
      throw new DomainError('conflict', 'an identical request is still being processed', {
        status: 409,
        retryAfterSeconds: 2,
      });
    }
    try {
      const body = await run();
      await cache.idempotency.complete(scoped, JSON.stringify(body));
      return { body, replayed: false };
    } catch (err) {
      // The write did not happen, so the key must be usable again.
      await cache.idempotency.release(scoped).catch(() => {});
      throw err;
    }
  };

  // ── Where am I ──

  // POST, not GET: a coordinate in a query string ends up in access logs, proxies and browser history.
  app.post('/v1/geo/resolve', async (request, reply) => {
    const input = resolveLocationRequest.parse(request.body);
    privateResponse(reply);
    return location.resolve(input.lat, input.lng);
  });

  // ── Comments ──

  app.post('/v1/topics/:id/comments', async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = topicParams.parse(request.params);
    const input = postCommentRequest.parse(request.body);
    privateResponse(reply);
    const { body, replayed } = await idempotent(request, principal, { id, ...input }, () =>
      forum.post(principal.citizenId, id, input),
    );
    return reply.status(replayed ? 200 : 202).send({ ...body, replayed });
  });

  app.get('/v1/topics/:id/comments', async (request, reply) => {
    const { id } = topicParams.parse(request.params);
    const query = z
      .object({
        sort: z.enum(COMMENT_SORTS).default('top'),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().max(300).optional(),
        parent_id: z.string().uuid().optional(),
      })
      .parse(request.query);
    const page = await forum.list(id, {
      sort: query.sort,
      limit: query.limit,
      cursor: query.cursor ?? null,
      parentId: query.parent_id ?? null,
    });
    liveCache(reply, 15);
    return page;
  });

  // Which of these has the caller upvoted. Separate from the listing so the listing stays cacheable.
  app.get('/v1/topics/:id/comments/mine/votes', async (request, reply) => {
    const principal = await authenticate(request);
    const { id } = topicParams.parse(request.params);
    const { ids } = z.object({ ids: z.string().max(4000) }).parse(request.query);
    const commentIds = ids.split(',').filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    privateResponse(reply);
    return { upvoted: await forum.myVotes(principal.citizenId, id, commentIds) };
  });

  app.put('/v1/topics/:id/comments/:commentId/vote', async (request, reply) => {
    const principal = await authenticate(request);
    const { id, commentId } = commentParams.parse(request.params);
    privateResponse(reply);
    return forum.vote(principal.citizenId, id, commentId, true);
  });

  app.delete('/v1/topics/:id/comments/:commentId/vote', async (request, reply) => {
    const principal = await authenticate(request);
    const { id, commentId } = commentParams.parse(request.params);
    privateResponse(reply);
    return forum.vote(principal.citizenId, id, commentId, false);
  });

  app.post('/v1/topics/:id/comments/:commentId/reports', async (request, reply) => {
    const principal = await authenticate(request);
    const { id, commentId } = commentParams.parse(request.params);
    const { reason } = reportCommentRequest.parse(request.body);
    privateResponse(reply);
    return reply.status(202).send(await forum.report(principal.citizenId, id, commentId, reason));
  });

  app.delete('/v1/topics/:id/comments/:commentId', async (request, reply) => {
    const principal = await authenticate(request);
    const { id, commentId } = commentParams.parse(request.params);
    privateResponse(reply);
    return forum.deleteOwn(principal.citizenId, id, commentId);
  });

  app.get('/v1/me/comments', async (request, reply) => {
    const principal = await authenticate(request);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    privateResponse(reply);
    return { items: await forum.mine(principal.citizenId, limit) };
  });

  // ── What the public thinks ──

  app.get('/v1/topics/:id/digest', async (request, reply) => {
    const { id } = topicParams.parse(request.params);
    liveCache(reply, 60);
    return forum.digest(id);
  });

  app.get('/v1/trending', async (request, reply) => {
    const { region_id, limit } = regionQuery
      .extend({ limit: z.coerce.number().int().min(1).max(50).default(10) })
      .parse(request.query);
    liveCache(reply, 60);
    return { items: await forum.trending(region_id, limit) };
  });

  app.post('/v1/issues', async (request, reply) => {
    const principal = await authenticate(request);
    const input = raiseIssueRequest.parse(request.body);
    privateResponse(reply);
    const { body, replayed } = await idempotent(request, principal, input, () =>
      forum.raiseIssue(principal.citizenId, input),
    );
    return reply.status(replayed ? 200 : 201).send(body);
  });

  // ── Documents, jobs, indicators ──

  app.get('/v1/documents', async (request, reply) => {
    const query = regionQuery
      .extend({
        kind: z.string().max(200).optional(),
        subject: z.enum(['project', 'scheme']).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z
          .string()
          .max(40)
          .regex(/^(\d{4}-\d{2}-\d{2})?_\d+$/)
          .optional(),
      })
      .parse(request.query);
    const kinds = query.kind?.split(',').map((k) => z.enum(DOCUMENT_KINDS).parse(k.trim()));
    const [date, id] = query.cursor?.split('_') ?? [];
    const page = await publicData.documents(query.region_id, {
      ...(kinds ? { kinds } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
      limit: query.limit,
      before: query.cursor ? { published_on: date || null, id: Number(id) } : null,
    });
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return page;
  });

  app.get('/v1/documents/:id', async (request, reply) => {
    const { id } = topicParams.parse(request.params);
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return publicData.document(id);
  });

  app.get('/v1/jobs', async (request, reply) => {
    const { region_id } = regionQuery.parse(request.query);
    reply.header('cache-control', 'public, max-age=600, stale-while-revalidate=3600');
    return publicData.jobs(region_id);
  });

  app.get('/v1/indicators', async (request, reply) => {
    const { region_id } = regionQuery.parse(request.query);
    reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return { items: await publicData.indicators(region_id) };
  });

  app.get('/v1/finance', async (request, reply) => {
    const { region_id, fy, stage } = regionQuery
      .extend({
        fy: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
        stage: z.enum(FISCAL_STAGES).optional(),
      })
      .parse(request.query);
    // Budgets change twice a year; an hour at the edge costs nothing in freshness.
    reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return publicData.finance(region_id, fy, stage);
  });

  app.get('/v1/insights/cohort', async (request, reply) => {
    const query = regionQuery
      .extend({
        cohort: z.enum(COHORT_IDS as [CohortId, ...CohortId[]]),
        days: z.coerce.number().int().min(7).max(365).default(30),
      })
      .parse(request.query);
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
    return publicData.cohort(query.cohort, query.region_id, query.days);
  });
}
