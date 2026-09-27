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
| Clients | Web PWA (~92 kB gzipped) with an offline write queue; Expo mobile app on the same SDK. |
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

**Catalogue datasets.** The seed carries a representative slice of real Indian geography and central
schemes. Production needs the full LGD, Census and ECI datasets (~800k regions), and an ingestion
pipeline for budget documents. The `codes` column exists so those join without fuzzy name matching.

## Not started

- **Ad-hoc cross-product slices.** The ClickHouse query and the k-gate are implemented
  ([ADR-0002](adr/0002-precompute-marginals-not-crossproducts.md)); the API endpoint, the per-key
  rate limit and the audit log around it are not. This is a deliberately gated surface and should
  not ship casually.
- **Authority compliance scorecards.** The rollup and the query exist; no endpoint or UI yet.
- **Moderation.** Free-text is kept off the ingest path precisely so this can be added later without
  touching the write path. Reason codes are a closed vocabulary today.
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
- **The Terraform is a sketch.** It records shape and sizing, not a deployable root module.
- **The capacity model rests on measured and assumed inputs.** `pnpm loadtest` measures the one that
  matters most (per-write service time) and fails loudly when it drifts; the demand assumptions are
  named in `packages/core/src/capacity.ts` so they can be challenged and re-run.
