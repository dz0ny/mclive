// Shared MeshCore types + display helpers for the live dashboard.

import { analyzeRaw, bytesToHex, PAYLOAD_TYPE_ADVERT } from "../../worker/lib/decode.js";

/** A logical packet (deduped by hash; heard by one or more observers). */
export interface Packet {
  id: number | null;
  hash: string | null;
  ts: string | null;
  first_seen: number;
  last_seen: number;
  direction: string | null;
  payload_type: number | null;
  route: string | null;
  len: number | null;
  payload_len: number | null;
  /** latest reception's path node-hash bytes (hex), e.g. ["a1","b2"] */
  path: string[];
  reception_count: number;
  best_snr: number | null;
  best_rssi: number | null;
  /** full wire packet hex (present from the API and SSE; used to decode channels) */
  raw?: string;
  /**
   * Region scope for transport-routed packets: region name (e.g. "si"),
   * "" = transport codes matching no known region (incl. Share), null/absent
   * otherwise.
   */
  scope?: string | null;
}

export interface Reception {
  origin: string | null;
  origin_id: string | null;
  iata: string | null;
  snr: number | null;
  rssi: number | null;
  path: string[];
  received_at: number;
  obs_lat?: number | null;
  obs_lon?: number | null;
}

export interface DecodedWire {
  route: string;
  routeType: number;
  payloadType: number;
  version: number;
  pathHashSize: number;
  pathBytes: string[];
  /**
   * TRACE (type 9) per-hop SNR measurements in dB — one per link the trace has
   * traversed so far. traceSnrs[i] is the signal hop i+1 heard from hop i.
   */
  traceSnrs?: number[] | null;
  /** transport codes [scope, reply] for TRANSPORT-routed packets, else null */
  transportCodes?: [number, number] | null;
  /** matched region name, "" = unknown region / Share, null = not transport */
  scope?: string | null;
  payloadOffset: number;
  payloadLen: number;
  payloadHex: string;
}

export interface Hop {
  hash: string;
  node: MeshNode | null;
}

export interface AdvertInfo {
  pubkey: string;
  hashPrefix: string;
  advType: number;
  hasLatLon: boolean;
  lat: number | null;
  lon: number | null;
  name: string;
  advTimestamp: number;
}

export interface PacketDetail {
  packet: Packet;
  decoded: DecodedWire | null;
  hops: Hop[];
  receptions: Reception[];
  advert: AdvertInfo | null;
  advertNode: MeshNode | null;
}

export interface MeshNode {
  pubkey: string;
  hash_prefix: string;
  name: string | null;
  adv_type: number | null;
  lat: number;
  lon: number;
  last_advert_ts: number | null;
  updated_at: number;
}

export interface Device {
  origin_id: string;
  origin: string | null;
  iata: string | null;
  lat: number | null;
  lon: number | null;
  last_seen: number;
  /** "advert" if location came from the device's self-advert, else "iata" */
  loc_source?: "advert" | "iata";
}

/** An observing device with its latest /status report + reception aggregates. */
export interface Observer {
  origin_id: string;
  origin: string | null;
  iata: string | null;
  lat: number | null;
  lon: number | null;
  last_seen: number;
  last_status_at: number | null;
  uptime_secs: number | null;
  firmware_version: string | null;
  model: string | null;
  battery_mv: number | null;
  clock_offset_ms: number | null;
  total_packets: number;
  packets_last_hour: number;
  last_packet_at: number | null;
}

/** The advertised node's pubkey for an ADVERT packet (decoded from raw), else null. */
export function advertPubkey(p: Packet): string | null {
  if (p.payload_type === PAYLOAD_TYPE_ADVERT && p.raw) {
    const { advert } = analyzeRaw(p.raw);
    return advert?.pubkey ?? null;
  }
  return null;
}

// Payload types whose payload starts dest_hash + src_hash — the src hash is a
// prefix of the sender's pubkey (see Mesh.cpp / Dispatcher logging). Both
// hashes are pathHashSize bytes wide (1 on old networks, 2+ on newer ones).
const SRC_HASH_TYPES = new Set([0, 1, 2, 8]); // REQ, RESPONSE, TXT_MSG, PATH
const PAYLOAD_TYPE_ANON_REQ = 7; // dest_hash + sender pubkey(32) + ...

/**
 * The sender's on-wire identity hash (hex pubkey prefix), where the protocol
 * carries one. ADVERT → full pubkey; REQ/RESPONSE/TXT_MSG/PATH → src hash
 * (pathHashSize bytes); ANON_REQ → full pubkey. Returns null for types without
 * a wire sender (ACK, GRP_TXT/GRP_DATA — the group sender hides inside the
 * ciphertext).
 *
 * Note the path is NOT used: flood relays append their own hash when
 * re-flooding (Mesh::routeRecvPacket), so path hops are relays, never the
 * originator.
 */
export function senderHash(p: Packet): string | null {
  if (!p.raw || p.payload_type == null) return null;
  if (p.payload_type === PAYLOAD_TYPE_ADVERT) return advertPubkey(p);
  if (SRC_HASH_TYPES.has(p.payload_type)) {
    const { packet } = analyzeRaw(p.raw);
    const hs = packet?.pathHashSize ?? 1;
    if (packet?.payload && packet.payload.length >= hs * 2) {
      return bytesToHex(packet.payload, hs, hs * 2);
    }
  }
  if (p.payload_type === PAYLOAD_TYPE_ANON_REQ) {
    const { packet } = analyzeRaw(p.raw);
    const hs = packet?.pathHashSize ?? 1;
    if (packet?.payload && packet.payload.length >= hs + 32) {
      return bytesToHex(packet.payload, hs, hs + 32);
    }
  }
  return null;
}

/**
 * Match a packet against a sender filter query. Hex token(s) (space-separated,
 * 1–4 bytes each, e.g. "a3 7f", "baba cfcf", "a1b2c3") match the packet's
 * on-wire sender hash (advert/anon-req pubkey or src hash) or its path hops
 * (prefix either way, so any network hash size works). A non-hex query matches
 * the resolved sender name (substring).
 */
export function matchesSenderQuery(p: Packet, query: string, nodes: MeshNode[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/);
  const allHex = tokens.every((t) => t.length >= 2 && t.length <= 8 && t.length % 2 === 0 && /^[0-9a-f]+$/.test(t));
  if (allHex) {
    const path = p.path.map((h) => h.toLowerCase());
    const sh = senderHash(p)?.toLowerCase() ?? null;
    return tokens.some(
      (h) =>
        path.some((t) => t.startsWith(h) || h.startsWith(t)) ||
        (sh != null && (sh.startsWith(h) || h.startsWith(sh)))
    );
  }
  return (senderName(p, nodes) ?? "").toLowerCase().includes(q);
}

export type ObserverStatus = "online" | "stale" | "offline";

/** Liveness from the most recent of any signal (status, packet, last_seen). */
export function observerStatus(o: Observer, now = Date.now()): ObserverStatus {
  const ref = Math.max(o.last_seen || 0, o.last_packet_at || 0, o.last_status_at || 0);
  const age = now - ref;
  if (age < 120_000) return "online"; // < 2 min
  if (age < 900_000) return "stale"; // < 15 min
  return "offline";
}

/** Compact "22s ago" / "5m ago" / "11d 17h" style relative time. */
export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

/** Device uptime "16m" / "22h 44m" / "11d 17h". */
export function formatUptime(secs: number | null | undefined): string {
  if (secs == null || secs < 0) return "—";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export const PAYLOAD_TYPE_NAMES: Record<number, string> = {
  0: "REQ",
  1: "RESPONSE",
  2: "TXT",
  3: "ACK",
  4: "ADVERT",
  5: "GRP_TXT",
  6: "GRP_DATA",
  7: "ANON_REQ",
  8: "PATH",
  9: "TRACE",
  10: "MULTIPART",
  11: "CONTROL",
  15: "RAW_CUSTOM",
};

export function payloadTypeName(t: number | null | undefined): string {
  if (t === null || t === undefined) return "?";
  return PAYLOAD_TYPE_NAMES[t] ?? `T${t}`;
}

export const ROUTE_LABELS: Record<string, string> = {
  F: "Flood",
  D: "Direct",
  T: "Transport",
  U: "Unknown",
};

export function routeLabel(r: string | null | undefined): string {
  if (!r) return "—";
  return ROUTE_LABELS[r] ?? r;
}

/** What each payload type means (from the MeshCore firmware's Packet.h). */
export const PAYLOAD_TYPE_DESCRIPTIONS: Record<number, string> = {
  0: "An encrypted request to a specific node (login, status or telemetry query). Only the destination node can decrypt it.",
  1: "An encrypted response to an earlier request — only the requesting node can read it.",
  2: "A private text message between two nodes, end-to-end encrypted with their shared secret.",
  3: "A tiny acknowledgement confirming a message was delivered.",
  4: "A node announcing its identity: public key, signed timestamp, name, node type and (optionally) its location. This is how the mesh learns who is out there.",
  5: "A group chat message on a channel. Encrypted with the channel's shared key — anyone holding the key (e.g. Public or a #hashtag) can decode it.",
  6: "A group datagram: arbitrary application data shared on a channel, encrypted like group text.",
  7: "An anonymous request carrying an ephemeral public key — used e.g. to log in to a room server without being a known contact.",
  8: "A returned route: tells the original sender which path to use to reach a node directly instead of flooding.",
  9: "A diagnostic traceroute along a fixed path — each repeater appends its measured SNR, mapping link quality hop by hop.",
  10: "One part of a larger payload that was split across multiple packets.",
  11: "A control/discovery packet used internally by the mesh.",
  15: "Raw custom bytes for applications that bring their own encryption and format.",
};

export function payloadTypeDescription(t: number | null | undefined): string {
  if (t === null || t === undefined) return "Unknown packet type.";
  return PAYLOAD_TYPE_DESCRIPTIONS[t] ?? `Unknown packet type (${t}).`;
}

export const ROUTE_DESCRIPTIONS: Record<string, string> = {
  F: "Flood routing: every repeater that hears it rebroadcasts it, and each hop appends its hash to the path.",
  D: "Direct routing: the packet follows a predetermined path of repeaters instead of flooding the whole mesh.",
  T: "Transport routing: flood/direct delivery scoped to a region. The packet carries a 2-byte code (an HMAC of the payload under the region's key) and only repeaters configured for that region recognize it and forward.",
  U: "Unknown routing mode.",
};

/**
 * Display label for a packet's region scope: "#si" when detected, "#?" for
 * transport packets whose code matches no known region, null when the packet
 * isn't transport-routed (nothing to show).
 */
export function scopeLabel(scope: string | null | undefined, route?: string | null): string | null {
  if (scope) return `#${scope}`;
  if (scope === "" || route === "T") return "#?";
  return null;
}

/** Badge classes per payload type (light + dark variants). */
export const PAYLOAD_TYPE_BADGE: Record<number, string> = {
  0: "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
  1: "border-lime-300 bg-lime-100 text-lime-800 dark:border-lime-500/40 dark:bg-lime-500/15 dark:text-lime-300",
  2: "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-300",
  3: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-300",
  4: "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
  5: "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300",
  6: "border-purple-300 bg-purple-100 text-purple-800 dark:border-purple-500/40 dark:bg-purple-500/15 dark:text-purple-300",
  7: "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-300",
  8: "border-cyan-300 bg-cyan-100 text-cyan-800 dark:border-cyan-500/40 dark:bg-cyan-500/15 dark:text-cyan-300",
  9: "border-pink-300 bg-pink-100 text-pink-800 dark:border-pink-500/40 dark:bg-pink-500/15 dark:text-pink-300",
  10: "border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-500/40 dark:bg-stone-500/15 dark:text-stone-300",
  11: "border-yellow-300 bg-yellow-100 text-yellow-800 dark:border-yellow-500/40 dark:bg-yellow-500/15 dark:text-yellow-300",
  15: "border-red-300 bg-red-100 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
};

export function typeBadgeClass(t: number | null | undefined): string {
  return (t != null && PAYLOAD_TYPE_BADGE[t]) || "border-border bg-muted text-muted-foreground";
}

/**
 * Solid fill color per payload type (tailwind-500 hues, mirroring the badge
 * palette above). For SVG/canvas where a className isn't usable — e.g. the
 * timeline histogram. Unknown types fall back to a neutral grey.
 */
export const PAYLOAD_TYPE_COLOR: Record<number, string> = {
  0: "#f59e0b", // amber
  1: "#84cc16", // lime
  2: "#3b82f6", // blue
  3: "#64748b", // slate
  4: "#10b981", // emerald
  5: "#8b5cf6", // violet
  6: "#a855f7", // purple
  7: "#f97316", // orange
  8: "#06b6d4", // cyan
  9: "#ec4899", // pink
  10: "#78716c", // stone
  11: "#eab308", // yellow
  15: "#ef4444", // red
};

export function payloadTypeColor(t: number | null | undefined): string {
  return (t != null && PAYLOAD_TYPE_COLOR[t]) || "#94a3b8";
}

/** Badge classes per route mode. */
export const ROUTE_BADGE: Record<string, string> = {
  F: "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-300",
  D: "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
  T: "border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-300",
};

export function routeBadgeClass(r: string | null | undefined): string {
  return (r && ROUTE_BADGE[r]) || "border-border bg-muted text-muted-foreground";
}

/** Link-quality text color by SNR (dB): strong / usable / weak. */
export function snrClass(snr: number): string {
  if (snr >= 10) return "text-emerald-600 dark:text-emerald-400";
  if (snr >= 4) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Stable-ish color per node hash byte for trace lines / markers. */
export function hashColor(hashByte: string): string {
  const n = parseInt(hashByte, 16);
  const hue = (Number.isNaN(n) ? 0 : n) * 1.41 % 360;
  return `hsl(${hue.toFixed(0)} 80% 55%)`;
}

/**
 * Resolve a path hash to a node. Path hashes are 1–4 bytes (the leading bytes
 * of the sender's pubkey), so match by pubkey prefix rather than a fixed byte.
 */
export function nodeForHash(hash: string, nodes: MeshNode[]): MeshNode | null {
  if (!hash) return null;
  const h = hash.toLowerCase();
  for (const n of nodes) {
    if (n.pubkey.toLowerCase().startsWith(h)) return n;
  }
  return null;
}

/**
 * Resolve the originating node's display name for a packet.
 *
 * For an ADVERT the sender is the identity carried *inside* the packet (the
 * advertised pubkey + name decoded from `raw`), not a path hash — adverts flood
 * from their origin with an empty path, so `path[0]` is absent. For every other
 * payload type the sender is the first path hash (a 1–4 byte pubkey prefix),
 * resolved against the known-node directory.
 *
 * Returns null when the sender can't be determined (unknown relay, no raw).
 */
export function senderName(p: Packet, nodes: MeshNode[]): string | null {
  // Adverts carry the most context: directory name, then the advert's own
  // embedded name, then a short pubkey.
  if (p.payload_type === PAYLOAD_TYPE_ADVERT && p.raw) {
    const { advert } = analyzeRaw(p.raw);
    if (advert) {
      const known = nodes.find((n) => n.pubkey.toLowerCase() === advert.pubkey.toLowerCase());
      return known?.name || advert.name || advert.pubkey.slice(0, 12);
    }
  }
  // Other types: resolve the on-wire sender hash against the node directory;
  // fall back to showing the raw hash so an unknown sender still attributes.
  const h = senderHash(p);
  if (!h) return null;
  const node = nodeForHash(h, nodes);
  return node?.name || (h.length > 8 ? h.slice(0, 12) : h);
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { hour12: false });
}

export const ADV_TYPE_NAMES: Record<number, string> = {
  0: "none",
  1: "chat",
  2: "repeater",
  3: "room",
  4: "sensor",
};
