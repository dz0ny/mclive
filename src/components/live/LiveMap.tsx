import { useMemo, useState } from "react";
import { useLiveFeed } from "./useLiveFeed";
import { useStats } from "./useStats";
import PacketMap from "./PacketMap";
import { StatusPill } from "./ui-bits";
import { cn } from "@/lib/utils";

// adv_type values, matching PacketMap's TYPE_STYLE marker colors.
const NODE_TYPES: { type: number; color: string; label: string }[] = [
  { type: 2, color: "#16a34a", label: "Repeater" },
  { type: 1, color: "#0ea5e9", label: "Chat node" },
  { type: 3, color: "#9333ea", label: "Room server" },
  { type: 4, color: "#ea580c", label: "Sensor" },
];

export default function LiveMap() {
  const { nodes, latest, status } = useLiveFeed();
  const stats = useStats();
  // node types currently hidden (legend entries act as toggles)
  const [hidden, setHidden] = useState<Set<number>>(new Set());

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

  const toggle = (t: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  return (
    <div className="relative h-full w-full">
      <PacketMap
        nodes={visibleNodes}
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
        </div>
      </div>
    </div>
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
