-- Per-observer reception lookups (the /observers dashboard counts and the
-- most-recent packet per device) filtered receptions by origin_id with no
-- index, scanning the whole table once per observer.
CREATE INDEX IF NOT EXISTS idx_receptions_origin ON receptions (origin_id, received_at);
