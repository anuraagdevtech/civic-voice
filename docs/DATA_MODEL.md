# Data model

Three stores, each with one job. The reasoning matters more than the DDL, so each table says
why it is shaped that way. Authoritative DDL: `packages/db/migrations/`.

---

## 1. Sharded Postgres — citizen-owned rows

Sharded by `vshard = hash(citizen_id) % 1024`. **Every query carries `citizen_id` and is
single-shard.** No cross-shard query exists in the codebase, and the shard router refuses to
build one.

### `citizen`
Pseudonymous account. Deliberately holds **no PII** — no name, no phone, no government ID.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` (v7) | Time-ordered, so index inserts are append-mostly |
| `region_id` | `bigint` | Their attested home region (ward/panchayat granularity) |
| `age_band`, `gender`, `urbanity`, `income_band`, `education_band`, `occupation_band` | `smallint` | Coarse bands only. Never a birth date, never an exact income |
| `verification_tier` | `smallint` | 0 anonymous → 3 gov-ID + address attested |
| `locale` | `text` | One of the 22 scheduled languages + English |
| `dek_wrapped` | `bytea` | Per-citizen data-encryption key, wrapped by KMS. Erasure = destroy this |
| `erased_at` | `timestamptz` | Tombstone; row retained for shard integrity, contents crypto-shredded |

Bands rather than raw values is the single most effective privacy control in the schema: a
value that was never collected cannot leak, be subpoenaed, or be correlated.

### `identity_binding` — separate database, separate credentials
Uniqueness proof for verified tiers, and nothing else.

`citizen_id`, `method` (phone | gov_id), `blind_index = HMAC(pepper_v, normalised_id)`,
`pepper_version`, `verified_at`.

The raw phone number or government ID is **never stored**. The blind index answers exactly one
question — "has this identity already claimed an account?" — and cannot be reversed to the
identity. The pepper lives in KMS and is versioned so it can be rotated by re-blinding.

### `sentiment_current`
The citizen's standing opinion. One row per `(citizen_id, topic_id)`.

`citizen_id`, `topic_id`, `mood` (−2..+2), `intensity` (1..5), `reason_code`, `updated_at`,
`event_id` (last applied, for idempotency).

This table exists for two reasons: so a citizen can see and change their own opinions, and so
the aggregator can compute a **compensating delta** when an opinion changes (`−1` old bucket,
`+1` new bucket) instead of double-counting. Without it, aggregates drift upward forever.

### `rti_request`
The citizen's RTI filings and their statutory clock. See [RTI.md](./RTI.md) for the state
machine. Sharded with the citizen so "my RTIs" is a single-shard query; the *public* view of a
disclosed response is a separate catalogue row, so publishing does not leak the filer's shard.

### `follow`
`(citizen_id, subject_type, subject_id)` — topics, regions, authorities or schemes a citizen
follows. Pull-based: there is no fan-out-on-write and no materialised timeline, which is what
keeps a 1B-user follow graph from being a scaling problem at all.

---

## 2. Catalogue Postgres — global, read-mostly

~10M rows, fits in RAM, replicated to every region, cached hard at the edge. No sharding: it is
small and almost never written.

### `region`
The spine. India's administrative hierarchy: country → state/UT → district →
constituency (AC/PC) → ward/panchayat. ~800k rows.

Stored with **both** a `parent_id` and an `ltree` materialised path. The path makes the two
queries that matter O(1) rather than recursive: "give me this region's 4 ancestors" (the rollup
fan-out, on every single write) and "is region A inside region B" (authorisation and filtering).

Also: `kind`, `codes` (jsonb — LGD / census / ECI codes, so external datasets can be joined),
`population`, `names` (jsonb, per-locale).

### `topic`
A government decision, policy, scheme, law or budget line — the thing a citizen has a mood
about. `kind`, `jurisdiction_region_id`, `authority_id`, `scheme_id`, `status`, `titles`
(jsonb per-locale), `summary`, `effective_from`, `source_refs` (jsonb).

Every topic is anchored to a jurisdiction, which bounds its rollup fan-out and makes
"policies that apply to me" a path-prefix query.

### `authority`
A public authority in the RTI sense: ministry, department, PSU, municipal body. Carries its
`pio_contact` and `faa_contact` (the First Appellate Authority), which is what makes the
appeal ladder actionable rather than informational.

### `scheme`, `budget_line`, `utilisation`
The tax-utilisation spine, modelled as the money actually moves:

- `scheme` — a programme, with its ministry and sector.
- `budget_line` — `(fy, scheme_id, region_id, level)` with `allocated_be`, `revised_re`,
  `released`, `utilised`, each with a `source_ref` to the document it came from.
- `utilisation` — dated events against a budget line, so a series can be drawn and revisions
  are visible rather than overwritten.

Per-capita metrics are derived from `region.population` at query time, not stored, so a census
update does not require a backfill.

### `disclosure`
An RTI response that has been published: content-addressed (`sha256`) object-store pointer,
`authority_id`, `topic_id`, extracted text for search, crowd-verification state. This is the
bridge from "a citizen asked a question" to "here is the evidence about where the money went".

---

## 3. ClickHouse — events and analytics

### `sentiment_event`
Append-only, the system of record for opinion history.

`event_id`, `occurred_at`, `topic_id`, `region_path` (4 ancestor ids, denormalised at write
time), the 6 demographic bands, `verification_tier`, `mood`, `intensity`, `reason_code`,
`pseudonym` (per-topic, see [PRIVACY.md](./PRIVACY.md)), `delta` (+1 / −1).

`PARTITION BY toYYYYMM(occurred_at)`, `ORDER BY (topic_id, occurred_at, event_id)`.
Denormalising the region path and the bands onto the event is what makes every analytical
query a single-table scan — no joins against a 1.4B-row citizen table, and no way for an
analytical query to reach identity at all.

The bus event *does* carry `citizen_id`, because the worker has to find the citizen's shard; the
projection written here does not, and the type system is what enforces that (see
[PRIVACY.md §2](./PRIVACY.md)).

90 days hot, then Parquet in object storage, still queryable.

### `mood_rollup`
The pre-computed marginals; the table the whole read path is built on.

`day`, `topic_id`, `region_id`, `dim` (0 = total, 1..6 = demographic dimension),
`bucket`, `tier`, `n`, `sum_intensity`, `mood_histogram`.

`AggregatingMergeTree`, `ORDER BY (topic_id, region_id, day, dim, bucket, tier)`.
`n` is carried explicitly because the k-anonymity gate needs the cohort size *before* deciding
whether the bucket may be published at all.

---

## 4. Redis — hot, derived, disposable

| Key shape | Purpose | TTL |
| --- | --- | --- |
| `m:{topic}:{region}:{dim}:{bucket}:{tier}` | Live counters (hash: `n`, `sum`, histogram) | 48 h |
| `q:{citizen}` / `qt:{citizen}:{topic}` | Token bucket / per-topic cooldown | window |
| `idem:{key}` | Idempotency record + stored response | 24 h |
| `hll:{topic}:{region}:{day}` | Distinct participants, without storing who | 30 d |
| `cat:{kind}:{id}` | Catalogue read-through cache | 1 h |

Everything here is rebuildable from ClickHouse. Nothing in Redis is a source of truth, which is
why losing a Redis shard is an availability event and not a data-loss event.

---

## 4a. Forum, documents, indicators (ADR-0008, ADR-0012)

| Store | Table | Keyed by | Notes |
| --- | --- | --- | --- |
| Shard (topic's) | `comment`, `comment_vote`, `comment_report`, `topic_digest` | `topic_id` | A thread is one shard; partial indexes on `state = 'published'` for "top" and "new" |
| Shard (citizen's) | `my_comment` | `citizen_id` | The author's index: "my comments" and erasure |
| Shard (citizen's) | `citizen.region_basis` | `citizen_id` | `declared` or `device`-confirmed home region |
| Catalogue | `document` | `content_hash` | Jurisdiction + canonical URL or GO number; `primary_region_path` and `geo_region_ids` for "what concerns me" |
| Catalogue | `source_health` | `source_id` | Last poll per source; flags probable redesigns |
| Catalogue | `indicator`, `indicator_observation` | `code`, `region_id`, `period` | Every observation carries `provenance` |
| ClickHouse | `comment_event` | `dedupe_key` | No body, id or pseudonym; hour-coarsened; `author_key` for distinct voices |
| Redis | `tr:{r<region>}:<hour>`, `tc:{t<topic>}:<hour>` | region / topic | Hourly trending buckets, summed with a 6-hour half-life |

## 5. Invariants the code enforces

1. No Postgres query without a `citizen_id` (sharded) or a bounded catalogue key.
2. No demographic value stored outside its declared band enum.
3. No published aggregate with `n < k` (default k = 25), with complementary suppression.
4. No raw phone number or government ID, in any store, at any time.
5. Every rollup mutation is idempotent on `event_id`.
6. Every monetary figure carries a `source_ref` — no number appears without provenance.
