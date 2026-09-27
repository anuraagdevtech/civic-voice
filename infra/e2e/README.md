# End-to-end verification

`run.mjs` drives a running API and worker through every product path and asserts 48 properties. It
is deliberately separate from `pnpm test`: the test suite proves each piece is correct in isolation
and runs in seconds with no daemon, while this proves the pieces are correct *together* and needs
the whole stack.

```bash
pnpm infra:up
pnpm migrate && pnpm seed
node packages/analytics/src/cli/migrate.ts

CIVIC_SENTIMENT_PARTITIONS=8 CIVIC_TOPIC_COOLDOWN_SECONDS=3 pnpm dev:api &
CIVIC_SENTIMENT_PARTITIONS=8 pnpm dev:worker &

BASE=http://localhost:8080 COOLDOWN_SECONDS=3 pnpm e2e
```

## What it proves that unit tests cannot

- A submission survives HTTP → quota → event log → worker → Postgres → ClickHouse → Redis and
  reappears in the published aggregate at **all four** region levels.
- **A changed opinion does not inflate the cohort.** The compensating delta is resolved by the
  worker from the citizen's own shard, so this is only observable with the real pipeline running.
- A suppressed bucket cannot be recovered by subtracting the published ones from the total.
- An idempotency-key replay returns the stored response and publishes nothing new.
- An erased account loses its opinions and cannot write, while published aggregates — which hold no
  personal data — stay intact.

It requires a freshly seeded database: several assertions concern cohort sizes relative to k = 25,
so leftover citizens from a previous run change what *should* be suppressed.
