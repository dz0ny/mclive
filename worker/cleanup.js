/**
 * Data retention, run from the Cron Trigger (see [triggers].crons in
 * wrangler.toml) and reusable on demand.
 *
 * Deleted after one week: receptions and non-ADVERT packets.
 * Kept forever:
 *   - ADVERT packets (payload_type 4) — the per-node history: advert cadence,
 *     recency, name/location changes over time.
 *   - nodes and devices — identity directories; deleting a stale row would
 *     erase what we know about a node/observer, not just old traffic.
 *   - repeater_telemetry — latest ver/telemetry snapshot per repeater; a
 *     separate table the purge never touches, so the most recent probe result
 *     survives even though the underlying TRACE/RESPONSE packets age out.
 */
import { analyzeRaw } from "./lib/decode.js";
import { detectScope } from "./lib/scope.js";
import { resolveCountry } from "./lib/geo.js";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

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
