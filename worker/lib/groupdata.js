/**
 * Server-side decoder for MeshCore GRP_DATA fast-GPS location beacons.
 *
 * This mirrors the browser decoder in src/lib/channel.ts, trimmed to the one
 * thing the worker needs: pulling a node's GPS fix out of a GRP_DATA packet
 * (payload_type 6). The envelope is the group-channel one —
 *   channel_hash(1) + MAC(2) + AES-128-ECB ciphertext
 * decrypting to an application datagram
 *   data_type(2 LE) + data_len(1) + blob[data_len]
 * and the fast-GPS beacon rides the developer data-type 0xFFFF with blob
 *   magic(0x47) + sender_pubkey_prefix[6] + lat_e6(i32 LE) + lon_e6(i32 LE) + speed(u8).
 *
 * We only try the channels every node ships with (Public + the default
 * hashtags), since their keys are derivable from the name alone — exactly the
 * set a fresh browser decodes against. Beacons on private channels we can't see,
 * which is fine: this is a coverage aggregate, not a surveillance tool.
 */
import aesjs from "aes-js";
import { hexToBytes } from "./decode.js";

// MeshCore's well-known public channel PSK (BaseChatMesh::addChannel).
const PUBLIC_PSK_B64 = "izOH6cXN6mrJ5e26oRXNcg==";
// Hashtag channels every visitor gets out of the box (src/lib/channel.ts).
const DEFAULT_HASHTAGS = ["slovenija", "notranjska", "bot", "test"];

const DATA_TYPE_DEV = 0xffff; // developer data-type namespace
const FAST_GPS_MAGIC = 0x47;
const FAST_GPS_PAYLOAD_LEN = 16;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

let channelsPromise = null;

/**
 * Derive the default channels (Public + DEFAULT_HASHTAGS), each as the minimal
 * { key16, hashByte } needed to match and decrypt. Cached for the isolate's
 * lifetime — the keys never change.
 */
export function defaultChannels() {
  if (!channelsPromise) {
    channelsPromise = (async () => {
      const out = [];
      const pub = base64ToBytes(PUBLIC_PSK_B64);
      out.push({ key16: pub.slice(0, 16), hashByte: (await sha256(pub))[0] });
      for (const name of DEFAULT_HASHTAGS) {
        const secret = (await sha256(new TextEncoder().encode("#" + name))).slice(0, 16);
        out.push({ key16: secret, hashByte: (await sha256(secret))[0] });
      }
      return out;
    })();
  }
  return channelsPromise;
}

/** Extract the payload (after wire header + path) from a raw wire packet hex. */
function wirePayload(rawHex) {
  const b = hexToBytes(rawHex);
  if (b.length < 2) return null;
  const route = b[0] & 0x03;
  let i = 1;
  if (route === 0 || route === 3) i += 4; // transport codes
  if (i >= b.length) return null;
  const pathLen = b[i++];
  const hashSize = (pathLen >> 6) + 1;
  const count = pathLen & 0x3f;
  i += count * hashSize;
  return b.subarray(i);
}

function readI32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}

/**
 * Decode a raw GRP_DATA packet's fast-GPS location against the default
 * channels. Returns { pubkeyPrefix, lat, lon } or null when it isn't a
 * recognised beacon (wrong key, not a GPS datagram, or no fix).
 */
export function decodeFastGpsLocation(rawHex, channels) {
  const payload = wirePayload(rawHex);
  if (!payload || payload.length < 1 + 2 + 16) return null;
  const chanHash = payload[0];

  for (const ch of channels) {
    if (ch.hashByte !== chanHash) continue;
    const ct = payload.subarray(3);
    if (ct.length === 0 || ct.length % 16 !== 0) continue;

    let pt;
    try {
      pt = new aesjs.ModeOfOperation.ecb(ch.key16).decrypt(ct);
    } catch {
      continue;
    }
    if (pt.length < 3) continue;
    const dataType = pt[0] | (pt[1] << 8);
    const dataLen = pt[2];
    if (dataType !== DATA_TYPE_DEV || dataLen > pt.length - 3) continue;

    const blob = pt.subarray(3, 3 + dataLen);
    if (blob.length < FAST_GPS_PAYLOAD_LEN || blob[0] !== FAST_GPS_MAGIC) continue;
    const lat = readI32LE(blob, 7) / 1e6;
    const lon = readI32LE(blob, 11) / 1e6;
    // Range-check the fix — also stands in for the MAC we don't verify, so a
    // wrong key almost never survives magic byte + in-range lat/lon together.
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) continue;
    if (lat === 0 && lon === 0) continue; // node has no GPS fix
    let prefix = "";
    for (let i = 1; i <= 6; i++) prefix += blob[i].toString(16).padStart(2, "0");
    return { pubkeyPrefix: prefix, lat, lon };
  }
  return null;
}
