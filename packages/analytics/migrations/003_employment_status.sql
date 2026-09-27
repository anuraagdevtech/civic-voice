-- Employment status on the event history and the comment projection (the seventh demographic
-- dimension). Nullable, like every band: older rows were recorded before it was asked.
ALTER TABLE civic.sentiment_event ADD COLUMN IF NOT EXISTS employment_status Nullable(UInt8) AFTER occupation_band;
ALTER TABLE civic.comment_event ADD COLUMN IF NOT EXISTS employment_status Nullable(UInt8) AFTER occupation_band;
