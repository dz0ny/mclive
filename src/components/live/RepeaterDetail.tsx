import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ADV_TYPE_NAMES,
  formatAgo,
  formatDateTime,
  formatUptime,
  type Hop,
  type MeshNode,
  snrClass,
} from "@/lib/meshcore";
import { cn } from "@/lib/utils";

/** Latest decoded ver/telemetry snapshot for a repeater (from /~/api/repeaters/:pk). */
interface RepeaterTelemetry {
  fields: Record<string, unknown> | null;
  observer_id: string | null;
  snr: number | null;
  rssi: number | null;
  updated_at: number;
}

/** Latest TRACE that targeted this repeater, decoded for the per-hop SNR view. */
interface RepeaterTrace {
  id: number;
  hash: string | null;
  last_seen: number;
  best_snr: number | null;
  best_rssi: number | null;
  hops: Hop[];
  traceSnrs: number[] | null;
}

interface RepeaterData {
  pubkey: string;
  node: MeshNode | null;
  telemetry: RepeaterTelemetry | null;
  trace: RepeaterTrace | null;
}

interface Props {
  pubkey: string;
  /** name to show in the header while the record loads */
  fallbackName?: string;
  onBack: () => void;
}

export default function RepeaterDetail({ pubkey, fallbackName, onBack }: Props) {
  const [data, setData] = useState<RepeaterData | null>(null);
  const [loading, setLoading] = useState(true);

  // (re)load the full record — also fired when a fresh probe arrives over SSE
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    const load = () =>
      fetch(`/~/api/repeaters/${encodeURIComponent(pubkey)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    load();

    // Passive live updates: the worker broadcasts a `telemetry` event when an
    // observer's probe yields fresh stats, and a `packet` event for every packet
    // (a type-9 trace targeting this repeater means a new traceroute to pull).
    const es = new EventSource("/~/stream");
    es.onmessage = (e) => {
      let evt: any;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      const pk = pubkey.toLowerCase();
      if (evt.type === "telemetry" && String(evt.pubkey).toLowerCase() === pk) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                telemetry: {
                  fields: evt.telemetry ?? null,
                  observer_id: evt.observer_id ?? null,
                  snr: evt.snr ?? null,
                  rssi: evt.rssi ?? null,
                  updated_at: evt.updated_at ?? Date.now(),
                },
              }
            : prev
        );
      } else if (
        evt.type === "packet" &&
        evt.packet?.payload_type === 9 &&
        String(evt.packet?.target_pubkey ?? "").toLowerCase() === pk
      ) {
        load(); // refetch to get the decoded per-hop SNR view
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [pubkey]);

  const now = Date.now();
  const node = data?.node ?? null;
  const name = node?.name || fallbackName || `${pubkey.slice(0, 12)}…`;
  const located =
    node && node.lat != null && node.lon != null && !(node.lat === 0 && node.lon === 0)
      ? { lat: node.lat, lon: node.lon }
      : null;

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
        >
          <span aria-hidden>←</span> All repeaters
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
          <Badge variant="default">{ADV_TYPE_NAMES[node?.adv_type ?? 2] ?? "repeater"}</Badge>
        </div>
        <p className="text-muted-foreground mt-1 font-mono text-xs break-all">{pubkey}</p>
      </div>

      {loading && !data && <p className="text-muted-foreground text-sm">Loading repeater…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label="Last advert"
              value={node ? formatAgo(node.updated_at, now) : "—"}
              sub={node ? formatDateTime(node.updated_at) : "not in directory"}
            />
            <Tile
              label="Location"
              value={located ? `${located.lat.toFixed(4)}, ${located.lon.toFixed(4)}` : "—"}
              sub={located ? "self-reported" : "no GPS fix"}
            />
            <Tile
              label="Telemetry"
              value={data.telemetry ? formatAgo(data.telemetry.updated_at, now) : "—"}
              sub={data.telemetry ? "last probed" : "no successful probe yet"}
            />
            <Tile
              label="Last trace"
              value={data.trace ? formatAgo(data.trace.last_seen, now) : "—"}
              sub={data.trace ? `${data.trace.hops.length} hops` : "no trace yet"}
            />
          </div>

          <TelemetryCard telemetry={data.telemetry} now={now} />
          <TraceCard trace={data.trace} now={now} />

          <p className="text-muted-foreground text-xs">
            Telemetry and traces are gathered passively: an observer auto-probes a repeater after
            hearing its advert. There is no manual trigger — this page only displays what arrives.
          </p>
        </>
      )}
    </div>
  );
}

// --- telemetry card --------------------------------------------------------

// Known GET_STATUS fields, rendered with friendly labels/units; anything else
// the firmware sends is shown generically so new fields appear without changes.
const TELEMETRY_LABELS: Record<string, string> = {
  uptime_secs: "Uptime",
  battery_mv: "Battery",
  airtime_pct: "Airtime",
  n_sent: "Packets sent",
  n_recv: "Packets received",
  noise_floor: "Noise floor",
  tx_queue: "TX queue",
  fw: "Firmware",
  firmware: "Firmware",
};

function formatTelemetry(key: string, value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "number") {
    switch (key) {
      case "uptime_secs":
        return formatUptime(value);
      case "battery_mv":
        return `${(value / 1000).toFixed(2)} V`;
      case "airtime_pct":
        return `${value}%`;
      case "noise_floor":
        return `${value} dBm`;
      default:
        return String(value);
    }
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function TelemetryCard({ telemetry, now }: { telemetry: RepeaterTelemetry | null; now: number }) {
  const entries = useMemo(
    () => (telemetry?.fields ? Object.entries(telemetry.fields) : []),
    [telemetry]
  );

  return (
    <section className="rounded-lg border">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Telemetry</h2>
        {telemetry && (
          <span className="text-muted-foreground text-xs">
            updated {formatAgo(telemetry.updated_at, now)}
            {telemetry.observer_id ? ` · via ${telemetry.observer_id.slice(0, 8)}…` : ""}
            {telemetry.snr != null ? ` · ${telemetry.snr.toFixed(1)} dB` : ""}
          </span>
        )}
      </header>
      {!telemetry || entries.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">
          No telemetry decoded yet. An observer requests stats automatically after it hears this
          repeater advertise; results appear here once a probe succeeds.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-3">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-0.5 text-sm">
              <span className="text-muted-foreground truncate" title={k}>
                {TELEMETRY_LABELS[k] ?? k}
              </span>
              <span className="tabular-nums">{formatTelemetry(k, v)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// --- trace card (reuses the per-hop SNR pattern from PacketDetail) ----------

function TraceCard({ trace, now }: { trace: RepeaterTrace | null; now: number }) {
  const hops = trace?.hops ?? [];
  const snrs = trace?.traceSnrs ?? null;
  return (
    <section className="rounded-lg border">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Latest trace {hops.length > 0 ? `(${hops.length} hop${hops.length === 1 ? "" : "s"})` : ""}
        </h2>
        {trace && <span className="text-muted-foreground text-xs">heard {formatAgo(trace.last_seen, now)}</span>}
      </header>
      {!trace ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">
          No traceroute yet. A diagnostic trace is sent along the reversed advert path after the
          repeater is heard; the per-link SNR appears here once a reply returns.
        </p>
      ) : hops.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-xs">Direct trace — no intermediate hops.</p>
      ) : (
        <ol className="space-y-1 px-4 py-3">
          {Array.isArray(snrs) && (
            <p className="text-muted-foreground mb-2 text-xs">
              Each repeater appends the SNR it heard from the previous hop, mapping link quality step
              by step. {snrs.length} of {Math.max(0, hops.length - 1)} link
              {hops.length - 1 === 1 ? "" : "s"} measured.
            </p>
          )}
          {hops.map((h, i) => (
            <li key={`${h.hash}-${i}`} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-5 text-right tabular-nums">{i + 1}.</span>
                <Badge variant="outline" className="font-mono">{h.hash}</Badge>
                <span>
                  {h.node ? h.node.name || "(unnamed node)" : <span className="text-muted-foreground">unknown node</span>}
                </span>
              </div>
              {Array.isArray(snrs) && i < hops.length - 1 && (
                <div className="text-muted-foreground flex items-center gap-2 pl-7 text-xs">
                  <span aria-hidden>↓</span>
                  {snrs[i] != null ? (
                    <span className={cn("font-mono tabular-nums", snrClass(snrs[i]))}>
                      {snrs[i].toFixed(2)} dB
                    </span>
                  ) : (
                    <span className="italic">not yet measured</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
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
