-- Latest decoded ver/telemetry snapshot per repeater, obtained by an mc-mq
-- observer that auto-probed the repeater after hearing its advert. The RESPONSE
-- (0x01) is encrypted to the requesting node, so the firmware decrypts it and
-- uplinks the decoded fields; the worker only stores the latest snapshot here.
CREATE TABLE IF NOT EXISTS repeater_telemetry (
  pubkey       TEXT PRIMARY KEY,   -- repeater node pubkey (hex, lowercase)
  telemetry    TEXT NOT NULL,      -- JSON blob of decoded GET_STATUS fields
  observer_id  TEXT,               -- origin_id of the mc-mq that obtained it
  snr          REAL,               -- RF context of the RESPONSE reception
  rssi         INTEGER,
  updated_at   INTEGER NOT NULL    -- epoch ms
);

-- Attribute a probe's TRACE (and the RESPONSE packet) to the repeater it
-- targeted. NULL for ordinary observed packets; only set for firmware-initiated
-- probes that stamp target_pubkey on the uplink.
ALTER TABLE packets ADD COLUMN target_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_packets_target ON packets (target_pubkey, last_seen);
