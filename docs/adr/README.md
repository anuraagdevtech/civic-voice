# Architecture Decision Records

Each record states the decision, the forces behind it, and **what we gave up**. The last part
is the reason these exist: a decision without a stated cost is not a decision, it is a
preference, and the next person cannot tell whether it still holds.

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-shard-by-citizen-not-region.md) | Shard OLTP by citizen, not region | Accepted |
| [0002](./0002-precompute-marginals-not-crossproducts.md) | Pre-compute demographic marginals, not cross-products | Accepted |
| [0003](./0003-event-log-as-commit-point.md) | The event log is the write commit point | Accepted |
| [0004](./0004-crypto-shredding-for-erasure.md) | Erasure by crypto-shredding, not row deletion | Accepted |
| [0005](./0005-tiered-participation-not-gated.md) | Label participation by tier; never block it | Accepted |
| [0006](./0006-typescript-monorepo-with-in-memory-adapters.md) | TypeScript monorepo with in-memory adapters | Accepted |
| [0007](./0007-no-crossshard-queries.md) | Forbid cross-shard queries in the router itself | Accepted |
| [0008](./0008-comments-on-topic-shards.md) | Comments live on their topic's shard and go through the log | Accepted |
| [0009](./0009-moderation.md) | Refuse personal information synchronously; hold, never silently drop | Accepted |
| [0010](./0010-where-people-live.md) | Local questions for local people: cities, wards, a location never kept | Accepted |
| [0011](./0011-in-house-model-first.md) | An in-house model on every comment; a large model where it is unsure | Accepted |
| [0012](./0012-polite-precise-ingestion.md) | Scrape politely, extract precisely, scope no narrower than the evidence | Accepted |
| [0013](./0013-public-finances-and-opinion-against-allocation.md) | Show the gap as the budget does; gate every topic before combining opinion | Accepted |
