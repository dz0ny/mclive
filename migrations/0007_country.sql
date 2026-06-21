-- Country of an advert's self-reported location, resolved at ingest by
-- point-in-polygon against European borders (worker/lib/geo.js). Stored per
-- packet alongside scope/advert_pubkey so the adverts API can filter by country
-- without re-running PIP on every read. Values: ISO2 code ("SI"), '' = located
-- but outside any covered (European) country / advert with no location, NULL =
-- non-advert packet or pre-column row (drained by worker/cleanup.js backfill).
ALTER TABLE packets ADD COLUMN country TEXT;
