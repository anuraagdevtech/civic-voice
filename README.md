# civic-voice

A web and mobile application to track public sentiment on government decisions, policies, and tax
utilisation. A mix of RTI and mood tracking with demographic metrics.

Built and sized for **1B+ registered citizens**.

---

## What it does

| | |
| --- | --- |
| **Mood tracking** | A citizen records how they feel about a government decision, policy or scheme. Aggregates are published per region and per demographic dimension, and never for a group of fewer than 25 people. |
| **RTI tracking** | Log an RTI request and the platform tracks the statutory clock under the RTI Act 2005 — telling you the day a deadline lapses, that silence is a *deemed refusal* you can appeal, and who the First Appellate Authority is. |
| **Tax utilisation** | What a region was allocated, what was released, and what was actually spent, per scheme, with per-capita figures and a link to the source document for every number. |
| **Discussion** | New GOs, projects, gazette notifications and news, ingested from government portals and scoped to the place they concern, become discussions. Residents of that place — and only they — comment, reply and upvote; a digest says what people think and what they say needs to be done. Residents can raise local issues for their ward or city. |
| **Near me** | Location resolves to a ward (Greater Hyderabad's 145 real wards today) and is never stored. The home page shows what people where you live are discussing, new orders and projects for your area, and the government jobs open to you. |
| **Youth, farmers and more** | What each group raises — jobs, exams, crop prices, water — from model-labelled comments, published only when at least 25 distinct people contributed. |
| **Money and jobs** | Budgets, deficits, debt, prices, unemployment and crop MSPs with their sources; open government job notifications and the vacancies they state. |

They are joined by the region hierarchy and the topic graph. A district's mood on a scheme, the
RTI responses about that scheme, and the rupees actually spent on it in that district are all
reachable from one place. That join is the product.

## Quick start

```bash
pnpm install

# No infrastructure needed — the whole platform in one process on in-memory adapters,
# with sample documents and invented demo comments (a banner on every page says so).
pnpm dev:demo
VITE_API_URL=http://127.0.0.1:8080 pnpm dev:web

# Or the full stack:
pnpm infra:up                              # Postgres, Redis, Redpanda, ClickHouse
pnpm migrate && pnpm seed                  # schema + real Indian geography and schemes
node packages/analytics/src/cli/migrate.ts # ClickHouse schema
pnpm ingest:run --fixtures                 # sample GOs, projects and job notifications
pnpm indicators:load --sample              # sample indicators, badged as such
pnpm finance:load --sample                 # sample Union and Telangana budgets, badged as such
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```

```bash
pnpm test            # ~470 unit and conformance tests, no daemon required
pnpm typecheck       # the whole workspace, including both client apps
pnpm nlp:evaluate    # cross-validated accuracy of the comment model, against baselines
pnpm ingest:check    # every source through the full ingestion pipeline (--live for the real sites)
pnpm loadtest        # measures the per-write cost the capacity model depends on
```

## How it scales

One decision does most of the work:

> **Postgres is only ever asked for rows a single citizen owns, by primary key. Every region-wide,
> demographic or time-series question is answered from a pre-computed rollup.**

Everything else follows. Citizen data is sharded by `hash(citizen_id) % 1024` — not by region,
because Uttar Pradesh is ~240M people and Lakshadweep is ~64,000, and no rebalancing fixes a 3,750:1
skew ([ADR-0001](docs/adr/0001-shard-by-citizen-not-region.md)). Region-shaped questions are answered
from marginals rather than cross-products, which is an ~850× reduction in rollup rows
([ADR-0002](docs/adr/0002-precompute-marginals-not-crossproducts.md)). The write path appends to an
event log and returns; nothing on it computes ([ADR-0003](docs/adr/0003-event-log-as-commit-point.md)).

The capacity model is executable (`packages/core/src/capacity.ts`) and asserted by the test suite, so
the numbers in [docs/SCALING.md](docs/SCALING.md) cannot silently rot:

| | |
| --- | --- |
| 1.4B registered → 90M daily active | 150M writes/day, 1.5B reads/day |
| Spike (budget day, a verdict) | 170k writes/s, 520k reads/s |
| Absorbed at the CDN | ~98% of reads → ~10k/s at origin |
| Counter touches per event | 32 — four region levels × (seven marginals + total) |
| Write fleet at spike | ~88 pods, from a **measured** 2.0 ms per write |

## Three things this design refuses to do

**Publish a number it cannot defend.** Every slice passes through one k-anonymity gate with
complementary suppression, because thresholding alone leaks by subtraction: publish five of six age
bands and a total, and the sixth is arithmetic. A suppressed bucket is shown *as suppressed*, with
the reason — hiding the row would imply the cohort does not exist.

**Pretend a stale number is fresh.** Aggregates are eventually consistent and every response carries
`staleness_seconds`. A citizen's *own* opinion is read-your-write, because that is the part they
notice.

**Overstate what it is.** This is a sentiment platform, not an election system. No cryptographic
receipts, no end-to-end verifiability, no coercion resistance. Saying so in the product copy is part
of the design ([docs/TRUST.md](docs/TRUST.md)).

## Privacy

The design assumption is that the operator will eventually be compelled to hand over what it holds,
so the controls aim at **holding as little as possible**:

- No name, no phone number, **no government ID anywhere**. Verification stores a one-way blind index
  and discards the identifier.
- Demographics as coarse bands only. A value never collected cannot leak or be subpoenaed.
- Per-topic pseudonyms, so linking one citizen's opinions across topics is not a `JOIN` — it needs
  every salt, and the salts live in KMS, never beside the data.
- Identity reaching the long-lived analytical store is prevented **by the type checker**, not by
  remembering: `AnalyticsStore.insertEvents` accepts only the projection `stripIdentity` produces.
- Erasure by crypto-shredding: destroying a per-citizen key makes ciphertext unrecoverable
  everywhere at once, including in backups nobody can reach
  ([ADR-0004](docs/adr/0004-crypto-shredding-for-erasure.md)).

Details in [docs/PRIVACY.md](docs/PRIVACY.md).

## Layout

```
apps/web         Vite + React PWA — static, CDN-first, ~103 kB gzipped, offline write queue
apps/mobile      Expo React Native app on the same SDK
services/api     Stateless Fastify API — idempotent ingest, edge-cacheable reads
services/worker  Aggregation and comment pipelines, RTI deadline sweeper, reconciliation
services/ingestor  Polls government portals and news feeds, politely
packages/
  contracts      Zod schemas — one source of runtime validation and static types
  core           Domain logic: k-anonymity, pseudonyms, the RTI clock, rollups, the capacity model
  db             1024-vshard routing, migrations, seed data
  cache          Redis: counters, quotas, idempotency, profile cache
  stream         Kafka / Redpanda event bus
  analytics      ClickHouse event history and rollups
  observability  Structured logging with redaction at the logger, and metrics
  sdk            One typed client for web and mobile
  nlp            The comment model: language, moderation, sentiment, needs, suggestions, digests
  geo            The region tree, real ward boundaries, point-in-polygon location lookup
  ingest         Polite fetching, RSS/HTML/PDF parsing, GO and vacancy extraction, geo-tagging
infra/           docker-compose, Kubernetes, a Terraform sketch, the load-test harness, the dev stack
docs/            Architecture, scaling, data model, privacy, trust, RTI — and 12 ADRs
```

Every infrastructure dependency is an interface with two implementations, a real one and an
in-memory one, held to **one shared conformance suite**. That is what lets `pnpm test` run in
seconds with no daemon while CI still proves the adapters have not diverged
([ADR-0006](docs/adr/0006-typescript-monorepo-with-in-memory-adapters.md)).

Node 22 runs the TypeScript directly via type stripping, so there is no build step and no transpiler
configuration to keep in sync between development and production.

## Documentation

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Then:

- [SCALING.md](docs/SCALING.md) — the capacity model, sharding, failure modes, cost levers
- [DATA_MODEL.md](docs/DATA_MODEL.md) — the schema, and why each table is shaped that way
- [PRIVACY.md](docs/PRIVACY.md) — k-anonymity, pseudonyms, erasure, DPDP Act alignment
- [TRUST.md](docs/TRUST.md) — verification tiers and Sybil resistance
- [RTI.md](docs/RTI.md) — the statutory clock and the appeal ladder
- [adr/](docs/adr) — the decisions, each with what it cost

## Status

The platform — opinions, RTI, tax utilisation and the discussion forum — is built, tested and verified
end to end against real Postgres, Redis, Redpanda and ClickHouse. What a production deployment still
needs is listed in [docs/ROADMAP.md](docs/ROADMAP.md) — chiefly verifying the scrapers against the
live portals, a moderation console, the identity-verification provider, notification fan-out, and
the datasets behind the catalogue.

Ward boundaries © OpenStreetMap contributors, under the ODbL ([packages/geo/data/ATTRIBUTION.md](packages/geo/data/ATTRIBUTION.md)).

## Licence

MIT — see [LICENSE](LICENSE).
