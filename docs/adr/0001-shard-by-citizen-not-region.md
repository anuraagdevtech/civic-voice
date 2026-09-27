# 0001 — Shard OLTP by citizen, not region

**Status:** Accepted

## Context
The platform is inherently geographic: almost every *question* a user asks is region-shaped
("what does my district think?"). The obvious move is to shard by region so those queries stay
local.

India's regions are catastrophically unequal. Uttar Pradesh is ~240M people; Lakshadweep is
~64,000 — a ratio of about 3,750:1. Region sharding makes UP a permanent hotspot that no
rebalancing can fix, because the skew is in the data, not the distribution.

## Decision
Shard citizen-owned data by `hash(citizen_id) % 1024`. Answer every region-shaped question from
pre-computed rollups (ADR-0002) instead of from the OLTP store.

## Consequences
- Shards are uniform by construction; capacity planning is arithmetic, not forecasting.
- Every OLTP query is a single-shard point lookup. No scatter-gather exists in the codebase.
- Rebalancing moves ~2 GB vshards, so blast radius is 0.1% of citizens and cutover is minutes.

## What we gave up
Region-scoped OLTP queries are now impossible — "list every citizen in this district" cannot be
served, at any cost. We accept this: it is also a privacy property we want, and the aggregate
form of the question is the only one the product actually needs.
