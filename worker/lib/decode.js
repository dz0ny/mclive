/**
 * Pure-JS decoder for MeshCore wire packets.
 *
 * The MQTT observer firmware emits each packet's full on-air/wire format as the
 * `raw` hex field (Packet::writeTo). Wire layout (see ~/mc-mq/src/Packet.cpp):
 *
 *   header (1 byte)
 *   [transport_codes: 4 bytes]   // only when route type is TRANSPORT_FLOOD/DIRECT
 *   path_len (1 byte)
 *   path (path_byte_len bytes)
 *   payload (rest)
 *
 * header bits:  [0:1] route type, [2:5] payload type, [6:7] version
 * path_len:     hashSize = (path_len >> 6) + 1, hashCount = path_len & 0x3F
 *
 * ADVERT payload (PAYLOAD_TYPE_ADVERT = 4):
 *   pub_key[32] + timestamp[4 LE] + signature[64] + app_data[<=32]
 * app_data (AdvertDataParser):
 *   flags(1); if flags&0x10: lat int32 LE, lon int32 LE (degrees * 1e6);
 *   if flags&0x20: extra1(2); if flags&0x40: extra2(2);
 *   if flags&0x80: name = remaining bytes (ASCII). adv_type = flags & 0x0F.
 */

export const PAYLOAD_TYPE_ADVERT = 0x04;
export const PAYLOAD_TYPE_TRACE = 0x09;

const ROUTE_LABELS = { 0: "T", 1: "F", 2: "D", 3: "T" }; // flood/direct + transport
const ROUTE_TYPE_TRANSPORT_FLOOD = 0x00;
const ROUTE_TYPE_TRANSPORT_DIRECT = 0x03;

const ADV_LATLON_MASK = 0x10;
const ADV_FEAT1_MASK = 0x20;
const ADV_FEAT2_MASK = 0x40;
const ADV_NAME_MASK = 0x80;

const PUB_KEY_SIZE = 32;
const SIGNATURE_SIZE = 64;

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const clean = hex.trim().replace(/[^0-9a-fA-F]/g, "");
  const len = clean.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes, start = 0, end = bytes.length) {
  let s = "";
  for (let i = start; i < end; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function readInt32LE(bytes, off) {
  const v =
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24));
  return v | 0; // force signed
}

/**
 * Decode a wire packet (Uint8Array or hex string).
 * Returns { ok, route, routeType, payloadType, version, path: [hexByte,...],
 *           pathHashSize, payloadOffset, payload: Uint8Array }.
 */
export function decodePacket(raw) {
  const bytes = raw instanceof Uint8Array ? raw : hexToBytes(raw);
  if (bytes.length < 2) return { ok: false };

  const header = bytes[0];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  const version = (header >> 6) & 0x03;
  const hasTransport =
    routeType === ROUTE_TYPE_TRANSPORT_FLOOD || routeType === ROUTE_TYPE_TRANSPORT_DIRECT;

  let i = 1;
  if (hasTransport) i += 4; // skip transport_codes[2] (2 x uint16)
  if (i >= bytes.length) return { ok: false };

  const pathLenByte = bytes[i++];
  let hashSize = (pathLenByte >> 6) + 1;
  let hashCount = pathLenByte & 0x3f;
  let pathByteLen = hashCount * hashSize;

  // TRACE packets (type 9) are special (see Mesh.cpp): the wire path holds one
  // SNR byte per traversed hop (int8, dB*4) — NOT node hashes — and path_len is
  // a plain byte count. The route hashes live in the payload instead.
  const isTrace = payloadType === PAYLOAD_TYPE_TRACE;
  if (isTrace) {
    hashSize = 1;
    hashCount = pathLenByte;
    pathByteLen = pathLenByte;
  }

  let path = [];
  const traceSnrs = [];
  for (let h = 0; h < hashCount; h++) {
    const off = i + hashSize * h;
    if (off + hashSize > bytes.length) break;
    if (isTrace) {
      const v = bytes[off];
      traceSnrs.push(((v << 24) >> 24) / 4); // signed int8 -> dB
    } else {
      path.push(bytesToHex(bytes, off, off + hashSize));
    }
  }
  i += pathByteLen;

  const payload = bytes.subarray(i);

  // TRACE route hashes: payload = tag(4) + auth_code(4) + flags(1) + hashes…
  // with hash size = 1 << (flags & 0x03).
  if (isTrace && payload.length >= 9) {
    const flags = payload[8];
    hashSize = 1 << (flags & 0x03);
    for (let off = 9; off + hashSize <= payload.length; off += hashSize) {
      path.push(bytesToHex(payload, off, off + hashSize));
    }
  }

  return {
    ok: true,
    route: ROUTE_LABELS[routeType] ?? "U",
    routeType,
    payloadType,
    version,
    path,
    pathHashSize: hashSize,
    traceSnrs: isTrace ? traceSnrs : undefined,
    payloadOffset: i,
    payload,
  };
}

/**
 * Decode an ADVERT payload (the bytes after the wire header/path).
 * Returns null if it doesn't look like a valid advert.
 */
export function decodeAdvert(payload) {
  if (!payload || payload.length < PUB_KEY_SIZE + 4 + SIGNATURE_SIZE + 1) return null;

  const pubkey = bytesToHex(payload, 0, PUB_KEY_SIZE);
  let i = PUB_KEY_SIZE;
  const advTimestamp =
    payload[i] | (payload[i + 1] << 8) | (payload[i + 2] << 16) | (payload[i + 3] << 24);
  i += 4;
  i += SIGNATURE_SIZE; // skip signature (not verified here)

  const app = payload.subarray(i);
  if (app.length < 1) return null;

  const flags = app[0];
  let j = 1;
  let lat = null;
  let lon = null;
  if (flags & ADV_LATLON_MASK) {
    if (j + 8 > app.length) return null;
    lat = readInt32LE(app, j) / 1e6;
    j += 4;
    lon = readInt32LE(app, j) / 1e6;
    j += 4;
  }
  if (flags & ADV_FEAT1_MASK) j += 2;
  if (flags & ADV_FEAT2_MASK) j += 2;

  let name = "";
  if (flags & ADV_NAME_MASK && j < app.length) {
    name = new TextDecoder().decode(app.subarray(j)).replace(/\0+$/, "");
  }

  return {
    pubkey,
    hashPrefix: pubkey.slice(0, 2), // first byte (hex) = 1-byte path hash
    advType: flags & 0x0f,
    hasLatLon: lat !== null,
    lat,
    lon,
    name,
    advTimestamp: advTimestamp >>> 0,
  };
}

/**
 * High-level helper: from a packet's `raw` hex, return decoded packet plus, if
 * it's an advert with location, the node record to upsert.
 */
export function analyzeRaw(rawHex) {
  const pkt = decodePacket(rawHex);
  if (!pkt.ok) return { packet: null, advert: null };
  let advert = null;
  if (pkt.payloadType === PAYLOAD_TYPE_ADVERT) {
    advert = decodeAdvert(pkt.payload);
  }
  return { packet: pkt, advert };
}
