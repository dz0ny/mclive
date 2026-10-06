-- Node and telemetry pubkeys are lowercase hex (decode.js bytesToHex, hub.js
-- target_pubkey). The API now compares them without LOWER() so that the
-- primary key index applies. This migration makes sure that old rows are
-- lowercase too. A mixed-case row with a lowercase twin is a duplicate, so we
-- delete it first.
DELETE FROM nodes
 WHERE pubkey != LOWER(pubkey) AND LOWER(pubkey) IN (SELECT pubkey FROM nodes);
UPDATE nodes SET pubkey = LOWER(pubkey) WHERE pubkey != LOWER(pubkey);

DELETE FROM repeater_telemetry
 WHERE pubkey != LOWER(pubkey) AND LOWER(pubkey) IN (SELECT pubkey FROM repeater_telemetry);
UPDATE repeater_telemetry SET pubkey = LOWER(pubkey) WHERE pubkey != LOWER(pubkey);
