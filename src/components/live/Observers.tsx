import { useEffect, useMemo, useState } from "react";
import type { Observer, ObserverStatus } from "@/lib/meshcore";
import { formatAgo, formatUptime, observerStatus } from "@/lib/meshcore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const STATUS_META: Record<ObserverStatus, { label: string; dot: string }> = {
  online: { label: "Online", dot: "bg-emerald-500" },
  stale: { label: "Stale", dot: "bg-amber-500" },
  offline: { label: "Offline", dot: "bg-rose-500" },
};

// Packet-flow health from how recently this observer last heard a packet.
function packetHealth(lastPacketAt: number | null, now: number) {
  if (!lastPacketAt) return { label: "no packets", cls: "text-muted-foreground" };
  const age = now - lastPacketAt;
  if (age < 120_000) return { label: formatAgo(lastPacketAt, now), cls: "text-emerald-600 dark:text-emerald-400" };
  if (age < 900_000) return { label: formatAgo(lastPacketAt, now), cls: "text-amber-600 dark:text-amber-400" };
  return { label: formatAgo(lastPacketAt, now), cls: "text-rose-600 dark:text-rose-400" };
}

export default function Observers() {
  const [observers, setObservers] = useState<Observer[]>([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState<string>("all");
  const [now, setNow] = useState(() => Date.now());

  const load = () =>
    fetch("/~/api/observers")
      .then((r) => r.json())
      .then((d) => {
        setObservers(d.observers || []);
        setNow(Date.now());
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  // poll + a ticking clock so the relative times stay fresh
  useEffect(() => {
    load();
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const regions = useMemo(() => {
    const s = new Set<string>();
    for (const o of observers) if (o.iata) s.add(o.iata);
    return [...s].sort();
  }, [observers]);

  const rows = useMemo(
    () => observers.filter((o) => region === "all" || o.iata === region),
    [observers, region]
  );

  const counts = useMemo(() => {
    let online = 0;
    let stale = 0;
    let offline = 0;
    for (const o of rows) {
      const s = observerStatus(o, now);
      if (s === "online") online++;
      else if (s === "stale") stale++;
      else offline++;
    }
    return { online, stale, offline, total: rows.length };
  }, [rows, now]);

  const maxRate = useMemo(
    () => Math.max(1, ...rows.map((o) => o.packets_last_hour || 0)),
    [rows]
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      {/* header */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Observer Status</h1>
        <Button variant="outline" size="icon" onClick={load} title="Refresh" aria-label="Refresh">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </Button>
      </div>

      {/* region filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Region:</span>
        <RegionPill active={region === "all"} onClick={() => setRegion("all")}>All</RegionPill>
        {regions.map((r) => (
          <RegionPill key={r} active={region === r} onClick={() => setRegion(r)}>
            {r}
          </RegionPill>
        ))}
      </div>

      {/* summary */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <Count dot="bg-emerald-500" n={counts.online} label="Online" />
        <Count dot="bg-amber-500" n={counts.stale} label="Stale" />
        <Count dot="bg-rose-500" n={counts.offline} label="Offline" />
        <span className="flex items-center gap-2 text-muted-foreground">
          <span aria-hidden>📡</span>
          <span className="font-semibold text-foreground">{counts.total}</span> Total
        </span>
      </div>

      <div className="rounded-lg border">
        <Table className="min-w-[920px]">
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <TableHead>Status</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Last status</TableHead>
              <TableHead>Last packet</TableHead>
              <TableHead>Packet health</TableHead>
              <TableHead className="text-right">Total packets</TableHead>
              <TableHead>Packets/hour</TableHead>
              <TableHead>Clock offset</TableHead>
              <TableHead>Uptime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  {loading ? "Loading observers…" : "No observers yet."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((o) => {
              const status = observerStatus(o, now);
              const meta = STATUS_META[status];
              const health = packetHealth(o.last_packet_at, now);
              const rate = o.packets_last_hour || 0;
              const offset = o.clock_offset_ms;
              return (
                <TableRow key={o.origin_id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className={cn("inline-block h-2.5 w-2.5 rounded-full", meta.dot)} />
                      {meta.label}
                    </span>
                  </TableCell>
                  <TableCell className="font-medium">{o.origin || o.origin_id.slice(0, 12)}</TableCell>
                  <TableCell>
                    {o.iata ? (
                      <Badge variant="outline" className="font-mono text-[11px]">{o.iata}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatAgo(o.last_status_at, now)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatAgo(o.last_packet_at, now)}</TableCell>
                  <TableCell className={health.cls}>{health.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{(o.total_packets || 0).toLocaleString()}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-sky-500"
                          style={{ width: `${Math.round((rate / maxRate) * 100)}%` }}
                        />
                      </span>
                      <span className="tabular-nums text-muted-foreground">{rate}/hr</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {offset == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs tabular-nums",
                          Math.abs(offset) < 5000
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                        )}
                        title={`${offset} ms`}
                      >
                        <span aria-hidden>⏱</span>({Math.round(offset / 1000)}s)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatUptime(o.uptime_secs)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RegionPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-sm font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"
      )}
    >
      {children}
    </button>
  );
}

function Count({ dot, n, label }: { dot: string; n: number; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("inline-block h-2.5 w-2.5 rounded-full", dot)} />
      <span className="font-semibold">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
