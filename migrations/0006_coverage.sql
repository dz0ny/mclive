-- GRP_DATA coverage aggregate.
--
-- Fast-GPS live-position beacons (GRP_DATA, payload_type 6) are subject to the
-- one-week retention purge (worker/cleanup.js) — only ADVERTs survive. To keep a
-- lasting picture of where the mesh's GPS-equipped nodes actually travel, the
-- hourly cron decodes recent beacons, bins each fix into a fixed lat/lon grid
-- cell, and rolls them up per UTC day here (worker/coverage.js). Days still
-- inside the retention window are recomputed from raw each run; older days keep
-- the aggregate forever, long after the raw beacons are gone.
CREATE TABLE IF NOT EXISTS coverage_cells (
  day        TEXT    NOT NULL,  -- UTC date 'YYYY-MM-DD' the fixes were heard
  cell       TEXT    NOT NULL,  -- grid index 'latIdx:lonIdx' at CELL_DEG resolution
  lat        REAL    NOT NULL,  -- cell centre latitude
  lon        REAL    NOT NULL,  -- cell centre longitude
  fixes      INTEGER NOT NULL,  -- GRP_DATA fixes that fell in this cell that day
  nodes      INTEGER NOT NULL,  -- distinct sender pubkey prefixes in the cell
  updated_at INTEGER NOT NULL,  -- server epoch ms of the rebuild that wrote this
  PRIMARY KEY (day, cell)
);

CREATE INDEX IF NOT EXISTS idx_coverage_day ON coverage_cells (day);
