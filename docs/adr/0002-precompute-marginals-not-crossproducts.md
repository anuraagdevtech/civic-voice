# 0002 — Pre-compute demographic marginals, not cross-products

**Status:** Accepted

## Context
Six demographic dimensions (age 6, gender 3, urbanity 2, income 5, education 5, occupation 8).
Fully crossed, that is 6×3×2×5×5×8 = **7,200 combinations** per (topic, region, day, tier) —
and with four region levels and 200k active topics it is billions of rows a day to maintain.

## Decision
Maintain **marginals**: each dimension independently, plus a total. 6 dimensions + 1 total = 7
increments per region level; 4 region levels = **28 counter increments per event**.

Serve cross-product slices on demand from ClickHouse, through the k-anonymity gate, rate-limited
per API key and cached by normalised query hash.

## Consequences
- ~4.2B increments/day (48k/s average), well inside a 16-shard Redis cluster.
- 30 rollup rows per (topic, region, day, tier) instead of 7,200 — a **240× reduction**, and ~1.5M
  persisted rows/day instead of ~1.4B.
- The questions users actually ask ("how do young voters feel vs older ones?") are O(1).

## What we gave up
"Muslim women aged 25–34 in rural Bihar" is a 2.5s query instead of a 40ms one, and is rate-
limited. Given that such slices are also the highest re-identification risk, making them slow,
gated and audited is a feature as much as a cost.
