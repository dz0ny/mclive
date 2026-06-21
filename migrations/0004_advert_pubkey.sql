-- Advert history: ADVERT packets are exempted from the retention purge (see
-- worker/cleanup.js) so per-node history survives — advert cadence, recency,
-- name/location changes. Index them by the advertised node's pubkey so that
-- history is queryable without decoding raw bytes per row. Lowercase hex;
-- '' marks an advert whose raw bytes failed to decode (skipped by backfill).
ALTER TABLE packets ADD COLUMN advert_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_packets_advert_pubkey ON packets (advert_pubkey, first_seen);
