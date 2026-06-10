import { useEffect, useState } from "react";
import type { Packet } from "@/lib/meshcore";
import { useLiveFeed } from "./useLiveFeed";
import { useStats } from "./useStats";
import { usePacketDetail } from "./usePacketDetail";
import PacketTable from "./PacketTable";
import PacketDetailSheet from "./PacketDetail";
import { StatCard, StatusPill } from "./ui-bits";

export default function LivePackets() {
  const { packets, nodes, status } = useLiveFeed();
  const stats = useStats();
  const { selectedId, detail, loading, open, close } = usePacketDetail();

  // node (sender) filter, seeded from ?node= when arriving from the map
  const [nodeFilter, setNodeFilter] = useState<string | null>(() =>
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("node") : null
  );

  function clearNodeFilter() {
    setNodeFilter(null);
    const u = new URL(location.href);
    u.searchParams.delete("node");
    history.replaceState({}, "", u.pathname + u.search);
  }

  // The live feed only holds the newest ~150 packets, so a quieter node would
  // show nothing. Pull that sender's last 24h from the server and merge.
  const [senderHistory, setSenderHistory] = useState<Packet[]>([]);
  useEffect(() => {
    if (!nodeFilter) {
      setSenderHistory([]);
      return;
    }
    const since = Date.now() - 24 * 60 * 60 * 1000;
    fetch(`/~/api/packets?sender=${encodeURIComponent(nodeFilter)}&since=${since}&limit=500`)
      .then((r) => r.json())
      .then((d) => setSenderHistory(d.packets ?? []))
      .catch(() => {});
  }, [nodeFilter]);

  const filterNode = nodeFilter
    ? nodes.find((n) => n.pubkey.toLowerCase() === nodeFilter.toLowerCase()) || null
    : null;
  const filterKey = (nodeFilter || "").toLowerCase();

  let shown: Packet[] = packets;
  if (nodeFilter) {
    // include packets where the node was any hop on the path, not just the sender
    const live = packets.filter((p) => p.path.some((h) => filterKey.startsWith(h.toLowerCase())));
    const byHash = new Map<string, Packet>();
    for (const p of [...senderHistory, ...live]) byHash.set(p.hash ?? String(p.id), p);
    shown = [...byHash.values()].sort((a, b) => b.last_seen - a.last_seen);
  }

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

      <PacketTable packets={shown} selectedId={selectedId} nodes={nodes} onSelect={(p) => open(p.id!)} />

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
