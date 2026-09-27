# 0006 — TypeScript monorepo with in-memory adapters

**Status:** Accepted

## Context
The product is a web app plus a mobile app plus services. The most expensive recurring bug in
this shape of system is client/server contract drift. Separately, a test suite that needs
Docker, Kafka and ClickHouse to run is a test suite developers learn to skip.

## Decision
One pnpm workspace. `packages/contracts` holds Zod schemas that are the single source of both
runtime validation and static types, consumed by services, web and mobile alike. Every
infrastructure dependency (Postgres, Redis, event log, ClickHouse) is an interface with **two**
implementations: a real one and an in-memory one.

## Consequences
- A breaking API change fails `typecheck` in the web and mobile apps, at authoring time.
- `pnpm test` runs the full suite with no daemon, in seconds, using Node's built-in test runner
  and native TypeScript execution — no build step, no transpiler config to maintain.
- Integration tests opt *in* to real infrastructure via `docker compose`, and CI runs both.

## What we gave up
In-memory adapters can diverge from real backend semantics, so they are held to the same
interface tests and the real-backend suite runs in CI on every PR. TypeScript also costs raw
throughput versus Go or Rust on the ingest path; the write path is I/O-bound (one Redis
pipeline, one log append), so the 1.5ms CPU budget holds — and if a single service later needs
rewriting, the contract package makes it a drop-in.
