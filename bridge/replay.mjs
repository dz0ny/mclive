/**
 * Dev replay: publish synthetic MeshCore packets to the worker's MQTT-over-WS
 * broker exactly like the observer firmware does (PsychicMqttClient). Generates
 * adverts (with locations) + flood traffic so the live page comes alive without
 * a real device.
 *
 *   MQTT_WS_URL=ws://localhost:8787/~/mqtt INGEST_TOKEN=dev-local-token \
 *     node bridge/replay.mjs
 *
 * Env:
 *   MQTT_WS_URL   default ws://localhost:8787/~/mqtt
 *   INGEST_TOKEN  default dev-local-token  (sent as MQTT password)
 *   INTERVAL_MS   default 900              (delay between flood packets)
 */
import mqtt from "mqtt";
import { buildAdvert, buildGroupText, fakeHash } from "./meshwire.mjs";

const URL = process.env.MQTT_WS_URL || "ws://localhost:8787/~/mqtt";
const TOKEN = process.env.INGEST_TOKEN || "dev-local-token";
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || "900", 10);

// Each node's pubkey FIRST byte is a distinct path hash; coords cluster around
// the Pacific Northwest.
const NODES = [
  { prefix: "a1", name: "Capitol Hill", lat: 47.6228, lon: -122.3208, type: 2 },
  { prefix: "b2", name: "Ballard Relay", lat: 47.6686, lon: -122.3848, type: 2 },
  { prefix: "c3", name: "West Seattle", lat: 47.5707, lon: -122.3868, type: 2 },
  { prefix: "d4", name: "Bellevue Hub", lat: 47.6101, lon: -122.2015, type: 2 },
  { prefix: "e5", name: "Tacoma Tower", lat: 47.2529, lon: -122.4443, type: 2 },
  { prefix: "f6", name: "Everett North", lat: 47.9789, lon: -122.2021, type: 2 },
  { prefix: "07", name: "Bremerton", lat: 47.5673, lon: -122.6329, type: 1 },
];

// Several observer devices in different regions (all IATA codes known to
// worker/lib/iata.js). The same packet is typically heard by several of them,
// which exercises dedup-by-hash + the per-observer receptions list.
const OBSERVERS = [
  { iata: "SEA", origin: "MeshCore-SEA", id: "ffaa00112233445566778899aabbccddeeff00112233445566778899aabbccdd" },
  { iata: "PDX", origin: "MeshCore-PDX", id: "ffbb00112233445566778899aabbccddeeff00112233445566778899aabbccdd" },
  { iata: "YVR", origin: "MeshCore-YVR", id: "ffcc00112233445566778899aabbccddeeff00112233445566778899aabbccdd" },
];

// Channels the replay sends on: public (auto), a named #sea-mesh (name-derived),
// and a private #ops (name + password). Add the latter two on the Channels page.
const CONVERSATIONS = [
  {
    channel: "public",
    messages: ["GM from the mesh!", "anyone copy?", "testing 123", "node online", "clear skies here", "signal looking good"],
  },
  {
    channel: "sea-mesh",
    messages: ["welcome to sea-mesh", "repeater on Capitol Hill is up", "who's at the meetup?", "rssi great tonight"],
  },
  {
    channel: "ops",
    password: "hunter2",
    messages: ["deploying node 7", "battery at 84%", "rebooting Bremerton relay", "all systems nominal"],
  },
];
const SENDERS = ["Alice", "Bob", "Carol", "Dave", "Erin", "node-7", "hilltop"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function fullPubkey(prefix) {
  // prefix byte + filler, exactly 32 bytes (64 hex chars)
  return (prefix + "0123456789abcdef".repeat(8)).slice(0, 64);
}

function nowIso() {
  return new Date().toISOString().replace("Z", "000");
}

function topicFor(obs) {
  return `meshcore/${obs.iata}/${obs.id}/packets`;
}

function packetMsg({ obs, raw, hash, route = "F", payloadType, payloadLen }) {
  return JSON.stringify({
    origin: obs.origin,
    origin_id: obs.id,
    timestamp: nowIso(),
    type: "PACKET",
    direction: "rx",
    packet_type: String(payloadType),
    route,
    len: String((raw.length / 2) | 0),
    payload_len: String(payloadLen),
    raw,
    SNR: (Math.random() * 12 + 2).toFixed(1),
    RSSI: String(-(Math.floor(Math.random() * 90) + 20)),
    hash,
  });
}

const client = mqtt.connect(URL, {
  username: "observer",
  password: TOKEN,
  protocolVersion: 4, // MQTT 3.1.1, like the firmware
  reconnectPeriod: 2000,
  clientId: "replay-" + Math.floor(Math.random() * 1e6),
});

let timer = null;
let seq = 0;

client.on("connect", () => {
  console.log(`[replay] connected to ${URL}`);

  // 1) Announce every node via an advert (so the map gets locations). Each
  //    advert is heard by a random subset of observers (deduped by hash).
  for (const n of NODES) {
    const raw = buildAdvert({
      pubkey: fullPubkey(n.prefix),
      lat: n.lat,
      lon: n.lon,
      name: n.name,
      advType: n.type,
    });
    const hash = fakeHash("adv-" + n.prefix);
    const heardBy = [...OBSERVERS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * OBSERVERS.length));
    for (const obs of heardBy) {
      client.publish(
        topicFor(obs),
        packetMsg({ obs, raw, hash, payloadType: 4, payloadLen: 32 }),
        { qos: 1, retain: true }
      );
    }
  }
  console.log(`[replay] sent ${NODES.length} adverts`);

  // 2) Stream real GRP_TXT channel chatter; each packet is heard by a random
  //    subset of observers (same hash -> deduped, multiple receptions).
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const hops = 1 + Math.floor(Math.random() * 4);
    const shuffled = [...NODES].sort(() => Math.random() - 0.5).slice(0, hops);
    const pathHashes = shuffled.map((n) => n.prefix);

    const conv = pick(CONVERSATIONS);
    const sender = pick(SENDERS);
    const raw = buildGroupText({
      channel: conv.channel,
      password: conv.password,
      sender,
      message: pick(conv.messages),
      timestamp: Math.floor(Date.now() / 1000),
      pathHashes,
    });
    const payloadLen = (raw.length / 2 - 2 - pathHashes.length) | 0;
    const hash = fakeHash("txt-" + seq++ + "-" + pathHashes.join(""));

    const heardBy = [...OBSERVERS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * OBSERVERS.length));
    for (const obs of heardBy) {
      client.publish(topicFor(obs), packetMsg({ obs, raw, hash, payloadType: 5, payloadLen }), { qos: 1, retain: true });
    }
  }, INTERVAL_MS);
});

client.on("error", (err) => console.error("[replay] mqtt error:", err.message || err));
client.on("close", () => {
  if (timer) clearInterval(timer);
});
