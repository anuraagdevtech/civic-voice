-- The analytics projection of forum comments (ADR-0008, docs/PRIVACY.md).
--
-- What is NOT here, deliberately: the comment body, the comment id, the pseudonym, the handle, and
-- any time finer than the hour. A row says "someone in these bands, in this region, wrote about
-- these needs in this tone, in this hour" — and cannot be joined back to the public comment it came
-- from, because every field that could do the join has been dropped or keyed-hashed.
--
-- ReplacingMergeTree on dedupe_key (a keyed hash of the comment id) absorbs redelivery; queries
-- count uniqExact(dedupe_key) so a not-yet-merged duplicate is still counted once.
CREATE TABLE IF NOT EXISTS civic.comment_event
(
  dedupe_key          FixedString(32),
  author_key          FixedString(32),
  hour                DateTime('UTC'),
  topic_id            UInt64,
  region_country      UInt64,
  region_state        UInt64,
  region_district     UInt64,
  region_constituency UInt64,
  verification_tier   UInt8,
  age_band            Nullable(UInt8),
  gender              Nullable(UInt8),
  urbanity            Nullable(UInt8),
  income_band         Nullable(UInt8),
  education_band      Nullable(UInt8),
  occupation_band     Nullable(UInt8),
  sentiment           Int8,
  needs               Array(LowCardinality(String)),
  suggestion          UInt8,
  language            LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (region_state, hour, topic_id, dedupe_key)
TTL hour + INTERVAL 90 DAY TO VOLUME 'cold'
SETTINGS index_granularity = 8192, storage_policy = 'tiered';
