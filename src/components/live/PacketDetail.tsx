import type { PacketDetail as Detail } from "@/lib/meshcore";
import {
  ADV_TYPE_NAMES,
  ROUTE_DESCRIPTIONS,
  formatDateTime,
  payloadTypeDescription,
  payloadTypeName,
  routeBadgeClass,
  routeLabel,
  typeBadgeClass,
} from "@/lib/meshcore";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import DetailMap from "./DetailMap";

interface Props {
  open: boolean;
  loading: boolean;
  detail: Detail | null;
  onOpenChange: (open: boolean) => void;
}

export default function PacketDetail({ open, loading, detail, onOpenChange }: Props) {
  const p = detail?.packet;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {p && (
              <Badge variant="outline" className={cn("font-mono text-sm", typeBadgeClass(p.payload_type))}>
                {payloadTypeName(p.payload_type)}
              </Badge>
            )}
            {!p && "Packet"}
            {p && (
              <Badge variant="outline" className={routeBadgeClass(p.route)}>
                {routeLabel(p.route)}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {p?.hash ?? (loading ? "Loading…" : "")}
          </SheetDescription>
        </SheetHeader>

        {loading && <p className="text-muted-foreground py-8 text-sm">Loading packet…</p>}

        {detail && p && (
          <div className="space-y-6 py-4 text-sm">
            {/* what this message is */}
            <div className="bg-muted/50 rounded-md border px-3 py-2.5 text-[13px] leading-relaxed">
              <p>{payloadTypeDescription(p.payload_type)}</p>
              {p.route && ROUTE_DESCRIPTIONS[p.route] && (
                <p className="text-muted-foreground mt-1.5">{ROUTE_DESCRIPTIONS[p.route]}</p>
              )}
            </div>

            {hasGeo(detail) && (
              <DetailMap advert={detail.advert} hops={detail.hops} />
            )}

            <Section title="Overview">
              <Field label="Packet ID" value={`#${p.id}`} />
              <Field label="Type" value={`${payloadTypeName(p.payload_type)} (${p.payload_type ?? "?"})`} />
              <Field label="Route" value={routeLabel(p.route)} />
              {detail.decoded && <Field label="Version" value={`v${detail.decoded.version + 1}`} />}
              <Field label="Direction" value={p.direction ?? "—"} />
              <Field label="Length" value={`${p.len ?? "—"} B (payload ${p.payload_len ?? "—"} B)`} />
              <Field label="Best SNR" value={p.best_snr == null ? "—" : `${p.best_snr} dB`} />
              <Field label="Best RSSI" value={p.best_rssi == null ? "—" : `${p.best_rssi} dBm`} />
              <Field label="First heard" value={formatDateTime(p.first_seen)} />
              <Field label="Last heard" value={formatDateTime(p.last_seen)} />
            </Section>

            <Section title={`Path (${detail.hops.length} hop${detail.hops.length === 1 ? "" : "s"})`}>
              {detail.hops.length === 0 ? (
                <p className="text-muted-foreground">No path recorded (direct reception).</p>
              ) : (
                <ol className="space-y-1">
                  {detail.hops.map((h, i) => (
                    <li key={`${h.hash}-${i}`} className="flex items-center gap-2">
                      <span className="text-muted-foreground w-5 text-right tabular-nums">{i + 1}.</span>
                      <Badge variant="outline" className="font-mono">{h.hash}</Badge>
                      <span>{h.node ? h.node.name || "(unnamed node)" : <span className="text-muted-foreground">unknown node</span>}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            {detail.advert && (
              <Section title="Advertised identity">
                <Field label="Name" value={detail.advert.name || "—"} />
                <Field label="Node type" value={ADV_TYPE_NAMES[detail.advert.advType] ?? String(detail.advert.advType)} />
                {detail.advert.hasLatLon && (
                  <Field label="Location" value={`${detail.advert.lat?.toFixed(5)}, ${detail.advert.lon?.toFixed(5)}`} />
                )}
                <Field label="Public key" value={detail.advert.pubkey} mono />
              </Section>
            )}

            <Section title={`Receptions (${detail.receptions.length})`}>
              <div className="space-y-2">
                {detail.receptions.map((r, i) => (
                  <div key={i} className="rounded-md border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.iata || r.origin || "observer"}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">{formatDateTime(r.received_at)}</span>
                    </div>
                    <div className="text-muted-foreground text-xs tabular-nums">
                      SNR {r.snr ?? "—"} dB · RSSI {r.rssi ?? "—"} dBm
                      {r.path.length ? ` · path ${r.path.join("→")}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            {detail.decoded && (
              <Section title="Raw wire">
                <p className="text-muted-foreground mb-1 text-xs">
                  payload {detail.decoded.payloadLen} B @ offset {detail.decoded.payloadOffset}
                </p>
                <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                  {/* full packet hex */}
                  {(detail.packet as any).raw ?? detail.decoded.payloadHex}
                </pre>
              </Section>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = `${location.origin}${location.pathname}?p=${p.id}`;
                navigator.clipboard?.writeText(url);
              }}
            >
              Copy link to this packet
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function hasGeo(d: Detail): boolean {
  // Only mesh geography counts — observers aren't drawn on the map.
  return Boolean(d.advert?.hasLatLon) || d.hops.some((h) => h.node);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs break-all text-right" : "text-right"}>{value}</span>
    </div>
  );
}
