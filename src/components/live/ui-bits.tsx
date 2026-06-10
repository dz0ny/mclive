import type { FeedStatus } from "./useLiveFeed";

export function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
    </div>
  );
}

export function StatusPill({ status }: { status: FeedStatus }) {
  const map = {
    connecting: { c: "bg-yellow-500", t: "Connecting" },
    live: { c: "bg-green-500", t: "Live" },
    offline: { c: "bg-red-500", t: "Offline" },
  } as const;
  const s = map[status];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-sm backdrop-blur">
      <span className={`size-2 rounded-full ${s.c} ${status === "live" ? "animate-pulse" : ""}`} />
      {s.t}
    </span>
  );
}
