import { DEFAULT_K, QUOTAS } from '@civic-voice/core';

/**
 * Service configuration. Read once at startup and validated, so a mistyped env var fails the
 * deployment rather than surfacing as a subtly wrong quota three hours later.
 */
export interface ApiConfig {
  port: number;
  host: string;
  env: string;
  /** Token signing secret. Required in production — the default is rejected there. */
  tokenSecret: string;
  tokenTtlSeconds: number;
  /** Pepper for identity blind indexes. KMS-held in production. */
  identityPepper: string;
  /** Per-topic pseudonym salt root. KMS-held in production (docs/PRIVACY.md §2). */
  pseudonymSaltRoot: string;
  kAnonymity: number;
  /** `stale-while-revalidate` window for public aggregate reads. The 98% edge hit rate depends on it. */
  aggregateCacheSeconds: number;
  aggregateStaleWhileRevalidateSeconds: number;
  useMemoryAdapters: boolean;
  /**
   * The in-memory demo stack (infra/dev): every page carries a banner saying the comments are invented
   * and the documents are samples. Refused in production.
   */
  demo: boolean;
  corsOrigins: string[];
  /**
   * Write quotas (docs/TRUST.md §3). Tunable without a code change, because the right cooldown is an
   * operational judgement that will be revised in response to real abuse, and a redeploy is a bad
   * thing to need in the middle of a brigading incident.
   */
  quotas: { writesPerHour: number; burst: number; topicCooldownSeconds: number };
}

const INSECURE_DEFAULT = 'dev-only-insecure-secret-change-me';

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const environment = env['CIVIC_ENV'] ?? 'development';
  const production = environment === 'production';

  const tokenSecret = env['CIVIC_TOKEN_SECRET'] ?? INSECURE_DEFAULT;
  const identityPepper = env['CIVIC_IDENTITY_PEPPER'] ?? INSECURE_DEFAULT;
  const pseudonymSaltRoot = env['CIVIC_PSEUDONYM_SALT_ROOT'] ?? INSECURE_DEFAULT;

  if (production) {
    // Shipping with the development secret would make every token forgeable and every pseudonym
    // reproducible by anyone who has read this repository.
    for (const [name, value] of [
      ['CIVIC_TOKEN_SECRET', tokenSecret],
      ['CIVIC_IDENTITY_PEPPER', identityPepper],
      ['CIVIC_PSEUDONYM_SALT_ROOT', pseudonymSaltRoot],
    ] as const) {
      if (value === INSECURE_DEFAULT)
        throw new Error(`${name} must be set when CIVIC_ENV=production`);
      if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
    }
  }

  if (production && env['CIVIC_DEMO'] === '1') {
    throw new Error('CIVIC_DEMO must not be set when CIVIC_ENV=production');
  }

  const k = Number(env['CIVIC_K_ANONYMITY'] ?? DEFAULT_K);
  if (!Number.isInteger(k) || k < DEFAULT_K) {
    // The gate itself also refuses to go below the floor; this makes the misconfiguration loud.
    throw new Error(
      `CIVIC_K_ANONYMITY must be an integer >= ${DEFAULT_K}, got ${env['CIVIC_K_ANONYMITY']}`,
    );
  }

  return {
    port: Number(env['PORT'] ?? 8080),
    host: env['HOST'] ?? '0.0.0.0',
    env: environment,
    tokenSecret,
    tokenTtlSeconds: Number(env['CIVIC_TOKEN_TTL_SECONDS'] ?? 60 * 60 * 24 * 30),
    identityPepper,
    pseudonymSaltRoot,
    kAnonymity: k,
    aggregateCacheSeconds: Number(env['CIVIC_AGGREGATE_CACHE_SECONDS'] ?? 30),
    aggregateStaleWhileRevalidateSeconds: Number(env['CIVIC_AGGREGATE_SWR_SECONDS'] ?? 120),
    useMemoryAdapters: env['CIVIC_MEMORY_ADAPTERS'] === '1',
    demo: env['CIVIC_DEMO'] === '1',
    corsOrigins: (env['CIVIC_CORS_ORIGINS'] ?? '*').split(',').map((s) => s.trim()),
    quotas: {
      writesPerHour: Number(env['CIVIC_WRITES_PER_HOUR'] ?? QUOTAS.perCitizenPerHour),
      burst: Number(env['CIVIC_WRITE_BURST'] ?? QUOTAS.perCitizenBurst),
      topicCooldownSeconds: Number(
        env['CIVIC_TOPIC_COOLDOWN_SECONDS'] ?? QUOTAS.topicCooldownSeconds,
      ),
    },
  };
}
