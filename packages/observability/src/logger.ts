import pino from 'pino';

/**
 * Structured logging with redaction at the logger, not at the call site.
 *
 * docs/PRIVACY.md §6 forbids PII in logs. Relying on every developer to remember that is how a
 * careless `log.info({ citizen })` exfiltrates a row, so the known-sensitive keys are stripped
 * here, once, for every logger in the fleet.
 */
const REDACTED_PATHS = [
  'citizen_id',
  '*.citizen_id',
  'citizenId',
  '*.citizenId',
  'phone',
  '*.phone',
  'mobile',
  '*.mobile',
  'aadhaar',
  '*.aadhaar',
  'gov_id',
  '*.gov_id',
  'identifier',
  '*.identifier',
  'blind_index',
  '*.blind_index',
  'access_token',
  '*.access_token',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'dek',
  '*.dek',
  'dek_wrapped',
  '*.dek_wrapped',
  'reason_text',
  '*.reason_text',
  // Location: coordinates are used for one boundary lookup and never kept (ADR-0010).
  'lat',
  '*.lat',
  'lng',
  '*.lng',
  'latitude',
  '*.latitude',
  'longitude',
  '*.longitude',
  'location_attestation',
  '*.location_attestation',
  // Comment text is public once published, but a log line is not where it belongs — and a refused
  // comment was refused for what it contains.
  'body',
  '*.body',
];

export type Logger = pino.Logger;

export function createLogger(
  name: string,
  opts: { level?: string; pretty?: boolean } = {},
): Logger {
  const level = opts.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const options: pino.LoggerOptions = {
    name,
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: name, env: process.env['CIVIC_ENV'] ?? 'development' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (!opts.pretty) return pino(options);

  // Pretty printing is a development convenience and an optional dependency. A service must never
  // fail to start because log formatting is unavailable — fall back to structured JSON, which is
  // what production wants anyway, and say so once.
  try {
    return pino({ ...options, transport: { target: 'pino-pretty' } });
  } catch {
    const logger = pino(options);
    logger.debug('pino-pretty unavailable; logging structured JSON');
    return logger;
  }
}

/** For tests and in-memory adapters: a logger that keeps everything and writes nothing. */
export function createTestLogger(): Logger & { records: unknown[] } {
  const records: unknown[] = [];
  const logger = pino(
    { level: 'debug', redact: { paths: REDACTED_PATHS, censor: '[redacted]' } },
    { write: (line: string) => records.push(JSON.parse(line)) },
  );
  return Object.assign(logger, { records }) as Logger & { records: unknown[] };
}

export { REDACTED_PATHS };
