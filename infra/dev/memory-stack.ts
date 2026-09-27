#!/usr/bin/env node
/**
 * The whole platform in one process, on in-memory adapters: API, the comment and aggregation
 * pipelines, and the ingestor over the bundled fixtures. For building and demonstrating the UI with no
 * Postgres, Redis, Kafka or ClickHouse.
 *
 *   pnpm dev:stack          empty forum; documents, indicators and budgets are samples
 *   pnpm dev:demo           the same, plus invented comments from simulated residents (demo-content.ts)
 *
 * Both run with CIVIC_DEMO=1, so the web app shows a banner saying the data is not real. Nothing
 * persists; restart and it is gone.
 */
import { createMemoryCacheTier } from '@civic-voice/cache';
import { createMemoryRepositories, seedMemoryGeography } from '@civic-voice/db';
import { createMemoryAnalyticsStore } from '@civic-voice/analytics';
import { createMemoryEventBus } from '@civic-voice/stream';
import { createLogger, createMetrics } from '@civic-voice/observability';
import { SOURCES } from '@civic-voice/ingest';
import { ClaudeAnalyzer, claudeConfigured, trainSeedModel } from '@civic-voice/nlp';
import { buildApp } from '../../services/api/src/app.ts';
import { loadApiConfig } from '../../services/api/src/config.ts';
import { Aggregator } from '../../services/worker/src/pipelines/aggregator.ts';
import { CommentPipeline } from '../../services/worker/src/pipelines/comments.ts';
import { Ingestor } from '../../services/ingestor/src/ingestor.ts';
import { loadFinance, SAMPLE_FINANCE } from '../../services/ingestor/src/finance.ts';
import { loadIndicators, SAMPLE_INDICATORS } from '../../services/ingestor/src/indicators.ts';
import { DEMO_ISSUES, DEMO_RESIDENTS } from './demo-content.ts';

const withDemoComments = process.argv.includes('--demo');
const port = Number(process.env['PORT'] ?? 8080);
const logger = createLogger('dev-stack', {
  pretty: true,
  level: process.env['LOG_LEVEL'] ?? 'warn',
});
const metrics = createMetrics();

const repos = createMemoryRepositories();
const cache = createMemoryCacheTier();
const analytics = createMemoryAnalyticsStore();
const bus = createMemoryEventBus();
const ids = seedMemoryGeography(repos.catalogue);

// Documents: the fixture pages, parsed by the real pipeline, every result marked `sample`.
const ingestor = await Ingestor.create({ repos, logger, metrics, mode: 'fixtures' });
for (const spec of SOURCES) await ingestor.runSource(spec);
const topics = await ingestor.promote(500);
await loadIndicators(repos, SAMPLE_INDICATORS);
await loadFinance(repos, SAMPLE_FINANCE);

const config = loadApiConfig({
  ...process.env,
  CIVIC_MEMORY_ADAPTERS: '1',
  CIVIC_DEMO: '1',
  PORT: String(port),
});
const app = await buildApp({ config, repos, cache, bus, analytics, logger, metrics });

const model = trainSeedModel();
const comments = new CommentPipeline({
  repos,
  cache,
  analytics,
  bus,
  model,
  claude: claudeConfigured(process.env) ? new ClaudeAnalyzer() : null,
  analyticsKey: 'dev-only-insecure-secret-change-me',
  metrics,
  logger,
});
await comments.start();
await new Aggregator({ repos, cache, analytics, bus, metrics, logger }).start();

if (withDemoComments) {
  const all = await repos.catalogue.listTopics({ limit: 200 });
  const topicFor = (needle: string) =>
    all.find((t) => t.title.toLowerCase().includes(needle.toLowerCase()));
  let posted = 0;
  let n = 0;
  for (const resident of DEMO_RESIDENTS) {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/citizens',
      payload: {
        region_id: ids.get(resident.regionKey),
        locale: 'en',
        demographics: resident.demographics,
      },
    });
    const token = (reg.json() as { access_token: string }).access_token;
    for (const [needle, body] of resident.comments) {
      const topic = topicFor(needle);
      if (!topic) continue;
      const res = await app.inject({
        method: 'POST',
        url: `/v1/topics/${topic.id}/comments`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': `demo-comment-${n++}` },
        payload: { body, parent_id: null },
      });
      if (res.statusCode === 202) posted++;
      else logger.warn({ status: res.statusCode, body: res.body, needle }, 'demo comment refused');
    }
  }
  for (const issue of DEMO_ISSUES) {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/citizens',
      payload: { region_id: ids.get(issue.regionKey), locale: 'en', demographics: {} },
    });
    const token = (reg.json() as { access_token: string }).access_token;
    await app.inject({
      method: 'POST',
      url: '/v1/issues',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': `demo-issue-${n++}` },
      payload: { title: issue.title, details: issue.details, scope: issue.scope },
    });
  }
  // Let the pipeline catch up, including the digests it schedules.
  await new Promise((r) => setTimeout(r, 500));
  await comments.drain();
  console.log(
    `demo: ${posted} invented comments posted by ${DEMO_RESIDENTS.length} simulated residents`,
  );
}

await app.listen({ port, host: '127.0.0.1' });
console.log(
  `\ncivic-voice dev stack on http://127.0.0.1:${port}  (in-memory; ${topics} topics from sample documents)\n` +
    `  Greater Hyderabad region id: ${ids.get('IN-TG-GHMC')}   Khairatabad ward: ${ids.get('IN-TG-GHMC-khairatabad')}\n` +
    `  web: VITE_API_URL=http://127.0.0.1:${port} pnpm dev:web\n`,
);
