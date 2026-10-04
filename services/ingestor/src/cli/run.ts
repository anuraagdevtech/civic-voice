#!/usr/bin/env node
/**
 * One ingestion pass against the configured catalogue, then promote discussable documents to topics.
 *
 *   pnpm ingest:run --fixtures    load the synthetic fixtures as `sample` documents (development)
 *   pnpm ingest:run --live        fetch the real sources once
 */
import { createPgRepositories, loadDbConfig, shardMapFrom, ShardRouter } from '@civic-voice/db';
import { CIVIC_USER_AGENT, PoliteFetcher, SOURCES } from '@civic-voice/ingest';
import { createLogger, createMetrics } from '@civic-voice/observability';
import { Ingestor } from '../ingestor.ts';

const live = process.argv.includes('--live');
if (!live && !process.argv.includes('--fixtures')) {
  console.error(
    'say which: --fixtures (synthetic, marked sample) or --live (fetch the real sources)',
  );
  process.exit(2);
}
const logger = createLogger('ingest-run', { pretty: true });
const dbConfig = loadDbConfig();
const router = new ShardRouter({
  shardMap: shardMapFrom(dbConfig),
  catalogueConnectionString: dbConfig.catalogueUrl,
  logger,
});
const repos = createPgRepositories(router);
try {
  const ingestor = await Ingestor.create({
    repos,
    logger,
    metrics: createMetrics(),
    mode: live ? 'live' : 'fixtures',
    ...(live ? { fetcher: new PoliteFetcher({ userAgent: CIVIC_USER_AGENT }) } : {}),
  });
  for (const spec of SOURCES) {
    const r = await ingestor.runSource(spec);
    logger.info(
      { source: spec.id, outcome: r.health.outcome, inserted: r.inserted, updated: r.updated },
      'source done',
    );
  }
  logger.info(
    { topics: await ingestor.promote(500) },
    'discussable documents put up for discussion',
  );
} finally {
  await repos.close();
}
