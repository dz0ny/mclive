-- Observer Status: the latest /status report each observing device publishes
-- (topic meshcore/{IATA}/{KEY}/status). Previously these were ignored; now we
-- persist the useful fields so the Observer Status dashboard can show uptime,
-- firmware, clock offset and health. All nullable — only set once a device
-- actually reports status.
ALTER TABLE devices ADD COLUMN last_status_at   INTEGER; -- server epoch ms of last /status
ALTER TABLE devices ADD COLUMN uptime_secs      INTEGER; -- device-reported uptime
ALTER TABLE devices ADD COLUMN firmware_version TEXT;
ALTER TABLE devices ADD COLUMN model            TEXT;
ALTER TABLE devices ADD COLUMN battery_mv       INTEGER;
ALTER TABLE devices ADD COLUMN clock_offset_ms  INTEGER; -- server_ms - device_reported_ms at status time
