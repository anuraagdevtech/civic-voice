import { createHmac } from 'node:crypto';
import {
  DIGEST_MIN_COMMENTS,
  EVENT_TOPICS,
  type CommentAnalyticsEvent,
  type CommentEvent,
  type CommentState,
  type Need,
  type SentimentLabel,
} from '@civic-voice/contracts';
import type { CacheTier } from '@civic-voice/cache';
import type { NewComment, Repositories } from '@civic-voice/db';
import type { AnalyticsStore } from '@civic-voice/analytics';
import {
  analyze,
  claudeDigest,
  extractiveDigest,
  LABEL_BATCH_SIZE,
  type ClaudeAnalyzer,
  type ClaudeLabel,
  type CommentAnalysis,
  type DigestComment,
  type TrainedModel,
} from '@civic-voice/nlp';
import type { Consumer, Envelope, EventBus } from '@civic-voice/stream';
import type { Logger, Metrics } from '@civic-voice/observability';
import { TopicScopes } from './topic-scopes.ts';

/**
 * The comment pipeline (ADR-0008, ADR-0009, ADR-0011).
 *
 * The API has already done what must be synchronous — authentication, "do you live here", rate
 * limits, and refusing a comment with a phone number in it while the author can still fix it — and
 * appended the event. Here, per batch:
 *
 *  1. Moderate and analyse every comment with the in-house model: language, sentiment, needs,
 *     whether it proposes something. Microseconds each; no network.
 *  2. Escalate only the comments the model is unsure about to the large model, in batches, if one is
 *     configured. Its labels replace the in-house ones for those comments; its failure changes nothing.
 *  3. Store each comment on its topic's shard (idempotent) — published, held for review, or rejected.
 *  4. Project to analytics without body, id or pseudonym, and bump trending once per topic per batch.
 *  5. Regenerate the digest of any topic that has grown enough since its last one.
 *
 * Redelivery is safe at every step: the store is idempotent on the comment id, the analytics row on
 * its keyed hash, and trending is bumped only for comments the store reports as newly inserted.
 */

export interface CommentPipelineDeps {
  repos: Repositories;
  cache: CacheTier;
  analytics: AnalyticsStore;
  bus: EventBus;
  model: TrainedModel;
  /** Null when no API key is configured: everything still works, on the in-house model alone. */
  claude: ClaudeAnalyzer | null;
  /** Keys the analytics hashes (dedupe_key, author_key). KMS-held in production. */
  analyticsKey: string;
  /**
   * Comments per minute this worker may send to the large model. On held-out data about 30% of
   * comments are uncertain enough to escalate; at a spike that is thousands a second, so the budget —
   * not the traffic — bounds the cost. Over budget, the in-house labels stand (and are counted).
   */
  escalationsPerMinute?: number;
  metrics: Metrics;
  logger: Logger;
  now?: () => Date;
  groupId?: string;
}

/** Weights for "what is being talked about". A comment says more than a vote. */
export const TRENDING_WEIGHT = { comment: 3, reply: 2 } as const;

/** Regenerate a digest when the thread has grown by this fraction since the last one. */
const DIGEST_GROWTH = 0.25;
/** …or when it is this old and anything at all has been added. */
const DIGEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** The digest reads at most this many comments, most upvoted first. */
const DIGEST_SAMPLE = 200;

const labelToSentiment = (label: SentimentLabel): -1 | 0 | 1 =>
  label === 'negative' ? -1 : label === 'positive' ? 1 : 0;

interface Processed {
  event: CommentEvent;
  row: NewComment;
  sentiment: SentimentLabel;
  needs: Need[];
  suggestion: boolean;
  language: string;
}

export class CommentPipeline {
  private readonly deps: CommentPipelineDeps;
  private readonly scopes: TopicScopes;
  private readonly now: () => Date;
  private consumer?: Consumer;
  private readonly escalationBudget: { perMinute: number; tokens: number; refilledAt: number };
  /** Topics whose digest is being rebuilt, so a burst of batches does not start ten rebuilds. */
  private readonly digesting = new Set<number>();
  private readonly pendingDigests = new Set<Promise<void>>();

  constructor(deps: CommentPipelineDeps) {
    this.deps = deps;
    this.scopes = new TopicScopes(deps.repos);
    this.now = deps.now ?? (() => new Date());
    const perMinute = deps.escalationsPerMinute ?? 1200;
    this.escalationBudget = { perMinute, tokens: perMinute, refilledAt: this.now().getTime() };
  }

  /** Token bucket: how many of `wanted` escalations the budget allows right now. */
  private takeEscalations(wanted: number): number {
    const b = this.escalationBudget;
    const now = this.now().getTime();
    b.tokens = Math.min(b.perMinute, b.tokens + ((now - b.refilledAt) / 60_000) * b.perMinute);
    b.refilledAt = now;
    const granted = Math.max(0, Math.min(wanted, Math.floor(b.tokens)));
    b.tokens -= granted;
    return granted;
  }

  async start(): Promise<void> {
    this.consumer = this.deps.bus.consumer(this.deps.groupId ?? 'civic-comments');
    await this.consumer.subscribe<CommentEvent>(EVENT_TOPICS.COMMENT, async (batch) => {
      await this.handleBatch(batch);
    });
    this.deps.logger.info({ claude: this.deps.claude !== null }, 'comment pipeline consuming');
  }

  async stop(): Promise<void> {
    await this.consumer?.close();
    await this.drain();
  }

  /** Wait for in-flight digest rebuilds. Tests use it; shutdown does too. */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingDigests]);
  }

  private keyed(purpose: string, value: string): string {
    return createHmac('sha256', this.deps.analyticsKey)
      .update(`${purpose}:${value}`)
      .digest('hex')
      .slice(0, 32);
  }

  private async escalate(
    candidates: Array<{ id: string; text: string }>,
  ): Promise<Map<string, ClaudeLabel>> {
    const labels = new Map<string, ClaudeLabel>();
    if (!this.deps.claude || candidates.length === 0) return labels;
    const uncertain = candidates.slice(0, this.takeEscalations(candidates.length));
    if (uncertain.length < candidates.length) {
      this.deps.metrics.inc(
        'civic_comments_escalation_skipped_total',
        {},
        candidates.length - uncertain.length,
      );
    }
    for (let i = 0; i < uncertain.length; i += LABEL_BATCH_SIZE) {
      const chunk = uncertain.slice(i, i + LABEL_BATCH_SIZE);
      try {
        for (const [id, label] of await this.deps.claude.label(chunk)) labels.set(id, label);
        this.deps.metrics.inc('civic_comments_escalated_total', {}, chunk.length);
      } catch (err) {
        // The in-house labels stand. An outage upstream must not hold comments back.
        this.deps.metrics.inc('civic_comments_escalation_failures_total', {}, chunk.length);
        this.deps.logger.warn(
          { err, comments: chunk.length },
          'escalation failed; keeping in-house labels',
        );
      }
    }
    return labels;
  }

  async handleBatch(
    batch: readonly Envelope<CommentEvent>[],
  ): Promise<{ inserted: number; published: number; held: number; rejected: number }> {
    const stats = { inserted: 0, published: 0, held: 0, rejected: 0 };
    if (batch.length === 0) return stats;
    this.deps.metrics.inc('civic_comments_consumed_total', {}, batch.length);

    // 1. In-house analysis for everyone.
    const analysed = batch.map((envelope) => ({
      event: envelope.value,
      analysis: analyze(this.deps.model, envelope.value.body),
    }));

    // 2. Escalate the uncertain ones that will actually be shown.
    const uncertain = analysed
      .filter(({ analysis }) => analysis.lowConfidence && analysis.moderation.verdict === 'allow')
      .map(({ event }) => ({ id: event.comment_id, text: event.body }));
    const escalated = await this.escalate(uncertain);

    const processed: Processed[] = analysed.map(({ event, analysis }) =>
      this.toRow(event, analysis, escalated.get(event.comment_id)),
    );

    // 3. Store.
    const fresh: Processed[] = [];
    for (const p of processed) {
      const { inserted } = await this.deps.repos.forum.insertComment(p.event.citizen_id, p.row);
      if (inserted) {
        fresh.push(p);
        stats.inserted++;
        stats[
          p.row.state === 'published' ? 'published' : p.row.state === 'held' ? 'held' : 'rejected'
        ]++;
      }
    }
    this.deps.metrics.inc('civic_comments_published_total', {}, stats.published);
    this.deps.metrics.inc('civic_comments_held_total', {}, stats.held);
    this.deps.metrics.inc('civic_comments_rejected_total', {}, stats.rejected);

    // 4a. Analytics: every published comment in the batch (idempotent on dedupe_key, so redelivered
    // ones are harmless). Held and rejected comments say nothing about what the public thinks.
    const projections: CommentAnalyticsEvent[] = processed
      .filter((p) => p.row.state === 'published')
      .map((p) => ({
        dedupe_key: this.keyed('comment', p.event.comment_id),
        author_key: this.keyed('author', `${p.event.topic_id}:${p.event.pseudonym}`),
        hour: `${p.event.occurred_at.slice(0, 13)}:00:00.000Z`,
        topic_id: p.event.topic_id,
        region_path: p.event.region_path,
        verification_tier: p.event.verification_tier,
        demographics: p.event.demographics,
        sentiment: p.sentiment,
        needs: p.needs,
        suggestion: p.suggestion,
        language: p.language,
      }));
    await this.deps.analytics.insertCommentEvents(projections);

    // 4b. Trending: one bump per topic per batch, for newly published comments only.
    const perTopic = new Map<number, { weight: number; comments: number }>();
    for (const p of fresh) {
      if (p.row.state !== 'published') continue;
      const t = perTopic.get(p.row.topic_id) ?? { weight: 0, comments: 0 };
      t.weight += p.row.parent_id ? TRENDING_WEIGHT.reply : TRENDING_WEIGHT.comment;
      t.comments += 1;
      perTopic.set(p.row.topic_id, t);
    }
    const now = this.now();
    for (const [topicId, { weight, comments }] of perTopic) {
      const scope = await this.scopes.get(topicId);
      if (!scope) continue;
      await this.deps.cache.trending.bump(topicId, scope.jurisdictionPath, weight, comments, now);
    }

    // 5. Digests, off the batch's critical path.
    for (const topicId of perTopic.keys()) this.maybeDigest(topicId);

    return stats;
  }

  private toRow(
    event: CommentEvent,
    analysis: CommentAnalysis,
    escalated: ClaudeLabel | undefined,
  ): Processed {
    const verdict = analysis.moderation.verdict;
    const state: CommentState =
      verdict === 'reject' ? 'rejected' : verdict === 'hold' ? 'held' : 'published';
    const sentiment: SentimentLabel = escalated?.sentiment ?? analysis.sentiment.label;
    const needs: Need[] = escalated?.needs ?? analysis.needs.map((n) => n.need);
    const suggestion = escalated?.suggestion ?? analysis.suggestion.value;
    return {
      event,
      sentiment,
      needs,
      suggestion,
      language: analysis.language,
      row: {
        topic_id: event.topic_id,
        id: event.comment_id,
        parent_id: event.parent_id,
        pseudonym: event.pseudonym,
        handle: event.handle,
        // A rejected comment is kept as a record that it was refused, not as text anyone can read:
        // it was refused because of what it says, often a phone number.
        body: state === 'rejected' ? '' : event.body,
        language: analysis.language,
        area: event.area,
        located: event.region_basis === 'device',
        verification_tier: event.verification_tier,
        state,
        moderation_reasons: analysis.moderation.reasons,
        sentiment: labelToSentiment(sentiment),
        needs,
        suggestion,
        model: escalated
          ? `${analysis.modelVersion}+${this.deps.claude?.model ?? 'claude'}`
          : analysis.modelVersion,
        created_at: event.occurred_at,
      },
    };
  }

  private maybeDigest(topicId: number): void {
    if (this.digesting.has(topicId)) return;
    this.digesting.add(topicId);
    const job: Promise<void> = this.rebuildDigestIfStale(topicId)
      .then(() => undefined)
      .catch((err) => this.deps.logger.warn({ err, topic_id: topicId }, 'digest rebuild failed'))
      .finally(() => {
        this.digesting.delete(topicId);
        this.pendingDigests.delete(job);
      });
    this.pendingDigests.add(job);
  }

  async rebuildDigestIfStale(topicId: number): Promise<boolean> {
    const count = await this.deps.repos.forum.countPublished(topicId);
    if (count < DIGEST_MIN_COMMENTS) return false;
    const current = await this.deps.repos.forum.getDigest(topicId);
    const now = this.now();
    if (current) {
      const grown = count >= current.based_on_comments * (1 + DIGEST_GROWTH);
      const aged =
        now.getTime() - Date.parse(current.generated_at) > DIGEST_MAX_AGE_MS &&
        count > current.based_on_comments;
      if (!grown && !aged) return false;
    }
    const scope = await this.scopes.get(topicId);
    const rows = await this.deps.repos.forum.commentsForDigest(topicId, DIGEST_SAMPLE);
    const comments: DigestComment[] = rows.map((r) => ({
      id: r.id,
      body: r.body,
      upvotes: r.upvotes,
      sentiment: r.sentiment,
      needs: r.needs,
      suggestion: r.suggestion,
    }));
    const digest = this.deps.claude
      ? await claudeDigest(
          this.deps.claude,
          { id: topicId, title: scope?.title ?? '' },
          comments,
          now,
          (err) =>
            this.deps.logger.warn(
              { err, topic_id: topicId },
              'large-model digest failed; using extractive',
            ),
        )
      : extractiveDigest(topicId, comments, now);
    // The sample may be smaller than the thread; the digest says what it read, but the trigger compares
    // against the thread, so record the thread's size.
    await this.deps.repos.forum.putDigest({
      ...digest,
      based_on_comments: Math.max(digest.based_on_comments, count),
    });
    this.deps.metrics.inc('civic_digests_built_total', { method: digest.method });
    return true;
  }
}
