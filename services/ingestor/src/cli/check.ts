#!/usr/bin/env node
/**
 * Check every registered source end to end, with no database.
 *
 *   pnpm ingest:check             parse the bundled fixtures (offline; what CI runs)
 *   pnpm ingest:check --live      fetch the real sites, politely, and report what each yields
 *   pnpm ingest:check --live --source tg-goir
 *   pnpm ingest:check --live --save-fixtures   also replace the synthetic fixtures with real captures
 *
 * `--live` is how the registry's selectors are verified and kept honest: run it from a network that
 * can reach the government portals, and fill in each source's `verified` field from what it reports.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryRepositories, seedMemoryGeography } from '@civic-voice/db';
import { CIVIC_USER_AGENT, FIXTURES_DIR, PoliteFetcher, SOURCES } from '@civic-voice/ingest';
import { createLogger, createMetrics } from '@civic-voice/observability';
import { Ingestor } from '../ingestor.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const saveFixtures = args.includes('--save-fixtures');
if (saveFixtures && !live) {
  console.error('--save-fixtures needs --live: it saves what the real sites serve');
  process.exit(2);
}
const only = args.includes('--source') ? args[args.indexOf('--source') + 1] : undefined;
const sources = SOURCES.filter((s) => !only || s.id === only);
if (sources.length === 0) {
  console.error(`no source "${only}"; known: ${SOURCES.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const repos = createMemoryRepositories();
const ids = seedMemoryGeography(repos.catalogue);
const nameOf = new Map(
  [...ids].map(([key, id]) => [id, repos.catalogue.regions.get(id)?.name ?? key]),
);
const fetcher = live ? new PoliteFetcher({ userAgent: CIVIC_USER_AGENT }) : undefined;
const ingestor = await Ingestor.create({
  repos,
  logger: createLogger('ingest-check', { pretty: true, level: 'warn' }),
  metrics: createMetrics(),
  mode: live ? 'live' : 'fixtures',
  ...(fetcher ? { fetcher } : {}),
});

console.log(
  `${live ? 'LIVE' : 'FIXTURES (synthetic pages; results are marked sample)'} — ${sources.length} source(s)\n`,
);
let failures = 0;
for (const spec of sources) {
  const { health, inserted, skipped, documents: docs } = await ingestor.runSource(spec);
  const gos = docs.filter((d) => d.go_number).length;
  const jobs = docs.filter((d) => d.kind === 'job_notification');
  const vacancies = jobs.reduce((s, d) => s + (d.vacancies ?? 0), 0);
  const money = docs.filter((d) => d.amount_rupees !== null).length;
  const placed = docs.filter((d) => d.geo_confidence > 0.5);
  const discussable = docs.filter((d) => d.discussable).length;
  const ok =
    health.outcome === 'ok' || health.outcome === 'fixture' || health.outcome === 'not_modified';
  if (!ok || health.suspectedLayoutChange || (health.items === 0 && !live)) failures++;
  console.log(
    `${ok && !health.suspectedLayoutChange ? '✔' : '✖'} ${spec.id.padEnd(24)} ${health.outcome.padEnd(12)} ` +
      `${String(inserted).padStart(3)} docs  ${String(gos).padStart(2)} GOs  ${String(jobs.length).padStart(2)} jobs (${vacancies.toLocaleString('en-IN')} posts)  ` +
      `${String(money).padStart(2)} ₹  ${String(placed.length).padStart(2)} placed  ${String(discussable).padStart(2)} discussable` +
      (skipped ? `  ${skipped} skipped` : '') +
      (health.message ? `\n    ${health.message}` : ''),
  );
  for (const d of placed.slice(0, 3)) {
    console.log(
      `    ↳ ${d.title.slice(0, 70)} → ${nameOf.get(d.primary_region_id ?? 0) ?? '?'} (${d.geo_confidence})`,
    );
  }
  if (saveFixtures && fetcher && health.outcome === 'ok') {
    // A second request, but a cheap one: the fetcher just cached this URL's validators, so a polite
    // server answers 304 — in which case there is nothing new to save and the fixture stays.
    const page = await fetcher.get(spec.url);
    if (page.status === 'ok') {
      await writeFile(join(FIXTURES_DIR, spec.fixture), page.body);
      console.log(
        `    saved ${spec.fixture} — review it, then update this source's \`verified\` entry`,
      );
    }
  }
}
console.log(`\n${failures === 0 ? 'all sources healthy' : `${failures} source(s) need attention`}`);
if (!live && failures > 0) process.exit(1);
