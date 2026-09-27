-- The spending head a topic is about, so opinion on a government's decisions can be set against what
-- that government spends on the same sector. Programme sectors only: nobody has a topic "about" interest
-- payments. Null when none fits — an unclassified topic is better than a wrong one.
SET search_path TO civic_catalogue;

ALTER TABLE topic ADD COLUMN IF NOT EXISTS sector text CHECK (sector IN (
  'infrastructure', 'housing_urban', 'health', 'education', 'defence', 'rural_development',
  'agriculture', 'water_sanitation', 'subsidies_welfare', 'labour_employment', 'police_justice',
  'administration_other'));

-- "A government's own decisions in a sector, newest first": one index range per government.
CREATE INDEX IF NOT EXISTS topic_sector_idx
  ON topic (jurisdiction_region_id, id DESC) WHERE sector IS NOT NULL;
