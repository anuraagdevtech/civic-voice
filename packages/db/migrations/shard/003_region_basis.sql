-- How a citizen's home region is known: 0 = declared (picked from a list), 1 = device (picked after
-- the device's location resolved inside it). Neither is proof; `device` is the stronger signal and is
-- shown beside their comments as such. See @civic-voice/contracts REGION_BASES.
SET search_path TO civic_shard;

ALTER TABLE citizen ADD COLUMN IF NOT EXISTS region_basis smallint NOT NULL DEFAULT 0
  CHECK (region_basis BETWEEN 0 AND 1);
