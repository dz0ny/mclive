/**
 * MeshCore wire-packet builders, used by replay.mjs to generate decoder-valid
 * sample packets. Mirrors Packet::writeTo and AdvertDataBuilder in ~/mc-mq.
 */
import { createHash, createHmac, createCipheriv } from "node:crypto";

const PAYLOAD_TYPE_GRP_TXT = 0x05;
const PAYLOAD_TYPE_ADVERT = 0x04;
const ROUTE_FLOOD = 0x01;

const ADV_LATLON_MASK = 0x10;
const ADV_NAME_MASK = 0x80;

function header(payloadType, routeType) {
  return (routeType & 0x03) | ((payloadType & 0x0f) << 2);
}

function int32LE(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v | 0, 0);
  return b;
}

function pathLenByte(hashCount, hashSize = 1) {
  return ((hashSize - 1) << 6) | (hashCount & 0x3f);
}

/** Build an ADVERT wire packet (flood, empty path) carrying name + lat/lon. */
export function buildAdvert({ pubkey, lat, lon, name, advType = 2, timestamp }) {
  const pub = Buffer.from(pubkey, "hex"); // 32 bytes
  const ts = int32LE(timestamp ?? Math.floor(Date.now() / 1000));
  const sig = Buffer.alloc(64, 0); // signature not verified by our decoder
  const flags = ADV_LATLON_MASK | (name ? ADV_NAME_MASK : 0) | (advType & 0x0f);
  const appData = Buffer.concat([
    Buffer.from([flags]),
    int32LE(Math.round(lat * 1e6)),
    int32LE(Math.round(lon * 1e6)),
    name ? Buffer.from(name, "utf8") : Buffer.alloc(0),
  ]);
  const payload = Buffer.concat([pub, ts, sig, appData]);
  const raw = Buffer.concat([
    Buffer.from([header(PAYLOAD_TYPE_ADVERT, ROUTE_FLOOD)]),
    Buffer.from([pathLenByte(0)]),
    payload,
  ]);
  return raw.toString("hex").toUpperCase();
}

/** Build a flood group-text wire packet whose path is the given node hashes. */
export function buildFloodText({ pathHashes = [], payloadLen = 24 }) {
  const path = Buffer.from(pathHashes.map((h) => parseInt(h, 16) & 0xff));
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] = (i * 37 + 11) & 0xff;
  const raw = Buffer.concat([
    Buffer.from([header(PAYLOAD_TYPE_GRP_TXT, ROUTE_FLOOD)]),
    Buffer.from([pathLenByte(path.length)]),
    path,
    payload,
  ]);
  return raw.toString("hex").toUpperCase();
}

// MeshCore's well-known public channel pre-shared key (base64, 16 bytes).
export const PUBLIC_PSK_B64 = "izOH6cXN6mrJ5e26oRXNcg==";

/** Channel key derivation — must match src/lib/channel.ts exactly. */
export function channelKey16(name, password) {
  const norm = String(name).replace(/^#+/, "").trim().toLowerCase();
  if (!password && norm === "public") return Buffer.from(PUBLIC_PSK_B64, "base64").subarray(0, 16);
  const material = password ? `${norm}:${password}` : norm;
  return createHash("sha256").update(material, "utf8").digest().subarray(0, 16);
}

/**
 * Build a GRP_TXT wire packet for a channel (by name / name+password):
 *   payload = channel_hash(1) + MAC(2) + AES-128-ECB(timestamp(4)+txt_type(1)+"sender: msg")
 * channel_hash = SHA256(key16)[0]; MAC = HMAC-SHA256(secret32, ct)[:2].
 */
export function buildGroupText({ channel = "public", password, sender, message, timestamp, pathHashes = [] }) {
  const key16 = channelKey16(channel, password);
  const secret32 = Buffer.alloc(32);
  key16.copy(secret32);
  const hashByte = createHash("sha256").update(key16).digest()[0];

  const text = `${sender}: ${message}`;
  const head = Buffer.alloc(5);
  head.writeUInt32LE((timestamp ?? Math.floor(Date.now() / 1000)) >>> 0, 0);
  head[4] = 0; // txt_type 0 (plain)
  let plain = Buffer.concat([head, Buffer.from(text, "utf8")]);
  const pad = (16 - (plain.length % 16)) % 16;
  if (pad) plain = Buffer.concat([plain, Buffer.alloc(pad)]); // zero-pad last block

  const cipher = createCipheriv("aes-128-ecb", key16, null);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", secret32).update(ct).digest().subarray(0, 2);

  const payload = Buffer.concat([Buffer.from([hashByte]), mac, ct]);
  const path = Buffer.from(pathHashes.map((h) => parseInt(h, 16) & 0xff));
  const raw = Buffer.concat([
    Buffer.from([header(PAYLOAD_TYPE_GRP_TXT, ROUTE_FLOOD), pathLenByte(path.length)]),
    path,
    payload,
  ]);
  return raw.toString("hex").toUpperCase();
}

/** Simple 16-bit FNV-ish hash -> hex, for synthetic packet hashes. */
export function fakeHash(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(16, "0").slice(0, 16).toUpperCase();
}
