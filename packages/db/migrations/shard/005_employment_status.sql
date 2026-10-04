-- Employment status, the seventh demographic dimension (see EMPLOYMENT_STATUSES in
-- @civic-voice/contracts): in regular work, in irregular work, unemployed and looking, not in the
-- labour force. Optional like every band; existing citizens simply have not been asked.
SET search_path TO civic_shard;

ALTER TABLE citizen ADD COLUMN IF NOT EXISTS employment_status smallint
  CHECK (employment_status BETWEEN 0 AND 3);
