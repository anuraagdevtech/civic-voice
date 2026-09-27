#!/usr/bin/env bash
# Prepares a fresh checkout so tests and typecheck can run immediately.
#
# Deliberately does NOT start Postgres, Redis, Kafka or ClickHouse. The unit and in-memory
# conformance suites run with no daemon at all (ADR-0006), which is the whole point of the in-memory
# adapters — `pnpm test` works within seconds of a clone. The integration suites skip themselves
# cleanly when nothing is reachable; run `pnpm infra:up && pnpm migrate && pnpm seed` for those.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 0

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null 2>&1
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "civic-voice: installing dependencies…"
  pnpm install --frozen-lockfile 2>&1 | tail -3
fi

cat <<'MSG'
civic-voice is ready.

  pnpm test          unit + in-memory conformance suites (no daemon needed)
  pnpm typecheck     whole workspace
  pnpm infra:up      Postgres, Redis, Redpanda and ClickHouse via docker compose
  pnpm migrate       schema for the shards and the catalogue
  pnpm seed          Indian administrative geography, schemes and budget lines
  pnpm dev:api       the API   (add CIVIC_MEMORY_ADAPTERS=1 to run with no infrastructure)
  pnpm dev:worker    the aggregation pipeline
  pnpm dev:web       the web app
  pnpm loadtest      measures the per-write cost the capacity model depends on

Start with docs/ARCHITECTURE.md; docs/adr/ says what each decision cost.
MSG
