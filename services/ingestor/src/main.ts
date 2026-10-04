#!/usr/bin/env node
/**
 * The ingestor: polls each registered source on its own interval, forever.
 *
 * Its own Deployment, at one replica per region: politeness is per host, and two replicas would each
 * be polite and together be twice as impolite. It scales by adding sources, not replicas.
 *
 *   CIVIC_INGEST_MODE=live       fetch the real sources (the default in production)
 *   CIVIC_INGEST_MODE=fixtures   parse the bundled synthetic pages, marked sample (the default elsewhere)
 */
import { createPgRepositories, loadDbConfig, shardMapFrom, ShardRouter } from '@civic-voice/db';
import { CIVIC_USER_AGENT, PoliteFetcher, SOURCES, type SourceSpec } from '@civic-voice/ingest';
import { createLogger, createMetrics } from '@civic-voice/observability';
import { Ingestor, type IngestMode } from './ingestor.ts';

const logger = createLogger('ingestor', { pretty: process.env['CIVIC_ENV'] !== 'production' });
const metrics = createMetrics();
const mode = (process.env['CIVIC_INGEST_MODE'] ??
  (process.env['CIVIC_ENV'] === 'production' ? 'live' : 'fixtures')) as IngestMode;
if (mode !== 'live' && mode !== 'fixtures')
  throw new Error(`CIVIC_INGEST_MODE must be live or fixtures, got ${mode}`);

const dbConfig = loadDbConfig();
const router = new ShardRouter({
  shardMap: shardMapFrom(dbConfig),
  catalogueConnectionString: dbConfig.catalogueUrl,
  logger,
});
const repos = createPgRepositories(router);
await repos.ready();

const ingestor = await Ingestor.create({
  repos,
  logger,
  metrics,
  mode,
  ...(mode === 'live' ? { fetcher: new PoliteFetcher({ userAgent: CIVIC_USER_AGENT }) } : {}),
});
logger.info({ mode, sources: SOURCES.length }, 'ingestor running');

const timers: NodeJS.Timeout[] = [];
const runOne = async (spec: SourceSpec) => {
  try {
    const r = await ingestor.runSource(spec);
    const topics = await ingestor.promote();
    logger.info(
      {
        source: spec.id,
        outcome: r.health.outcome,
        inserted: r.inserted,
        updated: r.updated,
        topics,
      },
      'source polled',
    );
  } catch (err) {
    // One broken source must not stop the others.
    logger.error({ err, source: spec.id }, 'source poll failed');
  }
};
for (const spec of SOURCES) {
  // Spread the first polls over a minute so a restart is not a burst against every host at once.
  const jitter = Math.floor(Math.random() * 60_000);
  timers.push(
    setTimeout(() => {
      void runOne(spec);
      timers.push(setInterval(() => void runOne(spec), spec.everyMinutes * 60_000));
    }, jitter),
  );
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  for (const t of timers) clearTimeout(t);
  await repos.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
