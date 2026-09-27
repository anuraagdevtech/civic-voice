import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VerificationTier } from '@civic-voice/contracts';
import { unauthorized } from '@civic-voice/core';

/**
 * Stateless bearer tokens.
 *
 * Stateless is not a shortcut — it is a requirement. At 90M daily actives, a session lookup on every
 * request would put a hot read in front of a store that is otherwise only touched by primary key, and
 * would make the API stateful, which is what lets it scale on pod count alone.
 *
 * A compact HMAC token rather than a JWT: no algorithm-confusion surface (`alg: none`, RS256→HS256
 * substitution), no header to parse, and a third of the bytes on every one of 1.5B daily requests.
 * Revocation is by short TTL plus a deny-list for the rare forced logout, not by per-request lookup.
 */

export interface Principal {
  citizenId: string;
  tier: VerificationTier;
  /** Unix seconds. */
  expiresAt: number;
}

const VERSION = 'cv1';

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(
  secret: string,
  citizenId: string,
  tier: VerificationTier,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  // A nonce makes tokens non-deterministic, so two sessions for one citizen are distinguishable in
  // the deny-list without carrying a session id.
  const nonce = randomBytes(8).toString('base64url');
  const payload = `${VERSION}.${citizenId}.${tier}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret: string, token: string, now = Date.now()): Principal {
  const parts = token.split('.');
  if (parts.length !== 6) throw unauthorized('malformed token');
  const [version, citizenId, tierRaw, expiresRaw, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) throw unauthorized('unsupported token version');

  const payload = `${version}.${citizenId}.${tierRaw}.${expiresRaw}.${nonce}`;
  const expected = sign(secret, payload);

  // Constant-time, and length-checked first: `timingSafeEqual` throws on a length mismatch.
  if (signature.length !== expected.length) throw unauthorized('bad signature');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw unauthorized('bad signature');
  }

  const expiresAt = Number(expiresRaw);
  const tier = Number(tierRaw);
  if (!Number.isInteger(expiresAt) || !Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw unauthorized('malformed token');
  }
  // Expiry is checked only after the signature verifies, so an attacker learns nothing from timing
  // about whether a forged token's claims were otherwise well-formed.
  if (expiresAt <= Math.floor(now / 1000)) throw unauthorized('token expired');

  return { citizenId, tier: tier as VerificationTier, expiresAt };
}

/** `Authorization: Bearer <token>`, tolerant of header casing but not of a missing scheme. */
export function principalFromHeader(
  secret: string,
  header: string | undefined,
  now = Date.now(),
): Principal {
  if (!header) throw unauthorized('missing authorization header');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) throw unauthorized('expected a bearer token');
  return verifyToken(secret, match[1], now);
}
