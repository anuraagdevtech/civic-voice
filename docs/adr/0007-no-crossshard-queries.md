# 0007 — Forbid cross-shard queries in the router itself

**Status:** Accepted

## Context
ADR-0001's guarantee — every OLTP query is single-shard — is the load-bearing assumption of the
whole capacity model. Documented invariants of this kind decay: someone adds a reporting
endpoint under deadline, fans out across 1024 shards, and the system quietly acquires a query
whose cost grows with the fleet. It will pass code review, because it works fine with 4 shards
in dev.

## Decision
The shard router exposes no API capable of expressing a cross-shard query. There is no
`queryAll`, no shard iterator, no "for each shard" helper. `withCitizenShard(citizenId, fn)`
takes the routing key as a required argument and hands back exactly one connection.

Bulk work that legitimately spans shards (the RTI deadline sweeper, reconciliation) goes through
a separate, explicit `forEachShard` **maintenance** API that is not importable from request
handlers — enforced by a lint boundary, and named so that using it in a handler is obviously
wrong.

## Consequences
- The expensive mistake is unrepresentable in request-handling code rather than merely
  discouraged.
- The 1.5ms-per-write CPU budget stays true as the fleet grows from 4 clusters to 128.

## What we gave up
Some genuinely reasonable admin queries become more work to write. That friction is the point:
it forces the question "should this be a rollup?", and the answer is almost always yes.
