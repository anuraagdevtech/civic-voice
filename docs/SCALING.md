# Scaling to 1B+ users

Every number below is derived, not asserted. Where an assumption drives the design, it is
named so it can be challenged and re-run. The model lives in code as
`packages/core/src/capacity.ts` and is asserted by tests, so the doc cannot silently rot.

---

## 1. Demand model

| Quantity | Assumption | Value |
| --- | --- | --- |
| Registered citizens | India-scale ceiling | **1.4B** |
| Monthly active | 32% of registered | 450M |
| Daily active | 20% of MAU | **90M** |
| Sessions / DAU / day | 1.4 | 126M sessions/day |
| Sentiment writes / session | 1.2 | **150M writes/day** |
| Aggregate reads / session | 12 | **1.5B reads/day** |

Derived steady-state rates (86,400 s/day):

- Writes: 150M / 86.4k ≈ **1.7k writes/s average**
- Reads: 1.5B / 86.4k ≈ **17.4k reads/s average**

Average rate is not the design point. Civic attention is extraordinarily peaky: a Union Budget
speech, a court verdict, or a fuel-price revision moves the whole country at once.

| Peak | Multiplier | Design target |
| --- | --- | --- |
| Diurnal peak (evening) | 3× average | 5k writes/s |
| Event spike (budget day, verdict) | **100× average, sustained 10 min** | **170k writes/s** |
| Read spike | 30× average | **520k reads/s** |

**Provisioned headroom: 250k writes/s and 750k reads/s.** The spike, not the average,
sizes the system — and the spike is why the write path appends rather than computes.

## 2. Where each request is absorbed

| Layer | Share of reads | Why |
| --- | --- | --- |
| CDN edge | **~98%** | Aggregates are identical for every citizen in a region. One district's mood page is one cache entry serving millions. 30–60s TTL + `stale-while-revalidate` keeps it fresh enough for a mood dial and turns 520k req/s into ~10k req/s at origin. |
| Redis counters | ~1.8% | Cache fills and personalised views ("your districts"). Sub-ms, sharded 16 ways. |
| ClickHouse | ~0.2% | Historical series and ad-hoc cross-product slices. |
| Postgres | ~0% of *aggregate* reads | Only ever point lookups for a citizen's own rows. |

The 98% edge hit rate is load-bearing, and it is achievable only because aggregate URLs are
deliberately low-cardinality: `/v1/topics/{id}/mood?region={id}&dim={dim}`. Personalisation
is layered on the client from a separate, small, private call — so the expensive thing stays
public and cacheable.

## 3. Write-path capacity

At the 170k/s spike, per write the API does:

1. a read-through profile lookup (region path + bands, ~40 B, cached) — sub-ms on a hit
2. one Redis pipeline (quota + idempotency) — ~0.3 ms
3. one event-log append (batched, acks=all, 3 replicas) — ~2 ms p99
4. no Postgres write at all, and no counter mutation (the worker does both, asynchronously)

Budget **2.0 ms CPU per write**, which is the figure `infra/loadtest` measures rather than the one
the design hoped for. One core sustains ~500 writes/s; 170k/s needs **~350 cores**, ≈ 88 pods at 4
cores. At average load that is a single pod.

That number is deliberately pessimistic. The measurement co-locates every dependency on one machine,
so production should do better — but provisioning against an optimistic figure is the error that
drops citizens' submissions during a budget speech, while provisioning against a pessimistic one
only costs money. `pnpm loadtest` re-measures it and fails loudly if the model and reality diverge.

HPA on in-flight requests plus a 15-minute pre-warm ahead of scheduled national events (budget,
results, verdicts) covers the spike; the event log absorbs the rest as queue depth, which is exactly
what a log is for.

**Event log sizing.** 250k msg/s × 400 B = 100 MB/s ingress, ×3 replication = 300 MB/s.
Across 256 partitions that is under 1.2 MB/s/partition — comfortable. Retention 7 days hot
= 60 TB, then Parquet in object storage.

## 4. Storage model

| Store | Rows | Size | Notes |
| --- | --- | --- | --- |
| `citizen` | 1.4B | ~280 GB | 1024 vshards → **~275 MB/vshard**; 64 physical clusters → 4.4 GB each |
| `sentiment_current` | 1.4B × 20 active topics = 28B | ~1.8 TB | 1024 vshards → 1.8 GB/vshard. Rows for topics inactive >18 months are tiered out |
| `sentiment_event` (ClickHouse) | 150M/day | 18 GB/day raw → **~3 GB/day compressed** (6×) | ~1.1 TB/year; 90 days hot, then Parquet |
| `mood_rollup` (ClickHouse) | ~1.5M/day | ~120 MB/day | 50k active (topic, region) pairs × 30 buckets |
| Catalogue | ~10M | ~8 GB | Fits in RAM on every replica |
| RTI documents | ~50M docs | ~25 TB | Object storage, CDN-fronted, deduped by content hash |

Nothing here is large by modern standards. That is the point of the sharding rule: the
1.4B-row tables are only ever touched one row at a time.

## 5. Rollup cardinality — the real risk, and the bound

Naively, aggregates explode. The bound is explicit and enforced in code
(`packages/core/src/rollup.ts`):

- **Region fan-out is 4, not 800k.** An event rolls up only along its own ancestor chain:
  country → state → district → constituency. Not to every region.
- **Demographic dimensions are marginal, not crossed.** 6 dimensions (age band 6, gender 3,
  urbanity 2, income band 5, education 5, occupation 8) = 29 values + 1 total = **30 buckets**,
  handled as 7 independent increments (6 dims + total). Crossing them would be 7,200 buckets.

So per event: `4 regions × 7 = 28 counter increments`.

- 150M events/day × 28 = **4.2B counter touches/day = 49k/s average**, **4.9M/s at the spike**.
- A bucket is a 6-field Redis hash — a 5-slot mood histogram plus summed intensity — so one touch
  is **two `HINCRBY`s**: 9.8M commands/s at the spike. `n` and the mean mood are *derived* from the
  histogram rather than stored, which halves the command count and removes any way for `n` and the
  histogram to drift apart.
- At ~1M pipelined ops/s per shard, **64 shards runs at ~15% utilisation** at the spike
  (152k commands/s/shard) and is negligible at average load. Sizing assumes no batching, so the
  worker's windowed merge below is headroom rather than a dependency.
- Persisted daily: ~50k active (topic, region) pairs × 30 buckets ≈ **1.5M rows/day** in
  ClickHouse. Trivially small.

The worker merges mutations in memory over a short window before flushing. Because the event log
is partitioned by `topic_id`, every event for a topic reaches one consumer, so a spike — which is
by definition concentrated on a handful of topics — collapses substantially before it reaches
Redis. We do not *size* for that, because its effectiveness depends on how geographically spread
the spike is, and a national announcement is spread across ~4,900 rollup regions.

Cross-product questions are still answerable — on demand, from ClickHouse, behind the
k-anonymity gate and a rate limit. They are just not pre-computed.

## 6. Sharding and rebalancing

- **1024 logical vshards**, `vshard = hash(citizen_id) % 1024`, mapped to physical clusters by
  a lookup table (`packages/db/src/shard.ts`). 1024 is chosen to stay divisible while the
  fleet grows from 4 to 128 clusters.
- **Why citizen, not region?** Regions are catastrophically unequal — Uttar Pradesh alone is
  ~240M people and would be a permanent hotspot no rebalance could fix. Hashing the citizen id
  gives uniform shards by construction. Region-shaped questions are answered by rollups, so
  locality is not needed.
- **Rebalancing** moves whole vshards: mark read-only → logical-replicate → cut over → release.
  One vshard is ~2 GB, so a move is minutes and the blast radius is 0.1% of citizens.
- **UUIDv7 keys** keep index inserts append-mostly, avoiding random-write amplification.

## 7. Failure modes

| Failure | Behaviour | Recovery |
| --- | --- | --- |
| A Postgres vshard is down | 0.1% of citizens cannot read/write *their own* data. Aggregates unaffected | Promote replica (~30 s) |
| Redis shard lost | Counters for that key range cold; API serves from ClickHouse, degraded latency, still correct | Rebuild from ClickHouse |
| Worker consumer group stalls | Writes still accepted and durable; aggregates go stale; staleness is surfaced in the API response, not hidden | Lag alarm, scale consumers, replay |
| Event log unavailable | Writes rejected with `503` + `Retry-After`; **clients queue locally and replay with the same idempotency key** | Quorum restore |
| Region-wide outage | Reads served from another region's replicas; writes fail over with the log as the replication unit | DNS/anycast shift |
| ClickHouse down | Historical series and ad-hoc slices unavailable; live mood (Redis) unaffected | Replica promotion |

Degradation is always: **reads before writes, aggregates before precision, and never silent
wrongness** — a stale aggregate is labelled stale.

## 8. Latency budget (p99, in-country)

| Operation | Budget |
| --- | --- |
| Static asset (edge hit) | 25 ms |
| Aggregate read (edge hit) | 40 ms |
| Aggregate read (origin, Redis) | 120 ms |
| Sentiment write (ack) | 250 ms |
| Ad-hoc ClickHouse slice | 2.5 s |
| Rollup visibility lag | 5 s p50, 30 s p99 |

## 9. Cost shape

The dominant costs at this scale, in order: CDN egress, ClickHouse storage, Postgres IOPS.
The dominant *levers*, in order:

1. **Edge hit rate.** Going from 98% → 99% halves origin fleet. Hence low-cardinality URLs.
2. **Compression + tiering.** 90-day hot window, Parquet after; ~6× on the event log.
3. **Marginals over cross-products.** A 240× reduction in rollup rows written (7,200 crossed vs.
   30 marginal, per topic·region·day·tier) — and ~1.5M rows/day instead of ~1.4B.
4. **Read replicas over bigger primaries.** The catalogue is read-mostly and cacheable.

## 10. What we deliberately do *not* do

- **No pre-computed demographic cross-products.** Billions of rows for questions almost nobody
  asks; available on demand instead.
- **No strong consistency between writes and public aggregates.** A mood dial does not need
  linearizability; the citizen's *own* opinion is read-your-write, which is what they notice.
- **No per-citizen fan-out on write.** Followers pull from rollups; there is no timeline
  materialisation to explode.
- **No unbounded free-text on the hot path.** Reasons are bounded, optional, and moderated
  asynchronously, so ingest stays a fixed-size append.
