-- Cities as a region kind, and stable region keys.
--
-- A municipal corporation is not a district: Greater Hyderabad spans parts of four districts, and it —
-- not any one of them — answers for its wards' drains and roads. It sits at district depth in the
-- tree so that its wards take the fourth rollup level (ADR-0010).
SET search_path TO civic_catalogue;

ALTER TABLE region DROP CONSTRAINT IF EXISTS region_kind_check;
ALTER TABLE region ADD CONSTRAINT region_kind_check
  CHECK (kind IN ('country', 'state', 'district', 'city', 'constituency', 'ward'));

-- Data files, source registries and the geolocation resolver refer to regions by `codes->>'key'`
-- (ids differ between environments; keys do not). Unique, so a key can never name two regions.
CREATE UNIQUE INDEX IF NOT EXISTS region_key_idx ON region ((codes ->> 'key')) WHERE codes ? 'key';
