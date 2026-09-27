# 0010 — Local questions for local people: cities, wards, and a location that is never kept

**Status:** Accepted

## Context
"Issues of Hyderabad need to be addressed by Hyderabad people." That needs three things the
platform did not have: regions for cities (Greater Hyderabad spans parts of four districts and is
who answers for its wards), a way to know where someone lives that is better than a drop-down, and a
rule that uses both.

## Decision
- **`city` is a region kind at district depth.** Its wards take the fourth level. Levels are
  positions, not kinds: `ROLLUP_FANOUT` stays 4, and the ClickHouse columns named for districts and
  constituencies hold cities and city wards (a GHMC ward is ~50,000 people, well above the k-gate).
- **Real ward boundaries.** GHMC's wards come from OpenStreetMap (ODbL, attributed wherever shown),
  simplified to ~11 m, and looked up in-process through a uniform grid (~1.4 µs per lookup): no
  database on the request path.
- **The coordinate is used once and never kept.** The client rounds it to 3 decimals (~110 m), the
  server rounds it again, it travels in a POST body (never a URL), `lat`/`lng` are on the logger's
  redaction list, and only the ward it resolved to is returned — as a *question* ("is this where you
  live?"), because a fix taken at work is not a home.
- **A short-lived attestation** (HMAC, 10 minutes, domain-separated from access tokens) lets the
  person confirm that ward as home, marking it `device`-confirmed. Their comments show "📍 located".
  Moving home without a fresh attestation resets it to `declared`.
- **Locals only.** Posting, replying and voting on a topic require the topic's jurisdiction to be on
  the citizen's region path. Reading is open to everyone.
- **Documents are scoped by what they name** (ADR-0012), so a Telangana GO about drains in Greater
  Hyderabad becomes a Greater Hyderabad topic.

## What we gave up
- **Two hierarchies cannot both be the tree.** Inside GHMC the civic hierarchy (city → ward) is
  modelled; the electoral one (district → assembly constituency) is not.
- **The boundaries are a 2018 OSM snapshot: 145 of 150 wards,** one ward number claimed twice. A
  point in a missing ward resolves to nothing, and the person picks from the list. Reconcile with the
  corporation's current map before relying on it.
- **Only Greater Hyderabad has boundaries.** Everywhere else, location lookup says "not mapped yet".
- **GPS can be spoofed.** "Located" is a signal, not proof; the attested-address tier is proof.
- **Rounding to 110 m** can resolve a point near a ward boundary to the neighbouring ward. The
  person confirms or corrects it; the privacy gain is worth it.
