/**
 * GRP_DATA coverage aggregate, refreshed hourly from the Cron Trigger.
 *
 * Fast-GPS beacons (payload_type 6) are purged after a week (worker/cleanup.js),
 * so we roll them up into a durable per-UTC-day grid (coverage_cells, migration
 * 0006). Each rebuild recomputes the days still backed by raw beacons from
 * scratch (delete-then-insert), so a re-run is idempotent and never double
 * counts. Older days were frozen by an earlier run and are left untouched.
 */
import { decodeFastGpsLocation, defaultChannels } from "./lib/groupdata.js";

// Grid resolution in degrees (~0.005° ≈ 555 m N/S). Returned to the client in
// the /coverage-cells response so the map can draw cells without hardcoding it.
export const CELL_DEG = 0.005;

const DAY_MS = 86_400_000;

// epoch ms → 'YYYY-MM-DD' (UTC). Day buckets align to floor(ms / DAY_MS).
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rebuild the coverage grid for the last `daysBack` UTC days (default 2: today
 * + yesterday — both comfortably inside the 1-week retention window). Decodes
 * every GRP_DATA beacon in that span, bins each fix into a CELL_DEG grid cell,
 * and replaces those days' rows.
 */
export async function rebuildCoverage(env, now = Date.now(), daysBack = 2) {
  const channels = await defaultChannels();
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS; // UTC midnight
  const since = todayStart - (daysBack - 1) * DAY_MS;
  // The exact days this run owns — deleted even if they decode to nothing now,
  // so a day that loses all its beacons is cleared rather than left stale.
  const days = [];
  for (let d = 0; d < daysBack; d++) days.push(dayKey(todayStart - d * DAY_MS));

  const rows = await env.DB
    .prepare(`SELECT raw, last_seen FROM packets WHERE payload_type = 6 AND last_seen >= ? AND raw IS NOT NULL`)
    .bind(since)
    .all();

  // day -> (cell -> { lat, lon, fixes, nodes:Set })
  const perDay = new Map();
  let decoded = 0;
  for (const r of rows.results || []) {
    const loc = decodeFastGpsLocation(r.raw, channels);
    if (!loc) continue;
    decoded++;
    const day = dayKey(r.last_seen);
    const latIdx = Math.floor(loc.lat / CELL_DEG);
    const lonIdx = Math.floor(loc.lon / CELL_DEG);
    const cell = `${latIdx}:${lonIdx}`;
    let cells = perDay.get(day);
    if (!cells) perDay.set(day, (cells = new Map()));
    let agg = cells.get(cell);
    if (!agg) {
      cells.set(cell, (agg = {
        lat: (latIdx + 0.5) * CELL_DEG,
        lon: (lonIdx + 0.5) * CELL_DEG,
        fixes: 0,
        nodes: new Set(),
      }));
    }
    agg.fixes++;
    agg.nodes.add(loc.pubkeyPrefix);
  }

  // Replace the owned days atomically-ish: delete then insert, chunked to stay
  // under D1's per-batch statement cap.
  const stmts = [];
  for (const day of days) {
    stmts.push(env.DB.prepare(`DELETE FROM coverage_cells WHERE day = ?`).bind(day));
  }
  let cellCount = 0;
  for (const [day, cells] of perDay) {
    for (const [cell, agg] of cells) {
      cellCount++;
      stmts.push(
        env.DB
          .prepare(`INSERT INTO coverage_cells (day, cell, lat, lon, fixes, nodes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(day, cell, agg.lat, agg.lon, agg.fixes, agg.nodes.size, now)
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  console.log(
    `coverage rebuild (${days.join(",")}): ${decoded} fixes → ${cellCount} cells`
  );
  return { days, decoded, cells: cellCount };
}
