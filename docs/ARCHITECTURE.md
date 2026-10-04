# Civic Voice — Architecture

> A web and mobile application to track public sentiment on government decisions,
> policies, and tax utilisation. A mix of RTI and mood tracking with demographic metrics.

Target operating scale: **1B+ registered citizens** (India-scale), with correctness,
privacy and Sybil-resistance treated as first-class constraints rather than add-ons.

---

## 1. The products in one platform

| Product | What a citizen does | What the platform must guarantee |
| --- | --- | --- |
| **Mood tracking** | Records a 5-point mood + intensity + optional reason on a government decision, policy or scheme | One opinion per verified citizen per topic; instant read-your-write; no de-anonymisation from aggregates |
| **RTI tracking** | Files / logs an RTI request against a public authority and tracks it through the statutory clock | Statutory deadlines computed correctly (RTI Act 2005); public responses become citable evidence |
| **Tax utilisation** | Sees allocated → released → utilised money for a scheme in their own district, per capita | Numbers are attributable to a source document; sentiment can be correlated with delivery |
| **Discussion** | Comments on new GOs, projects and news that concern where they live, raises local issues, reads what residents think and say needs to be done | Only residents of the place speak on it; no personal information is published; a thread is one shard (ADR-0008 – 0012) |
| **Insights, jobs, money** | Sees what youth or farmers raise, the government jobs open to them, and budgets, prices and unemployment with sources | Cohorts k-gated on distinct voices; every figure sourced; samples labelled as samples |

They are joined by two shared spines: the **region hierarchy** and the **topic graph**.
A district's mood on a scheme, the RTI responses about that scheme, and the rupees actually
spent on it in that district are all reachable from one place. That join is the product.

---

## 2. System shape

```
                       ┌──────────────── Anycast edge (CDN + WAF + TLS) ─────────────────┐
  Web PWA ────────────▶│  static assets (immutable, 1y)  ·  GET /v1/... (cacheable)      │
  Android / iOS ──────▶│  stale-while-revalidate  ·  98%+ of all reads terminate here    │
                       └───────────────────────────────┬────────────────────────────────┘
                                                       │ cache miss / all writes
                                     ┌─────────────────▼──────────────────┐
                                     │  API  (Fastify, stateless, N pods) │
                                     │  authn · quota · idempotency       │
                                     └──┬──────────────┬──────────────┬───┘
                        point lookups    │              │ append       │ instant counters
                        by primary key   │              │              │
                      ┌──────────────────▼───┐  ┌───────▼────────┐  ┌──▼──────────────┐
                      │ Postgres — 1024 vshds│  │ Event log      │  │ Redis Cluster   │
                      │ citizen-owned rows   │  │ (Kafka/        │  │ counters · HLL  │
                      │ sharded by citizen   │  │  Redpanda)     │  │ quota · idemp.  │
                      └──────────────────────┘  └───────┬────────┘  └─────────────────┘
                      ┌──────────────────────┐          │
                      │ Postgres — catalogue │  ┌───────▼────────────────────────────┐
                      │ regions · topics ·   │  │ Worker (consumer groups)           │
                      │ authorities · budget │  │ rollups · RTI clock · tiering       │
                      │ read-mostly, cached  │  └───────┬────────────────────────────┘
                      └──────────────────────┘          │
                                                ┌───────▼────────┐   ┌────────────────┐
                                                │ ClickHouse     │   │ Object store   │
                                                │ rollups +      │   │ Parquet cold   │
                                                │ ad-hoc slices  │   │ tier, RTI docs │
                                                └────────────────┘   └────────────────┘
```

Every box is independently scalable and every box except the catalogue is horizontally
partitioned. The API holds no session state, so it scales purely on pod count.

---

## 3. The one rule that makes 1B users tractable

> **Postgres is only ever asked for rows a single citizen owns, by primary key.
> Every region-wide, demographic or time-series question is answered from a
> pre-computed rollup.**

This is the whole scaling argument, and it is why the schema is shaped the way it is
([DATA_MODEL.md](./DATA_MODEL.md)):

- **Citizen-owned data** — the citizen record, their current opinions, their RTI requests,
  their follows — is sharded by `hash(citizen_id) % 1024`. Every query carries the citizen id,
  so every query is single-shard. No scatter-gather, ever. Adding capacity is moving vshards.
- **Catalogue data** — ~10M rows of regions, topics, authorities, schemes, budget lines — is
  read-mostly, fits in RAM, and is replicated to every read replica and cached at the edge.
- **Aggregates** — "what does Bihar's 25–34 cohort think of this scheme" — never touch the
  OLTP path. They are maintained incrementally by the worker and served from Redis (hot,
  seconds old) or ClickHouse (historical, minutes old).

The corollary: the write path's job is to *durably append and acknowledge*, not to compute.
See [SCALING.md](./SCALING.md) for the capacity model that falls out of this.

---

## 4. Write path (sentiment ingest)

1. **Edge** terminates TLS, applies WAF and a coarse per-IP budget.
2. **API** authenticates the citizen from a stateless bearer token, loads their region path and
   demographic bands from a read-through profile cache (~40 bytes; a miss costs one point lookup on
   their own shard, once per TTL rather than once per write), and checks two quotas in one Redis
   round trip: a per-citizen token bucket and a per-(citizen, topic) cooldown.
3. **Idempotency.** The client sends `Idempotency-Key`. `SET key <hash> NX EX 86400` either
   wins (proceed) or loses (replay the stored response). This makes mobile retries over a
   flaky 4G connection safe, which at this scale is the common case, not the edge case.
4. **Durable append.** The event is written to the event log, partitioned by
   `hash(topic_id)` so that all deltas for one topic land on one partition and a consumer can
   aggregate them without cross-partition coordination.
5. **Instant feedback.** The API records the citizen's own submitted value in a short-lived
   per-citizen overlay key. `GET /v1/me/sentiment` reads through it, so the citizen sees their own
   opinion immediately without the write path touching the shared counters — which it must not,
   since it cannot know whether a compensating `−1` is owed (ADR-0003).
6. **Worker** consumes the partition, reads `sentiment_current` on the citizen's shard to resolve
   whether this replaces an earlier opinion, upserts it, and applies the resulting `+1` (or
   `−1`/`+1` pair) to the shared counters and the daily rollups.

Failure semantics are explicit: the event log append is the commit point. If the worker is
down, aggregates go stale but nothing is lost and the write path keeps serving. If Redis is
down, the API degrades to "accepted, aggregate will follow" rather than failing the write.

## 5. Read path

Two tiers, chosen by cardinality:

- **Pre-computed marginals** (the 99% case). For every event the worker touches
  `4 regions × (7 demographic dimensions + 1 total)` = **32 counters** — marginals, *not* the
  cross-product. Served from Redis; edge-cached for 30–60s with `stale-while-revalidate`.
- **Ad-hoc cross-product slices** (the 1% case, for journalists and researchers). Computed in
  ClickHouse on demand, forced through the k-anonymity gate, rate-limited per API key and
  cached by normalised query hash.

Refusing to pre-compute the cross-product is deliberate: the seven dimensions crossed are 28,800
buckets per (topic, region, day, tier) versus 34 as marginals — an ~850× difference, and ~5.8B rows
a day instead of ~1.7M — for questions almost nobody asks. Marginals answer the questions people
actually do ask, in 32 increments.

## 6. Correctness concerns that scale forces on us

- **Changed opinions.** A citizen who moves from *angry* to *hopeful* must not inflate both
  buckets. `sentiment_current` holds the previous value, so the consumer emits a compensating
  `−1` for the old bucket with the `+1` for the new. The event log keeps both, so history is
  auditable.
- **Exactly-once-enough aggregation.** Consumers are at-least-once. Every rollup mutation is
  keyed by `(event_id)` in a dedupe set with a retention window longer than the maximum
  redelivery lag, so a redelivered event is a no-op rather than a double count.
- **Reconciliation.** Redis counters are a cache of ClickHouse truth, not the record. A nightly
  job recomputes each active (topic, region) pair's marginals from the event log and repairs
  drift, so a lost Redis node is an availability event, not a data-loss event.

## 7. Sybil-resistance is a scaling requirement

A sentiment platform that can be brigaded is worthless at any size, and at 1B users it is a
national-scale target. Aggregates are therefore *always* qualified by verification tier
(T0 anonymous → T3 gov-ID + address-attested), and the default public view counts **T2+ only**.
Lower tiers are still collected and still visible, labelled, on a separate axis. See
[TRUST.md](./TRUST.md).

## 8. Privacy is not a feature flag

Coarse demographic bands only, k-anonymity with complementary suppression on every published
slice, per-topic pseudonyms so cross-topic opinion linkage is not a `JOIN`, no raw government
ID anywhere in the system, and crypto-shredding for erasure under the DPDP Act 2023. See
[PRIVACY.md](./PRIVACY.md).

## 9. Repository layout

```
apps/web         Vite + React PWA, CDN-first, offline-tolerant
apps/mobile      Expo React Native app on the same SDK
services/api     Fastify HTTP API — write + read paths, stateless
services/worker  Stream consumers — rollups, RTI clock, cold tiering
packages/contracts     Zod schemas + shared types; the wire contract
packages/core          Domain logic: mood scoring, k-anonymity, geo, RTI statutory clock
packages/db            Sharded Postgres access + migrations + shard router
packages/cache         Redis: counters, HLL, token buckets, idempotency
packages/stream        Event bus abstraction (Kafka/Redpanda; in-memory for tests)
packages/analytics     ClickHouse rollup + ad-hoc slice queries
packages/observability Structured logging, metrics, tracing
packages/sdk           Typed client shared by web and mobile
infra/                 docker-compose, Kubernetes, Terraform sketch
docs/                  This directory, plus ADRs
```

Adapters are interfaces with two implementations: a real one and an in-memory one. The whole
test suite runs with no Docker daemon, which is what keeps CI fast enough to be useful.

## 10. Further reading

- [SCALING.md](./SCALING.md) — capacity model, sharding, failure modes, cost
- [DATA_MODEL.md](./DATA_MODEL.md) — schema and the reasoning behind each table
- [PRIVACY.md](./PRIVACY.md) — k-anonymity, pseudonyms, erasure, DPDP alignment
- [TRUST.md](./TRUST.md) — verification tiers and Sybil resistance
- [RTI.md](./RTI.md) — the statutory clock, appeal ladder, and how it is modelled
- [adr/](./adr) — the decisions, and what we gave up for them

## 11. The forum, in one paragraph

The ingestor ([ADR-0012](adr/0012-polite-precise-ingestion.md)) turns government documents into
topics scoped to the place they concern. A resident's comment is checked synchronously (do you live
there, is there personal information in it, are you over your limit) and appended to the log like an
opinion; the worker labels it with the in-house model, escalating uncertain ones to a large model
within a budget ([ADR-0011](adr/0011-in-house-model-first.md)), stores it on its **topic's** shard
([ADR-0008](adr/0008-comments-on-topic-shards.md)), projects it to ClickHouse with nothing that can be
joined back to it, bumps trending in Redis, and rebuilds the topic's digest when it has grown. Who
counts as a resident comes from the region tree and, optionally, a device location that is used once
and kept nowhere ([ADR-0010](adr/0010-where-people-live.md)).
