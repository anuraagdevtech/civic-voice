# 0012 — Scrape politely, extract precisely, and scope a document no narrower than its evidence

**Status:** Accepted

## Context
New GOs, projects, gazette notifications and job notifications appear on dozens of central and
state portals, mostly as HTML listings and PDFs, with no common feed. Getting them in front of the
right residents needs scraping, extraction and geo-tagging — and each can go wrong in a way that
matters: hammering a small state portal, attributing a Telangana order to Andhra Pradesh, or
putting a Gujarat press release in a Hyderabad ward's feed.

## Decision
- **Politeness is enforced in the fetcher, not left to callers:** robots.txt (RFC 9309, cached, a
  5xx robots means "disallow all"), one request per host at a time with a minimum interval and
  `Crawl-delay`, conditional GETs, `Retry-After`, a per-host circuit breaker, an identifying
  user agent, and one ingestor replica so politeness is not multiplied.
- **Sources are data, not code.** Each is a registry entry with selectors; a layout change is a
  one-line fix, and a source that suddenly yields nothing is reported as a probable redesign.
- **The instrument decides the kind** (a numbered GO is a GO, an `S.O.` is a gazette notification,
  a news item is news); what it is *about* (a project, a scheme) is a separate field.
- **Extraction targets what citizens ask:** GO numbers and their type (a routine transfer order is
  indexed but not put up for discussion), amounts in lakh and crore, vacancies and closing dates.
- **Geo-tagging favours precision over recall.** A name several regions share is dropped unless the
  issuing jurisdiction settles it; a ward name counts only in a document already about its city;
  a bare ward name that is also a zone name scopes to the city, and only "Ward 91 Khairatabad"
  scopes to the ward; states carry their cities as aliases, so a road "between Hyderabad and
  Vijayawada" is scoped to India. The primary scope is the lowest common ancestor of the places the
  title names.
- **News is linked, not republished:** headline, link and a 280-character snippet.
- **Fixtures produce `sample` documents,** badged everywhere, so a synthetic GO is never shown as an
  official one.

## What we gave up
- **None of the selectors has been verified against the live sites.** The build environment could
  not reach them. `pnpm ingest:check --live` verifies them, and `--save-fixtures` replaces the
  synthetic pages with real captures; every registry entry says `verified: null` until then.
- **Recall.** A document not in a listing or feed is not found; a scanned PDF is flagged for OCR,
  which is not implemented.
- **The gazetteer covers only what the region tree holds.** Places outside it are invisible, which
  under-scopes some documents to their issuing state.
