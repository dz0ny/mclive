import { useLiveFeed } from "./useLiveFeed";
import { useStats } from "./useStats";
import PacketMap from "./PacketMap";
import { StatusPill } from "./ui-bits";

export default function LiveMap() {
  const { nodes, latest, status } = useLiveFeed();
  const stats = useStats();

  return (
    <div className="relative h-full w-full">
      <PacketMap
        nodes={nodes}
        latest={latest}
        className="h-full w-full"
        onNodeClick={(n) => {
          window.location.href = `/?node=${encodeURIComponent(n.pubkey)}`;
        }}
      />

      {/* floating overlay */}
      <div className="pointer-events-none absolute left-4 top-4 z-[1000] flex flex-col gap-2">
        <div className="pointer-events-auto rounded-lg border bg-background/85 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between gap-6">
            <h1 className="text-lg font-semibold tracking-tight">Mesh map</h1>
            <StatusPill status={status} />
          </div>
          <div className="text-muted-foreground mt-1 flex gap-4 text-xs tabular-nums">
            <span>{stats?.nodes ?? nodes.length} nodes</span>
            <span>{stats?.packets ?? 0} packets</span>
            <span>{stats?.receptions ?? 0} receptions</span>
          </div>
        </div>
        <div className="pointer-events-auto rounded-lg border bg-background/85 px-3 py-2 text-xs backdrop-blur">
          <Legend color="#16a34a" label="Repeater" />
          <Legend color="#0ea5e9" label="Chat node" />
          <Legend color="#9333ea" label="Room server" />
          <Legend color="#ea580c" label="Sensor" />
          <Legend color="#f43f5e" label="Live hop trace" />
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="size-2.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}
