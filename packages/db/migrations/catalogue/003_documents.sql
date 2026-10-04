-- Public documents, jobs and indicators; new topic kinds.
SET search_path TO civic_catalogue;

ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_kind_check;
ALTER TABLE topic ADD CONSTRAINT topic_kind_check CHECK (kind IN (
  'policy', 'decision', 'scheme', 'law', 'budget_line', 'project',
  'government_order', 'news', 'local_issue'));

-- Newest-first listings of what applies to a region.
CREATE INDEX IF NOT EXISTS topic_created_idx ON topic (created_at DESC);

-- Every monetary figure carries provenance; `sample` marks development seed data so that it can never
-- be mistaken for an official statistic.
ALTER TABLE budget_line ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'official'
  CHECK (provenance IN ('official', 'news', 'sample'));

-- An ingested public document: a GO, a gazette notification, a press release, a job notification, a
-- news item (linked, never copied). Global and read-mostly, like the rest of the catalogue.
CREATE TABLE IF NOT EXISTS document (
  id                      bigserial PRIMARY KEY,
  -- Jurisdiction + canonical URL, or + GO number when there is one: the same order at two URLs is one
  -- document, and the same number in two states is two.
  content_hash            text      NOT NULL UNIQUE,
  source_id               text      NOT NULL,
  source_name             text      NOT NULL,
  kind                    text      NOT NULL CHECK (kind IN (
                            'government_order', 'gazette_notification', 'press_release', 'project',
                            'scheme', 'tender', 'job_notification', 'news')),
  subject                 text      CHECK (subject IN ('project', 'scheme')),
  title                   text      NOT NULL,
  url                     text      NOT NULL,
  published_on            date,
  -- For news this short extract is all that is kept.
  snippet                 text,
  go_number               text,
  go_type                 text      CHECK (go_type IN ('Ms', 'Rt', 'P')),
  gazette_number          text,
  department              text,
  amount_rupees           numeric(20, 2),
  vacancies               integer   CHECK (vacancies > 0),
  closing_on              date,
  jurisdiction_region_id  bigint    NOT NULL REFERENCES region (id),
  primary_region_id       bigint    REFERENCES region (id),
  primary_region_path     bigint[]  NOT NULL DEFAULT '{}',
  geo_confidence          real      NOT NULL DEFAULT 0,
  -- Every region the document names, for "what concerns my ward" beyond its primary scope.
  geo_region_ids          bigint[]  NOT NULL DEFAULT '{}',
  discussable             boolean   NOT NULL DEFAULT false,
  provenance              text      NOT NULL CHECK (provenance IN ('official', 'news', 'sample')),
  needs_ocr               boolean   NOT NULL DEFAULT false,
  -- Set when the document was put up for discussion.
  topic_id                bigint    REFERENCES topic (id),
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_primary_region_idx ON document (primary_region_id, published_on DESC);
CREATE INDEX IF NOT EXISTS document_geo_gin            ON document USING gin (geo_region_ids);
CREATE INDEX IF NOT EXISTS document_kind_idx           ON document (kind, published_on DESC);
CREATE INDEX IF NOT EXISTS document_open_jobs_idx      ON document (closing_on)
  WHERE kind = 'job_notification';

-- Is each source still yielding what it used to? A source that suddenly parses to nothing is
-- reported as a probable redesign, not treated as a quiet day.
CREATE TABLE IF NOT EXISTS source_health (
  source_id                text        PRIMARY KEY,
  fetched_at               timestamptz NOT NULL,
  outcome                  text        NOT NULL,
  items                    integer     NOT NULL,
  suspected_layout_change  boolean     NOT NULL,
  message                  text
);

-- Socio-economic indicators: public finances, prices, jobs, farming. One row per published figure.
CREATE TABLE IF NOT EXISTS indicator (
  code         text      PRIMARY KEY,
  name         text      NOT NULL,
  category     text      NOT NULL CHECK (category IN ('public_finance', 'economy', 'jobs', 'agriculture')),
  unit         text      NOT NULL,
  source_name  text      NOT NULL,
  source_url   text      NOT NULL,
  note         text
);

CREATE TABLE IF NOT EXISTS indicator_observation (
  code        text      NOT NULL REFERENCES indicator (code),
  region_id   bigint    NOT NULL REFERENCES region (id),
  period      text      NOT NULL,
  -- Sortable form of `period` ("2025-26" → 2025-04-01), so "latest" is an index scan.
  period_start date     NOT NULL,
  value       numeric(20, 4) NOT NULL,
  provenance  text      NOT NULL CHECK (provenance IN ('official', 'news', 'sample')),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, region_id, period)
);

CREATE INDEX IF NOT EXISTS indicator_observation_latest_idx
  ON indicator_observation (region_id, code, period_start DESC);
