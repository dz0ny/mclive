-- Flag a packet that is an observer advertising itself (advert pubkey == the
-- reporting device's origin_id). These feed the map/observer directory but are
-- excluded from the live packet list.
ALTER TABLE packets ADD COLUMN self_advert INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_packets_self_advert ON packets (self_advert);
