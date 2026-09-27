import { Kafka, Partitioners, type Consumer as KafkaConsumer, type Producer as KafkaProducer } from 'kafkajs';
import type { Logger } from '@civic-voice/observability';
import type { Consumer, ConsumerHandler, Envelope, EventBus, Producer, PublishOptions } from './ports.ts';

/**
 * Kafka / Redpanda event bus.
 *
 * Settings that matter at the load in docs/SCALING.md are called out inline; the defaults are wrong
 * for this workload in two specific ways (durability and batching) and both are corrected here.
 */

export interface KafkaBusOptions {
  brokers?: string[];
  clientId?: string;
  logger?: Logger;
}

export const SENTIMENT_PARTITIONS = 256;

function resolveBrokers(opts: KafkaBusOptions): string[] {
  return opts.brokers ?? (process.env['KAFKA_BROKERS'] ?? '127.0.0.1:9092').split(',');
}

export class KafkaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private readonly kafkaProducer: KafkaProducer;
  private readonly consumers: KafkaConsumer[] = [];
  private readonly logger?: Logger;
  readonly producer: Producer;

  constructor(opts: KafkaBusOptions = {}) {
    if (opts.logger) this.logger = opts.logger;
    this.kafka = new Kafka({
      clientId: opts.clientId ?? 'civic-voice',
      brokers: resolveBrokers(opts),
      retry: { initialRetryTime: 100, retries: 5 },
      // A write path with a 250ms p99 ack budget must not block on a slow broker.
      requestTimeout: 3_000,
      connectionTimeout: 2_000,
    });

    this.kafkaProducer = this.kafka.producer({
      // Key-hash partitioning, so all events for one topic_id land on one partition.
      createPartitioner: Partitioners.DefaultPartitioner,
      // Ordering per partition under retry. Without this, a retried append can be reordered behind a
      // later one, and a compensating −1 could be applied before the +1 it belongs with.
      idempotent: true,
      maxInFlightRequests: 5,
      allowAutoTopicCreation: false,
    });

    const self = this;
    this.producer = {
      async publish<T>(topic: string, value: T, options: PublishOptions) {
        const [result] = await self.kafkaProducer.send({
          topic,
          // acks=-1: every in-sync replica. This append IS the commit point (ADR-0003); acking on the
          // leader alone would mean a leader failure silently loses citizens' submissions.
          acks: -1,
          messages: [{ key: options.key, value: JSON.stringify(value) }],
        });
        return {
          partition: result?.partition ?? 0,
          offset: result?.baseOffset ?? '0',
        };
      },
      async publishBatch<T>(topic: string, batch: readonly { value: T; key: string }[]) {
        if (batch.length === 0) return;
        await self.kafkaProducer.send({
          topic,
          acks: -1,
          messages: batch.map((m) => ({ key: m.key, value: JSON.stringify(m.value) })),
        });
      },
      async ready() {
        await self.kafkaProducer.connect();
      },
      async close() {
        await self.kafkaProducer.disconnect();
      },
    };
  }

  consumer(groupId: string): Consumer {
    const kafkaConsumer = this.kafka.consumer({
      groupId,
      // Long enough that a GC pause or a slow ClickHouse insert does not trigger a rebalance storm.
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      maxWaitTimeInMs: 200,
    });
    this.consumers.push(kafkaConsumer);
    const logger = this.logger;

    return {
      async subscribe<T>(topic: string, handler: ConsumerHandler<T>) {
        await kafkaConsumer.connect();
        await kafkaConsumer.subscribe({ topic, fromBeginning: false });
        await kafkaConsumer.run({
          // Batch mode: the whole point of the aggregation pipeline is to merge many events into few
          // counter writes, which per-message delivery would make impossible.
          eachBatchAutoResolve: false,
          autoCommitInterval: 1_000,
          eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
            const envelopes: Envelope<T>[] = [];
            for (const message of batch.messages) {
              if (message.value === null) continue;
              try {
                envelopes.push({
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: message.offset,
                  key: message.key?.toString() ?? null,
                  value: JSON.parse(message.value.toString()) as T,
                });
              } catch (err) {
                // A message we cannot parse will never become parseable. Skipping it and moving on
                // is right; blocking the partition forever on it is not.
                logger?.error(
                  { err, partition: batch.partition, offset: message.offset },
                  'skipping unparseable message',
                );
                resolveOffset(message.offset);
              }
            }

            if (envelopes.length > 0) {
              await handler(envelopes);
              // Offsets advance only after the handler resolves: at-least-once, never at-most-once.
              for (const envelope of envelopes) resolveOffset(envelope.offset);
            }
            await heartbeat();
            await commitOffsetsIfNecessary();
          },
        });
      },
      /**
       * Lag is a broker-side fact, not a consumer-side one: it needs committed offsets compared
       * against the partition high-water marks, which only the admin API exposes. Use
       * `KafkaEventBus.lagByPartition(groupId, topic)` — the worker reports that as its gauge. This
       * returns empty rather than a plausible-looking wrong number.
       */
      async lag() {
        return new Map<number, number>();
      },
      async ready() {
        await kafkaConsumer.connect();
      },
      async close() {
        await kafkaConsumer.disconnect();
      },
    };
  }

  /** Topic provisioning. Partition count is a capacity decision, so it is explicit, not defaulted. */
  async ensureTopics(topics: readonly { topic: string; partitions?: number }[]): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      const missing = topics.filter((t) => !existing.has(t.topic));
      if (missing.length > 0) {
        await admin.createTopics({
          topics: missing.map((t) => ({
            topic: t.topic,
            numPartitions: t.partitions ?? SENTIMENT_PARTITIONS,
            replicationFactor: -1,
            configEntries: [
              // 7 days hot; Parquet in object storage after that (docs/SCALING.md §3).
              { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
              { name: 'compression.type', value: 'zstd' },
              { name: 'min.insync.replicas', value: '2' },
            ],
          })),
        });
      }
    } finally {
      await admin.disconnect();
    }
  }

  async lagByPartition(groupId: string, topic: string): Promise<Map<number, number>> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const [committed, latest] = await Promise.all([
        admin.fetchOffsets({ groupId, topics: [topic] }),
        admin.fetchTopicOffsets(topic),
      ]);
      const head = new Map(latest.map((p) => [p.partition, BigInt(p.offset)]));
      const out = new Map<number, number>();
      for (const entry of committed[0]?.partitions ?? []) {
        const at = BigInt(entry.offset === '-1' ? '0' : entry.offset);
        out.set(entry.partition, Number((head.get(entry.partition) ?? at) - at));
      }
      return out;
    } finally {
      await admin.disconnect();
    }
  }

  async close(): Promise<void> {
    await Promise.all([
      this.producer.close(),
      ...this.consumers.map((c) => c.disconnect().catch(() => {})),
    ]);
  }
}

export function createKafkaEventBus(opts: KafkaBusOptions = {}): KafkaEventBus {
  return new KafkaEventBus(opts);
}
