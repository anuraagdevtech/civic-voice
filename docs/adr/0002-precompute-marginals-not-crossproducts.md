# 0002 — Pre-compute demographic marginals, not cross-products

**Status:** Accepted

## Context
Seven demographic dimensions (age 6, gender 3, urbanity 2, income 5, education 5, occupation 8,
employment status 4). Fully crossed, that is 6×3×2×5×5×8×4 = **28,800 combinations** per
(topic, region, day, tier) —
and with four region levels and 200k active topics it is billions of rows a day to maintain.

## Decision
Maintain **marginals**: each dimension independently, plus a total. 7 dimensions + 1 total = 8
increments per region level; 4 region levels = **32 counter increments per event**.

Serve cross-product slices on demand from ClickHouse, through the k-anonymity gate, rate-limited
per API key and cached by normalised query hash.

## Consequences
- ~4.8B increments/day (56k/s average), well inside a 64-shard Redis cluster.
- 34 rollup rows per (topic, region, day, tier) instead of 28,800 — an **~850× reduction**, and
  ~1.7M persisted rows/day instead of ~5.8B.
- Adding a dimension is cheap here and ruinous crossed: employment status (4 values) added 4
  counters per event and 4 rows per slice, where it would have quadrupled the cross-product.
- The questions users actually ask ("how do young voters feel vs older ones?") are O(1).

## What we gave up
"Muslim women aged 25–34 in rural Bihar" is a 2.5s query instead of a 40ms one, and is rate-
limited. Given that such slices are also the highest re-identification risk, making them slow,
gated and audited is a feature as much as a cost.
