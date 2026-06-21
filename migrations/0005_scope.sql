-- Region scoping: transport-routed packets carry transport codes that scope
-- them to a region (e.g. "#si"). Detected at ingest (worker/lib/scope.js) by
-- matching the code against known public region names, the same way repeaters
-- do. Values: region name ("si"), '' = transport packet with no known region
-- match (incl. Share/{0,0}), NULL = not a transport packet / pre-column row.
ALTER TABLE packets ADD COLUMN scope TEXT;
