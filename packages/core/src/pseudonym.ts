import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-topic pseudonyms (docs/PRIVACY.md §2).
 *
 *     pseudonym = HMAC-SHA256(topic_salt[topic_id], citizen_id)  truncated to 128 bits
 *
 * Within a topic this is stable, so one citizen is one voice and duplicates are detectable.
 * Across topics, linking a citizen's opinions is not a `JOIN` — it requires every topic's salt,
 * which lives in KMS and never in the analytics store. An attacker holding a full ClickHouse dump
 * cannot assemble an individual's political profile.
 *
 * 128 bits is chosen against the birthday bound: at 1.4B citizens × 200k topics the collision
 * probability stays negligible, while halving the bytes on every event and rollup key.
 */
export interface TopicSaltProvider {
  saltFor(topicId: number): Promise<Buffer>;
}

export function derivePseudonym(topicSalt: Buffer | string, citizenId: string): string {
  const key = typeof topicSalt === 'string' ? Buffer.from(topicSalt, 'utf8') : topicSalt;
  if (key.length < 16) {
    throw new RangeError('topic salt must be at least 16 bytes');
  }
  return createHmac('sha256', key).update(citizenId, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Blind index for identity uniqueness (docs/PRIVACY.md §4). The raw phone number or government
 * ID is hashed under a KMS-held, versioned pepper and then discarded. The index answers exactly
 * one question — "has this identity already claimed an account?" — and cannot be reversed.
 */
export function blindIndex(pepper: Buffer, normalisedIdentifier: string): string {
  if (pepper.length < 32) {
    throw new RangeError('pepper must be at least 32 bytes');
  }
  return createHmac('sha256', pepper).update(normalisedIdentifier, 'utf8').digest('hex');
}

/**
 * Normalise before blind-indexing, or the same identity produces different indexes and claims two
 * accounts. Indian mobile numbers: strip everything non-numeric, drop a 91 country prefix and any
 * leading 0, and require the remaining 10 digits to start 6–9.
 */
export function normaliseIndianMobile(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local =
    digits.startsWith('91') && digits.length === 12
      ? digits.slice(2)
      : digits.startsWith('0') && digits.length === 11
        ? digits.slice(1)
        : digits;
  if (!/^[6-9]\d{9}$/.test(local)) {
    throw new RangeError('not a valid Indian mobile number');
  }
  return local;
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  // `Buffer.from(s, 'hex')` truncates at the first non-hex character instead of throwing, so a
  // malformed pair would otherwise decode to two empty buffers and compare *equal*. Requiring the
  // decoded length to match the input closes that.
  if (ba.length !== a.length / 2 || bb.length !== b.length / 2) return false;
  return timingSafeEqual(ba, bb);
}
