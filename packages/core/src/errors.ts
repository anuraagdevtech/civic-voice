import type { ErrorCode } from '@civic-voice/contracts';

/**
 * Domain errors carry the wire error code, so the HTTP layer maps them mechanically instead of
 * each handler inventing its own status codes.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = opts.status ?? STATUS_BY_CODE[code];
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  cooldown_active: 429,
  invalid_transition: 409,
  k_anonymity_suppressed: 200,
  degraded: 503,
  internal: 500,
};

export const badRequest = (m: string, details?: unknown) =>
  new DomainError('bad_request', m, { details });
export const unauthorized = (m = 'authentication required') => new DomainError('unauthorized', m);
export const forbidden = (m = 'not permitted') => new DomainError('forbidden', m);
export const notFound = (m = 'not found') => new DomainError('not_found', m);
export const conflict = (m: string, details?: unknown) => new DomainError('conflict', m, { details });
export const rateLimited = (retryAfterSeconds: number) =>
  new DomainError('rate_limited', 'write quota exceeded', { retryAfterSeconds });
export const cooldownActive = (retryAfterSeconds: number) =>
  new DomainError('cooldown_active', 'you changed this opinion too recently', { retryAfterSeconds });
export const invalidTransition = (from: string, to: string) =>
  new DomainError('invalid_transition', `cannot move an RTI request from ${from} to ${to}`, {
    details: { from, to },
  });
export const degraded = (m: string) => new DomainError('degraded', m, { retryAfterSeconds: 5 });
