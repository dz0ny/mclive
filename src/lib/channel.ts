// Browser-side MeshCore group-channel decoder (GRP_TXT + GRP_DATA).
//
// GRP_TXT payload = channel_hash(1) + MAC(2) + AES-128-ECB ciphertext.
// Plaintext = timestamp(4 LE) + txt_type(1) + "sender: message".
// GRP_DATA shares the same envelope but carries an application datagram (see
// decodeGroupData below) — notably the fast-GPS live-position beacon.
// channel_hash = SHA256(key16)[0]. The public channel uses a well-known PSK.
//
// WebCrypto has no AES-ECB, so we use aes-js for the block cipher and
// SubtleCrypto only for the SHA-256 used to derive the channel hash.
import aesjs from "aes-js";

// MeshCore's well-known public channel. A channel is defined exactly as in the
// firmware (BaseChatMesh::addChannel): a name + a base64 PSK that decodes to a
// 16- or 32-byte secret. channel hash = SHA256(secret)[0]; AES key = secret[:16].
export const PUBLIC_PSK_B64 = "izOH6cXN6mrJ5e26oRXNcg==";

// Hashtag channels every visitor gets out of the box (this mesh's commons).
// Keys are derivable from the name alone, so shipping them costs nothing.
export const DEFAULT_HASHTAGS = ["slovenija", "notranjska", "bot", "test"];

export type ChannelKind = "public" | "hashtag" | "private";

export interface Channel {
  name: string;
  psk: string; // base64 PSK (the MeshCore channel secret)
  key16: Uint8Array;
  hashByte: number;
  kind: ChannelKind;
  isPublic: boolean;
  /** shipped with the site (Public + DEFAULT_HASHTAGS) — not removable, not persisted */
  builtin?: boolean;
}

export interface ChannelMessage {
  channel: string;
  timestamp: number;
  sender: string | null;
  text: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function normalizeName(name: string): string {
  return name.replace(/^#+/, "").trim();
}

/**
 * Derive a channel (matches MeshCore exactly):
 *  - an explicit base64 PSK (16/32 bytes) → private/custom channel,
 *  - name "public" with no PSK → the well-known fixed public key,
 *  - any other #hashtag name with no PSK → first 16 bytes of SHA256("#name").
 * Returns null on an invalid PSK.
 */
export async function deriveChannel(
  name: string,
  pskBase64?: string,
  isPublic = false
): Promise<Channel | null> {
  const norm = normalizeName(name);
  if (!norm) return null;
  try {
    let secret: Uint8Array;
    let kind: ChannelKind;
    if (pskBase64 && pskBase64.trim()) {
      secret = base64ToBytes(pskBase64.trim());
      if (secret.length !== 16 && secret.length !== 32) return null;
      kind = "private";
    } else if (norm.toLowerCase() === "public") {
      secret = base64ToBytes(PUBLIC_PSK_B64);
      kind = "public";
    } else {
      // #hashtag channel: key = SHA256("#name")[:16]
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("#" + norm));
      secret = new Uint8Array(digest).slice(0, 16);
      kind = "hashtag";
    }
    if (isPublic) kind = "public";
    const hashDigest = await crypto.subtle.digest("SHA-256", secret);
    return {
      name: norm,
      psk: bytesToBase64(secret),
      key16: secret.slice(0, 16),
      hashByte: new Uint8Array(hashDigest)[0],
      kind,
      isPublic: kind === "public",
    };
  } catch {
    return null;
  }
}

/** The channels shipped with the site: Public + the default hashtag channels. */
export async function defaultChannels(): Promise<Channel[]> {
  const out: Channel[] = [];
  const pub = await deriveChannel("Public", PUBLIC_PSK_B64, true);
  if (pub) out.push({ ...pub, builtin: true });
  for (const name of DEFAULT_HASHTAGS) {
    const ch = await deriveChannel(name);
    if (ch) out.push({ ...ch, builtin: true });
  }
  return out;
}

/**
 * Derive every channel this browser knows: the built-in defaults plus any
 * channels the user added on the Channels page (persisted in localStorage
 * under "mclive.channels"). A stored channel shadows a default of the same
 * name (e.g. the user re-added it with a private PSK).
 * Used wherever GRP_TXT senders need decoding.
 */
export async function loadAllChannels(): Promise<Channel[]> {
  const stored: Channel[] = [];
  try {
    const raw = localStorage.getItem("mclive.channels");
    const entries: { name: string; psk?: string }[] = raw ? JSON.parse(raw) : [];
    for (const c of entries) {
      const ch = await deriveChannel(c.name, c.psk);
      if (ch) stored.push(ch);
    }
  } catch {}
  const storedNames = new Set(stored.map((c) => c.name.toLowerCase()));
  const defaults = await defaultChannels();
  return [
    ...defaults.filter((d) => d.isPublic || !storedNames.has(d.name.toLowerCase())),
    ...stored,
  ];
}

/** Extract the payload (after wire header + path) from a raw wire packet hex. */
function wirePayload(rawHex: string): Uint8Array | null {
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

function plausibleText(s: string): boolean {
  if (!s) return false;
  const chars = [...s];
  let printable = 0;
  for (const c of chars) {
    const code = c.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
  }
  return printable / chars.length > 0.85;
}

/**
 * Try to decode a raw GRP_TXT packet against the given channels. Returns the
 * first channel that decrypts to plausible text, or null.
 */
export function decodeGroupText(rawHex: string, channels: Channel[]): ChannelMessage | null {
  const payload = wirePayload(rawHex);
  if (!payload || payload.length < 1 + 2 + 16) return null;
  const chanHash = payload[0];

  for (const ch of channels) {
    if (ch.hashByte !== chanHash) continue;
    const ct = payload.subarray(3);
    if (ct.length === 0 || ct.length % 16 !== 0) continue;

    let pt: Uint8Array;
    try {
      pt = new aesjs.ModeOfOperation.ecb(ch.key16).decrypt(ct);
    } catch {
      continue;
    }
    if (pt.length < 5) continue;
    const txtType = pt[4];
    if (txtType >> 2 !== 0) continue; // unsupported text type

    const timestamp = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0, true);
    let end = pt.length;
    while (end > 5 && pt[end - 1] === 0) end--; // trim zero padding
    const raw = new TextDecoder().decode(pt.subarray(5, end));
    if (!plausibleText(raw)) continue;

    const idx = raw.indexOf(": ");
    const sender = idx > 0 ? raw.slice(0, idx) : null;
    const text = idx > 0 ? raw.slice(idx + 2) : raw;
    return { channel: ch.name, timestamp, sender, text };
  }
  return null;
}

// ── GRP_DATA (payload type 6) ────────────────────────────────────────────────
// Same channel envelope as GRP_TXT (channel_hash + MAC + AES-128-ECB), but the
// decrypted plaintext is an application datagram instead of chat text:
//   data_type(2 LE) + data_len(1) + blob[data_len]   (BaseChatMesh::onGroupDataRecv)
// The payload we recognise is the "fast GPS" live-position beacon nodes share on
// a channel (meshui MyMesh::maybeSendFastGpsUpdate): it rides in the developer
// data-type 0xFFFF and its blob is
//   magic(0x47) + sender_pubkey_prefix[6] + lat_e6(i32 LE) + lon_e6(i32 LE)
//   + speed(u8, km/h).
// The blob carries no timestamp — the receiver stamps its own RX time, so a
// beacon's effective time is the packet's reception time.

export const DATA_TYPE_DEV = 0xffff; // developer data-type namespace
const FAST_GPS_MAGIC = 0x47;
const FAST_GPS_PAYLOAD_LEN = 16;

export interface GroupLocation {
  /** first 6 bytes of the sender's public key (hex) — match against the node directory */
  pubkeyPrefix: string;
  lat: number;
  lon: number;
  /** sender's ground speed, km/h (0 = stationary/unknown) */
  speed: number;
}

export interface GroupDataMessage {
  channel: string;
  /** 16-bit application data-type (0xFFFF = developer namespace) */
  dataType: number;
  /** decoded position when this datagram is a fast-GPS location beacon, else null */
  location: GroupLocation | null;
}

function readI32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}

/** Parse a fast-GPS beacon blob into a position, or null if it isn't one. */
function decodeFastGps(dataType: number, blob: Uint8Array): GroupLocation | null {
  if (dataType !== DATA_TYPE_DEV) return null;
  if (blob.length < FAST_GPS_PAYLOAD_LEN || blob[0] !== FAST_GPS_MAGIC) return null;
  const lat = readI32LE(blob, 7) / 1e6;
  const lon = readI32LE(blob, 11) / 1e6;
  // Range-check the fix — this also stands in for the MAC we don't verify, so a
  // wrong key almost never survives the magic byte + in-range lat/lon together.
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  if (lat === 0 && lon === 0) return null; // node has no GPS fix
  let prefix = "";
  for (let i = 1; i <= 6; i++) prefix += blob[i].toString(16).padStart(2, "0");
  return { pubkeyPrefix: prefix, lat, lon, speed: blob[15] };
}

/**
 * Try to decode a raw GRP_DATA packet against the given channels. A recognised
 * fast-GPS location beacon (magic byte + in-range lat/lon) is a strong match and
 * is returned as soon as it's found; otherwise the first channel whose key
 * yields a structurally valid datagram is returned best-effort with
 * location=null. Returns null when no channel key fits.
 */
export function decodeGroupData(rawHex: string, channels: Channel[]): GroupDataMessage | null {
  const payload = wirePayload(rawHex);
  if (!payload || payload.length < 1 + 2 + 16) return null;
  const chanHash = payload[0];

  let fallback: GroupDataMessage | null = null;
  for (const ch of channels) {
    if (ch.hashByte !== chanHash) continue;
    const ct = payload.subarray(3);
    if (ct.length === 0 || ct.length % 16 !== 0) continue;

    let pt: Uint8Array;
    try {
      pt = new aesjs.ModeOfOperation.ecb(ch.key16).decrypt(ct);
    } catch {
      continue;
    }
    if (pt.length < 3) continue;
    const dataType = pt[0] | (pt[1] << 8);
    const dataLen = pt[2];
    if (dataLen > pt.length - 3) continue; // declared length doesn't fit → wrong key

    const location = decodeFastGps(dataType, pt.subarray(3, 3 + dataLen));
    if (location) return { channel: ch.name, dataType, location };
    // Structurally plausible but unrecognised payload: a 1-byte channel hash is
    // weak, so keep this only as a fallback in case nothing decodes to a beacon.
    if (!fallback) fallback = { channel: ch.name, dataType, location: null };
  }
  return fallback;
}
