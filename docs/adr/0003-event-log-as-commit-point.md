# 0003 — The event log is the write commit point

**Status:** Accepted

## Context
Civic attention is extraordinarily peaky: budget day or a major verdict drives ~100× average
write load for ten minutes. Synchronously writing sentiment to a sharded Postgres cluster on
that spike means provisioning 100× the OLTP capacity for a few minutes a month, or dropping
citizens' input at exactly the moment it matters most.

## Decision
The API validates, quota-checks, appends to a replicated event log (acks=all, 3 replicas), and
returns. That append is the commit point. Postgres `sentiment_current` and the rollups are
updated asynchronously by the worker.

## Consequences
- Write path is O(1) with no OLTP dependency; spikes become queue depth, which is what a log is
  for.
- Aggregate staleness is bounded (p50 5s, p99 30s) and **surfaced in the API response** rather
  than hidden.
- The log is the audit trail: aggregates can be recomputed from scratch, which is what makes
  Redis disposable.

## What we gave up
No read-your-write on the *public* aggregate.

We compensate where citizens actually notice. The API cannot optimistically apply the delta to the
shared counters: it does not know whether this submission is a new opinion or a change of mind, and
that is precisely what decides whether a compensating `−1` is owed. Guessing would double-count
every changed opinion. Resolving it on the write path would mean an OLTP read, which is what this
ADR exists to avoid.

Instead the worker resolves `replaces` from `sentiment_current` on the citizen's own shard — a
single-shard point lookup, exactly what ADR-0001 is for — and applies the compensating pair. The
API separately records the citizen's submitted value in a short-lived per-citizen overlay key, and
`GET /v1/me/sentiment` reads through it. So a citizen sees *their own* opinion immediately, the
shared aggregate is never double-counted, and the public number carries its staleness
(`staleness_seconds`) rather than pretending to be fresh.
