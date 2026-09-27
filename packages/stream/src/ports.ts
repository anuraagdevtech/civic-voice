import type { SentimentEvent } from '@civic-voice/contracts';

/**
 * The event bus. The append to this log is the write path's **commit point** (ADR-0003): once it
 * returns, the citizen's submission is durable, and everything downstream is catch-up.
 */

export interface PublishOptions {
  /**
   * Partition key. Sentiment events are keyed by `topic_id` so that every event for one topic lands
   * on one partition: a consumer can then aggregate a topic's deltas with no cross-partition
   * coordination, and the in-memory merge before flushing is effective during a spike, which is by
   * definition concentrated on a few topics.
   */
  key: string;
}

export interface Envelope<T> {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: T;
}

export interface Producer {
  publish<T>(topic: string, value: T, opts: PublishOptions): Promise<{ partition: number; offset: string }>;
  publishBatch<T>(
    topic: string,
    messages: readonly { value: T; key: string }[],
  ): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface ConsumerHandler<T> {
  (batch: readonly Envelope<T>[]): Promise<void>;
}

export interface Consumer {
  /**
   * Subscribe with at-least-once delivery. The handler receives a batch; offsets advance only after
   * it resolves, so a crash mid-batch replays it. Every rollup mutation is therefore keyed by event
   * id in a dedupe set (docs/ARCHITECTURE.md §6).
   */
  subscribe<T>(topic: string, handler: ConsumerHandler<T>): Promise<void>;
  /** Events behind the head, per partition. The signal a stale-aggregate alarm fires on. */
  lag(): Promise<Map<number, number>>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface EventBus {
  producer: Producer;
  consumer(groupId: string): Consumer;
  close(): Promise<void>;
}

export type SentimentEnvelope = Envelope<SentimentEvent>;

import { EVENT_TOPICS } from '@civic-voice/contracts';

/**
 * Topics to provision, with their partition counts. Partition count is a capacity decision
 * (docs/SCALING.md §3), so it is declared here rather than left to a broker default.
 */
export const EVENT_TOPICS_LIST = [
  { topic: EVENT_TOPICS.SENTIMENT, partitions: 256 },
  { topic: EVENT_TOPICS.RTI_TRANSITION, partitions: 16 },
  { topic: EVENT_TOPICS.MODERATION, partitions: 16 },
] as const;
