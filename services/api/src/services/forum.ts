import {
  DIGEST_MIN_COMMENTS,
  EVENT_TOPICS,
  type CommentEvent,
  type CommentView,
  type Digest,
  type PostCommentRequest,
  type RaiseIssueRequest,
  type ReportReason,
  type TrendingItem,
} from '@civic-voice/contracts';
import {
  badRequest,
  derivePseudonym,
  DomainError,
  handleFor,
  inJurisdiction,
  notFound,
  rollupAncestors,
  uuidv7,
  type TopicSaltProvider,
} from '@civic-voice/core';
import type { CacheTier, CitizenProfile, ForumAction } from '@civic-voice/cache';
import type { CommentRow, Repositories, TopicRow } from '@civic-voice/db';
import { detectPii, moderate, sectorFor } from '@civic-voice/nlp';
import type { EventBus } from '@civic-voice/stream';
import type { Metrics } from '@civic-voice/observability';
import type { RegionCache } from './regions.ts';

/**
 * The forum's synchronous half (ADR-0008, ADR-0009). What has to be decided while the author is
 * still looking at the screen is decided here — may you speak on this, are you over your limit, does
 * your comment contain a phone number — and then the comment goes on the log like an opinion does.
 * Everything slower (the model, the large model, storage, trending, digests) is the worker's.
 */
export const FORUM_LIMITS: Record<ForumAction, { limit: number; windowSeconds: number }> = {
  comment: { limit: 20, windowSeconds: 3600 },
  issue: { limit: 3, windowSeconds: 86_400 },
  report: { limit: 30, windowSeconds: 3600 },
  vote: { limit: 300, windowSeconds: 3600 },
};

const PII_LABELS: Record<string, string> = {
  aadhaar: 'an Aadhaar number',
  pan: 'a PAN',
  phone: 'a phone number',
  email: 'an email address',
  upi: 'a UPI id',
  bank_account: 'a bank account number',
};

export interface ForumDeps {
  repos: Repositories;
  cache: CacheTier;
  bus: EventBus;
  salts: TopicSaltProvider;
  regions: RegionCache;
  metrics: Metrics;
  profileFor(citizenId: string): Promise<CitizenProfile>;
}

export function toCommentView(row: CommentRow, opts: { own?: boolean } = {}): CommentView {
  return {
    id: row.id,
    topic_id: row.topic_id,
    parent_id: row.parent_id,
    handle: row.handle,
    body: row.body,
    language: row.language,
    area: row.area,
    located: row.located,
    verification_tier: row.verification_tier,
    analysis:
      row.sentiment === null || row.model === null
        ? null
        : {
            sentiment:
              row.sentiment === -1 ? 'negative' : row.sentiment === 1 ? 'positive' : 'neutral',
            needs: row.needs,
            suggestion: row.suggestion,
            model: row.model,
          },
    upvotes: row.upvotes,
    reply_count: row.reply_count,
    created_at: row.created_at,
    ...(opts.own ? { state: row.state } : {}),
  };
}

export class ForumService {
  private readonly deps: ForumDeps;

  constructor(deps: ForumDeps) {
    this.deps = deps;
  }

  private async limit(citizenId: string, action: ForumAction): Promise<void> {
    const { limit, windowSeconds } = FORUM_LIMITS[action];
    const decision = await this.deps.cache.forumLimits.consume(
      citizenId,
      action,
      limit,
      windowSeconds,
    );
    if (!decision.allowed) {
      this.deps.metrics.inc('civic_forum_limited_total', { action });
      throw new DomainError('rate_limited', `too many ${action}s; try again later`, {
        status: 429,
        ...(decision.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: decision.retryAfterSeconds }),
      });
    }
  }

  private async activeTopic(topicId: number): Promise<TopicRow> {
    const topic = await this.deps.repos.catalogue.getTopic(topicId);
    if (!topic || topic.status !== 'active') throw notFound(`no open topic ${topicId}`);
    return topic;
  }

  /** "Issues of Hyderabad are for Hyderabad people": only residents of a topic's jurisdiction speak on it. */
  private async requireLocal(profile: CitizenProfile, topic: TopicRow): Promise<void> {
    if (inJurisdiction(profile.region_path, topic.jurisdiction_region_id)) return;
    const where = await this.deps.regions.name(topic.jurisdiction_region_id);
    throw new DomainError(
      'not_local',
      `this discussion is for residents of ${where ?? 'the area it concerns'}`,
      {
        details: { jurisdiction_region_id: topic.jurisdiction_region_id, jurisdiction_name: where },
      },
    );
  }

  /**
   * Refuse, before accepting, text that would put someone's identity on a public page. The author is
   * told what kind of thing was found — never the match itself, which would echo it into a response
   * body that proxies and browser extensions can see.
   */
  private screen(text: string): void {
    const pii = detectPii(text);
    if (pii.length > 0) {
      const kinds = [...new Set(pii.map((p) => p.kind))];
      throw new DomainError(
        'content_rejected',
        `please remove ${kinds.map((k) => PII_LABELS[k] ?? k).join(' and ')} before posting — comments are public`,
        { details: { reasons: kinds.map((k) => `personal_info:${k}`) } },
      );
    }
    const verdict = moderate(text);
    if (verdict.verdict === 'reject') {
      throw new DomainError('content_rejected', 'this comment cannot be posted', {
        details: { reasons: verdict.reasons },
      });
    }
  }

  private async pseudonymFor(topicId: number, citizenId: string): Promise<string> {
    return derivePseudonym(await this.deps.salts.saltFor(topicId), citizenId);
  }

  /** The author's area one level below the topic's jurisdiction: their ward on a city topic. */
  private async areaOf(
    path: readonly number[],
    jurisdictionId: number,
  ): Promise<{ id: number | null; name: string | null }> {
    const at = path.indexOf(jurisdictionId);
    const areaId = at >= 0 ? (path[at + 1] ?? null) : null;
    return { id: areaId, name: await this.deps.regions.name(areaId) };
  }

  async post(
    citizenId: string,
    topicId: number,
    input: PostCommentRequest,
  ): Promise<{ comment_id: string; state: 'pending'; handle: string }> {
    const topic = await this.activeTopic(topicId);
    const profile = await this.deps.profileFor(citizenId);
    await this.requireLocal(profile, topic);
    this.screen(input.body);

    if (input.parent_id) {
      const parent = await this.deps.repos.forum.getComment(topicId, input.parent_id);
      if (!parent || parent.state !== 'published')
        throw notFound('the comment you are replying to is not available');
      if (parent.parent_id !== null)
        throw badRequest('replies are one level deep; reply to the top-level comment');
    }
    await this.limit(citizenId, 'comment');

    const pseudonym = await this.pseudonymFor(topicId, citizenId);
    const area = await this.areaOf(profile.region_path, topic.jurisdiction_region_id);
    const event: CommentEvent = {
      comment_id: uuidv7(),
      citizen_id: citizenId,
      topic_id: topicId,
      parent_id: input.parent_id,
      occurred_at: new Date().toISOString(),
      body: input.body,
      pseudonym,
      handle: handleFor(pseudonym),
      region_path: rollupAncestors(profile.region_path),
      area_region_id: area.id,
      area: area.name,
      region_basis: profile.region_basis ?? 'declared',
      verification_tier: profile.verification_tier,
      demographics: profile.demographics,
    };
    await this.deps.bus.producer.publish(EVENT_TOPICS.COMMENT, event, { key: String(topicId) });
    this.deps.metrics.inc('civic_comments_accepted_total');
    return { comment_id: event.comment_id, state: 'pending', handle: event.handle };
  }

  async list(
    topicId: number,
    opts: { sort: 'top' | 'new'; limit: number; cursor?: string | null; parentId?: string | null },
  ): Promise<{ items: CommentView[]; next_cursor: string | null; total: number }> {
    const topic = await this.deps.repos.catalogue.getTopic(topicId);
    if (!topic) throw notFound(`no topic ${topicId}`);
    const [page, total] = await Promise.all([
      this.deps.repos.forum.listComments(topicId, opts),
      this.deps.repos.forum.countPublished(topicId),
    ]);
    return { items: page.items.map((c) => toCommentView(c)), next_cursor: page.next_cursor, total };
  }

  async myVotes(
    citizenId: string,
    topicId: number,
    commentIds: readonly string[],
  ): Promise<string[]> {
    const pseudonym = await this.pseudonymFor(topicId, citizenId);
    return [...(await this.deps.repos.forum.votedBy(topicId, commentIds.slice(0, 100), pseudonym))];
  }

  async vote(
    citizenId: string,
    topicId: number,
    commentId: string,
    on: boolean,
  ): Promise<{ upvotes: number; upvoted: boolean }> {
    const topic = await this.activeTopic(topicId);
    await this.requireLocal(await this.deps.profileFor(citizenId), topic);
    await this.limit(citizenId, 'vote');
    const pseudonym = await this.pseudonymFor(topicId, citizenId);
    const result = await this.deps.repos.forum.setVote(topicId, commentId, pseudonym, on);
    if (!result) throw notFound('no such comment');
    return { upvotes: result.upvotes, upvoted: on };
  }

  async report(
    citizenId: string,
    topicId: number,
    commentId: string,
    reason: ReportReason,
  ): Promise<{ received: true }> {
    await this.limit(citizenId, 'report');
    const pseudonym = await this.pseudonymFor(topicId, citizenId);
    const result = await this.deps.repos.forum.report(topicId, commentId, pseudonym, reason);
    if (!result) throw notFound('no such comment');
    if (result.held) this.deps.metrics.inc('civic_comments_held_by_reports_total');
    // The same answer whether or not this report tipped it over: telling a reporter "that one did it"
    // would make coordinated reporting easier to tune.
    return { received: true };
  }

  async deleteOwn(
    citizenId: string,
    topicId: number,
    commentId: string,
  ): Promise<{ deleted: true }> {
    if (!(await this.deps.repos.forum.deleteOwn(citizenId, topicId, commentId)))
      throw notFound('no such comment of yours');
    return { deleted: true };
  }

  async mine(citizenId: string, limit: number): Promise<CommentView[]> {
    return (await this.deps.repos.forum.myComments(citizenId, limit)).map((c) =>
      toCommentView(c, { own: true }),
    );
  }

  async digest(
    topicId: number,
  ): Promise<{ digest: Digest | null; comments: number; needed: number }> {
    const [digest, comments] = await Promise.all([
      this.deps.repos.forum.getDigest(topicId),
      this.deps.repos.forum.countPublished(topicId),
    ]);
    return { digest, comments, needed: DIGEST_MIN_COMMENTS };
  }

  /**
   * A resident raises a local issue, scoped to their own ward or city (or district, or state). The
   * title is public at once, so it is screened here; the details become the first comment, so they go
   * through the full comment pipeline — and are erased with the author's account like any comment.
   */
  async raiseIssue(citizenId: string, input: RaiseIssueRequest): Promise<TopicRow> {
    const profile = await this.deps.profileFor(citizenId);
    this.screen(input.title);
    if (input.details) this.screen(input.details);

    const path = await this.deps.regions.many(profile.region_path);
    const kinds: Record<RaiseIssueRequest['scope'], string[]> = {
      ward: ['ward', 'constituency'],
      city: ['city', 'district'],
      district: ['district', 'city'],
      state: ['state'],
    };
    const scope = [...profile.region_path]
      .reverse()
      .find((id) => kinds[input.scope].includes(path.get(id)?.kind ?? ''));
    if (scope === undefined)
      throw badRequest(`your home region has no ${input.scope} to raise this in`);
    await this.limit(citizenId, 'issue');

    // A title the moderator must see first is created unlisted rather than refused: the author did
    // nothing wrong that a regex can prove.
    const held = moderate(input.title).verdict === 'hold';
    const topic = await this.deps.repos.catalogue.createTopic({
      kind: 'local_issue',
      status: held ? 'proposed' : 'active',
      jurisdiction_region_id: scope,
      title: input.title,
      summary: null,
      effective_from: new Date().toISOString().slice(0, 10),
      source_refs: [],
      sector: sectorFor(`${input.title}. ${input.details ?? ''}`),
    });
    this.deps.metrics.inc('civic_issues_raised_total', { held: String(held) });
    if (input.details && !held)
      await this.post(citizenId, topic.id, { body: input.details, parent_id: null });
    return topic;
  }

  async trending(regionId: number, limit: number): Promise<TrendingItem[]> {
    const now = new Date();
    const top = await this.deps.cache.trending.top(regionId, limit, now);
    if (top.length === 0) return [];
    const [topics, counts] = await Promise.all([
      this.deps.repos.catalogue.getTopics(top.map((t) => t.topicId)),
      this.deps.cache.trending.commentsLast24h(
        top.map((t) => t.topicId),
        now,
      ),
    ]);
    const byId = new Map(topics.map((t) => [t.id, t]));
    const names = await this.deps.regions.many(topics.map((t) => t.jurisdiction_region_id));
    return top
      .map((t) => {
        const topic = byId.get(t.topicId);
        if (!topic || topic.status !== 'active') return null;
        return {
          topic_id: topic.id,
          title: topic.title,
          kind: topic.kind,
          jurisdiction_region_id: topic.jurisdiction_region_id,
          jurisdiction_name: names.get(topic.jurisdiction_region_id)?.name ?? null,
          score: Math.round(t.score * 100) / 100,
          comments_24h: counts.get(topic.id) ?? 0,
        };
      })
      .filter((t): t is TrendingItem => t !== null);
  }
}
