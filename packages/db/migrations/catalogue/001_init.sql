-- Catalogue: global, read-mostly, ~10M rows. Fits in RAM, replicated to every region, cached hard at
-- the edge. Not sharded, because it is small and almost never written (docs/DATA_MODEL.md §2).

CREATE SCHEMA IF NOT EXISTS civic_catalogue;
SET search_path TO civic_catalogue;

-- India's administrative hierarchy: country → state/UT → district → constituency → ward/panchayat.
-- ~800k rows.
CREATE TABLE IF NOT EXISTS region (
  id          bigserial PRIMARY KEY,
  parent_id   bigint    REFERENCES region (id),
  kind        text      NOT NULL
                CHECK (kind IN ('country', 'state', 'district', 'constituency', 'ward')),
  -- Materialised ancestor path, root first, INCLUSIVE of self. Both queries that matter become O(1)
  -- instead of recursive: "give me this region's 4 rollup ancestors" (asked on every single write)
  -- and "is region A inside region B" (asked on every authorisation and filter).
  path        bigint[]  NOT NULL,
  name        text      NOT NULL,
  -- Per-locale names for the 22 scheduled languages.
  names       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  -- LGD / Census / ECI codes, so external datasets can be joined without a fuzzy name match.
  codes       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  population  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS region_parent_idx ON region (parent_id);
CREATE INDEX IF NOT EXISTS region_kind_idx   ON region (kind);
-- GIN on the path array answers "every region under X" as an index scan.
CREATE INDEX IF NOT EXISTS region_path_gin   ON region USING gin (path);

CREATE TABLE IF NOT EXISTS authority (
  id           bigserial PRIMARY KEY,
  kind         text      NOT NULL CHECK (kind IN (
                 'union_ministry', 'state_department', 'psu', 'municipal_body',
                 'panchayat', 'regulator', 'court_registry', 'other')),
  name         text      NOT NULL,
  region_id    bigint    NOT NULL REFERENCES region (id),
  -- The Public Information Officer, and the First Appellate Authority. Carrying the FAA is what
  -- makes the appeal ladder actionable rather than merely informational (docs/RTI.md §3).
  pio_contact  text,
  faa_contact  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authority_region_idx ON authority (region_id);

CREATE TABLE IF NOT EXISTS scheme (
  id          bigserial PRIMARY KEY,
  name        text      NOT NULL,
  ministry    text,
  sector      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A government decision, policy, scheme, law or budget line: the thing a citizen has a mood about.
CREATE TABLE IF NOT EXISTS topic (
  id                     bigserial PRIMARY KEY,
  kind                   text      NOT NULL CHECK (kind IN (
                           'policy', 'decision', 'scheme', 'law', 'budget_line', 'project')),
  status                 text      NOT NULL DEFAULT 'active'
                           CHECK (status IN ('proposed', 'active', 'amended', 'lapsed', 'withdrawn')),
  -- Anchors the topic. Bounds its rollup fan-out, and makes "policies that apply to me" a path
  -- prefix query rather than a scan.
  jurisdiction_region_id bigint    NOT NULL REFERENCES region (id),
  authority_id           bigint    REFERENCES authority (id),
  scheme_id              bigint    REFERENCES scheme (id),
  title                  text      NOT NULL,
  titles                 jsonb     NOT NULL DEFAULT '{}'::jsonb,
  summary                text,
  effective_from         date,
  source_refs            jsonb     NOT NULL DEFAULT '[]'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topic_jurisdiction_idx ON topic (jurisdiction_region_id, status);
CREATE INDEX IF NOT EXISTS topic_scheme_idx       ON topic (scheme_id);
CREATE INDEX IF NOT EXISTS topic_authority_idx    ON topic (authority_id);

-- The tax-utilisation spine, modelled the way the money actually moves: budget estimate → revised
-- estimate → released → utilised.
CREATE TABLE IF NOT EXISTS budget_line (
  id            bigserial PRIMARY KEY,
  fy            text      NOT NULL CHECK (fy ~ '^\d{4}-\d{2}$'),
  scheme_id     bigint    NOT NULL REFERENCES scheme (id),
  region_id     bigint    NOT NULL REFERENCES region (id),
  level         text      NOT NULL CHECK (level IN ('union', 'state', 'district', 'local')),
  allocated_be  numeric(18, 2),
  revised_re    numeric(18, 2),
  released      numeric(18, 2),
  utilised      numeric(18, 2),
  -- Every monetary figure carries provenance. No number appears in this system without a source.
  source_refs   jsonb     NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fy, scheme_id, region_id)
);

CREATE INDEX IF NOT EXISTS budget_line_region_fy_idx ON budget_line (region_id, fy);

-- Dated events against a budget line, so a series can be drawn and revisions stay VISIBLE rather
-- than overwriting the figure they replace.
CREATE TABLE IF NOT EXISTS utilisation (
  id             bigserial PRIMARY KEY,
  budget_line_id bigint    NOT NULL REFERENCES budget_line (id),
  as_of          date      NOT NULL,
  released       numeric(18, 2),
  utilised       numeric(18, 2),
  source_ref     text      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_line_id, as_of)
);

-- A published RTI response. Content-addressed, so the same document filed by many citizens is one
-- object. Crucially it links to the AUTHORITY and TOPIC — never to the rti_request or the citizen.
-- §8(1)(j) cuts both ways (docs/RTI.md §5).
CREATE TABLE IF NOT EXISTS disclosure (
  id                bigserial PRIMARY KEY,
  sha256            text      NOT NULL UNIQUE,
  authority_id      bigint    NOT NULL REFERENCES authority (id),
  topic_id          bigint    REFERENCES topic (id),
  object_key        text      NOT NULL,
  title             text      NOT NULL,
  extracted_text    text,
  received_on       date,
  verifications     integer   NOT NULL DEFAULT 0,
  disputes          integer   NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS disclosure_authority_idx ON disclosure (authority_id);
CREATE INDEX IF NOT EXISTS disclosure_topic_idx     ON disclosure (topic_id);
CREATE INDEX IF NOT EXISTS disclosure_text_idx
  ON disclosure USING gin (to_tsvector('english', coalesce(extracted_text, '')));

-- Aggregate windows the anomaly detectors have quarantined. Read by the k-anonymity gate, which
-- suppresses them with a disclosed reason rather than silently dropping them (docs/TRUST.md §4).
CREATE TABLE IF NOT EXISTS aggregate_quarantine (
  topic_id    bigint      NOT NULL,
  region_id   bigint      NOT NULL,
  dim         smallint    NOT NULL,
  bucket      text        NOT NULL,
  reason      text        NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, region_id, dim, bucket)
);
