-- ClickHouse: the event history and the analytical store (docs/DATA_MODEL.md §3).

CREATE DATABASE IF NOT EXISTS civic;

-- Append-only system of record for opinion history.
--
-- Note what is NOT here: no citizen_id. The event carries a per-topic `pseudonym` instead, so a full
-- dump of this table cannot assemble an individual's political profile (docs/PRIVACY.md §2).
--
-- The region path and demographic bands are denormalised onto the row, which makes every analytical
-- query a single-table scan — no join against a 1.4B-row citizen table, and no query path from here
-- back to identity at all.
CREATE TABLE IF NOT EXISTS civic.sentiment_event
(
  event_id           UUID,
  occurred_at        DateTime64(3, 'UTC'),
  topic_id           UInt64,
  region_country     UInt64,
  region_state       UInt64,
  region_district    UInt64,
  region_constituency UInt64,
  pseudonym          FixedString(32),
  verification_tier  UInt8,
  age_band           Nullable(UInt8),
  gender             Nullable(UInt8),
  urbanity           Nullable(UInt8),
  income_band        Nullable(UInt8),
  education_band     Nullable(UInt8),
  occupation_band    Nullable(UInt8),
  mood               Int8,
  intensity          UInt8,
  reason_code        UInt8,
  -- +1 for a new or replacing opinion, -1 for the compensating retraction of a previous one.
  delta              Int8
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (topic_id, occurred_at, event_id)
-- 90 days hot, then the partition is moved to object storage as Parquet and stays queryable.
TTL toDateTime(occurred_at) + INTERVAL 90 DAY TO VOLUME 'cold'
SETTINGS index_granularity = 8192, storage_policy = 'tiered';

-- Pre-computed daily marginals: the table the read path's time series is built on (ADR-0002).
--
-- `n` is carried explicitly rather than derived, because the k-anonymity gate needs the cohort size
-- BEFORE it can decide whether the bucket may be published at all.
CREATE TABLE IF NOT EXISTS civic.mood_rollup
(
  day             Date,
  topic_id        UInt64,
  region_id       UInt64,
  -- 0 = total, 1..6 = the demographic dimension's fixed index.
  dim             UInt8,
  bucket          LowCardinality(String),
  tier            UInt8,
  n               Int64,
  sum_intensity   Int64,
  h_angry         Int64,
  h_concerned     Int64,
  h_neutral       Int64,
  h_hopeful       Int64,
  h_satisfied     Int64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (topic_id, region_id, day, dim, bucket, tier);

-- Distinct participants per (topic, region, day), without storing who. Backs the population-share
-- ceiling in the anomaly detectors (docs/TRUST.md §4).
CREATE TABLE IF NOT EXISTS civic.participation_daily
(
  day          Date,
  topic_id     UInt64,
  region_id    UInt64,
  participants AggregateFunction(uniq, FixedString(32))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (topic_id, region_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS civic.participation_daily_mv
TO civic.participation_daily AS
SELECT
  toDate(occurred_at) AS day,
  topic_id,
  region_district AS region_id,
  uniqState(pseudonym) AS participants
FROM civic.sentiment_event
WHERE delta = 1
GROUP BY day, topic_id, region_id;

-- RTI outcomes, for the authority compliance scorecard (docs/RTI.md §4). Deliberately holds no filer
-- identity: the platform publishes the authority's behaviour, never the citizen's.
CREATE TABLE IF NOT EXISTS civic.rti_outcome
(
  authority_id     UInt64,
  filed_on         Date,
  closed_on        Nullable(Date),
  track            LowCardinality(String),
  final_state      LowCardinality(String),
  response_days    Nullable(UInt16),
  deemed_refused   UInt8,
  first_appealed   UInt8,
  appeal_overturned UInt8,
  exemption_clause LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(filed_on)
ORDER BY (authority_id, filed_on);
