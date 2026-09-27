# What is built, and what is not

An honest inventory. The platform core works end to end against real infrastructure; several things
a production launch needs are deliberately stubbed or absent, and they are listed here rather than
left for someone to discover.

---

## Built and verified

| Area | State |
| --- | --- |
| Sentiment write path | Idempotent ingest, quotas and cooldowns, event-log append as commit point. Verified end to end. |
| Aggregation pipeline | Compensating deltas for changed opinions, idempotent on redelivery, lossless in-memory merge, dual-sink flush. |
| Read path | Pre-computed marginals, k-anonymity gate with complementary suppression, disclosed staleness, edge-cacheable headers. |
| RTI clock | The full RTI Act 2005 ladder — §7(1) and its provisos, §6(3), §11, §7(2) deemed refusal, §19(1)/(3)/(6). Exhaustively tested. |
| Tax utilisation | BE → RE → released → utilised, across a citizen's region path, per capita against the right population, every figure sourced. |
| Sharding | 1024 vshards by citizen id, a router that cannot express a cross-shard query, a separate maintenance entry point. |
| Privacy | Band-only demographics, per-topic pseudonyms, blind indexes, crypto-shredding erasure, type-enforced identity boundary. |
| Discussion forum | Comments on topic-keyed shards, one-level replies, votes, reports, author deletion and erasure; locals-only participation; trending per region; digests of what people think and what needs to be done. Verified end to end through Kafka, the worker, Postgres, Redis and ClickHouse. |
| Comment ML | In-house multilingual sentiment, 14 needs and suggestion detection with calibrated confidence; budgeted escalation to a large model; evaluated by cross-validation against baselines. |
| Where people live | Cities as regions; 145 real GHMC ward boundaries; location resolved once and never kept; device-confirmed home regions. |
| Public documents | Polite ingestion framework for central, Telangana and Andhra Pradesh sources; GO/gazette/vacancy/amount extraction; precision-first geo-tagging; discussable documents become topics. |
| Jobs, indicators, cohorts | Open government job notifications with stated vacancies; socio-economic indicators with sources; youth/farmer/women/student/job-seeker insights behind the k-gate. |
| Public finances | Taxes collected by category, spending by sector and the gap, for the Union and each state, per year and stage, every figure sourced; the gap reconciled or shown as unreconciled (ADR-0013). |
| Opinion against allocation | Per sector: share of programme spending, share of what residents raise, and mood on the government's own decisions, by any demographic dimension; per-topic gating before combining; CSV for researchers. Verified against real ClickHouse. |
| Clients | Web PWA (~107 kB gzipped) with an offline write queue and the full forum; Expo mobile app on the same SDK with onboarding and the Near me thread. |
| Adapters | Postgres, Redis, Kafka/Redpanda and ClickHouse, each with an in-memory twin held to one conformance suite. |

## Stubbed — the shape is right, the integration is not there

**Identity verification (tiers 2 and 3).** The blind-index scheme, the uniqueness constraint, the
tier model and the isolated vault are all implemented. What is missing is the provider integration
that actually asserts "this is a real, unique government ID" — and the choice of provider is a policy
decision with real consequences, not a library swap. Until it is wired up, every citizen is tier 0,
which is why the default public view is empty in a fresh deployment.

**Notification fan-out.** The RTI sweeper computes exactly what to tell a citizen and when; it
currently logs it. Delivery needs push (FCM/APNs), SMS and email, and at 90M daily actives the
fan-out is its own scaling problem, not a feature of the worker.

**Device attestation.** Play Integrity and App Attest tokens are accepted and ignored. Verifying them
is what makes tier 0 cost anything to forge.

**RTI disclosure pipeline.** The `disclosure` table, content addressing and the search index exist.
Upload, OCR for scanned replies, and crowd verification do not.

**Live scraping.** Every source in `packages/ingest/src/sources.ts` has selectors written against
its expected format and a synthetic fixture, and none has been checked against the live site: the
build environment's network policy did not allow government or news hosts. Run
`pnpm ingest:check --live` from a network that does, fix what it reports, capture real fixtures with
`--save-fixtures`, and fill in each source's `verified` entry.

**Moderation console.** Comments held by the automatic checks or by reports wait, invisible, for a
moderator. The queue, the reviewer tooling and the author's appeal are not built (ADR-0009).

**Indicator figures.** The indicator catalogue names real sources, but the values loaded in
development are samples, badged as such. Load published figures with `pnpm indicators:load <file>`.

**Budget figures.** The Union and Telangana budgets loaded in development are samples of roughly the
right magnitude, badged as such. Each government's published Budget at a Glance or Annual Financial
Statement needs mapping to the category vocabulary in a reviewed file, then
`pnpm finance:load <file>`; the loader refuses unknown or duplicate categories and warns on budgets
that do not reconcile. Existing topics created before sectors existed have none until re-classified
or set by hand.

**Catalogue datasets.** The seed carries a representative slice of real Indian geography and central
schemes. Production needs the full LGD, Census and ECI datasets (~800k regions), and an ingestion
pipeline for budget documents. The `codes` column exists so those join without fuzzy name matching.

## Not started

- **Ad-hoc cross-product slices.** The ClickHouse query and the k-gate are implemented
  ([ADR-0002](adr/0002-precompute-marginals-not-crossproducts.md)); the API endpoint, the per-key
  rate limit and the audit log around it are not. This is a deliberately gated surface and should
  not ship casually.
- **Authority compliance scorecards.** The rollup and the query exist; no endpoint or UI yet.
- **Ward boundaries beyond Greater Hyderabad.** Location lookup covers GHMC only; elsewhere it says
  "not mapped yet" and the person picks from the list.
- **Mobile parity.** Device-location confirmation (needs `expo-location`), voting, reporting, raising
  issues, insights, jobs, indicators, public finances and opinion against allocation are web-only
  for now.
- **OCR** for scanned GO PDFs, which are flagged `needs_ocr` and indexed by title only.
- **Localisation.** The 22 scheduled languages are modelled throughout (`locale`, `names`, `titles`);
  no translations are loaded and the UI strings are not extracted.
- **Rebalancing tooling.** The vshard model supports moving a shard; the operational runbook and
  tooling to do it live are not written.
- **Second region.** Everything is single-region. The failover story in
  [SCALING.md §7](SCALING.md#7-failure-modes) is designed, not built.

## Known limitations of what *is* built

- **The in-memory adapters are not emulators.** They implement the semantics the conformance suite
  checks, which is the set the code depends on — not everything Redis or Kafka does. CI runs both.
- **Consumer lag is reported via the Kafka admin API**, not through the `Consumer.lag()` port, which
  returns empty rather than a plausible-looking wrong number.
- **Rounding does not defeat a determined differencing attack.** Counts above 1,000 are rounded to
  the nearest ten, which raises the cost of comparing the same slice across days; it does not make
  it impossible, and [PRIVACY.md §3](PRIVACY.md) says so rather than implying otherwise.
- **The comment model is evaluated on 241 seed examples,** not on real forum traffic. Sentiment
  macro-F1 is 0.62 against a 0.27 baseline; needs micro-F1 0.79, mostly from the lexicon. Real
  traffic needs a labelled sample and re-evaluation before its labels are relied on (ADR-0011).
- **The GHMC ward boundaries are a 2018 OpenStreetMap snapshot,** 145 of 150 wards (ADR-0010).
- **The seed's budget lines are illustrative,** stored as `sample` and badged; RTI authorities carry
  no PIO/FAA contacts until they are loaded from each authority's published list.
- **Sector classification is lexical.** A topic is tagged from the need lexicon; a scheme known only
  by its name ("Jal Jeevan Mission extension") gets no sector until someone sets it. Opinion by
  sector covers a government's 2,000 newest sector-tagged decisions.
- **The demo cannot show attention by sector.** Its 66 invented residents spread over twelve sectors
  rarely reach 25 distinct voices in one, so the view shows spending with attention withheld — the
  gate working as designed, and k cannot be lowered below 25.
- **The Terraform is a sketch.** It records shape and sizing, not a deployable root module.
- **The capacity model rests on measured and assumed inputs.** `pnpm loadtest` measures the one that
  matters most (per-write service time) and fails loudly when it drifts; the demand assumptions are
  named in `packages/core/src/capacity.ts` so they can be challenged and re-run.
