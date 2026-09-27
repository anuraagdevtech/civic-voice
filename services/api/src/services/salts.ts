import { createHmac } from 'node:crypto';
import type { TopicSaltProvider } from '@civic-voice/core';

/**
 * Per-topic pseudonym salts (docs/PRIVACY.md §2).
 *
 * Derived from a single KMS-held root rather than stored per topic, so there is no salt table to
 * leak, back up, or forget to rotate — and adding a topic needs no key ceremony:
 *
 *     topic_salt[t] = HMAC-SHA256(root, "topic-salt:v1:" || t)
 *
 * The security property that matters is preserved: the analytics store holds pseudonyms and never a
 * salt, so linking one citizen's opinions across topics requires the root, which lives only in KMS
 * and is never in the same place as the data.
 *
 * Rotating the root re-pseudonymises everything, which deliberately breaks historical per-topic
 * dedupe. That is a planned migration, not an operational knob.
 */
export class DerivedTopicSaltProvider implements TopicSaltProvider {
  private readonly root: Buffer;
  private readonly cache = new Map<number, Buffer>();
  private readonly maxCached: number;

  constructor(root: string | Buffer, opts: { maxCached?: number } = {}) {
    this.root = typeof root === 'string' ? Buffer.from(root, 'utf8') : root;
    if (this.root.length < 16) throw new RangeError('pseudonym salt root must be at least 16 bytes');
    this.maxCached = opts.maxCached ?? 50_000;
  }

  async saltFor(topicId: number): Promise<Buffer> {
    const cached = this.cache.get(topicId);
    if (cached) return cached;

    const salt = createHmac('sha256', this.root).update(`topic-salt:v1:${topicId}`).digest();
    // Bounded, so a scan across 200k topics cannot grow the process without limit. Eviction is
    // cheap because derivation is cheap.
    if (this.cache.size >= this.maxCached) this.cache.clear();
    this.cache.set(topicId, salt);
    return salt;
  }
}
