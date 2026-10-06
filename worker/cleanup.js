/**
 * Data retention, run from the Cron Trigger (see [triggers].crons in
 * wrangler.toml) and reusable on demand.
 *
 * Deleted after one week: receptions and non-ADVERT packets.
 * Removed after one week of silence (hourly): observers (devices) that have
 *   sent neither a packet nor a /status report — see purgeStaleObservers. An
 *   observer that reconnects is re-created by the next upsert in hub.js.
 * Removed after two weeks without an advert (hourly): repeaters (nodes with
 *   adv_type 2) and their repeater_telemetry snapshot — see
 *   purgeStaleRepeaters. The next advert re-creates the node.
 * Removed hourly: nodes with no packets at all (no advert and no probe that
 *   targets them) — see purgeOrphanNodes.
 * Kept forever:
 *   - ADVERT packets (payload_type 4) — the per-node history: advert cadence,
 *     recency, name/location changes over time.
 *   - other nodes (chat, room, sensor) — identity directory; deleting a stale
 *     row would erase what we know about a node, not just old traffic.
 *   - repeater_telemetry of live repeaters — latest ver/telemetry snapshot; the
 *     traffic purge never touches it, so the most recent probe result survives
 *     even though the underlying TRACE/RESPONSE packets age out.
 */
import { analyzeRaw } from "./lib/decode.js";
import { detectScope } from "./lib/scope.js";
import { resolveCountry } from "./lib/geo.js";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
export const REPEATER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

export async function purgeOldData(env, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const db = env.DB;
  const res = await db.batch([
    db.prepare(`DELETE FROM receptions WHERE received_at < ?`).bind(cutoff),
    // IS NOT 4 (not !=) so rows with a NULL payload_type are still purged
    db.prepare(`DELETE FROM packets WHERE last_seen < ? AND payload_type IS NOT 4`).bind(cutoff),
  ]);
  const deleted = {
    receptions: res[0]?.meta?.changes ?? 0,
    packets: res[1]?.meta?.changes ?? 0,
  };
  console.log(`retention purge (cutoff ${new Date(cutoff).toISOString()}):`, JSON.stringify(deleted));
  return { cutoff, deleted };
}

/**
 * Drop observers that haven't reported for longer than RETENTION_MS. last_seen
 * is bumped by both packet receptions and /status reports (hub.js), so it is
 * the observer's last contact of any kind.
 */
export async function purgeStaleObservers(env, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const res = await env.DB
    .prepare(`DELETE FROM devices WHERE last_seen IS NULL OR last_seen < ?`)
    .bind(cutoff)
    .run();
  const deleted = res?.meta?.changes ?? 0;
  if (deleted) console.log(`stale observer purge (cutoff ${new Date(cutoff).toISOString()}): ${deleted} removed`);
  return deleted;
}

/**
 * Drop repeaters whose last advert is older than REPEATER_RETENTION_MS, along
 * with their telemetry snapshot. nodes.updated_at is the server time of the
 * last advert (hub.js) — used instead of last_advert_ts, which is the device's
 * own clock and often wrong.
 */
export async function purgeStaleRepeaters(env, now = Date.now()) {
  const cutoff = now - REPEATER_RETENTION_MS;
  const stale = `SELECT LOWER(pubkey) FROM nodes WHERE adv_type = 2 AND (updated_at IS NULL OR updated_at < ?)`;
  const db = env.DB;
  // Telemetry first: its subquery needs the node rows the second statement removes.
  const res = await db.batch([
    db.prepare(`DELETE FROM repeater_telemetry WHERE LOWER(pubkey) IN (${stale})`).bind(cutoff),
    db.prepare(`DELETE FROM nodes WHERE adv_type = 2 AND (updated_at IS NULL OR updated_at < ?)`).bind(cutoff),
  ]);
  const deleted = {
    telemetry: res[0]?.meta?.changes ?? 0,
    repeaters: res[1]?.meta?.changes ?? 0,
  };
  if (deleted.repeaters || deleted.telemetry) {
    console.log(`stale repeater purge (cutoff ${new Date(cutoff).toISOString()}):`, JSON.stringify(deleted));
  }
  return deleted;
}

/**
 * Drop nodes that no packet refers to: no ADVERT from the node
 * (advert_pubkey) and no probe that targets it (target_pubkey). Also drop the
 * repeater_telemetry rows of those nodes. We skip the run while the
 * advert_pubkey backfill has rows to do, because a NULL advert_pubkey can hide
 * the advert of a node.
 */
export async function purgeOrphanNodes(env) {
  const db = env.DB;
  const pending = await db
    .prepare(`SELECT 1 FROM packets WHERE payload_type = 4 AND advert_pubkey IS NULL LIMIT 1`)
    .first();
  if (pending) return { skipped: "advert_pubkey backfill pending" };
  const orphan = `NOT EXISTS (SELECT 1 FROM packets p WHERE p.advert_pubkey = LOWER(nodes.pubkey))
     AND NOT EXISTS (SELECT 1 FROM packets p WHERE p.target_pubkey = LOWER(nodes.pubkey))`;
  const res = await db.batch([
    db.prepare(
      `DELETE FROM repeater_telemetry WHERE LOWER(pubkey) IN (SELECT LOWER(pubkey) FROM nodes WHERE ${orphan})`
    ),
    db.prepare(`DELETE FROM nodes WHERE ${orphan}`),
  ]);
  const deleted = {
    telemetry: res[0]?.meta?.changes ?? 0,
    nodes: res[1]?.meta?.changes ?? 0,
  };
  if (deleted.nodes || deleted.telemetry) console.log(`orphan node purge:`, JSON.stringify(deleted));
  return deleted;
}

/**
 * One-time convergence: adverts ingested before the advert_pubkey column
 * existed have it NULL. Decode their raw bytes and fill it in, a bounded batch
 * per cron run; undecodable rows get '' so they aren't re-scanned forever.
 * (The history API decodes NULL rows on the fly until this drains.)
 */
export async function backfillAdvertPubkeys(env, limit = 2000) {
  const rows = await env.DB
    .prepare(`SELECT id, raw FROM packets WHERE payload_type = 4 AND advert_pubkey IS NULL LIMIT ?`)
    .bind(limit)
    .all();
  const updates = [];
  for (const r of rows.results || []) {
    const { advert } = analyzeRaw(r.raw || "");
    updates.push(
      env.DB.prepare(`UPDATE packets SET advert_pubkey = ? WHERE id = ?`)
        .bind(advert ? advert.pubkey.toLowerCase() : "", r.id)
    );
  }
  if (updates.length) await env.DB.batch(updates);
  if (updates.length) console.log(`advert_pubkey backfill: ${updates.length} rows`);
  return updates.length;
}

/**
 * Backfill region scope for transport packets ingested before the scope column
 * existed (NULL). Recomputes the detection from raw; unmatched rows get '' so
 * they aren't re-scanned (the packet-detail API still recomputes fresh, so a
 * later dictionary addition shows there immediately).
 */
export async function backfillScopes(env, limit = 500) {
  const rows = await env.DB
    .prepare(`SELECT id, raw FROM packets WHERE route = 'T' AND scope IS NULL LIMIT ?`)
    .bind(limit)
    .all();
  const updates = [];
  for (const r of rows.results || []) {
    const { packet } = analyzeRaw(r.raw || "");
    const scope = (await detectScope(packet)) ?? "";
    updates.push(
      env.DB.prepare(`UPDATE packets SET scope = ? WHERE id = ?`).bind(scope, r.id)
    );
  }
  if (updates.length) await env.DB.batch(updates);
  if (updates.length) console.log(`scope backfill: ${updates.length} rows`);
  return updates.length;
}

/**
 * Backfill the country of adverts ingested before the country column existed
 * (NULL). Decodes raw, resolves located adverts by point-in-polygon
 * (worker/lib/geo.js); unmatched/unlocated rows get '' so they aren't
 * re-scanned. The adverts API resolves NULL rows on the fly until this drains.
 */
export async function backfillCountries(env, limit = 2000) {
  const rows = await env.DB
    .prepare(`SELECT id, raw FROM packets WHERE payload_type = 4 AND country IS NULL LIMIT ?`)
    .bind(limit)
    .all();
  const updates = [];
  for (const r of rows.results || []) {
    const { advert } = analyzeRaw(r.raw || "");
    const country =
      advert && advert.hasLatLon ? resolveCountry(advert.lat, advert.lon)?.code ?? "" : "";
    updates.push(
      env.DB.prepare(`UPDATE packets SET country = ? WHERE id = ?`).bind(country, r.id)
    );
  }
  if (updates.length) await env.DB.batch(updates);
  if (updates.length) console.log(`country backfill: ${updates.length} rows`);
  return updates.length;
}
