import { useEffect, useMemo, useState } from "react";
import type { MeshNode, Packet } from "@/lib/meshcore";
import { useLiveFeed } from "./useLiveFeed";
import { useStats } from "./useStats";
import { usePacketDetail } from "./usePacketDetail";
import { useUrlString } from "./useUrlState";
import PacketTable from "./PacketTable";
import PacketTimeline from "./PacketTimeline";
import PacketDetailSheet from "./PacketDetail";
import { StatCard, StatusPill } from "./ui-bits";

// Selectable time spans. "live" rides the websocket feed; the rest pull a
// closed window from the server so quiet periods still show their packets.
const RANGES = [
  { key: "live", label: "Live", ms: 0 },
  { key: "1h", label: "Last hour", ms: 3_600_000 },
  { key: "24h", label: "Last 24h", ms: 86_400_000 },
  { key: "7d", label: "Last 7 days", ms: 604_800_000 },
  { key: "custom", label: "Custom range…", ms: 0 },
] as const;

// Resolve a Sender column query to server-side sender filters (pubkey / hash
// prefixes). Space-separated hex tokens map straight through; a name is matched
// against the node directory (capped, so a broad substring can't fan out). An
// empty result means "nothing to pull" — the client-side filter still applies.
function senderHexes(query: string, nodes: MeshNode[]): string[] {
  const s = query.trim();
  if (!s) return [];
  const toks = s.toLowerCase().split(/\s+/);
  const allHex = toks.every((t) => t.length >= 2 && t.length <= 8 && t.length % 2 === 0 && /^[0-9a-f]+$/.test(t));
  if (allHex) return toks;
  const lc = s.toLowerCase();
  return nodes
    .filter((n) => (n.name || "").toLowerCase().includes(lc))
    .map((n) => n.pubkey.toLowerCase())
    .slice(0, 8);
}

// epoch ms → value for <input type="datetime-local"> (local time, no seconds)
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function LivePackets() {
  const { packets, nodes, status } = useLiveFeed();
  const stats = useStats();
  const { selectedId, detail, loading, open, close } = usePacketDetail();

  // timeline scrubber: the moment under the playhead, which the table follows
  const [scrubTs, setScrubTs] = useState<number | null>(null);

  // node (sender) filter, seeded from ?node= when arriving from the map
  const [nodeFilter, setNodeFilter] = useState<string | null>(() =>
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("node") : null
  );

  // the Sender column query, mirrored up from the table (seeded from ?sender=)
  const [senderQ, setSenderQ] = useState<string>(() =>
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("sender") ?? "" : ""
  );

  // time range — in the URL so a windowed view is shareable (?range=, ?from=, ?to=)
  const [range, setRange] = useUrlString("range", "live");
  const [from, setFrom] = useUrlString("from");
  const [to, setTo] = useUrlString("to");

  function clearNodeFilter() {
    setNodeFilter(null);
    const u = new URL(location.href);
    u.searchParams.delete("node");
    history.replaceState({}, "", u.pathname + u.search);
  }

  // a fetched window of packets, used whenever we're not on the live feed
  // (or on the live feed but filtered to a specific, possibly-quiet device)
  const [fetched, setFetched] = useState<Packet[]>([]);
  const [fetching, setFetching] = useState(false);
  // bump to force a re-pull so sliding presets ("last hour") stay fresh
  const [tick, setTick] = useState(0);

  // server-side sender filters: the ?node= pubkey wins; otherwise resolve the
  // Sender column query. A stable key keeps the fetch from re-firing on every
  // node advert (the node list churns; the resolved set rarely does).
  const senders = useMemo(
    () => (nodeFilter ? [nodeFilter.toLowerCase()] : senderHexes(senderQ, nodes)),
    [nodeFilter, senderQ, nodes]
  );
  const sendersKey = senders.join(",");

  useEffect(() => {
    // on the live feed with no sender constraint there's nothing to pull
    if (range === "live" && senders.length === 0) {
      setFetched([]);
      return;
    }
    let since: number;
    let until: number | undefined;
    if (range === "custom") {
      since = from ? Date.parse(from) : NaN;
      until = to ? Date.parse(to) : undefined;
      if (!Number.isFinite(since)) {
        setFetched([]);
        return;
      }
    } else if (range !== "live") {
      since = Date.now() - (RANGES.find((r) => r.key === range)?.ms || 86_400_000);
    } else {
      // live feed scoped to a device: pull that sender's last 24h
      since = Date.now() - 86_400_000;
    }
    const base = new URLSearchParams();
    base.set("since", String(Math.floor(since)));
    if (until != null && Number.isFinite(until)) base.set("until", String(Math.floor(until)));
    base.set("limit", "2000");

    // one request per resolved sender (the API takes a single sender prefix);
    // with no sender it's a single windowed pull.
    const urls = senders.length
      ? senders.map((s) => {
          const p = new URLSearchParams(base);
          p.set("sender", s);
          return `/~/api/packets?${p.toString()}`;
        })
      : [`/~/api/packets?${base.toString()}`];

    let cancelled = false;
    setFetching(true);
    Promise.all(urls.map((u) => fetch(u).then((r) => r.json()).catch(() => ({}))))
      .then((results) => {
        if (cancelled) return;
        const byHash = new Map<string, Packet>();
        for (const d of results) for (const p of (d?.packets ?? []) as Packet[]) byHash.set(p.hash ?? String(p.id), p);
        setFetched([...byHash.values()].sort((a, b) => b.last_seen - a.last_seen));
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, from, to, sendersKey, tick]);

  // keep sliding presets fresh; closed custom ranges don't need polling
  useEffect(() => {
    if (range === "live" || range === "custom") return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [range]);

  const filterNode = nodeFilter
    ? nodes.find((n) => n.pubkey.toLowerCase() === nodeFilter.toLowerCase()) || null
    : null;
  const filterKey = (nodeFilter || "").toLowerCase();

  const shown: Packet[] = useMemo(() => {
    if (range !== "live") {
      // the server already scoped the window (and the sender, if filtered)
      return fetched;
    }
    // the ?node= chip narrows the live feed to packets that touched that node;
    // a Sender column query is applied by the table, so keep the full feed here
    const live = nodeFilter
      ? packets.filter((p) => p.path.some((h) => filterKey.startsWith(h.toLowerCase())))
      : packets;
    if (!fetched.length) return live;
    // merge in the server-pulled history so a quiet device's older packets show
    const byHash = new Map<string, Packet>();
    for (const p of [...fetched, ...live]) byHash.set(p.hash ?? String(p.id), p);
    return [...byHash.values()].sort((a, b) => b.last_seen - a.last_seen);
  }, [range, fetched, packets, nodeFilter, filterKey]);

  // sensible defaults when opening the custom inputs for the first time
  const customFrom = from || toLocalInput(Date.now() - 86_400_000);
  const customTo = to || toLocalInput(Date.now());

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Live packets</h1>
          <p className="text-muted-foreground text-sm">
            Deduped mesh packets across all observers. Use the filter icons in each column header.
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Unique packets" value={stats?.packets ?? packets.length} />
        <StatCard label="Nodes" value={stats?.nodes ?? nodes.length} />
        <StatCard label="Observers" value={stats?.devices ?? 0} />
        <StatCard label="Receptions/min" value={stats?.receptions_per_min ?? 0} />
      </div>

      {/* time range */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Range:</span>
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key === "live" ? "" : r.key)}
              className={
                "rounded-full px-3 py-1 text-sm font-medium transition-colors " +
                ((range || "live") === r.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70")
              }
            >
              {r.label}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <span className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={customFrom}
              max={customTo}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
              aria-label="From"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="datetime-local"
              value={customTo}
              min={customFrom}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
              aria-label="To"
            />
          </span>
        )}

        {range !== "live" && (
          <span className="text-muted-foreground tabular-nums">
            {fetching ? "loading…" : `${shown.length} packet${shown.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      {nodeFilter && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Node:</span>
          <span className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-full px-3 py-1">
            {filterNode?.name || "node"}
            <span className="font-mono opacity-80">{nodeFilter.slice(0, 8)}…</span>
            <button type="button" onClick={clearNodeFilter} className="opacity-80 hover:opacity-100">
              ✕
            </button>
          </span>
          <span className="text-muted-foreground">{shown.length} packets</span>
        </div>
      )}

      <PacketTimeline packets={shown} scrubTs={scrubTs} onScrub={setScrubTs} />

      <PacketTable
        packets={shown}
        selectedId={selectedId}
        scrubTs={scrubTs}
        nodes={nodes}
        onSenderQuery={setSenderQ}
        onSelect={(p) => open(p.id!)}
      />

      <PacketDetailSheet
        open={selectedId != null}
        loading={loading}
        detail={detail}
        onOpenChange={(o) => {
          if (!o) close();
        }}
      />
    </div>
  );
}
