-- MeshCore live stats schema.
--
-- A logical mesh packet is identified by its MeshCore `hash`. The same packet is
-- typically heard by several observer devices, each reporting its own SNR/RSSI
-- and the path it travelled. We therefore dedupe packets by hash and keep the
-- per-observer reports in `receptions`.

CREATE TABLE IF NOT EXISTS packets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hash            TEXT UNIQUE,     -- dedup key (MeshCore packet hash, hex)
  ts              TEXT,            -- device-reported ISO timestamp (first report)
  first_seen      INTEGER NOT NULL,-- server epoch ms (first reception)
  last_seen       INTEGER NOT NULL,-- server epoch ms (most recent reception)
  direction       TEXT,            -- 'rx' | 'tx'
  payload_type    INTEGER,         -- MeshCore PAYLOAD_TYPE_* (0..15)
  route           TEXT,            -- 'F' | 'D' | 'T' | 'U'
  len             INTEGER,         -- total packet length (latest report)
  payload_len     INTEGER,
  path            TEXT,            -- latest reception's path (comma hex hashes)
  raw             TEXT,            -- full wire packet (hex)
  reception_count INTEGER NOT NULL DEFAULT 1,
  best_snr        REAL,            -- max SNR across receptions
  best_rssi       INTEGER          -- best (closest to 0) RSSI across receptions
);

CREATE INDEX IF NOT EXISTS idx_packets_last_seen ON packets (last_seen);

-- One row per observer that heard a given packet.
CREATE TABLE IF NOT EXISTS receptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id   INTEGER NOT NULL,
  hash        TEXT,
  origin_id   TEXT,             -- observing device public key (hex)
  origin      TEXT,             -- observing device name
  iata        TEXT,             -- observing device region
  snr         REAL,
  rssi        INTEGER,
  path        TEXT,             -- path as seen by this observer
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receptions_packet ON receptions (packet_id);
CREATE INDEX IF NOT EXISTS idx_receptions_time   ON receptions (received_at);

-- Node directory built by decoding ADVERT packets (those that carry lat/lon).
CREATE TABLE IF NOT EXISTS nodes (
  pubkey         TEXT PRIMARY KEY,  -- full Ed25519 public key (hex)
  hash_prefix    TEXT,              -- first byte of pubkey (hex) = path hash
  name           TEXT,
  adv_type       INTEGER,           -- ADV_TYPE_* (1=chat,2=repeater,3=room,4=sensor)
  lat            REAL,
  lon            REAL,
  last_advert_ts INTEGER,           -- advert's own timestamp (epoch secs)
  updated_at     INTEGER            -- server epoch ms
);

CREATE INDEX IF NOT EXISTS idx_nodes_hash_prefix ON nodes (hash_prefix);

-- Observing devices (the repeaters uplinking packets), located by IATA.
CREATE TABLE IF NOT EXISTS devices (
  origin_id  TEXT PRIMARY KEY,  -- device public key (hex)
  origin     TEXT,              -- device name
  iata       TEXT,
  lat        REAL,
  lon        REAL,
  last_seen  INTEGER            -- server epoch ms
);
