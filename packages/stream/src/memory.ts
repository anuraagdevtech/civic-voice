import type {
  Consumer,
  ConsumerHandler,
  Envelope,
  EventBus,
  Producer,
  PublishOptions,
} from './ports.ts';

/**
 * In-memory event bus.
 *
 * Models the properties the code depends on and the tests assert: partitioning by key, ordering
 * within a partition, at-least-once redelivery on handler failure, and consumer lag. It is not a
 * Kafka emulator — it is the smallest thing that makes the worker's correctness testable without a
 * broker (ADR-0006).
 */

interface StoredMessage {
  partition: number;
  offset: number;
  key: string;
  value: unknown;
}

export interface MemoryBusOptions {
  partitions?: number;
  /** Deliver on `publish` (default), or only when `drain()` is called — useful for batch assertions. */
  autoDeliver?: boolean;
}

function partitionFor(key: string, partitions: number): number {
  // Same shape as Kafka's default murmur-ish partitioner: a stable hash of the key, modulo count.
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % partitions;
}

export class MemoryEventBus implements EventBus {
  readonly partitions: number;
  private readonly autoDeliver: boolean;
  /** topic → messages, in publish order. */
  private readonly log = new Map<string, StoredMessage[]>();
  private readonly subscriptions: Array<{
    groupId: string;
    topic: string;
    handler: ConsumerHandler<unknown>;
    /** Next offset to deliver, per group+topic. */
    cursor: number;
  }> = [];

  readonly producer: Producer;

  constructor(opts: MemoryBusOptions = {}) {
    this.partitions = opts.partitions ?? 8;
    this.autoDeliver = opts.autoDeliver ?? true;
    const bus = this;

    this.producer = {
      async publish<T>(topic: string, value: T, options: PublishOptions) {
        const messages = bus.log.get(topic) ?? [];
        const partition = partitionFor(options.key, bus.partitions);
        const stored: StoredMessage = {
          partition,
          offset: messages.length,
          key: options.key,
          value,
        };
        messages.push(stored);
        bus.log.set(topic, messages);
        if (bus.autoDeliver) await bus.drain();
        return { partition, offset: String(stored.offset) };
      },
      async publishBatch<T>(topic: string, batch: readonly { value: T; key: string }[]) {
        for (const m of batch) await this.publish(topic, m.value, { key: m.key });
      },
      async ready() {},
      async close() {},
    };
  }

  consumer(groupId: string): Consumer {
    const bus = this;
    const owned: typeof this.subscriptions = [];
    return {
      async subscribe<T>(topic: string, handler: ConsumerHandler<T>) {
        const sub = {
          groupId,
          topic,
          handler: handler as ConsumerHandler<unknown>,
          // A new group starts at the head, matching `auto.offset.reset=latest`: a consumer joining
          // mid-flight must not replay the entire history.
          cursor: (bus.log.get(topic) ?? []).length,
        };
        bus.subscriptions.push(sub);
        owned.push(sub);
      },
      async lag() {
        const out = new Map<number, number>();
        for (const sub of owned) {
          const messages = bus.log.get(sub.topic) ?? [];
          for (const m of messages.slice(sub.cursor)) {
            out.set(m.partition, (out.get(m.partition) ?? 0) + 1);
          }
        }
        return out;
      },
      async ready() {},
      async close() {
        for (const sub of owned) {
          const at = bus.subscriptions.indexOf(sub);
          if (at >= 0) bus.subscriptions.splice(at, 1);
        }
      },
    };
  }

  /**
   * Deliver everything pending. Offsets advance only after a handler resolves, so a throwing handler
   * leaves the batch to be redelivered — which is the semantics the dedupe logic exists to survive.
   */
  async drain(): Promise<void> {
    for (const sub of this.subscriptions) {
      const messages = this.log.get(sub.topic) ?? [];
      if (sub.cursor >= messages.length) continue;
      const batch: Envelope<unknown>[] = messages.slice(sub.cursor).map((m) => ({
        topic: sub.topic,
        partition: m.partition,
        offset: String(m.offset),
        key: m.key,
        value: m.value,
      }));
      await sub.handler(batch);
      sub.cursor = messages.length;
    }
  }

  /** Replay from an offset, for testing redelivery explicitly. */
  rewind(topic: string, groupId: string, toOffset = 0): void {
    for (const sub of this.subscriptions) {
      if (sub.topic === topic && sub.groupId === groupId) sub.cursor = toOffset;
    }
  }

  published<T>(topic: string): T[] {
    return (this.log.get(topic) ?? []).map((m) => m.value as T);
  }

  async close(): Promise<void> {
    this.subscriptions.length = 0;
    this.log.clear();
  }
}

export function createMemoryEventBus(opts: MemoryBusOptions = {}): MemoryEventBus {
  return new MemoryEventBus(opts);
}
