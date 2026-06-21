import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ADV_TYPE_NAMES, formatAgo, formatDateTime } from "@/lib/meshcore";
import type { AdvertInfo } from "@/lib/meshcore";
import { decodeGroupData, loadAllChannels } from "@/lib/channel";
import { classifyAdvertHealth, DAY_MS, fmtDur, median } from "@/lib/advertHealth";
import { cn } from "@/lib/utils";
import { Download, MapPin } from "lucide-react";
import DetailMap, { type BeaconPoint } from "./DetailMap";

/** One ADVERT transmission, decoded server-side (/~/api/adverts/:pubkey/history). */
interface AdvertEvent {
  id: number;
  hash: string | null;
  first_seen: number;
  last_seen: number;
  reception_count: number;
  best_snr: number | null;
  best_rssi: number | null;
  name: string;
  adv_type: number;
  has_lat_lon: boolean;
  lat: number | null;
  lon: number | null;
  adv_timestamp: number; // node's own clock, epoch secs (0 if unset)
}

interface Props {
  /** node to show, or null for closed */
  pubkey: string | null;
  /** fallback header info while history loads */
  fallbackName?: string;
  onClose: () => void;
  /** drill into one advert's full packet detail */
  onOpenPacket: (id: number) => void;
}

const FETCH_LIMIT = 500;
const LOC_DEPTH_MS = 48 * 60 * 60 * 1000;

/** A fast-GPS location update (GRP_DATA beacon) this contact broadcast. */
interface LocUpdate {
  id: number;
  lat: number;
  lon: number;
  speed: number; // sender's ground speed, km/h (0 = stationary/unknown)
  at: number; // reception time, ms
}

export default function NodeAdvertSheet({ pubkey, fallbackName, onClose, onOpenPacket }: Props) {
  const [events, setEvents] = useState<AdvertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [locations, setLocations] = useState<LocUpdate[]>([]);

  useEffect(() => {
    if (!pubkey) return;
    setEvents([]);
    setLoading(true);
    let cancelled = false;
    fetch(`/~/api/adverts/${encodeURIComponent(pubkey)}/history?limit=${FETCH_LIMIT}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setEvents(d.events ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  // Fast-GPS location updates this contact shared on a channel. The sender lives
  // inside the encrypted GRP_DATA payload, so we can't filter server-side — pull
  // recent type-6 beacons (bucketed across 48h), decrypt with the channel keys
  // this browser holds, and keep the ones whose pubkey prefix matches this node.
  useEffect(() => {
    if (!pubkey) {
      setLocations([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const channels = await loadAllChannels().catch(() => []);
      if (cancelled || channels.length === 0) return;
      const since = Date.now() - LOC_DEPTH_MS;
      const res = await fetch(
        `/~/api/packets?type=6&since=${since}&bucket=600000&perBucket=15&limit=8000`
      )
        .then((r) => r.json())
        .catch(() => ({ packets: [] }));
      if (cancelled) return;
      const pk = pubkey.toLowerCase();
      const out: LocUpdate[] = [];
      for (const p of res.packets ?? []) {
        if (!p.raw) continue;
        const loc = decodeGroupData(p.raw, channels)?.location;
        if (!loc || !pk.startsWith(loc.pubkeyPrefix.toLowerCase())) continue;
        out.push({ id: p.id ?? 0, lat: loc.lat, lon: loc.lon, speed: loc.speed, at: p.last_seen });
      }
      out.sort((a, b) => b.at - a.at); // newest first
      setLocations(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const now = Date.now();

  const stats = useMemo(() => {
    if (events.length === 0) return null;
    // events arrive newest-first; intervals need oldest-first
    const asc = [...events].sort((a, b) => a.first_seen - b.first_seen);
    const gaps: number[] = [];
    for (let i = 1; i < asc.length; i++) gaps.push(asc[i].first_seen - asc[i - 1].first_seen);
    const typical = median(gaps);
    const lastSeen = asc[asc.length - 1].first_seen;
    const age = now - lastSeen;

    const health = classifyAdvertHealth(typical, gaps.length, age);

    const last24h = events.filter((e) => e.first_seen >= now - DAY_MS).length;
    const avgReach = events.reduce((s, e) => s + (e.reception_count || 0), 0) / events.length;
    const bestSnr = events.reduce<number | null>(
      (best, e) => (e.best_snr != null && (best == null || e.best_snr > best) ? e.best_snr : best),
      null
    );
    // clock drift: node-reported advert time vs when we first heard it
    const offsets = events
      .filter((e) => e.adv_timestamp > 0)
      .map((e) => e.first_seen - e.adv_timestamp * 1000);
    const clockOffset = median(offsets);
    const renames = new Set(asc.map((e) => e.name || "")).size - 1;

    // adverts per day, oldest → newest, for the 14-day strip
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const days: { t: number; n: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const t = dayStart.getTime() - i * DAY_MS;
      days.push({ t, n: events.filter((e) => e.first_seen >= t && e.first_seen < t + DAY_MS).length });
    }

    return { asc, typical, lastSeen, age, health, last24h, avgReach, bestSnr, clockOffset, renames, days };
  }, [events, now]);

  const latest = events[0] ?? null;
  const name = latest?.name || fallbackName || (pubkey ? `${pubkey.slice(0, 12)}…` : "");
  const truncated = events.length >= FETCH_LIMIT;

  // most recent self-reported location (0,0 = advertised without a GPS fix)
  const located =
    latest?.has_lat_lon &&
    latest.lat != null &&
    latest.lon != null &&
    !(latest.lat === 0 && latest.lon === 0)
      ? { lat: latest.lat, lon: latest.lon }
      : null;

  // synthesize an AdvertInfo so the shared DetailMap can plot the node (no hops)
  const advertForMap: AdvertInfo | null =
    located && pubkey
      ? {
          pubkey,
          hashPrefix: pubkey.slice(0, 2),
          advType: latest!.adv_type,
          hasLatLon: true,
          lat: located.lat,
          lon: located.lon,
          name: latest!.name,
          advTimestamp: latest!.adv_timestamp,
        }
      : null;

  // node's own clock reading from its latest advert (epoch secs, 0 = unset)
  const nodeClock = latest && latest.adv_timestamp > 0 ? latest.adv_timestamp * 1000 : null;

  // most recent fast-GPS fix — plotted on the map (amber) and tiled below
  const latestLoc = locations[0] ?? null;
  const beaconForMap: BeaconPoint | null = latestLoc
    ? { lat: latestLoc.lat, lon: latestLoc.lon, label: `${name} — live GPS` }
    : null;

  return (
    <Sheet open={pubkey != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 pb-3 pt-5 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <span className="truncate">{name}</span>
            {latest && (
              <Badge variant={latest.adv_type === 2 ? "default" : "outline"}>
                {ADV_TYPE_NAMES[latest.adv_type] ?? `type ${latest.adv_type}`}
              </Badge>
            )}
            {stats && (
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", stats.health.cls)}>
                {stats.health.label}
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{pubkey}</SheetDescription>
          {stats && <p className="text-muted-foreground text-xs">{stats.health.detail}</p>}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && <p className="text-muted-foreground px-4 py-6 text-center text-xs">Loading advert history…</p>}
          {!loading && events.length === 0 && (
            <p className="text-muted-foreground px-4 py-6 text-center text-xs">
              No adverts on record for this node.
            </p>
          )}

          {stats && (
            <>
              {/* advert location (rose) + latest live-GPS fix (amber), plotted together */}
              {(advertForMap || beaconForMap) && (
                <div className="px-4 pt-3">
                  <DetailMap advert={advertForMap} hops={[]} beacon={beaconForMap} />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 px-4 py-3">
                <Tile
                  label="Location"
                  value={located ? `${located.lat.toFixed(4)}, ${located.lon.toFixed(4)}` : "—"}
                  sub={located ? "self-reported position" : "no GPS fix advertised"}
                />
                {latestLoc && (
                  <Tile
                    label="Live GPS"
                    value={`${latestLoc.lat.toFixed(4)}, ${latestLoc.lon.toFixed(4)}`}
                    sub={`fast-GPS · ${formatAgo(latestLoc.at, now)}`}
                  />
                )}
                <Tile
                  label="Node clock"
                  value={
                    stats.clockOffset != null
                      ? Math.abs(stats.clockOffset) < 5000
                        ? "in sync"
                        : `~${fmtDur(Math.abs(stats.clockOffset))} ${stats.clockOffset >= 0 ? "behind" : "ahead"}`
                      : "—"
                  }
                  sub={nodeClock != null ? `reads ${formatDateTime(nodeClock)}` : "no node timestamp"}
                />
                <Tile label="Last advert" value={formatAgo(stats.lastSeen, now)} sub={formatDateTime(stats.lastSeen)} />
                <Tile
                  label="Typical interval"
                  value={stats.typical != null ? `~${fmtDur(stats.typical)}` : "—"}
                  sub={stats.typical != null ? `median of ${stats.asc.length - 1} gaps` : "needs ≥3 adverts"}
                />
                <Tile label="Last 24 h" value={String(stats.last24h)} sub="adverts heard" />
                <Tile
                  label="History"
                  value={`${events.length}${truncated ? "+" : ""}`}
                  sub={`since ${formatDateTime(stats.asc[0].first_seen)}`}
                />
                <Tile
                  label="Reach"
                  value={stats.avgReach.toFixed(1)}
                  sub="avg observers per advert"
                />
                <Tile
                  label="Best SNR"
                  value={stats.bestSnr != null ? `${stats.bestSnr.toFixed(1)} dB` : "—"}
                  sub="best across history"
                />
              </div>

              {/* adverts per day, last 14 days */}
              <div className="px-4 pb-3">
                <div className="text-muted-foreground mb-1 flex justify-between text-[11px]">
                  <span>adverts / day</span>
                  <span>last 14 days</span>
                </div>
                <div className="flex h-12 items-end gap-1">
                  {stats.days.map(({ t, n }) => {
                    const max = Math.max(1, ...stats.days.map((d) => d.n));
                    return (
                      <div
                        key={t}
                        title={`${new Date(t).toLocaleDateString()}: ${n} adverts`}
                        className={cn("flex-1 rounded-sm", n > 0 ? "bg-primary/70" : "bg-muted")}
                        style={{ height: n > 0 ? `${Math.max(12, (n / max) * 100)}%` : "4px" }}
                      />
                    );
                  })}
                </div>
                {stats.renames > 0 && (
                  <p className="text-muted-foreground mt-2 text-[11px]">
                    ⚠ advertised under {stats.renames + 1} different names — see history below
                  </p>
                )}
              </div>

              {/* fast-GPS location updates, newest first */}
              {locations.length > 0 && (
                <div className="border-t px-4 py-3">
                  <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide">
                    <MapPin className="size-3.5 text-amber-500" /> Location updates ({locations.length})
                    <span className="ml-auto flex items-center gap-0.5">
                      <Download className="size-3" />
                      {(["gpx", "kml", "kmz"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => pubkey && exportTrack(fmt, name, pubkey, locations)}
                          title={`Export as ${fmt.toUpperCase()} track`}
                          className="hover:text-foreground hover:bg-muted/60 rounded px-1.5 py-0.5 transition-colors"
                        >
                          {fmt.toUpperCase()}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {locations.slice(0, 50).map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => onOpenPacket(l.id)}
                        title="Open packet detail"
                        className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs tabular-nums transition-colors"
                      >
                        <MapPin className="size-3 shrink-0 text-amber-500" />
                        <span className="font-mono">{l.lat.toFixed(5)}, {l.lon.toFixed(5)}</span>
                        <span className="text-muted-foreground ml-auto shrink-0">{formatAgo(l.at, now)}</span>
                      </button>
                    ))}
                  </div>
                  {locations.length > 50 && (
                    <p className="text-muted-foreground mt-1.5 text-[11px]">showing newest 50 of {locations.length}</p>
                  )}
                </div>
              )}

              {/* event list, newest first */}
              <div className="border-t">
                {events.map((e, i) => {
                  const next = events[i + 1]; // chronologically previous advert
                  const gap = next ? e.first_seen - next.first_seen : null;
                  const renamed = next && (next.name || "") !== (e.name || "");
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onOpenPacket(e.id)}
                      title="Open packet detail"
                      className="hover:bg-muted/60 block w-full border-b px-4 py-2 text-left text-xs transition-colors"
                    >
                      <span className="flex items-center gap-2 tabular-nums">
                        <span className="font-mono">{formatDateTime(e.first_seen)}</span>
                        <span className="text-muted-foreground">{formatAgo(e.first_seen, now)}</span>
                        <span className="text-muted-foreground ml-auto shrink-0">
                          {e.reception_count} obs{e.best_snr != null ? ` · ${e.best_snr.toFixed(1)} dB` : ""}
                        </span>
                      </span>
                      <span className="text-muted-foreground mt-0.5 block">
                        {gap != null ? `+${fmtDur(gap)} after previous` : "first on record"}
                        {renamed && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {" "}· renamed “{next!.name || "(unnamed)"}” → “{e.name || "(unnamed)"}”
                          </span>
                        )}
                        {e.has_lat_lon && next?.has_lat_lon && (e.lat !== next.lat || e.lon !== next.lon) && (
                          <span className="text-amber-600 dark:text-amber-400"> · moved</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const xmlEscape = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** reception time (ms) — beacons carry no GPS clock; the receiver stamps RX time */
const locTimeIso = (l: LocUpdate) => new Date(l.at).toISOString();
const ascByTime = (locs: LocUpdate[]) => [...locs].sort((a, b) => a.at - b.at);

/**
 * Serialize a contact's fast-GPS fixes to GPX 1.1 as a single track, oldest →
 * newest, timestamped by our reception time (beacons carry no GPS clock).
 */
function buildGpx(name: string, pubkey: string, locs: LocUpdate[]): string {
  const pts = ascByTime(locs)
    .map(
      (l) =>
        `      <trkpt lat="${l.lat.toFixed(6)}" lon="${l.lon.toFixed(6)}"><time>${locTimeIso(l)}</time></trkpt>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="mclive" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEscape(name)}</name>
    <desc>fast-GPS location history · ${xmlEscape(pubkey)}</desc>
  </metadata>
  <trk>
    <name>${xmlEscape(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Serialize the same fixes to KML 2.2 as a time-stamped gx:Track (the standard
 * analog to a GPX track): all <when> stamps, then all <gx:coord> lon/lat/alt.
 */
function buildKml(name: string, pubkey: string, locs: LocUpdate[]): string {
  const asc = ascByTime(locs);
  const whens = asc.map((l) => `        <when>${locTimeIso(l)}</when>`).join("\n");
  const coords = asc
    .map((l) => `        <gx:coord>${l.lon.toFixed(6)} ${l.lat.toFixed(6)} 0</gx:coord>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEscape(name)}</name>
    <description>fast-GPS location history · ${xmlEscape(pubkey)}</description>
    <Style id="track">
      <LineStyle><color>ff0b9ef5</color><width>3</width></LineStyle>
    </Style>
    <Placemark>
      <name>${xmlEscape(name)}</name>
      <styleUrl>#track</styleUrl>
      <gx:Track>
${whens}
${coords}
      </gx:Track>
    </Placemark>
  </Document>
</kml>
`;
}

// CRC-32 (IEEE) for the KMZ ZIP container — computed per call, no lookup table.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal single-file ZIP, stored (no compression) — enough for a .kmz. */
function zipStore(filename: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(filename);
  const crc = crc32(data);
  const size = data.length;

  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); // local file header sig
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(8, 0, true); // method: store
  lv.setUint32(14, crc, true);
  lv.setUint32(18, size, true); // compressed size
  lv.setUint32(22, size, true); // uncompressed size
  lv.setUint16(26, name.length, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); // central dir header sig
  cv.setUint16(4, 20, true); // version made by
  cv.setUint16(6, 20, true); // version needed
  cv.setUint32(16, crc, true);
  cv.setUint32(20, size, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);

  const localTotal = local.length + size;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir sig
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // total entries
  ev.setUint32(12, central.length, true); // central dir size
  ev.setUint32(16, localTotal, true); // central dir offset

  const out = new Uint8Array(localTotal + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, localTotal);
  out.set(end, localTotal + central.length);
  return out;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function trackSlug(name: string, pubkey: string): string {
  return (
    (name || pubkey.slice(0, 12)).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "track"
  );
}

function exportTrack(format: "gpx" | "kml" | "kmz", name: string, pubkey: string, locs: LocUpdate[]) {
  const slug = trackSlug(name, pubkey);
  if (format === "gpx") {
    triggerDownload(new Blob([buildGpx(name, pubkey, locs)], { type: "application/gpx+xml" }), `${slug}.gpx`);
  } else if (format === "kml") {
    triggerDownload(
      new Blob([buildKml(name, pubkey, locs)], { type: "application/vnd.google-earth.kml+xml" }),
      `${slug}.kml`
    );
  } else {
    const zip = zipStore("doc.kml", new TextEncoder().encode(buildKml(name, pubkey, locs)));
    triggerDownload(new Blob([zip], { type: "application/vnd.google-earth.kmz" }), `${slug}.kmz`);
  }
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-muted-foreground truncate text-[11px]">{sub}</div>}
    </div>
  );
}
