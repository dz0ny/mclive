/**
 * Read-only JSON API backed by D1, mounted under /~/api by the worker entry.
 */
import { Hono } from "hono";
import { analyzeRaw, bytesToHex } from "./lib/decode.js";
import { detectScope } from "./lib/scope.js";
import { resolveCountry } from "./lib/geo.js";
import { CELL_DEG } from "./coverage.js";

export const api = new Hono();

// Newest deduped packets (one row per hash), most-recently-heard first.
// Optional ?type=<payload_type> and ?since=/?until=<epoch ms> filters
// (e.g. last 24h, or a closed custom range).
api.get("/packets", async (c) => {
  // Optional ?bucket=<ms>&perBucket=<n>: sample up to n rows per time bucket so
  // a wide range (e.g. 48h) is covered evenly instead of clustering at "now".
  const bucketMs = parseInt(c.req.query("bucket") || "0", 10) || 0;
  const perBucket = Math.min(parseInt(c.req.query("perBucket") || "0", 10) || 0, 200);
  const bucketed = bucketMs > 0 && perBucket > 0;
  const maxLimit = bucketed ? 8000 : 2000;
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10) || 100, maxLimit);
  const type = c.req.query("type");
  const since = c.req.query("since");
  const until = c.req.query("until");

  const conds = [`self_advert = 0`];
  const binds = [];
  if (type !== undefined && type !== "") {
    conds.push(`payload_type = ?`);
    binds.push(parseInt(type, 10));
  }
  if (since !== undefined && since !== "") {
    conds.push(`last_seen >= ?`);
    binds.push(parseInt(since, 10));
  }
  if (until !== undefined && until !== "") {
    conds.push(`last_seen <= ?`);
    binds.push(parseInt(until, 10));
  }
  // ?sender=<pubkey>: packets where the node appears anywhere on the path (sent
  // OR relayed). Path hashes are 1–4 bytes, stored as comma-joined hex tokens,
  // so a hop matches one of the pubkey's 2/4/6/8-char prefixes as a whole token.
  const sender = (c.req.query("sender") || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (sender.length >= 2) {
    const s = [];
    for (const len of [2, 4, 6, 8]) {
      if (sender.length < len) break;
      const prefix = sender.slice(0, len);
      // whole path | first token | last token | middle token
      s.push(`path = ?`, `path LIKE ?`, `path LIKE ?`, `path LIKE ?`);
      binds.push(prefix, `${prefix},%`, `%,${prefix}`, `%,${prefix},%`);
    }
    conds.push(`(${s.join(" OR ")})`);
  }
  const where = conds.join(" AND ");

  let sql;
  let allBinds;
  if (bucketed) {
    // ROW_NUMBER() partitioned by the time bucket keeps the newest perBucket
    // rows in each window, so the result is spread across the whole range.
    sql = `SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY last_seen / ? ORDER BY last_seen DESC) AS _rn
        FROM packets WHERE ${where}
      ) WHERE _rn <= ? ORDER BY last_seen DESC LIMIT ?`;
    allBinds = [bucketMs, ...binds, perBucket, limit];
  } else {
    sql = `SELECT * FROM packets WHERE ${where} ORDER BY last_seen DESC LIMIT ?`;
    allBinds = [...binds, limit];
  }

  const rows = await c.env.DB.prepare(sql).bind(...allBinds).all();
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
        // transport scoping: raw codes + freshly matched region (recomputed so
        // dictionary additions show up without waiting for the backfill)
        transportCodes: packet.transportCodes ?? null,
        scope: await detectScope(packet),
        payloadOffset: packet.payloadOffset,
        payloadLen: packet.payload.length,
        payloadHex: bytesToHex(packet.payload),
      }
    : null;

  return c.json({ packet: { ...row, path: pathArr }, decoded, hops, receptions, advert, advertNode });
});

// Decoded adverts (identity announcements), deduped by node public key.
api.get("/adverts", async (c) => {
  // One representative (latest) advert packet per node, across the FULL history
  // — not just the most recent N packets. Capping the packet window before
  // deduping by pubkey silently dropped nodes whose latest advert had aged out
  // of that window, so country/region filters came up short. The advert_pubkey
  // index makes the per-node MAX(last_seen) lookup cheap.
  const indexedRows = await c.env.DB
    .prepare(
      `SELECT p.* FROM packets p
         JOIN (
           SELECT advert_pubkey, MAX(last_seen) AS ms
             FROM packets
            WHERE payload_type = 4 AND advert_pubkey IS NOT NULL AND advert_pubkey != ''
            GROUP BY advert_pubkey
         ) m ON p.advert_pubkey = m.advert_pubkey AND p.last_seen = m.ms
        WHERE p.payload_type = 4`
    )
    .all();
  // Pre-backfill rows (advert_pubkey NULL) aren't covered by the index above;
  // include recent ones decoded on the fly until the daily backfill drains them.
  const legacyRows = await c.env.DB
    .prepare(
      `SELECT * FROM packets
        WHERE payload_type = 4 AND (advert_pubkey IS NULL OR advert_pubkey = '')
        ORDER BY last_seen DESC LIMIT 400`
    )
    .all();
  const rows = { results: [...(indexedRows.results || []), ...(legacyRows.results || [])] };
  // Per-node advert cadence (count + first/last advert) over the full history,
  // via the advert_pubkey index. Pre-backfill rows (advert_pubkey IS NULL)
  // aren't counted; the daily backfill in worker/cleanup.js drains them.
  const statRows = await c.env.DB
    .prepare(
      `SELECT advert_pubkey AS pk, COUNT(*) AS n,
              MIN(first_seen) AS first_advert, MAX(first_seen) AS last_advert
         FROM packets
        WHERE payload_type = 4 AND advert_pubkey IS NOT NULL AND advert_pubkey != ''
        GROUP BY advert_pubkey`
    )
    .all();
  const stats = new Map((statRows.results || []).map((s) => [s.pk, s]));
  const seen = new Set();
  const adverts = [];
  for (const r of rows.results || []) {
    const { advert } = analyzeRaw(r.raw || "");
    if (!advert || seen.has(advert.pubkey)) continue;
    seen.add(advert.pubkey);
    const s = stats.get(advert.pubkey.toLowerCase());
    // Stored at ingest; resolve NULL (pre-backfill) rows on the fly so the
    // country filter works before the daily backfill drains. '' = no match.
    const country =
      r.country != null
        ? r.country || null
        : advert.hasLatLon
          ? resolveCountry(advert.lat, advert.lon)?.code ?? null
          : null;
    adverts.push({
      ...advert,
      id: r.id,
      hash: r.hash,
      country,
      last_seen: r.last_seen,
      reception_count: r.reception_count,
      advert_count: s?.n ?? 1,
      first_advert: s?.first_advert ?? r.first_seen,
      last_advert: s?.last_advert ?? r.first_seen,
    });
  }
  return c.json({ adverts });
});

// Full advert history for one node (adverts are exempt from retention, so this
// reaches back to the first advert we ever decoded). Each event is one ADVERT
// transmission (deduped by packet hash), decoded server-side so the client gets
// name/type/location per event without shipping raw bytes. Drives the
// node-health sidebar: advert cadence, recency, behaviour changes.
api.get("/adverts/:pubkey/history", async (c) => {
  const pubkey = (c.req.param("pubkey") || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (pubkey.length !== 64) return c.json({ error: "bad pubkey" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "500", 10) || 500, 2000);

  // advert_pubkey IS NULL: rows from before the column existed — decode and
  // filter below until the daily backfill (worker/cleanup.js) drains them.
  const rows = await c.env.DB
    .prepare(
      `SELECT id, hash, first_seen, last_seen, reception_count, best_snr, best_rssi, raw
         FROM packets
        WHERE payload_type = 4 AND (advert_pubkey = ? OR advert_pubkey IS NULL)
        ORDER BY first_seen DESC LIMIT ?`
    )
    .bind(pubkey, limit)
    .all();

  const events = [];
  for (const r of rows.results || []) {
    const { advert } = analyzeRaw(r.raw || "");
    if (!advert || advert.pubkey.toLowerCase() !== pubkey) continue;
    events.push({
      id: r.id,
      hash: r.hash,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      reception_count: r.reception_count,
      best_snr: r.best_snr,
      best_rssi: r.best_rssi,
      name: advert.name,
      adv_type: advert.advType,
      has_lat_lon: advert.hasLatLon,
      lat: advert.lat,
      lon: advert.lon,
      adv_timestamp: advert.advTimestamp, // node's own clock, epoch secs
    });
  }

  const node = await c.env.DB
    .prepare(`SELECT * FROM nodes WHERE LOWER(pubkey) = ?`)
    .bind(pubkey)
    .first();
  return c.json({ pubkey, node: node || null, events });
});

// Repeater directory: nodes that advertise as repeaters (adv_type = 2), joined
// with the latest ver/telemetry snapshot a probing observer obtained for each.
// Drives the Repeaters list page. `has_telemetry` lets the list show ✓/—.
api.get("/repeaters", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT n.pubkey, n.hash_prefix, n.name, n.adv_type, n.lat, n.lon,
            n.last_advert_ts, n.updated_at,
            t.updated_at AS telemetry_at,
            t.observer_id AS telemetry_observer,
            t.snr AS telemetry_snr, t.rssi AS telemetry_rssi
       FROM nodes n
       LEFT JOIN repeater_telemetry t ON LOWER(t.pubkey) = LOWER(n.pubkey)
      WHERE n.adv_type = 2
      ORDER BY n.updated_at DESC`
  ).all();
  // Per-node advert cadence (count + first/last advert) over the full history,
  // via the advert_pubkey index — same stats the /adverts endpoint surfaces, so
  // the repeater list can show the identical advert-health badge.
  const statRows = await c.env.DB
    .prepare(
      `SELECT advert_pubkey AS pk, COUNT(*) AS n,
              MIN(first_seen) AS first_advert, MAX(first_seen) AS last_advert
         FROM packets
        WHERE payload_type = 4 AND advert_pubkey IS NOT NULL AND advert_pubkey != ''
        GROUP BY advert_pubkey`
    )
    .all();
  const stats = new Map((statRows.results || []).map((s) => [s.pk, s]));
  const repeaters = (rows.results || []).map((r) => {
    // Resolve country from the node's self-reported location (same point-in-
    // polygon the adverts API uses) so the Location column can filter by country.
    const country =
      r.lat != null && r.lon != null && !(r.lat === 0 && r.lon === 0)
        ? resolveCountry(r.lat, r.lon)?.code ?? null
        : null;
    const s = stats.get((r.pubkey || "").toLowerCase());
    return {
      ...r,
      country,
      has_telemetry: r.telemetry_at != null,
      advert_count: s?.n ?? 1,
      first_advert: s?.first_advert ?? r.last_advert_ts ?? r.updated_at,
      last_advert: s?.last_advert ?? r.last_advert_ts ?? r.updated_at,
    };
  });
  return c.json({ repeaters });
});

// One repeater: node record + latest decoded telemetry snapshot + latest TRACE
// that targeted it (decoded for the per-hop SNR traceroute). Both telemetry and
// trace are nullable — a repeater with no successful probe yet shows neither.
api.get("/repeaters/:pk", async (c) => {
  const pk = (c.req.param("pk") || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (pk.length !== 64) return c.json({ error: "bad pubkey" }, 400);
  const db = c.env.DB;

  const node = await db.prepare(`SELECT * FROM nodes WHERE LOWER(pubkey) = ?`).bind(pk).first();

  const tRow = await db
    .prepare(`SELECT * FROM repeater_telemetry WHERE LOWER(pubkey) = ?`)
    .bind(pk)
    .first();
  let telemetry = null;
  if (tRow) {
    let fields = null;
    try {
      fields = JSON.parse(tRow.telemetry);
    } catch {}
    telemetry = {
      fields,
      observer_id: tRow.observer_id,
      snr: tRow.snr,
      rssi: tRow.rssi,
      updated_at: tRow.updated_at,
    };
  }

  // Latest probe TRACE for this repeater (firmware stamped target_pubkey).
  const traceRow = await db
    .prepare(
      `SELECT * FROM packets WHERE payload_type = 9 AND target_pubkey = ? ORDER BY last_seen DESC LIMIT 1`
    )
    .bind(pk)
    .first();
  let trace = null;
  if (traceRow) {
    const { packet } = analyzeRaw(traceRow.raw || "");
    const pathArr = packet?.path?.length
      ? packet.path
      : traceRow.path
        ? String(traceRow.path).split(",").filter(Boolean)
        : [];
    const hops = [];
    for (const h of pathArr) {
      const hopNode = h
        ? await db.prepare(`SELECT * FROM nodes WHERE pubkey LIKE ? LIMIT 1`).bind(`${h.toLowerCase()}%`).first()
        : null;
      hops.push({ hash: h, node: hopNode || null });
    }
    trace = {
      id: traceRow.id,
      hash: traceRow.hash,
      last_seen: traceRow.last_seen,
      best_snr: traceRow.best_snr,
      best_rssi: traceRow.best_rssi,
      hops,
      traceSnrs: packet?.traceSnrs ?? null,
    };
  }

  return c.json({ pubkey: pk, node: node || null, telemetry, trace });
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

// GRP_DATA coverage grid (worker/coverage.js, refreshed hourly). Returns the
// list of available UTC days plus the cells for one day — the most recent day by
// default, a specific ?day=YYYY-MM-DD, or ?day=all to union every day into a
// single all-time coverage map. Drives the map's coverage toggle + day selector.
api.get("/coverage-cells", async (c) => {
  const db = c.env.DB;
  const dayRows = await db
    .prepare(`SELECT DISTINCT day FROM coverage_cells ORDER BY day DESC LIMIT 90`)
    .all();
  const days = (dayRows.results || []).map((r) => r.day);

  const req = c.req.query("day");
  const day = req === "all" ? "all" : req && days.includes(req) ? req : days[0] || null;
  if (!day) return c.json({ days, day: null, cells: [], maxFixes: 0, cellDeg: CELL_DEG });

  const res =
    day === "all"
      ? await db
          .prepare(
            `SELECT MIN(lat) AS lat, MIN(lon) AS lon, SUM(fixes) AS fixes, MAX(nodes) AS nodes
               FROM coverage_cells GROUP BY cell`
          )
          .all()
      : await db
          .prepare(`SELECT lat, lon, fixes, nodes FROM coverage_cells WHERE day = ?`)
          .bind(day)
          .all();

  const cells = res.results || [];
  const maxFixes = cells.reduce((m, r) => (r.fixes > m ? r.fixes : m), 0);
  return c.json({ days, day, cells, maxFixes, cellDeg: CELL_DEG });
});

// Tile proxy for mapy.cz. Their tile server 403s unless the request carries a
// `Referer: https://mapy.com/`, which a browser fetching tiles cross-origin
// can't set — so we relay server-side, add the referer, and lean on the
// Cloudflare edge cache (tiles are immutable). Path: /~/api/tiles/<style>/<z>/<x>/<y>
api.get("/tiles/:style/:z/:x/:y", async (c) => {
  const { style, z, x, y } = c.req.param();
  // allowlist styles so the proxy can't be turned into an open relay
  const STYLES = new Set(["turist-en", "turist", "base-en", "base", "aerial"]);
  if (!STYLES.has(style)) return c.text("unknown style", 400);
  if (![z, x, y].every((n) => /^\d+$/.test(n))) return c.text("bad tile coord", 400);

  const upstream = `https://mapserver.mapy.cz/${style}/retina/${z}-${x}-${y}`;
  const cache = caches.default;
  const cacheKey = new Request(upstream);
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(upstream, { headers: { referer: "https://mapy.com/", origin: "https://mapy.com" } });
    if (res.ok) {
      res = new Response(res.body, res);
      res.headers.set("cache-control", "public, max-age=2592000, immutable"); // 30d
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    }
  }
  return res;
});

// RF coverage layer (MeshCore). `generate-coverage-layer` is referer-gated to
// app.meshcore.nz and mints a short-lived tile set for a transmitter location.
// We round the request to ~1 m so nearby clicks share a cache entry, relay it
// with the required referer, and hand back a trimmed descriptor whose tile URL
// points at our own (cached) tile proxy below.
const MC_HEADERS = { accept: "application/json", origin: "https://app.meshcore.nz", referer: "https://app.meshcore.nz/" };

api.get("/coverage", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return c.json({ error: "bad lat/lon" }, 400);
  // antenna heights (m); clamp to a sane allowlist range
  const antA = Math.min(Math.max(parseInt(c.req.query("ant_a") || "5", 10) || 5, 0), 200);
  const antB = Math.min(Math.max(parseInt(c.req.query("ant_b") || "1", 10) || 1, 0), 200);
  // 5 decimals ≈ 1.1 m — the quantisation that makes "heavily cache" work
  const qlat = lat.toFixed(5);
  const qlon = lon.toFixed(5);

  const cache = caches.default;
  const cacheKey = new Request(`https://mclive.internal/coverage?lat=${qlat}&lon=${qlon}&a=${antA}&b=${antB}`);
  let hit = await cache.match(cacheKey);
  if (!hit) {
    const upstream =
      `https://api.meshcore.nz/api/v1/tools/generate-coverage-layer` +
      `?lat_a=${qlat}&lon_a=${qlon}&ant_a=${antA}&ant_b=${antB}`;
    const res = await fetch(upstream, { headers: MC_HEADERS });
    if (!res.ok) return c.json({ error: "coverage upstream failed", status: res.status }, 502);
    const data = await res.json();
    const cov = data.coverage_layer;
    if (!cov?.id) return c.json({ error: "no coverage layer" }, 502);

    // bounding_box is a closed lat/lon polygon — reduce to a lon/lat extent
    const pts = cov.bounding_box || [];
    let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
    for (const [plat, plon] of pts) {
      if (plon < minLon) minLon = plon;
      if (plon > maxLon) maxLon = plon;
      if (plat < minLat) minLat = plat;
      if (plat > maxLat) maxLat = plat;
    }
    const body = {
      id: cov.id,
      url: `/~/api/coverage-tiles/${cov.id}/{z}/{x}/{y}`,
      extent: [minLon, minLat, maxLon, maxLat],
      minZoom: cov.min_zoom_level ?? 1,
      maxZoom: cov.max_zoom_level ?? 12,
      expiresAt: cov.expires_at ?? null,
      lat: Number(qlat),
      lon: Number(qlon),
    };
    hit = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    // cache for 20 min — comfortably inside the ~30 min upstream layer lifetime
    hit.headers.set("cache-control", "public, max-age=1200");
    c.executionCtx.waitUntil(cache.put(cacheKey, hit.clone()));
  }
  return hit;
});

// Coverage PNG tiles for a minted layer — relayed (referer-gated) and cached.
api.get("/coverage-tiles/:id/:z/:x/:y", async (c) => {
  const { id, z, x, y } = c.req.param();
  if (!/^[0-9a-z-]+$/i.test(id)) return c.text("bad layer id", 400);
  if (![z, x, y].every((n) => /^\d+$/.test(n))) return c.text("bad tile coord", 400);

  const upstream = `https://api.meshcore.nz/data/coverage-layers/${id}/${z}/${x}/${y}.png`;
  const cache = caches.default;
  const cacheKey = new Request(upstream);
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(upstream, { headers: MC_HEADERS });
    if (res.ok) {
      res = new Response(res.body, res);
      // tiles belong to a layer that expires upstream; an hour is plenty
      res.headers.set("cache-control", "public, max-age=3600");
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    }
  }
  return res;
});

function withPathArray(row) {
  const { _rn, ...rest } = row; // drop the bucket-sampling helper column if present
  return { ...rest, path: rest.path ? String(rest.path).split(",").filter(Boolean) : [] };
}
