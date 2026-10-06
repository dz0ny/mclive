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
export const PAYLOAD_TYPE_CONTROL = 0x0b;

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
  let transportCodes = null;
  if (hasTransport) {
    // transport_codes[2]: two uint16 LE. codes[0] is the scope (HMAC of the
    // region key over type+payload, see TransportKey::calcTransportCode);
    // codes[1] indicates the reply region (mostly unused). {0,0} = "send to
    // nowhere" (Share adverts).
    transportCodes = [
      bytes[1] | (bytes[2] << 8),
      bytes[3] | (bytes[4] << 8),
    ];
    i += 4;
  }
  if (i >= bytes.length) return { ok: false };

  const pathLenByte = bytes[i++];
  let hashSize = (pathLenByte >> 6) + 1;
  let hashCount = pathLenByte & 0x3f;
  let pathByteLen = hashCount * hashSize;
  // Hash size code 3 (top bits 11) is reserved. The firmware drops these
  // packets, so we flag them and do not read the path.
  let malformed = null;
  if (hashSize === 4 && payloadType !== PAYLOAD_TYPE_TRACE) {
    malformed = "reserved path hash size";
    hashCount = 0;
    pathByteLen = 0;
  }

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
    transportCodes,
    malformed,
    payloadOffset: i,
    payload,
  };
}

const CTL_TYPE_NODE_DISCOVER_REQ = 0x80;
const CTL_TYPE_NODE_DISCOVER_RESP = 0x90;

/**
 * Decode a CONTROL (0x0B) payload. The upper 4 bits of byte 0 give the sub
 * type. See MeshCore docs/payloads.md "Control data".
 * DISCOVER_REQ: flags(1) type_filter(1) tag(4) [since(4)].
 * DISCOVER_RESP: flags(1, low 4 bits = node type) snr(1, SNR*4) tag(4) pubkey(8 or 32).
 */
export function decodeControl(payload) {
  if (!payload || payload.length < 1) return null;
  const flags = payload[0];
  const subType = flags & 0xf0;
  const u32 = (off) => (payload[off] | (payload[off + 1] << 8) | (payload[off + 2] << 16) | (payload[off + 3] << 24)) >>> 0;
  if (subType === CTL_TYPE_NODE_DISCOVER_REQ && payload.length >= 6) {
    const filter = payload[1];
    const types = [];
    for (let t = 1; t <= 4; t++) if (filter & (1 << t)) types.push(t);
    return {
      kind: "DISCOVER_REQ",
      subType,
      prefixOnly: (flags & 1) === 1,
      typeFilter: types,
      tag: u32(2),
      since: payload.length >= 10 ? u32(6) : 0,
    };
  }
  if (subType === CTL_TYPE_NODE_DISCOVER_RESP && payload.length >= 6 + 8) {
    return {
      kind: "DISCOVER_RESP",
      subType,
      nodeType: flags & 0x0f,
      snr: ((payload[1] << 24) >> 24) / 4,
      tag: u32(2),
      pubkey: bytesToHex(payload, 6, Math.min(payload.length, 6 + PUB_KEY_SIZE)),
    };
  }
  return { kind: "UNKNOWN", subType };
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
