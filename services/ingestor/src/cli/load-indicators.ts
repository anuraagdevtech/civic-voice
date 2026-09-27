#!/usr/bin/env node
/**
 * Load published indicator figures into the catalogue.
 *
 *   pnpm indicators:load figures.json   a reviewed file of published figures (see indicators.ts)
 *   pnpm indicators:load --sample       development sample values, every one marked `sample`
 */
import { createPgRepositories, loadDbConfig, shardMapFrom, ShardRouter } from '@civic-voice/db';
import { createLogger } from '@civic-voice/observability';
import { loadIndicators, readIndicatorFile, SAMPLE_INDICATORS } from '../indicators.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: load-indicators.ts <file.json> | --sample');
  process.exit(2);
}
const logger = createLogger('indicators', { pretty: true });
const dbConfig = loadDbConfig();
const router = new ShardRouter({
  shardMap: shardMapFrom(dbConfig),
  catalogueConnectionString: dbConfig.catalogueUrl,
  logger,
});
const repos = createPgRepositories(router);
try {
  const file = arg === '--sample' ? SAMPLE_INDICATORS : await readIndicatorFile(arg);
  const { loaded, skipped } = await loadIndicators(repos, file);
  logger.info(
    { loaded, skipped },
    arg === '--sample' ? 'sample indicators loaded (marked sample)' : 'indicators loaded',
  );
} finally {
  await repos.close();
}
