# Terraform

A **sketch**, not a deployable root module. It records the shape of the managed infrastructure and —
more usefully — the reasoning behind each size, so that whoever provisions this for real starts from
the argument rather than from a blank file.

Backend configuration, providers, VPC, IAM and the `modules/` implementations are deliberately absent.
Those belong to whoever owns the cloud account, and inventing them here would produce something that
looks runnable and is not.

## What the sizes come from

Every number traces back to `packages/core/src/capacity.ts`, which is executable and asserted by the
test suite, and to `infra/loadtest`, which measures the inputs the model cannot assume.

| Resource | Size | Why |
| --- | --- | --- |
| Postgres shards | 4 clusters × 256 vshards | 1024 divides evenly at every power-of-two fleet size, so growth never remaps a vshard that is not moving (ADR-0001) |
| Postgres catalogue | 1 primary + 3 replicas | Read-mostly, ~10M rows, read by every API pod — one replica per AZ so it is never a cross-AZ hop |
| Postgres identity | Its own cluster, own key | Blind indexes only; the API has no network route to it at all |
| Redis | 64 shards | 9.8M commands/s at the modelled spike ≈ 15% utilisation (docs/SCALING.md §5) |
| Kafka | 12 brokers, 256 partitions | ~70 MB/s ingress × 3 replication, under 1.2 MB/s per partition |
| ClickHouse | 4 shards × 2 replicas, 2 TB hot | 90 days at ~3 GB/day compressed, plus rollups and headroom |
| CDN | 30s TTL + 120s SWR | The 98% hit rate that turns 520k reads/s into ~10k at origin |

## The three keys, and why they are separate

- `identity` — the pepper for blind indexes. Rotation is a re-blinding migration, not an automatic
  operation, so key rotation is off.
- `pseudonym` — the root for per-topic salts. **Must not live in the same account or role as the
  analytics data**: the whole unlinkability property is that reading ClickHouse does not get you the
  salts (docs/PRIVACY.md §2).
- `citizen_dek` — wraps per-citizen data-encryption keys. Destroying one is how erasure works, which
  is why it is the only one with automatic rotation enabled (ADR-0004).
