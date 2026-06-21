import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Eye, EyeOff, Grid3x3, History, Link2, Radio, Route, X } from "lucide-react";
import { useLiveFeed } from "./useLiveFeed";
import { useStats } from "./useStats";
import PacketMap, {
  heatColor,
  type CoverageCell,
  type CoverageLayer,
  type LivePosition,
  type MapViewState,
} from "./PacketMap";
import { StatusPill } from "./ui-bits";
import { decodeGroupData, loadAllChannels, type Channel } from "@/lib/channel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { MeshNode, Packet } from "@/lib/meshcore";
import {
  formatAgo,
  formatTime,
  nodeForHash,
  payloadTypeName,
  senderName,
  typeBadgeClass,
} from "@/lib/meshcore";
import { cn } from "@/lib/utils";

// adv_type values, matching PacketMap's TYPE_STYLE marker colors.
const NODE_TYPES: { type: number; color: string; label: string }[] = [
  { type: 2, color: "#16a34a", label: "Repeater" },
  { type: 1, color: "#0ea5e9", label: "Chat node" },
  { type: 3, color: "#9333ea", label: "Room server" },
  { type: 4, color: "#ea580c", label: "Sensor" },
];

// sidebar time windows; never more rows than MAX_ROWS regardless of window
const WINDOWS = [
  { key: "1h", label: "last hour", ms: 60 * 60 * 1000 },
  { key: "12h", label: "last 12 h", ms: 12 * 60 * 60 * 1000 },
  { key: "24h", label: "last 24 h", ms: 24 * 60 * 60 * 1000 },
  { key: "48h", label: "last 48 h", ms: 48 * 60 * 60 * 1000 },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];
const MAX_ROWS = 30;

// How far back the position-rewind scrubber can reach — independent of the
// paths-list window selector so you can always rewind the full depth.
const REWIND_DEPTH_MS = 48 * 60 * 60 * 1000;

type LonLatExtent = [number, number, number, number];

// shareable view: ?v=<lat>,<lon>,<zoom>&w=<window>
function viewFromUrl(): MapViewState | null {
  if (typeof location === "undefined") return null;
  const v = new URLSearchParams(location.search).get("v");
  if (!v) return null;
  const [lat, lon, zoom] = v.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(zoom)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, zoom: Math.min(Math.max(zoom, 1), 22) };
}

function windowFromUrl(): WindowKey {
  if (typeof location === "undefined") return "1h";
  const w = new URLSearchParams(location.search).get("w");
  return WINDOWS.some((x) => x.key === w) ? (w as WindowKey) : "1h";
}

// hidden node types travel as ?hide=<type>,<type>… so a filtered legend shares
function hiddenFromUrl(): Set<number> {
  if (typeof location === "undefined") return new Set();
  const h = new URLSearchParams(location.search).get("hide");
  if (!h) return new Set();
  return new Set(h.split(",").map(Number).filter((n) => Number.isFinite(n)));
}

// a traced path travels as ?pin=<hash> (restored once its packet is loaded)
function pinFromUrl(): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get("pin");
}

// the rewind cutoff travels as ?rw=<epoch-ms> (absolute, so a shared "rewound to
// 14:53" link lands on the same instant); clamped into the live span on load
function rewindFromUrl(): number | null {
  if (typeof location === "undefined") return null;
  const r = new URLSearchParams(location.search).get("rw");
  if (!r) return null;
  const ms = Number(r);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// coverage origins travel as ?cov=<lat>,<lon>;<lat>,<lon>… (regenerated on load)
function covKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}
function covsFromUrl(): CoveragePin[] {
  if (typeof location === "undefined") return [];
  const c = new URLSearchParams(location.search).get("cov");
  if (!c) return [];
  const pins: CoveragePin[] = [];
  const seen = new Set<string>();
  for (const part of c.split(";")) {
    const [lat, lon] = part.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const id = covKey(lat, lon);
    if (seen.has(id)) continue;
    seen.add(id);
    pins.push({ id, lat, lon, layer: null, loading: false, visible: true });
  }
  return pins;
}

interface CoveragePin {
  id: string;
  lat: number;
  lon: number;
  layer: CoverageLayer | null;
  loading: boolean;
  visible: boolean;
}

// GRP_DATA coverage grid (/~/api/coverage-cells). `day` is the selected UTC date
// or "all"; `days` lists every aggregated date for the selector.
interface CoverageCellsData {
  days: string[];
  day: string | null;
  cells: CoverageCell[];
  maxFixes: number;
  cellDeg: number;
}

// the coverage grid toggles via ?cells=1, with the picked day in ?cday=
function cellsFromUrl(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("cells") === "1";
}
function cdayFromUrl(): string {
  if (typeof location === "undefined") return "";
  return new URLSearchParams(location.search).get("cday") || "";
}

function inExtent(n: MeshNode, e: LonLatExtent): boolean {
  return n.lon >= e[0] && n.lon <= e[2] && n.lat >= e[1] && n.lat <= e[3];
}

function packetKey(p: Packet): string {
  return p.hash ?? String(p.id);
}

export default function LiveMap() {
  const { packets, nodes, latest, status } = useLiveFeed();
  const stats = useStats();
  // node types currently hidden (legend entries act as toggles) — seeded from ?hide=
  const [hidden, setHidden] = useState<Set<number>>(hiddenFromUrl);
  // visible map extent (lon/lat), reported by PacketMap on every pan/zoom
  const [extent, setExtent] = useState<LonLatExtent | null>(null);
  // current center/zoom, mirrored into ?v= so the address bar is shareable
  const [view, setView] = useState<MapViewState | null>(null);
  // view restored from a shared URL (read once, before the map mounts)
  const [initialView] = useState<MapViewState | null>(viewFromUrl);
  // sidebar time window — ?w= so it travels with shared links
  const [windowKey, setWindowKey] = useState<WindowKey>(windowFromUrl);
  const [copied, setCopied] = useState(false);
  // packet whose path is pinned on the map; ?pin=<hash> restores it once loaded
  const [pinned, setPinned] = useState<Packet | null>(null);
  const [initialPin] = useState<string | null>(pinFromUrl);
  const pinRestored = useRef(false);

  // RF coverage: any number of transmitter origins (?cov=lat,lon;… regenerated
  // on load). Each pin owns its minted tile layer and a per-pin show/hide.
  const [coveragePins, setCoveragePins] = useState<CoveragePin[]>(covsFromUrl);
  const [coverageMode, setCoverageMode] = useState(false);

  // GRP_DATA coverage grid: a toggleable heat layer of where GPS beacons land,
  // aggregated per UTC day by the hourly cron. ?cells=1 + ?cday= make it shareable.
  const [showCells, setShowCells] = useState<boolean>(cellsFromUrl);
  const [cellDay, setCellDay] = useState<string>(cdayFromUrl);
  const [cellsData, setCellsData] = useState<CoverageCellsData | null>(null);
  useEffect(() => {
    if (!showCells) {
      setCellsData(null);
      return;
    }
    let cancelled = false;
    const q = cellDay ? `?day=${encodeURIComponent(cellDay)}` : "";
    fetch(`/~/api/coverage-cells${q}`)
      .then((r) => r.json())
      .then((d: CoverageCellsData) => {
        if (cancelled) return;
        setCellsData(d);
        // adopt the server's default day so the selector reflects what's shown
        if (!cellDay && d.day) setCellDay(d.day);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showCells, cellDay]);

  // fetch the coverage layer for any pin that doesn't have one yet
  useEffect(() => {
    const pending = coveragePins.filter((p) => !p.layer && !p.loading);
    if (pending.length === 0) return;
    setCoveragePins((cur) =>
      cur.map((p) => (pending.some((m) => m.id === p.id) ? { ...p, loading: true } : p))
    );
    for (const pin of pending) {
      fetch(`/~/api/coverage?lat=${pin.lat.toFixed(5)}&lon=${pin.lon.toFixed(5)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) =>
          setCoveragePins((cur) =>
            cur.map((p) =>
              p.id === pin.id
                ? { ...p, loading: false, layer: { url: d.url, extent: d.extent, minZoom: d.minZoom, maxZoom: d.maxZoom } }
                : p
            )
          )
        )
        .catch(() =>
          setCoveragePins((cur) => cur.map((p) => (p.id === pin.id ? { ...p, loading: false } : p)))
        );
    }
  }, [coveragePins]);

  // stable arrays for the map: only the visible pins (and layers that loaded)
  const visibleCoverages = useMemo(
    () => coveragePins.filter((p) => p.visible && p.layer).map((p) => p.layer as CoverageLayer),
    [coveragePins]
  );
  const visibleCoveragePoints = useMemo(
    () => coveragePins.filter((p) => p.visible).map((p) => ({ lat: p.lat, lon: p.lon })),
    [coveragePins]
  );

  const addCoverage = (lat: number, lon: number) => {
    const id = covKey(lat, lon);
    setCoveragePins((cur) =>
      cur.some((p) => p.id === id) ? cur : [...cur, { id, lat, lon, layer: null, loading: false, visible: true }]
    );
    setCoverageMode(false);
  };
  const toggleCoverageVisible = (id: string) =>
    setCoveragePins((cur) => cur.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p)));
  const removeCoverage = (id: string) =>
    setCoveragePins((cur) => cur.filter((p) => p.id !== id));
  const clearAllCoverage = () => {
    setCoveragePins([]);
    setCoverageMode(false);
  };
  // mobile sheet visibility (closes when a path is picked, to reveal the map)
  const [sheetOpen, setSheetOpen] = useState(false);
  // desktop sidebar visibility — persisted
  const [panelOpen, setPanelOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("mclive.pathPanel") !== "0";
  });
  useEffect(() => {
    try {
      localStorage.setItem("mclive.pathPanel", panelOpen ? "1" : "0");
    } catch {}
  }, [panelOpen]);

  // ticking clock so the time window and "ago" labels stay fresh
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // keep ?v= ?w= ?hide= ?pin= in sync with the map (debounced; replaceState, no history spam)
  useEffect(() => {
    const t = setTimeout(() => {
      const u = new URL(location.href);
      if (view)
        u.searchParams.set("v", `${view.lat.toFixed(5)},${view.lon.toFixed(5)},${view.zoom.toFixed(2)}`);
      if (windowKey === "1h") u.searchParams.delete("w");
      else u.searchParams.set("w", windowKey);
      if (hidden.size) u.searchParams.set("hide", [...hidden].sort((a, b) => a - b).join(","));
      else u.searchParams.delete("hide");
      if (pinned) u.searchParams.set("pin", packetKey(pinned));
      else u.searchParams.delete("pin");
      if (coveragePins.length) u.searchParams.set("cov", coveragePins.map((p) => p.id).join(";"));
      else u.searchParams.delete("cov");
      if (showCells) u.searchParams.set("cells", "1");
      else u.searchParams.delete("cells");
      if (showCells && cellDay) u.searchParams.set("cday", cellDay);
      else u.searchParams.delete("cday");
      window.history.replaceState({}, "", u.pathname + u.search);
    }, 250);
    return () => clearTimeout(t);
  }, [view, windowKey, hidden, pinned, coveragePins, showCells, cellDay]);

  // the live feed holds only the newest ~200 packets — for wider windows pull
  // the rest of the range from the server and merge by hash
  const windowMs = WINDOWS.find((w) => w.key === windowKey)!.ms;
  const [windowHistory, setWindowHistory] = useState<Packet[]>([]);
  useEffect(() => {
    if (windowKey === "1h") {
      setWindowHistory([]);
      return;
    }
    let cancelled = false;
    fetch(`/~/api/packets?since=${Date.now() - windowMs}&limit=2000`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setWindowHistory(d.packets ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [windowKey, windowMs]);

  // Position beacons for the rewind layer, fetched on their own at a fixed 48h
  // depth (NOT tied to the paths-list window) and *bucketed* (≤15 per 10-minute
  // window) so the freshest fixes are kept evenly across the whole range — a
  // flat "newest 2000" of all packet types starves old beacons, and tying this
  // to the 1h paths window capped the scrubber at one hour.
  const [beaconHistory, setBeaconHistory] = useState<Packet[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/~/api/packets?type=6&since=${Date.now() - REWIND_DEPTH_MS}&bucket=600000&perBucket=15&limit=8000`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setBeaconHistory(d.packets ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allPackets = useMemo(() => {
    if (!windowHistory.length) return packets;
    const byHash = new Map<string, Packet>();
    for (const p of [...windowHistory, ...packets]) byHash.set(packetKey(p), p);
    return [...byHash.values()].sort((a, b) => b.last_seen - a.last_seen);
  }, [packets, windowHistory]);

  // restore a shared ?pin= once its packet shows up in the loaded window (one-shot)
  useEffect(() => {
    if (pinRestored.current || !initialPin || allPackets.length === 0) return;
    pinRestored.current = true;
    const match = allPackets.find((p) => packetKey(p) === initialPin);
    if (match) setPinned(match);
  }, [allPackets, initialPin]);

  const copyLink = () => {
    navigator.clipboard?.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (n) =>
          // drop "null island" nodes — adverts without a real GPS fix carry 0,0
          !(n.lat === 0 && n.lon === 0) &&
          !hidden.has(n.adv_type ?? 0)
      ),
    [nodes, hidden]
  );

  // channel keys this browser holds — needed to decrypt GRP_DATA location beacons
  const [channels, setChannels] = useState<Channel[]>([]);
  useEffect(() => {
    loadAllChannels().then(setChannels).catch(() => {});
  }, []);

  // every GRP_DATA fast-GPS fix in the window (one entry per reception), decoded
  // once and resolved to a node — the raw material for the time-rewind scrubber.
  // Drawn from the bucketed beacon history plus the live feed (dedup by id).
  const beacons = useMemo<LivePosition[]>(() => {
    if (channels.length === 0) return [];
    const byId = new Map<number, Packet>();
    for (const p of beaconHistory) if (p.payload_type === 6 && p.raw) byId.set(p.id ?? 0, p);
    for (const p of packets) if (p.payload_type === 6 && p.raw) byId.set(p.id ?? 0, p);
    const out: LivePosition[] = [];
    for (const p of byId.values()) {
      const loc = decodeGroupData(p.raw!, channels)?.location;
      if (!loc) continue;
      const node = nodeForHash(loc.pubkeyPrefix, nodes);
      out.push({ key: loc.pubkeyPrefix, lat: loc.lat, lon: loc.lon, name: node?.name ?? null, at: p.last_seen, node });
    }
    return out;
  }, [beaconHistory, packets, channels, nodes]);

  // time span covered by the beacons — drives the rewind slider range
  const beaconSpan = useMemo(() => {
    if (beacons.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const b of beacons) {
      if (b.at < min) min = b.at;
      if (b.at > max) max = b.at;
    }
    return min < max ? { min, max } : null;
  }, [beacons]);

  // time-rewind: an absolute cutoff (ms) the position layer is frozen at, or null
  // = live (follow the newest fixes). Stepped/scrubbed by the minute.
  const [rewindTo, setRewindTo] = useState<number | null>(rewindFromUrl);
  // keep the cutoff inside the available span as the window/feed shifts
  useEffect(() => {
    if (!beaconSpan) return;
    setRewindTo((c) => (c == null ? null : Math.min(Math.max(c, beaconSpan.min), beaconSpan.max)));
  }, [beaconSpan]);

  // mirror the rewind cutoff into ?rw= (its own effect — kept after rewindTo is
  // declared so it doesn't reference the binding before its TDZ initialization)
  useEffect(() => {
    const t = setTimeout(() => {
      const u = new URL(location.href);
      if (rewindTo != null) u.searchParams.set("rw", String(Math.round(rewindTo)));
      else u.searchParams.delete("rw");
      window.history.replaceState({}, "", u.pathname + u.search);
    }, 250);
    return () => clearTimeout(t);
  }, [rewindTo]);

  // positions to draw: each node's freshest fix at-or-before the cutoff (or its
  // freshest fix overall, when live)
  const positions = useMemo<LivePosition[]>(() => {
    const byNode = new Map<string, LivePosition>();
    for (const b of beacons) {
      if (rewindTo != null && b.at > rewindTo) continue; // hasn't happened yet at this point in time
      const prev = byNode.get(b.key);
      if (prev && prev.at >= b.at) continue; // keep the freshest reception
      byNode.set(b.key, b);
    }
    return [...byNode.values()];
  }, [beacons, rewindTo]);

  // minute step for the scrubber; snaps to the span edges (max edge = back to live)
  const stepRewind = (deltaMs: number) => {
    if (!beaconSpan) return;
    const base = rewindTo ?? beaconSpan.max;
    const next = base + deltaMs;
    setRewindTo(next >= beaconSpan.max ? null : Math.max(beaconSpan.min, next));
  };

  // packets whose path is examinable in the current view: inside the selected
  // time window, at least two hops resolving to mapped nodes, at least one of
  // them inside the extent — so zooming the map scopes the list to that region
  const inView = useMemo(() => {
    if (!extent) return { rows: [] as { p: Packet; mapped: number }[], total: 0 };
    const cutoff = now - windowMs;
    const rows: { p: Packet; mapped: number }[] = [];
    let total = 0;
    for (const p of allPackets) {
      if (p.last_seen < cutoff || p.path.length < 2) continue;
      const hops = p.path
        .map((h) => nodeForHash(h, nodes))
        .filter((n): n is MeshNode => !!n && !(n.lat === 0 && n.lon === 0));
      if (hops.length < 2) continue; // not enough to draw a path
      if (!hops.some((n) => inExtent(n, extent))) continue;
      total++;
      if (rows.length < MAX_ROWS) rows.push({ p, mapped: hops.length });
    }
    return { rows, total };
  }, [allPackets, nodes, extent, now, windowMs]);

  const toggle = (t: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  const pinnedKey = pinned ? packetKey(pinned) : null;
  const gateLabel =
    inView.total > MAX_ROWS ? `newest ${MAX_ROWS} of ${inView.total}` : `${inView.total} packets`;

  const pickPath = (p: Packet) => setPinned(packetKey(p) === pinnedKey ? null : p);

  const list = (
    <PathRows
      rows={inView.rows}
      nodes={nodes}
      now={now}
      pinnedKey={pinnedKey}
      waiting={packets.length === 0}
      onPick={pickPath}
    />
  );

  return (
    <div className="flex h-full w-full">
      {/* isolate: keep the z-[1000] map overlays inside this stacking context so
          the portal'd mobile sheet (z-50 on body) still paints above them */}
      <div className="relative isolate min-h-0 flex-1">
        <PacketMap
          nodes={visibleNodes}
          latest={latest}
          pinnedPath={pinned?.path ?? null}
          className="h-full w-full"
          initialView={initialView}
          coverages={visibleCoverages}
          coveragePoints={visibleCoveragePoints}
          coverageMode={coverageMode}
          onPickPoint={addCoverage}
          positions={positions}
          coverageCells={showCells ? cellsData?.cells ?? [] : []}
          coverageCellDeg={cellsData?.cellDeg}
          coverageMaxFixes={cellsData?.maxFixes}
          formatAgo={(ms) => formatAgo(ms, rewindTo ?? now)}
          onNodeClick={(n) => {
            window.location.href = `/?node=${encodeURIComponent(n.pubkey)}`;
          }}
          onViewChange={(ext, v) => {
            setExtent(ext);
            setView(v);
          }}
        />

        {/* floating overlay */}
        <div className="pointer-events-none absolute left-4 top-4 z-[1000] flex flex-col gap-2">
          <div className="pointer-events-auto rounded-lg border bg-background/85 px-4 py-3 backdrop-blur">
            <div className="flex items-center justify-between gap-6">
              <h1 className="text-lg font-semibold tracking-tight">Mesh map</h1>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowCells((s) => !s)}
                  title="GPS coverage — heat grid of GRP_DATA beacons, by day"
                  className={cn(
                    "rounded p-1 transition-colors",
                    showCells
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  )}
                >
                  <Grid3x3 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setCoverageMode((m) => !m)}
                  title="RF coverage — click a node or any point to map its reach"
                  className={cn(
                    "rounded p-1 transition-colors",
                    coverageMode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  )}
                >
                  <Radio className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={copyLink}
                  title="Copy a link to this view"
                  className="text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded p-1 transition-colors"
                >
                  {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                </button>
                <StatusPill status={status} />
              </span>
            </div>
            <div className="text-muted-foreground mt-1 flex gap-4 text-xs tabular-nums">
              <span>{stats?.nodes ?? nodes.length} nodes</span>
              <span>{stats?.packets ?? 0} packets</span>
              <span>{stats?.receptions ?? 0} receptions</span>
            </div>
          </div>
          <div className="pointer-events-auto rounded-lg border bg-background/85 px-3 py-2 text-xs backdrop-blur">
            {NODE_TYPES.map(({ type, color, label }) => (
              <Legend
                key={type}
                color={color}
                label={label}
                hidden={hidden.has(type)}
                onClick={() => toggle(type)}
              />
            ))}
            <Legend color="#f43f5e" label="Live hop trace" />
            {positions.length > 0 && <Legend color="#f59e0b" label="Live position" />}
          </div>

          {/* coverage origins: each toggleable + removable */}
          {(coverageMode || coveragePins.length > 0) && (
            <div className="pointer-events-auto flex max-w-[280px] flex-col gap-1 rounded-lg border bg-background/85 px-3 py-2 text-xs backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <Radio className="text-primary size-3.5" /> RF coverage
                </span>
                {coveragePins.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAllCoverage}
                    className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    clear all
                  </button>
                )}
              </div>
              {coveragePins.map((p) => (
                <div key={p.id} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleCoverageVisible(p.id)}
                    title={p.visible ? "Hide on map" : "Show on map"}
                    className="text-muted-foreground hover:text-foreground rounded p-0.5"
                  >
                    {p.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </button>
                  <span className={cn("tabular-nums", !p.visible && "text-muted-foreground line-through")}>
                    {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                  </span>
                  {p.loading && <span className="text-muted-foreground">· computing…</span>}
                  <button
                    type="button"
                    onClick={() => removeCoverage(p.id)}
                    title="Remove"
                    className="text-muted-foreground hover:text-foreground ml-auto rounded p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <span className="text-muted-foreground">
                {coverageMode ? "Click a node or any point to add an origin" : "Toggle coverage mode to add more"}
              </span>
            </div>
          )}

          {/* GPS coverage grid: day selector + heat legend */}
          {showCells && (
            <div className="pointer-events-auto flex max-w-[280px] flex-col gap-1.5 rounded-lg border bg-background/85 px-3 py-2 text-xs backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <Grid3x3 className="text-primary size-3.5" /> GPS coverage
                </span>
                <button
                  type="button"
                  onClick={() => setShowCells(false)}
                  title="Hide coverage"
                  className="text-muted-foreground hover:text-foreground rounded p-0.5"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <select
                value={cellDay}
                onChange={(e) => setCellDay(e.target.value)}
                title="Coverage day"
                className="hover:border-foreground/30 cursor-pointer rounded border bg-transparent px-1.5 py-1 text-xs focus:outline-none"
              >
                <option value="all">All days</option>
                {(cellsData?.days ?? []).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">less</span>
                <span
                  className="h-2 flex-1 rounded"
                  style={{
                    background: `linear-gradient(to right, ${heatColor(0, 0.85)}, ${heatColor(0.5, 0.85)}, ${heatColor(1, 0.85)})`,
                  }}
                />
                <span className="text-muted-foreground">more</span>
              </div>
              <span className="text-muted-foreground tabular-nums">
                {cellsData
                  ? cellsData.cells.length > 0
                    ? `${cellsData.cells.length} cells · max ${cellsData.maxFixes} fixes`
                    : "no beacons for this day yet"
                  : "loading…"}
              </span>
            </div>
          )}
        </div>

        {/* desktop sidebar toggle */}
        <button
          type="button"
          onClick={() => setPanelOpen((o) => !o)}
          className="hover:bg-muted/80 absolute right-3 top-3 z-[1000] hidden rounded-lg border bg-background/85 px-3 py-2 text-xs font-medium backdrop-blur transition-colors md:block"
        >
          {panelOpen ? "Hide paths" : `Paths in view (${inView.total})`}
        </button>

        {/* mobile: paths list in a sheet */}
        <div className="absolute right-3 top-3 z-[1000] md:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="relative bg-background/85 backdrop-blur"
                aria-label="Paths in view"
              >
                <Route className="size-4" />
                {inView.total > 0 && (
                  <span className="bg-primary text-primary-foreground absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums">
                    {inView.total > 99 ? "99+" : inView.total}
                  </span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="flex w-[85vw] flex-col gap-0 p-0 sm:max-w-sm">
              <SheetHeader className="border-b px-4 pb-3 pt-5 text-left">
                <SheetTitle className="text-base">Paths in view</SheetTitle>
                <SheetDescription>
                  <WindowSelect value={windowKey} onChange={setWindowKey} /> · {gateLabel} — tap
                  one to trace it on the map
                </SheetDescription>
                {pinned && (
                  <button
                    type="button"
                    onClick={() => setPinned(null)}
                    className="text-muted-foreground hover:text-foreground self-start text-xs underline underline-offset-2"
                  >
                    unpin current path
                  </button>
                )}
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <PathRows
                  rows={inView.rows}
                  nodes={nodes}
                  now={now}
                  pinnedKey={pinnedKey}
                  waiting={packets.length === 0}
                  onPick={(p) => {
                    pickPath(p);
                    setSheetOpen(false);
                  }}
                />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* time rewind: scrub the live-position layer back through the window */}
        {beaconSpan && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[1000] flex justify-center px-4">
            <div className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-lg border bg-background/85 px-3 py-2 backdrop-blur">
              <button
                type="button"
                onClick={() => setRewindTo(rewindTo == null ? beaconSpan.max - 60_000 : null)}
                title={rewindTo == null ? "Rewind positions" : "Back to live"}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
                  rewindTo == null
                    ? "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                )}
              >
                <History className="size-3.5" />
                {rewindTo == null ? "Live" : "Rewound"}
              </button>
              <button
                type="button"
                onClick={() => stepRewind(-60_000)}
                title="Back one minute"
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0 rounded p-1 transition-colors"
              >
                <ChevronLeft className="size-4" />
              </button>
              <input
                type="range"
                min={beaconSpan.min}
                max={beaconSpan.max}
                step={60_000}
                value={rewindTo ?? beaconSpan.max}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRewindTo(v >= beaconSpan.max ? null : v);
                }}
                aria-label="Rewind live positions"
                className="h-1 flex-1 cursor-pointer accent-amber-500"
              />
              <button
                type="button"
                onClick={() => stepRewind(60_000)}
                disabled={rewindTo == null}
                title="Forward one minute"
                className="text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0 rounded p-1 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="size-4" />
              </button>
              <span className="shrink-0 text-xs tabular-nums">
                <span className={cn("font-medium", rewindTo != null && "text-amber-600 dark:text-amber-400")}>
                  {rewindTo == null ? "now" : formatTime(rewindTo)}
                </span>
                <span className="text-muted-foreground"> · {positions.length} node{positions.length === 1 ? "" : "s"}</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* desktop sidebar */}
      {panelOpen && (
        <aside className="bg-card hidden w-80 shrink-0 flex-col border-l md:flex">
          <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2.5">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Paths in view</h2>
              <p className="text-muted-foreground text-xs">
                <WindowSelect value={windowKey} onChange={setWindowKey} /> · {gateLabel}
              </p>
            </div>
            {pinned && (
              <button
                type="button"
                onClick={() => setPinned(null)}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              >
                unpin
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
        </aside>
      )}
    </div>
  );
}

/** Time-window selector, styled as inline text within the sidebar caption. */
function WindowSelect({ value, onChange }: { value: WindowKey; onChange: (k: WindowKey) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as WindowKey)}
      title="Time window"
      className="text-muted-foreground hover:text-foreground cursor-pointer rounded bg-transparent text-xs underline decoration-dotted underline-offset-2 focus:outline-none"
    >
      {WINDOWS.map((w) => (
        <option key={w.key} value={w.key}>
          {w.label}
        </option>
      ))}
    </select>
  );
}

/** The shared packet-path list (desktop sidebar + mobile sheet). */
function PathRows({
  rows,
  nodes,
  now,
  pinnedKey,
  waiting,
  onPick,
}: {
  rows: { p: Packet; mapped: number }[];
  nodes: MeshNode[];
  now: number;
  pinnedKey: string | null;
  waiting: boolean;
  onPick: (p: Packet) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-xs">
        {waiting
          ? "Waiting for packets…"
          : "No packets with mapped paths crossed this view in the last hour. Pan or zoom out to find some."}
      </p>
    );
  }
  return (
    <>
      {rows.map(({ p, mapped }) => {
        const key = packetKey(p);
        const isPinned = key === pinnedKey;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onPick(p)}
            title={isPinned ? "Unpin this path" : "Pin this path on the map"}
            className={cn(
              "hover:bg-muted/60 block w-full border-b px-3 py-2 text-left text-xs transition-colors",
              isPinned && "bg-primary/10 hover:bg-primary/15"
            )}
          >
            <span className="flex items-center gap-2">
              <Badge variant="outline" className={cn("font-mono", typeBadgeClass(p.payload_type))}>
                {payloadTypeName(p.payload_type)}
              </Badge>
              <span className="truncate">{senderName(p, nodes) ?? "unknown sender"}</span>
              <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                {formatAgo(p.last_seen, now)}
              </span>
            </span>
            <span className="text-muted-foreground mt-1 block truncate font-mono">
              {p.path.join("→")}
              <span className="font-sans"> · {mapped}/{p.path.length} hops on map</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

function Legend({
  color,
  label,
  hidden = false,
  onClick,
}: {
  color: string;
  label: string;
  hidden?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span
        className={cn("size-2.5 rounded-full", hidden && "opacity-30")}
        style={{ background: color }}
      />
      <span className={cn(hidden && "text-muted-foreground/60 line-through")}>{label}</span>
    </>
  );
  if (!onClick) {
    return <div className="flex items-center gap-2 py-0.5">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={hidden ? `Show: ${label}` : `Hide: ${label}`}
      className="hover:bg-muted/60 -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-0.5 text-left transition-colors"
    >
      {body}
    </button>
  );
}
