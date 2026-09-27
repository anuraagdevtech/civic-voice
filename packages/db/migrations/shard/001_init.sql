-- Sharded citizen store. This file is applied to EVERY shard cluster; each holds a disjoint set of
-- vshards (ADR-0001). Nothing here is ever queried without a citizen_id, so nothing here needs a
-- cross-shard index.

CREATE SCHEMA IF NOT EXISTS civic_shard;
SET search_path TO civic_shard;

-- Which vshards this cluster owns. Read at startup to validate the shard map against reality: a map
-- that disagrees with the database is how writes end up on the wrong shard and quietly disappear.
CREATE TABLE IF NOT EXISTS shard_ownership (
  vshard      integer PRIMARY KEY CHECK (vshard >= 0 AND vshard < 1024),
  cluster_id  text        NOT NULL,
  state       text        NOT NULL DEFAULT 'active'
                CHECK (state IN ('active', 'read_only', 'migrating')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Pseudonymous citizen. Deliberately holds NO PII: no name, no phone, no government ID
-- (docs/PRIVACY.md §1). Demographics are coarse bands, stored as smallint ordinals of the
-- vocabularies in @civic-voice/contracts.
CREATE TABLE IF NOT EXISTS citizen (
  id                 uuid        PRIMARY KEY,
  vshard             integer     NOT NULL CHECK (vshard >= 0 AND vshard < 1024),
  region_id          bigint      NOT NULL,
  -- Denormalised ancestor path. Copied onto every event, which is what lets analytical queries be
  -- single-table scans with no path back to identity (docs/DATA_MODEL.md §3).
  region_path        bigint[]    NOT NULL,
  verification_tier  smallint    NOT NULL DEFAULT 0 CHECK (verification_tier BETWEEN 0 AND 3),
  locale             text        NOT NULL DEFAULT 'en',

  age_band           smallint    CHECK (age_band        BETWEEN 0 AND 5),
  gender             smallint    CHECK (gender          BETWEEN 0 AND 2),
  urbanity           smallint    CHECK (urbanity        BETWEEN 0 AND 1),
  income_band        smallint    CHECK (income_band     BETWEEN 0 AND 4),
  education_band     smallint    CHECK (education_band  BETWEEN 0 AND 4),
  occupation_band    smallint    CHECK (occupation_band BETWEEN 0 AND 7),

  -- Per-citizen data-encryption key, wrapped by KMS. Erasure destroys this key, which renders
  -- ciphertext unrecoverable everywhere at once, including in backups we cannot reach (ADR-0004).
  dek_wrapped        bytea,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Tombstone. The row survives so shard accounting and aggregate counts stay consistent; the
  -- contents are crypto-shredded.
  erased_at          timestamptz
);

CREATE INDEX IF NOT EXISTS citizen_vshard_idx ON citizen (vshard);

-- A citizen's standing opinion: one row per (citizen, topic).
--
-- This table exists for two reasons. A citizen must be able to see and change their own opinions,
-- and the aggregator must be able to compute a COMPENSATING delta when an opinion changes (−1 on the
-- old bucket, +1 on the new). Without it, changing your mind would inflate both buckets and
-- aggregates would drift upward forever (docs/ARCHITECTURE.md §6).
CREATE TABLE IF NOT EXISTS sentiment_current (
  citizen_id    uuid        NOT NULL,
  topic_id      bigint      NOT NULL,
  mood          smallint    NOT NULL CHECK (mood BETWEEN -2 AND 2),
  intensity     smallint    NOT NULL CHECK (intensity BETWEEN 1 AND 5),
  reason_code   smallint    NOT NULL,
  -- The last event applied. Makes the upsert idempotent under at-least-once redelivery.
  event_id      uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (citizen_id, topic_id)
);

-- "My opinions", newest first. Covered by the primary key's leading column, so it is a single-shard
-- index scan.
CREATE INDEX IF NOT EXISTS sentiment_current_citizen_updated_idx
  ON sentiment_current (citizen_id, updated_at DESC);

-- A citizen's RTI filings and their statutory clock (docs/RTI.md). Sharded with the citizen so
-- "my RTIs" is single-shard; the PUBLIC view of a disclosed response is a separate catalogue row, so
-- publishing never leaks which shard — or which citizen — a filing came from.
CREATE TABLE IF NOT EXISTS rti_request (
  id               uuid        PRIMARY KEY,
  citizen_id       uuid        NOT NULL,
  authority_id     bigint      NOT NULL,
  topic_id         bigint,
  subject          text        NOT NULL,
  track            text        NOT NULL DEFAULT 'standard'
                     CHECK (track IN ('standard', 'life_liberty', 'transferred', 'third_party')),
  state            text        NOT NULL DEFAULT 'draft',
  filed_at         date,
  acknowledged_at  date,
  responded_at     date,
  first_appeal_at  date,
  fa_responded_at  date,
  fa_extended      boolean     NOT NULL DEFAULT false,
  second_appeal_at date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rti_request_citizen_idx ON rti_request (citizen_id, created_at DESC);

-- Partial index for the deadline sweeper. Only requests whose clock is still running are ever
-- scanned, which is what keeps the sweep bounded rather than a full scan of 50M rows
-- (docs/RTI.md §3).
CREATE INDEX IF NOT EXISTS rti_request_open_deadline_idx
  ON rti_request (filed_at)
  WHERE state IN ('filed', 'acknowledged', 'first_appeal') AND filed_at IS NOT NULL;

-- Follows are pull-based: there is no fan-out-on-write and no materialised timeline, which is what
-- keeps a 1.4B-user follow graph from being a scaling problem at all.
CREATE TABLE IF NOT EXISTS follow (
  citizen_id   uuid        NOT NULL,
  subject_type text        NOT NULL CHECK (subject_type IN ('topic', 'region', 'authority', 'scheme')),
  subject_id   bigint      NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (citizen_id, subject_type, subject_id)
);

-- Audit of DEK access. An insider reading citizens' opinions has to touch keys, and that leaves a
-- trail here (docs/PRIVACY.md §7).
CREATE TABLE IF NOT EXISTS dek_access_log (
  id          bigserial   PRIMARY KEY,
  citizen_id  uuid        NOT NULL,
  actor       text        NOT NULL,
  purpose     text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
