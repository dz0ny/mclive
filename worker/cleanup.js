/**
 * Data retention: delete everything older than one week. Run from the Cron
 * Trigger (see [triggers].crons in wrangler.toml) and reusable on demand.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export async function purgeOldData(env, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const db = env.DB;
  const res = await db.batch([
    db.prepare(`DELETE FROM receptions WHERE received_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM packets WHERE last_seen < ?`).bind(cutoff),
    db.prepare(`DELETE FROM nodes WHERE updated_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM devices WHERE last_seen < ?`).bind(cutoff),
  ]);
  const deleted = {
    receptions: res[0]?.meta?.changes ?? 0,
    packets: res[1]?.meta?.changes ?? 0,
    nodes: res[2]?.meta?.changes ?? 0,
    devices: res[3]?.meta?.changes ?? 0,
  };
  console.log(`retention purge (cutoff ${new Date(cutoff).toISOString()}):`, JSON.stringify(deleted));
  return { cutoff, deleted };
}
