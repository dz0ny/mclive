/**
 * Read-only JSON API backed by D1, mounted under /~/api by the worker entry.
 */
import { Hono } from "hono";
import { analyzeRaw, bytesToHex } from "./lib/decode.js";

export const api = new Hono();

// Newest deduped packets (one row per hash), most-recently-heard first.
// Optional ?type=<payload_type> and ?since=<epoch ms> filters (e.g. last 24h).
api.get("/packets", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, 2000);
  const type = c.req.query("type");
  const since = c.req.query("since");

  let sql = `SELECT * FROM packets WHERE self_advert = 0`;
  const binds = [];
  if (type !== undefined && type !== "") {
    sql += ` AND payload_type = ?`;
    binds.push(parseInt(type, 10));
  }
  if (since !== undefined && since !== "") {
    sql += ` AND last_seen >= ?`;
    binds.push(parseInt(since, 10));
  }
  // ?sender=<pubkey>: packets where the node appears anywhere on the path (sent
  // OR relayed). Path hashes are 1–4 bytes, stored as comma-joined hex tokens,
  // so a hop matches one of the pubkey's 2/4/6/8-char prefixes as a whole token.
  const sender = (c.req.query("sender") || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (sender.length >= 2) {
    const conds = [];
    for (const len of [2, 4, 6, 8]) {
      if (sender.length < len) break;
      const prefix = sender.slice(0, len);
      // whole path | first token | last token | middle token
      conds.push(`path = ?`, `path LIKE ?`, `path LIKE ?`, `path LIKE ?`);
      binds.push(prefix, `${prefix},%`, `%,${prefix}`, `%,${prefix},%`);
    }
    sql += ` AND (${conds.join(" OR ")})`;
  }
  sql += ` ORDER BY last_seen DESC LIMIT ?`;
  binds.push(limit);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ packets: (rows.results || []).map(withPathArray) });
});

// Full detail for a single packet, with decoded wire fields and resolved hops.
api.get("/packets/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "bad id" }, 400);
  const db = c.env.DB;

  const row = await db.prepare(`SELECT * FROM packets WHERE id = ?`).bind(id).first();
  if (!row) return c.json({ error: "not found" }, 404);

  const { packet, advert } = analyzeRaw(row.raw || "");
  // Prefer the freshly decoded path (authoritative — e.g. TRACE route hashes
  // live in the payload); fall back to the stored column.
  const pathArr = packet?.path?.length
    ? packet.path
    : row.path
      ? String(row.path).split(",").filter(Boolean)
      : [];

  // Resolve each hop hash to a known node. Path hashes are 1–4 bytes (the
  // leading bytes of the sender's pubkey), so match by pubkey prefix.
  const hops = [];
  for (const h of pathArr) {
    const node = h
      ? await db.prepare(`SELECT * FROM nodes WHERE pubkey LIKE ? LIMIT 1`).bind(`${h.toLowerCase()}%`).first()
      : null;
    hops.push({ hash: h, node: node || null });
  }

  // All observers that heard this packet, with the observer's location —
  // preferring its own self-advert location (nodes) over the IATA approximation.
  const recRes = await db
    .prepare(
      `SELECT r.origin, r.origin_id, r.iata, r.snr, r.rssi, r.path, r.received_at,
              COALESCE(n.lat, d.lat) AS obs_lat,
              COALESCE(n.lon, d.lon) AS obs_lon
         FROM receptions r
         LEFT JOIN devices d ON d.origin_id = r.origin_id
         LEFT JOIN nodes n ON LOWER(n.pubkey) = LOWER(r.origin_id)
        WHERE r.packet_id = ? ORDER BY r.received_at DESC LIMIT 50`
    )
    .bind(id)
    .all();
  const receptions = (recRes.results || []).map((r) => ({
    ...r,
    path: r.path ? String(r.path).split(",").filter(Boolean) : [],
  }));

  // If this packet is an advert, surface the full node record it announced.
  const advertNode = advert
    ? await db.prepare(`SELECT * FROM nodes WHERE pubkey = ?`).bind(advert.pubkey).first()
    : null;

  const decoded = packet
    ? {
        route: packet.route,
        routeType: packet.routeType,
        payloadType: packet.payloadType,
        version: packet.version,
        pathHashSize: packet.pathHashSize,
        pathBytes: packet.path,
        traceSnrs: packet.traceSnrs ?? null,
        payloadOffset: packet.payloadOffset,
        payloadLen: packet.payload.length,
        payloadHex: bytesToHex(packet.payload),
      }
    : null;

  return c.json({ packet: { ...row, path: pathArr }, decoded, hops, receptions, advert, advertNode });
});

// Decoded adverts (identity announcements), deduped by node public key.
api.get("/adverts", async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT * FROM packets WHERE payload_type = 4 ORDER BY last_seen DESC LIMIT 400`)
    .all();
  const seen = new Set();
  const adverts = [];
  for (const r of rows.results || []) {
    const { advert } = analyzeRaw(r.raw || "");
    if (!advert || seen.has(advert.pubkey)) continue;
    seen.add(advert.pubkey);
    adverts.push({
      ...advert,
      id: r.id,
      hash: r.hash,
      last_seen: r.last_seen,
      reception_count: r.reception_count,
    });
  }
  return c.json({ adverts });
});

api.get("/nodes", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM nodes WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY updated_at DESC`
  ).all();
  // Observers: prefer the precise location from the device's own self-advert
  // (nodes.pubkey == devices.origin_id) over the IATA approximation.
  const devices = await c.env.DB.prepare(
    `SELECT d.origin_id, d.origin, d.iata, d.last_seen,
            COALESCE(n.lat, d.lat) AS lat,
            COALESCE(n.lon, d.lon) AS lon,
            CASE WHEN n.lat IS NOT NULL THEN 'advert' ELSE 'iata' END AS loc_source
       FROM devices d
       LEFT JOIN nodes n ON LOWER(n.pubkey) = LOWER(d.origin_id)
      WHERE COALESCE(n.lat, d.lat) IS NOT NULL
      ORDER BY d.last_seen DESC`
  ).all();
  return c.json({ nodes: rows.results || [], devices: devices.results || [] });
});

api.get("/stats", async (c) => {
  const db = c.env.DB;
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM packets WHERE self_advert = 0`).first();
  const nodes = await db.prepare(`SELECT COUNT(*) AS n FROM nodes`).first();
  const devices = await db.prepare(`SELECT COUNT(*) AS n FROM devices`).first();
  const receptions = await db.prepare(`SELECT COUNT(*) AS n FROM receptions`).first();
  const lastMin = await db
    .prepare(`SELECT COUNT(*) AS n FROM receptions WHERE received_at > ?`)
    .bind(Date.now() - 60000)
    .first();
  return c.json({
    packets: total?.n ?? 0,
    nodes: nodes?.n ?? 0,
    devices: devices?.n ?? 0,
    receptions: receptions?.n ?? 0,
    receptions_per_min: lastMin?.n ?? 0,
  });
});

// Observer Status: one row per observing device, with its latest /status report
// plus reception aggregates (total + last hour + most-recent). Drives the
// Observer Status dashboard.
api.get("/observers", async (c) => {
  const db = c.env.DB;
  const hourAgo = Date.now() - 3600000;
  const rows = await db
    .prepare(
      `SELECT d.origin_id, d.origin, d.iata, d.lat, d.lon, d.last_seen,
              d.last_status_at, d.uptime_secs, d.firmware_version, d.model,
              d.battery_mv, d.clock_offset_ms,
              (SELECT COUNT(*) FROM receptions r WHERE r.origin_id = d.origin_id) AS total_packets,
              (SELECT COUNT(*) FROM receptions r WHERE r.origin_id = d.origin_id AND r.received_at >= ?) AS packets_last_hour,
              (SELECT MAX(received_at) FROM receptions r WHERE r.origin_id = d.origin_id) AS last_packet_at
         FROM devices d
        ORDER BY d.last_seen DESC`
    )
    .bind(hourAgo)
    .all();
  return c.json({ observers: rows.results || [] });
});

function withPathArray(row) {
  return { ...row, path: row.path ? String(row.path).split(",").filter(Boolean) : [] };
}
