# 0004 — Erasure by crypto-shredding, not row deletion

**Status:** Accepted

## Context
The DPDP Act 2023 gives citizens a right to erasure on consent withdrawal. The data lives in
1024 Postgres vshards with replicas, in point-in-time backups, in a 7-day event log, in
ClickHouse, and in Parquet cold storage. Chasing a row through all of that inside a statutory
window is not reliably achievable, and claiming otherwise would be a lie told to a regulator.

## Decision
Encrypt each citizen's sensitive columns under a per-citizen DEK wrapped by KMS. Erasure
**destroys the DEK**. Ciphertext everywhere — including in backups and copies we cannot reach —
becomes unrecoverable simultaneously. The row is tombstoned so shard integrity and aggregate
counts stay consistent.

## Consequences
- Erasure is a single, verifiable, auditable operation with immediate global effect.
- Backups need no rewriting; a restored backup yields ciphertext without a key.
- Per-citizen DEK access is itself an audit signal for insider access.

## What we gave up
A key-management dependency on the hot read path (mitigated by short-lived DEK caching), and
~40 bytes of per-row overhead. Also: **aggregates are not reversed** — they contain no personal
data, being counts of ≥25 people, and rewriting history would corrupt the public record. That
limit is stated in the consent flow, not buried in a policy.
