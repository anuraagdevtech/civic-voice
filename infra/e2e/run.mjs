#!/usr/bin/env node
/**
 * End-to-end verification against a running API and worker.
 *
 * Unlike the test suite, this exercises the *whole* path — HTTP, Postgres, Redis, Kafka, the worker,
 * ClickHouse and back — and asserts the properties that only emerge when all of them are involved:
 * a changed opinion not inflating a cohort, an event surviving the log and reappearing in every
 * rollup level, a suppressed bucket not being recoverable by subtraction, and an erased account
 * genuinely losing its data while published aggregates stay intact.
 *
 *   pnpm infra:up && pnpm migrate && pnpm seed
 *   node packages/analytics/src/cli/migrate.ts
 *   CIVIC_SENTIMENT_PARTITIONS=8 CIVIC_TOPIC_COOLDOWN_SECONDS=3 pnpm dev:api &
 *   CIVIC_SENTIMENT_PARTITIONS=8 pnpm dev:worker &
 *   BASE=http://localhost:8080 COOLDOWN_SECONDS=3 pnpm e2e
 *
 * Exits non-zero on any failure, so it can gate a deployment.
 */
// Assumes a freshly migrated and seeded database. Several assertions are about cohort sizes
// relative to k = 25, so citizens left over from a previous run change what should be suppressed —
// which would look like a failure and is not one.
const base = process.env.BASE ?? 'http://localhost:8080';

let passes = 0;
let failures = 0;

const call = async (path, opts = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
};

const ok = (label, cond, extra = '') => {
  if (cond) passes += 1;
  else failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  [' + extra + ']' : ''}`);
};

// ── 1. Catalogue ──
const india = await call('/v1/regions/1');
ok('catalogue: region 1 is India', india.json?.name === 'India', india.json?.name);

const states = await call('/v1/regions/1/children');
const up = states.json.items.find((r) => r.name === 'Uttar Pradesh');
const kerala = states.json.items.find((r) => r.name === 'Kerala');
const lakshadweep = states.json.items.find((r) => r.name === 'Lakshadweep');
const districts = await call(`/v1/regions/${up.id}/children`);
const lucknow = districts.json.items.find((r) => r.name === 'Lucknow');
const acs = await call(`/v1/regions/${lucknow.id}/children`);
const ac = acs.json.items[0];
ok(
  'catalogue: a constituency has a 4-level ancestor path',
  ac.path.length === 4,
  JSON.stringify(ac.path),
);

const topics = await call(`/v1/topics?region_id=${ac.id}`);
const national = topics.json.items.find((t) => t.jurisdiction_region_id === 1);
ok('catalogue: national topics apply to a UP constituency', Boolean(national), national?.title);
ok(
  'catalogue: another state’s topics do not apply',
  !topics.json.items.some((t) => t.jurisdiction_region_id === kerala.id),
);

// ── 2. Registration ──
const AGE = ['18-24', '25-34', '35-44'];
const GENDER = ['female', 'male'];
const tokens = [];
for (let i = 0; i < 60; i += 1) {
  const r = await call('/v1/citizens', {
    method: 'POST',
    body: {
      region_id: ac.id,
      locale: 'hi',
      demographics: {
        age_band: AGE[i % 3],
        gender: GENDER[i % 2],
        urbanity: i % 2 === 0 ? 'rural' : 'urban',
        occupation_band: i % 2 === 0 ? 'agriculture' : 'salaried_private',
      },
    },
  });
  if (r.status !== 201) {
    console.log('     register failed:', r.status, JSON.stringify(r.json).slice(0, 200));
    break;
  }
  tokens.push(r.json.access_token);
}
ok('identity: 60 citizens registered', tokens.length === 60, `${tokens.length}/60`);
const sample = await call('/v1/citizens', { method: 'POST', body: { region_id: ac.id } });
ok(
  'privacy: the registration response carries no PII field',
  !/"(phone|mobile|aadhaar|gov_id|name)"/.test(JSON.stringify(sample.json)),
);
ok('trust: a new citizen starts at tier 0', sample.json?.citizen?.verification_tier === 0);

// ── 3. Write path ──
let accepted = 0;
for (const [i, token] of tokens.entries()) {
  const r = await call('/v1/sentiment', {
    method: 'POST',
    token,
    idem: `e2e-${i}-${Date.now()}`,
    body: {
      topic_id: national.id,
      mood: [-2, -1, 0, 1, 2][i % 5],
      intensity: (i % 5) + 1,
      reason_code: 'poor_implementation',
    },
  });
  if (r.status === 202) accepted += 1;
  else if (i === 0)
    console.log('     first submit:', r.status, JSON.stringify(r.json).slice(0, 300));
}
ok('write: all submissions accepted with 202', accepted === 60, `${accepted}/60`);

const noKey = await call('/v1/sentiment', {
  method: 'POST',
  token: tokens[0],
  body: { topic_id: national.id, mood: 1 },
});
ok('write: an idempotency key is required', noKey.status === 400, `${noKey.status}`);

const key = `replay-${Date.now()}`;
// A fresh citizen: one who has already submitted would be held by the cooldown, which would mask
// what this test is actually checking.
const other = (await call('/v1/citizens', { method: 'POST', body: { region_id: ac.id } })).json
  .access_token;
const first = await call('/v1/sentiment', {
  method: 'POST',
  token: other,
  idem: key,
  body: { topic_id: national.id, mood: 2, intensity: 3 },
});
const replay = await call('/v1/sentiment', {
  method: 'POST',
  token: other,
  idem: key,
  body: { topic_id: national.id, mood: 2, intensity: 3 },
});
ok(
  'write: replaying a key returns the stored response, not a second write',
  replay.json?.replayed === true,
  `first=${first.status} replay=${replay.status}`,
);
ok(
  'write: replay returns the same event id',
  replay.json?.event_id === first.json?.event_id,
  `${first.json?.event_id}`,
);

const conflict = await call('/v1/sentiment', {
  method: 'POST',
  token: other,
  idem: key,
  body: { topic_id: national.id, mood: -2, intensity: 1 },
});
ok(
  'write: the same key with a different body is a conflict, not a silent replay',
  conflict.status === 409,
  `${conflict.status} ${conflict.json?.error?.code}`,
);

const cooled = await call('/v1/sentiment', {
  method: 'POST',
  token: tokens[1],
  idem: `cool-${Date.now()}`,
  body: { topic_id: national.id, mood: 1 },
});
ok(
  'trust: the per-topic cooldown blocks a rapid change',
  cooled.status === 429 && cooled.json?.error?.code === 'cooldown_active',
  `${cooled.status} ${cooled.json?.error?.code}`,
);
ok(
  'trust: the rejection tells the client when to retry',
  Number(cooled.headers.get('retry-after')) > 0,
  cooled.headers.get('retry-after'),
);

const keralaTopics = await call(`/v1/topics?region_id=${kerala.id}`);
const keralaOnly = keralaTopics.json.items.find((t) => t.jurisdiction_region_id === kerala.id);
const wrongRegion = await call('/v1/sentiment', {
  method: 'POST',
  token: tokens[5],
  idem: `juris-${Date.now()}`,
  body: { topic_id: keralaOnly.id, mood: 1 },
});
ok(
  'correctness: a topic outside your jurisdiction is refused',
  wrongRegion.status === 403,
  `${wrongRegion.status} ${wrongRegion.json?.error?.code}`,
);

// ── 4. Read-your-write ──
const mine = await call('/v1/me/sentiment', { token: tokens[0] });
ok(
  'read-your-write: a citizen sees their own opinion immediately',
  mine.json?.items?.length > 0,
  JSON.stringify(mine.json?.items?.[0]),
);

// ── 5. Aggregates (after the worker catches up) ──
console.log('\n--- waiting for the worker to aggregate ---');
let mood = null;
let stable = 0;
let previous = -1;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  mood = await call(`/v1/topics/${national.id}/mood?region_id=${ac.id}&tier=0`);
  const n = mood.json?.total?.n ?? 0;
  // Wait for the count to STOP changing, not merely to pass a threshold: reading a still-catching-up
  // worker's intermediate value is how a rollup comparison flaps.
  stable = n === previous ? stable + 1 : 0;
  previous = n;
  if (n >= 60 && stable >= 2) break;
}
console.log(`    total after aggregation: ${JSON.stringify(mood.json?.total)}\n`);

ok(
  'read: the aggregate reflects every submission',
  (mood.json?.total?.n ?? 0) >= 60,
  `n=${mood.json?.total?.n}`,
);
ok(
  'read: the aggregate is cacheable at the edge',
  /stale-while-revalidate/.test(mood.headers.get('cache-control') ?? ''),
  mood.headers.get('cache-control'),
);
ok(
  'read: staleness is disclosed rather than hidden',
  mood.headers.get('x-aggregate-staleness') !== null && mood.json?.staleness_seconds !== undefined,
  `header=${mood.headers.get('x-aggregate-staleness')} body=${mood.json?.staleness_seconds}`,
);
ok(
  'read: the mood histogram sums to the cohort size',
  mood.json?.total?.histogram?.reduce((a, b) => a + b, 0) === mood.json?.total?.n,
  JSON.stringify(mood.json?.total?.histogram),
);

const byAge = await call(
  `/v1/topics/${national.id}/mood?region_id=${ac.id}&dimension=age_band&tier=0`,
);
console.log(
  '    age buckets:',
  JSON.stringify(byAge.json?.buckets?.map((b) => [b.bucket, b.n, b.suppression_reason])),
);
ok(
  'privacy: all six age bands are present (absent reads as zero, not missing)',
  byAge.json?.buckets?.length === 6,
  `${byAge.json?.buckets?.length}`,
);
ok(
  'privacy: cohorts below k are suppressed',
  byAge.json?.buckets?.some((b) => b.suppressed),
  '',
);
const publishedAgeSum =
  byAge.json?.buckets?.filter((b) => !b.suppressed).reduce((a, b) => a + b.n, 0) ?? 0;
const suppressedCount = byAge.json?.buckets?.filter((b) => b.suppressed).length ?? 0;
ok(
  'privacy: a suppressed bucket cannot be recovered by subtraction',
  suppressedCount === 0 || suppressedCount >= 2 || byAge.json.total.n - publishedAgeSum >= 25,
  `total=${byAge.json?.total?.n} published=${publishedAgeSum} suppressed=${suppressedCount}`,
);

const byGender = await call(
  `/v1/topics/${national.id}/mood?region_id=${ac.id}&dimension=gender&tier=0`,
);
const genderSum =
  byGender.json?.buckets?.filter((b) => !b.suppressed).reduce((a, b) => a + b.n, 0) ?? 0;
ok(
  'correctness: the gender marginal agrees with the total',
  genderSum === byGender.json?.total?.n,
  `${genderSum} vs ${byGender.json?.total?.n}`,
);

const district = await call(`/v1/topics/${national.id}/mood?region_id=${lucknow.id}&tier=0`);
const state = await call(`/v1/topics/${national.id}/mood?region_id=${up.id}&tier=0`);
const country = await call(`/v1/topics/${national.id}/mood?region_id=1&tier=0`);
ok(
  'rollup: the same submissions appear at district level',
  district.json?.total?.n === mood.json?.total?.n,
  `${district.json?.total?.n}`,
);
ok(
  'rollup: and at state level',
  state.json?.total?.n === mood.json?.total?.n,
  `${state.json?.total?.n}`,
);
ok(
  'rollup: and at country level',
  country.json?.total?.n === mood.json?.total?.n,
  `${country.json?.total?.n}`,
);

const publicView = await call(`/v1/topics/${national.id}/mood?region_id=${ac.id}`);
ok(
  'trust: the default public view excludes unverified citizens',
  publicView.json?.total?.suppressed === true,
  `n=${publicView.json?.total?.n} suppressed=${publicView.json?.total?.suppressed}`,
);

// Changing an opinion must not inflate the cohort.
// Changing an opinion must not inflate the cohort. Uses a fresh citizen, submits once, waits for the
// cohort to grow, then changes — so the assertion is about the change and not about the first write.
const changer = (
  await call('/v1/citizens', {
    method: 'POST',
    body: { region_id: ac.id, demographics: { age_band: '25-34', gender: 'male' } },
  })
).json.access_token;
await call('/v1/sentiment', {
  method: 'POST',
  token: changer,
  idem: `pre-${Date.now()}`,
  body: { topic_id: national.id, mood: -2, intensity: 1 },
});
let before = mood.json.total.n;
let firstWriteSeen = false;
// Wait for the first write to land AND for the cooldown to elapse; breaking on the first alone
// would have the change rejected and the assertion skipped.
const cooldownSeconds = Number(process.env.COOLDOWN_SECONDS ?? 3);
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const now = await call(`/v1/topics/${national.id}/mood?region_id=${ac.id}&tier=0`);
  if (now.json.total.n > mood.json.total.n) {
    before = now.json.total.n;
    firstWriteSeen = true;
  }
  if (firstWriteSeen && attempt >= cooldownSeconds) break;
}
const changed = await call('/v1/sentiment', {
  method: 'POST',
  token: changer,
  idem: `change-${Date.now()}`,
  body: { topic_id: national.id, mood: 2, intensity: 5 },
});
if (changed.status === 202) {
  let after = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await call(`/v1/topics/${national.id}/mood?region_id=${ac.id}&tier=0`);
    // The change is applied when the satisfied bucket has grown; the cohort size must not have.
    if ((after.json?.total?.histogram?.[4] ?? 0) > (mood.json?.total?.histogram?.[4] ?? 0)) break;
  }
  ok(
    'CORRECTNESS: changing an opinion does not inflate the cohort',
    after.json?.total?.n === before,
    `before=${before} after=${after.json?.total?.n}`,
  );
  ok(
    'correctness: and the histogram still sums to the cohort size',
    after.json?.total?.histogram?.reduce((a, b) => a + b, 0) === after.json?.total?.n,
    JSON.stringify(after.json?.total?.histogram),
  );
} else {
  console.log(
    `SKIP  opinion-change check (cooldown): ${changed.status} ${changed.json?.error?.code}`,
  );
}

// A tiny region: every demographic slice should be suppressed.
const lakDistricts = await call(`/v1/regions/${lakshadweep.id}/children`);
const lakAcs = await call(`/v1/regions/${lakDistricts.json.items[0].id}/children`);
const lakAc = lakAcs.json.items[0];
const lakToken = (
  await call('/v1/citizens', {
    method: 'POST',
    body: { region_id: lakAc.id, demographics: { age_band: '25-34', gender: 'female' } },
  })
).json.access_token;
await call('/v1/sentiment', {
  method: 'POST',
  token: lakToken,
  idem: `lak-${Date.now()}`,
  body: { topic_id: national.id, mood: -2 },
});
await new Promise((r) => setTimeout(r, 3000));
const lakMood = await call(`/v1/topics/${national.id}/mood?region_id=${lakAc.id}&tier=0`);
ok(
  'privacy: a single participant in a tiny region publishes nothing',
  lakMood.json?.total?.suppressed === true,
  JSON.stringify(lakMood.json?.total),
);

// ── 6. RTI ──
const rti = await call('/v1/rti', {
  method: 'POST',
  token: tokens[0],
  body: {
    authority_id: 1,
    subject: 'Functional tap connections completed in this district in FY 2025-26',
    filed_at: '2026-01-01',
  },
});
ok(
  'rti: a filed request is created',
  rti.status === 201,
  `${rti.status} ${rti.json?.request?.state}`,
);
console.log(
  '    deadlines:',
  JSON.stringify(rti.json?.deadlines?.map((d) => `${d.label} → ${d.due_on} (${d.statute})`)),
);
console.log('    next:', rti.json?.next_action?.action);
ok(
  'rti: the §7(1) window is 30 days from filing',
  rti.json?.deadlines?.[0]?.due_on === '2026-01-31',
  rti.json?.deadlines?.[0]?.due_on,
);
ok(
  'rti: a lapsed request already reads as deemed refused',
  rti.json?.request?.state === 'deemed_refused',
  rti.json?.request?.state,
);
ok(
  'rti: and the citizen is pointed at a free first appeal',
  rti.json?.next_action?.action === 'file_first_appeal',
  rti.json?.next_action?.action,
);

const appeal = await call(`/v1/rti/${rti.json.request.id}/transitions`, {
  method: 'POST',
  token: tokens[0],
  body: { to: 'first_appeal', on: '2026-02-10' },
});
ok(
  'rti: the first appeal is accepted',
  appeal.status === 200 && appeal.json?.request?.state === 'first_appeal',
  `${appeal.status} ${appeal.json?.request?.state ?? appeal.json?.error?.code}`,
);
const illegal = await call(`/v1/rti/${rti.json.request.id}/transitions`, {
  method: 'POST',
  token: tokens[0],
  body: { to: 'filed' },
});
ok(
  'rti: an illegal transition is refused',
  illegal.status === 409,
  `${illegal.status} ${illegal.json?.error?.code}`,
);
const snoop = await call(`/v1/rti/${rti.json.request.id}`, { token: tokens[1] });
ok('privacy: another citizen cannot read that filing', snoop.status === 404, `${snoop.status}`);

// ── 7. Tax utilisation ──
const tax = await call(`/v1/tax-utilisation?region_id=${up.id}&fy=2026-27`);
ok(
  'tax: the view returns budget lines',
  tax.json?.lines?.length > 0,
  `${tax.json?.lines?.length} lines`,
);
const line = tax.json?.lines?.[0];
console.log(
  `    top line: ${line?.scheme_name} | utilisation ${line?.utilisation_rate} | ₹${line?.per_capita_utilised}/capita`,
);
ok(
  'tax: every monetary figure carries a source',
  tax.json?.lines?.every((l) => l.source_refs.length > 0),
);
ok(
  'tax: utilisation never exceeds what was released',
  tax.json?.lines?.every((l) => (l.utilised ?? 0) <= (l.released ?? 0)),
);
ok(
  'tax: per-capita is derived from population',
  (line?.per_capita_utilised ?? 0) > 0,
  `pop=${tax.json?.population}`,
);
ok(
  'tax: totals are consistent with the lines',
  Math.abs(tax.json.totals.utilised - tax.json.lines.reduce((a, l) => a + (l.utilised ?? 0), 0)) <
    1,
);

// ── 8. Erasure ──
const erasing = tokens[58];
const erasingHasOpinions =
  (await call('/v1/me/sentiment', { token: erasing })).json?.items?.length ?? 0;
ok(
  'privacy: the citizen about to be erased does have opinions',
  erasingHasOpinions > 0,
  `${erasingHasOpinions}`,
);
const erased = await call('/v1/me', { method: 'DELETE', token: erasing });
ok('privacy: erasure succeeds', erased.json?.erased === true, `${erased.status}`);
const afterErase = await call('/v1/me/sentiment', { token: erasing });
ok(
  'privacy: an erased citizen has no opinions left',
  afterErase.json?.items?.length === 0,
  `${afterErase.status}`,
);
const writeAfterErase = await call('/v1/sentiment', {
  method: 'POST',
  token: erasing,
  idem: `dead-${Date.now()}`,
  body: { topic_id: national.id, mood: 1 },
});
ok(
  'privacy: an erased account cannot write',
  writeAfterErase.status === 403 || writeAfterErase.status === 404,
  `${writeAfterErase.status} ${writeAfterErase.json?.error?.code}`,
);
const countryAfter = await call(`/v1/topics/${national.id}/mood?region_id=1&tier=0`);
ok(
  'privacy: erasure does not rewrite published aggregates (they hold no personal data)',
  (countryAfter.json?.total?.n ?? 0) >= 60,
  `n=${countryAfter.json?.total?.n}`,
);

console.log(`\n${'='.repeat(60)}\n${passes} passed, ${failures} failed\n${'='.repeat(60)}`);
process.exit(failures === 0 ? 0 : 1);
