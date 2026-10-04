#!/usr/bin/env node
/**
 * Load-test harness.
 *
 * Its job is not to prove the system does 170k writes/s on a laptop — it cannot, and a number from
 * one machine would be meaningless anyway. Its job is to measure the **per-write service time** that
 * the capacity model in `packages/core/src/capacity.ts` assumes (1.5 ms of CPU), because that single
 * constant is what turns the demand model into a fleet size. If the measured figure drifts, the
 * published pod count is wrong and this is how you find out.
 *
 *   node infra/loadtest/run.ts --writes 2000 --concurrency 50
 *   node infra/loadtest/run.ts --reads 5000 --concurrency 100
 */
import { ASSUMPTIONS, computeCapacity } from '@civic-voice/core';

interface Options {
  base: string;
  writes: number;
  reads: number;
  concurrency: number;
  regionId: number;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string, fallback: number) => {
    const at = argv.indexOf(`--${flag}`);
    return at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : fallback;
  };
  const baseAt = argv.indexOf('--base');
  return {
    base:
      baseAt >= 0
        ? (argv[baseAt + 1] as string)
        : (process.env['CIVIC_API_URL'] ?? 'http://localhost:8080'),
    writes: get('writes', 1_000),
    reads: get('reads', 2_000),
    concurrency: get('concurrency', 32),
    regionId: get('region', 0),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] as number;
}

interface Summary {
  label: string;
  count: number;
  errors: number;
  seconds: number;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function summarise(label: string, latencies: number[], errors: number, seconds: number): Summary {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    label,
    count: latencies.length,
    errors,
    seconds,
    perSecond: latencies.length / seconds,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

/** Run `total` tasks with at most `concurrency` in flight, recording each one's latency. */
async function drive(
  total: number,
  concurrency: number,
  task: (i: number) => Promise<boolean>,
): Promise<{ latencies: number[]; errors: number; seconds: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const startedAt = performance.now();

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const at = performance.now();
      try {
        const ok = await task(i);
        if (ok) latencies.push(performance.now() - at);
        else errors += 1;
      } catch {
        errors += 1;
      }
    }
  });

  await Promise.all(workers);
  return { latencies, errors, seconds: (performance.now() - startedAt) / 1000 };
}

const options = parseArgs(process.argv.slice(2));
const api = (path: string) => `${options.base}${path}`;

console.log(`civic-voice load test → ${options.base}`);
console.log(
  `  writes=${options.writes} reads=${options.reads} concurrency=${options.concurrency}\n`,
);

// Resolve a region and a topic to exercise.
const states = (await (await fetch(api('/v1/regions/1/children'))).json()) as {
  items: Array<{ id: number }>;
};
const regionId = options.regionId || (states.items[0]?.id ?? 1);
const topics = (await (await fetch(api(`/v1/topics?region_id=${regionId}`))).json()) as {
  items: Array<{ id: number }>;
};
const topicId = topics.items[0]?.id;
if (topicId === undefined) throw new Error('no topics available — run `pnpm seed` first');

// Registration is part of the write path's cost, so it is measured rather than assumed away.
console.log('registering citizens…');
const tokens: string[] = [];
await drive(options.writes, options.concurrency, async () => {
  const res = await fetch(api('/v1/citizens'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      region_id: regionId,
      demographics: { age_band: '25-34', gender: 'female', urbanity: 'rural' },
    }),
  });
  if (!res.ok) return false;
  tokens.push(((await res.json()) as { access_token: string }).access_token);
  return true;
});
console.log(`  ${tokens.length} citizens\n`);

const summaries: Summary[] = [];

if (options.writes > 0) {
  console.log('measuring the write path…');
  // One write per citizen: the per-(citizen, topic) cooldown means a second would be rejected, and
  // measuring rejections would flatter the numbers rather than test them.
  const write = await drive(tokens.length, options.concurrency, async (i) => {
    const res = await fetch(api('/v1/sentiment'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens[i]}`,
        'idempotency-key': `loadtest-${Date.now()}-${i}`,
      },
      body: JSON.stringify({ topic_id: topicId, mood: (i % 5) - 2, intensity: (i % 5) + 1 }),
    });
    return res.status === 202;
  });
  summaries.push(
    summarise('write  POST /v1/sentiment', write.latencies, write.errors, write.seconds),
  );
}

if (options.reads > 0) {
  console.log('measuring the read path (origin, no edge cache)…');
  const read = await drive(options.reads, options.concurrency, async () => {
    const res = await fetch(api(`/v1/topics/${topicId}/mood?region_id=${regionId}&tier=0`));
    return res.ok;
  });
  summaries.push(
    summarise('read   GET  /v1/topics/:id/mood', read.latencies, read.errors, read.seconds),
  );
}

console.log(`\n${'─'.repeat(92)}`);
console.log(
  `${'operation'.padEnd(34)}${'ok'.padStart(7)}${'err'.padStart(6)}${'req/s'.padStart(10)}` +
    `${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}`,
);
console.log('─'.repeat(92));
for (const s of summaries) {
  console.log(
    s.label.padEnd(34) +
      String(s.count).padStart(7) +
      String(s.errors).padStart(6) +
      s.perSecond.toFixed(0).padStart(10) +
      `${s.p50.toFixed(1)}ms`.padStart(9) +
      `${s.p95.toFixed(1)}ms`.padStart(9) +
      `${s.p99.toFixed(1)}ms`.padStart(9) +
      `${s.max.toFixed(0)}ms`.padStart(9),
  );
}
console.log('─'.repeat(92));

/**
 * The part that matters: does the measured cost per write still support the published fleet size?
 *
 * Throughput on one machine is not comparable to production, but *service time per request* largely
 * is, once concurrency is accounted for. If it has drifted above the modelled figure, the pod count
 * in docs/SCALING.md is understated and the spike will not be absorbed.
 */
const write = summaries.find((s) => s.label.startsWith('write'));
if (write && write.count > 0) {
  const model = computeCapacity();
  // Service time ≈ observed p50 ÷ concurrency: with N requests in flight, each one's wall-clock
  // latency includes waiting behind the other N−1.
  const serviceTimeMs = write.p50 / Math.max(1, Math.min(options.concurrency, write.count));

  console.log('\nCapacity model check (docs/SCALING.md §3)');
  console.log(`  modelled CPU per write     ${ASSUMPTIONS.cpuMsPerWrite.toFixed(2)} ms`);
  console.log(`  observed service time      ${serviceTimeMs.toFixed(2)} ms  (p50 ÷ concurrency)`);
  console.log(
    `  modelled spike             ${Math.round(model.spikeWritesPerSecond).toLocaleString()} writes/s`,
  );
  console.log(
    `  modelled fleet at spike    ${model.podsAtSpike} pods × ${ASSUMPTIONS.coresPerPod} cores`,
  );

  const impliedPods = Math.ceil(
    (model.spikeWritesPerSecond * serviceTimeMs) / 1000 / ASSUMPTIONS.coresPerPod,
  );
  console.log(`  implied by measurement     ${impliedPods} pods`);
  if (impliedPods > model.podsAtSpike) {
    console.log(
      `\n  ⚠ The measured cost per write implies ${impliedPods} pods, not ${model.podsAtSpike}. ` +
        'Either the write path got slower or cpuMsPerWrite is optimistic — the published fleet size ' +
        'is understated until one of the two is corrected.',
    );
  } else {
    console.log('\n  ✓ The measured cost per write is within the modelled budget.');
  }
}
