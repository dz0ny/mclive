/**
 * PacketHub — a single Durable Object that is the live hub for MeshCore packets.
 *
 *  - /~/mqtt   (WebSocket): the observer firmware connects as an MQTT client
 *              (PsychicMqttClient, MQTT-over-WS) and PUBLISHes packet JSON.
 *  - /~/stream (SSE):       browsers connect and receive live packet/node events.
 *
 * On each ingested packet the hub decodes the raw wire bytes, upserts the node
 * directory (from adverts) and observing devices (by IATA), persists the packet
 * to D1, and broadcasts normalized events to all SSE clients.
 */
import { analyzeRaw } from "./lib/decode.js";
import { detectScope } from "./lib/scope.js";
import { resolveCountry } from "./lib/geo.js";
import { iataLatLon } from "./lib/iata.js";
import {
  MqttDecoder,
  encodeConnack,
  encodePuback,
  encodeSuback,
  encodeUnsuback,
  encodePingresp,
} from "./lib/mqtt.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PacketHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Set<ReadableStreamDefaultController>} */
    this.clients = new Set();
    this.heartbeat = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/mqtt" || url.pathname === "/~/mqtt") {
      return this.handleMqtt(request);
    }
    if (url.pathname === "/~/stream") {
      return this.handleStream(request);
    }
    return new Response("Not found", { status: 404 });
  }

  // --- MQTT-over-WebSocket broker (the observer firmware connects here) ------
  handleMqtt(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const dec = new MqttDecoder();
    const send = (bytes) => {
      try {
        server.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } catch {}
    };

    // Process messages strictly in order: Blob->bytes conversion is async and
    // the decoder keeps a shared byte accumulator, so we serialize on a chain.
    let chain = Promise.resolve();
    const state = { authed: false };
    server.addEventListener("message", (event) => {
      chain = chain.then(() => this.onMqttMessage(event.data, dec, send, state, server));
    });

    // Echo the MQTT subprotocol ONLY if the client offered it. Returning a
    // subprotocol the client didn't request makes strict WS clients (ws/undici)
    // abort the connection.
    const offered = request.headers.get("Sec-WebSocket-Protocol");
    const headers = {};
    if (offered && offered.split(",").map((s) => s.trim()).includes("mqtt")) {
      headers["Sec-WebSocket-Protocol"] = "mqtt";
    }
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /** Process one inbound WS frame: decode MQTT packets and respond. */
  async onMqttMessage(data, dec, send, state, server) {
    const bytes = await toBytes(data);
    if (!bytes) return;

    let packets;
    try {
      packets = dec.push(bytes);
    } catch (err) {
      console.error("mqtt decode error:", err);
      return;
    }

    for (const pkt of packets) {
      switch (pkt.type) {
        case "connect": {
          const expected = this.env.INGEST_TOKEN;
          if (expected && pkt.password !== expected) {
            send(encodeConnack(0x05)); // not authorized
            server.close(1008, "unauthorized");
            return;
          }
          state.authed = true;
          send(encodeConnack(0x00));
          break;
        }
        case "publish": {
          if (pkt.qos === 1 && pkt.packetId != null) send(encodePuback(pkt.packetId));
          if (!state.authed) break;
          await this.handlePublish(pkt);
          break;
        }
        case "subscribe":
          send(encodeSuback(pkt.packetId, 1));
          break;
        case "unsubscribe":
          send(encodeUnsuback(pkt.packetId));
          break;
        case "pingreq":
          send(encodePingresp());
          break;
        case "disconnect":
          server.close(1000, "bye");
          break;
      }
    }
  }

  /** Handle an MQTT PUBLISH: topic `meshcore/{IATA}/{KEY}/packets`, JSON body. */
  async handlePublish(pkt) {
    const segs = pkt.topic.split("/");
    const iata = segs[0] === "meshcore" ? segs[1] : null;
    const leaf = segs[segs.length - 1];
    if (leaf !== "packets" && leaf !== "status") return; // ignore /raw
    let msg;
    try {
      msg = JSON.parse(decoder.decode(pkt.payload));
    } catch {
      return;
    }
    if (iata && !msg.iata) msg.iata = iata;
    if (leaf === "status") {
      await this.ingestStatus(msg);
    } else {
      await this.ingestPacket(msg);
    }
  }

  /**
   * Persist an observer's /status report. Payload (observer firmware):
   * { status, timestamp, origin, origin_id, model, firmware_version, radio,
   *   client_version, stats: { uptime_secs, battery_mv, noise_floor, ... } }.
   * Updates the device row's status columns + last_seen so the Observer Status
   * dashboard can show uptime, firmware, clock offset and liveness.
   */
  async ingestStatus(msg) {
    const originId = msg.origin_id || null;
    if (!originId) return;
    const now = Date.now();
    const origin = msg.origin || null;
    const iata = msg.iata || null;
    const stats = msg.stats || {};
    const uptime = Number.isFinite(stats.uptime_secs) ? stats.uptime_secs : null;
    const battery = Number.isFinite(stats.battery_mv) ? stats.battery_mv : null;
    const fw = msg.firmware_version || null;
    const model = msg.model || null;
    // Clock offset: how far the device's reported time is from the server's.
    const devMs = msg.timestamp ? Date.parse(msg.timestamp) : NaN;
    const clockOffset = Number.isFinite(devMs) ? now - devMs : null;
    const loc = iataLatLon(iata);
    try {
      await this.env.DB.prepare(
        `INSERT INTO devices
          (origin_id, origin, iata, lat, lon, last_seen,
           last_status_at, uptime_secs, firmware_version, model, battery_mv, clock_offset_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(origin_id) DO UPDATE SET
           origin=COALESCE(excluded.origin, origin),
           iata=COALESCE(excluded.iata, iata),
           lat=COALESCE(excluded.lat, lat),
           lon=COALESCE(excluded.lon, lon),
           last_seen=excluded.last_seen,
           last_status_at=excluded.last_status_at,
           uptime_secs=excluded.uptime_secs,
           firmware_version=excluded.firmware_version,
           model=excluded.model,
           battery_mv=excluded.battery_mv,
           clock_offset_ms=excluded.clock_offset_ms`
      )
        .bind(
          originId, origin, iata, loc?.[0] ?? null, loc?.[1] ?? null, now,
          now, uptime, fw, model, battery, clockOffset
        )
        .run();
    } catch (err) {
      console.error("status upsert failed:", err);
    }
  }

  // --- SSE stream (to browsers) ---------------------------------------------
  handleStream(request) {
    const stream = new ReadableStream({
      start: (controller) => {
        this.clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        this.ensureHeartbeat();
      },
      cancel: (controller) => {
        this.clients.delete(controller);
      },
    });

    // Drop the client when the request is aborted (tab closed).
    request.signal?.addEventListener("abort", () => {
      this.maybeStopHeartbeat();
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  ensureHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.broadcastRaw(": ping\n\n");
    }, 20000);
  }

  maybeStopHeartbeat() {
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  broadcast(obj) {
    this.broadcastRaw(`data: ${JSON.stringify(obj)}\n\n`);
  }

  broadcastRaw(text) {
    const chunk = encoder.encode(text);
    for (const controller of this.clients) {
      try {
        controller.enqueue(chunk);
      } catch {
        this.clients.delete(controller);
      }
    }
  }

  // --- Core ingest logic -----------------------------------------------------
  async ingestPacket(msg) {
    const now = Date.now();
    const raw = msg.raw || msg.data || "";
    const { packet, advert } = analyzeRaw(raw);
    // Region scoping: name for transport packets matching a known region,
    // '' for unmatched/Share, null otherwise (see worker/lib/scope.js).
    const scope = await detectScope(packet);
    // Country of a located advert (point-in-polygon, worker/lib/geo.js): ISO2
    // code, '' for an advert with no European match / no location, null for
    // non-advert packets.
    const country = advert
      ? advert.hasLatLon
        ? resolveCountry(advert.lat, advert.lon)?.code ?? ""
        : ""
      : null;

    const route = packet?.route || routeFromJson(msg.route);
    const payloadType =
      packet?.payloadType ?? toInt(msg.packet_type ?? msg.payload_type);
    const pathStr = packet?.path?.length ? packet.path.join(",") : "";
    const snr = toFloat(msg.SNR ?? msg.snr);
    const rssi = toInt(msg.RSSI ?? msg.rssi);
    const len = toInt(msg.len);
    const payloadLen = toInt(msg.payload_len);
    const direction = msg.direction || null;
    const ts = msg.timestamp || null;
    const originId = msg.origin_id || null;
    const origin = msg.origin || null;
    const iata = msg.iata || null;

    // Dedup key: the MeshCore packet hash. The same packet heard by multiple
    // observers collapses to one row; fall back to the raw bytes if no hash.
    const hashKey = msg.hash || (raw ? `raw:${raw.slice(0, 48)}` : `t:${now}`);

    // An observer advertising itself (advert pubkey == reporting device) — kept
    // for the map/observer directory but excluded from the live packet list.
    const isSelfAdvert =
      advert && originId && advert.pubkey.toLowerCase() === originId.toLowerCase() ? 1 : 0;

    // Upsert the logical packet, merging receptions.
    let logical = null;
    try {
      logical = await this.env.DB.prepare(
        `INSERT INTO packets
          (hash, ts, first_seen, last_seen, direction, payload_type, route,
           len, payload_len, path, raw, reception_count, best_snr, best_rssi, self_advert, advert_pubkey, scope, country)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)
         ON CONFLICT(hash) DO UPDATE SET
           last_seen=excluded.last_seen,
           reception_count=reception_count+1,
           best_snr=CASE WHEN best_snr IS NULL OR excluded.best_snr > best_snr
                         THEN excluded.best_snr ELSE best_snr END,
           best_rssi=CASE WHEN best_rssi IS NULL OR excluded.best_rssi > best_rssi
                          THEN excluded.best_rssi ELSE best_rssi END,
           path=excluded.path,
           len=excluded.len,
           payload_len=excluded.payload_len
         RETURNING id, first_seen, reception_count, best_snr, best_rssi`
      )
        .bind(
          hashKey, ts, now, now, direction, payloadType, route,
          len, payloadLen, pathStr, raw, snr, rssi, isSelfAdvert,
          advert ? advert.pubkey.toLowerCase() : null, scope, country
        )
        .first();
    } catch (err) {
      console.error("packet upsert failed:", err);
      return;
    }
    const packetId = logical?.id ?? null;

    // Record this observer's reception.
    if (packetId) {
      try {
        await this.env.DB.prepare(
          `INSERT INTO receptions
            (packet_id, hash, origin_id, origin, iata, snr, rssi, path, received_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
          .bind(packetId, hashKey, originId, origin, iata, snr, rssi, pathStr, now)
          .run();
      } catch (err) {
        console.error("reception insert failed:", err);
      }
    }

    // Upsert observing device (located by IATA).
    let device = null;
    if (originId) {
      const loc = iataLatLon(iata);
      device = {
        origin_id: originId,
        origin,
        iata,
        lat: loc?.[0] ?? null,
        lon: loc?.[1] ?? null,
        last_seen: now,
      };
      try {
        await this.env.DB.prepare(
          `INSERT INTO devices (origin_id, origin, iata, lat, lon, last_seen)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(origin_id) DO UPDATE SET
             origin=excluded.origin, iata=excluded.iata,
             lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen`
        )
          .bind(device.origin_id, device.origin, device.iata, device.lat, device.lon, device.last_seen)
          .run();
      } catch (err) {
        console.error("device upsert failed:", err);
      }
    }

    // Upsert node directory from adverts that carry a location.
    let node = null;
    if (advert && advert.hasLatLon) {
      node = {
        pubkey: advert.pubkey,
        hash_prefix: advert.hashPrefix,
        name: advert.name || null,
        adv_type: advert.advType,
        lat: advert.lat,
        lon: advert.lon,
        last_advert_ts: advert.advTimestamp,
        updated_at: now,
      };
      try {
        await this.env.DB.prepare(
          `INSERT INTO nodes
            (pubkey, hash_prefix, name, adv_type, lat, lon, last_advert_ts, updated_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(pubkey) DO UPDATE SET
             hash_prefix=excluded.hash_prefix, name=excluded.name,
             adv_type=excluded.adv_type, lat=excluded.lat, lon=excluded.lon,
             last_advert_ts=excluded.last_advert_ts, updated_at=excluded.updated_at`
        )
          .bind(
            node.pubkey, node.hash_prefix, node.name, node.adv_type,
            node.lat, node.lon, node.last_advert_ts, node.updated_at
          )
          .run();
      } catch (err) {
        console.error("node upsert failed:", err);
      }
    }

    // Fan out to SSE clients. `packet` is the deduped logical record; `path` is
    // this reception's hops (used for the live map animation).
    this.broadcast({
      type: "packet",
      packet: {
        id: packetId,
        hash: hashKey,
        ts,
        first_seen: logical?.first_seen ?? now,
        last_seen: now,
        direction,
        payload_type: payloadType,
        route,
        len,
        payload_len: payloadLen,
        path: packet?.path ?? [],
        reception_count: logical?.reception_count ?? 1,
        best_snr: logical?.best_snr ?? snr,
        best_rssi: logical?.best_rssi ?? rssi,
        raw,
        self_advert: isSelfAdvert,
        scope,
      },
      reception: { origin_id: originId, iata, snr, rssi },
    });
    if (node) this.broadcast({ type: "node", node });
  }
}

async function toBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer()); // Blob
  return null;
}

function toInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}
function toFloat(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}
function routeFromJson(r) {
  if (!r) return null;
  const c = String(r).trim().charAt(0).toUpperCase();
  return ["F", "D", "T", "U"].includes(c) ? c : null;
}
