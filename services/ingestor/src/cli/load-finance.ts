#!/usr/bin/env node
/**
 * Load published public-finance figures — taxes by category, receipts, spending by sector — into the
 * catalogue.
 *
 *   pnpm finance:load budgets.json   a reviewed file of published figures (see finance.ts)
 *   pnpm finance:load --sample       development sample values, every one marked `sample`
 */
import { createPgRepositories, loadDbConfig, shardMapFrom, ShardRouter } from '@civic-voice/db';
import { createLogger } from '@civic-voice/observability';
import { loadFinance, readFinanceFile, SAMPLE_FINANCE } from '../finance.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: load-finance.ts <file.json> | --sample');
  process.exit(2);
}
const logger = createLogger('finance', { pretty: true });
const dbConfig = loadDbConfig();
const router = new ShardRouter({
  shardMap: shardMapFrom(dbConfig),
  catalogueConnectionString: dbConfig.catalogueUrl,
  logger,
});
const repos = createPgRepositories(router);
try {
  const file = arg === '--sample' ? SAMPLE_FINANCE : await readFinanceFile(arg);
  const { loaded, skipped, warnings } = await loadFinance(repos, file);
  for (const w of warnings) logger.warn(w, 'budget does not reconcile; loaded, and shown as such');
  logger.info(
    { loaded, skipped },
    arg === '--sample' ? 'sample finance loaded (marked sample)' : 'finance loaded',
  );
} finally {
  await repos.close();
}
