import { useEffect, useMemo, useState } from "react";
import { decodeGroupData, decodeGroupText, loadAllChannels, type Channel } from "@/lib/channel";
import type { MeshNode, PacketDetail as Detail } from "@/lib/meshcore";
import {
  ADV_TYPE_NAMES,
  ROUTE_DESCRIPTIONS,
  formatDateTime,
  type Hop,
  nodeForHash,
  payloadTypeDescription,
  payloadTypeName,
  routeBadgeClass,
  routeLabel,
  scopeLabel,
  snrClass,
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
import DetailMap, { type BeaconPoint } from "./DetailMap";

interface Props {
  open: boolean;
  loading: boolean;
  detail: Detail | null;
  onOpenChange: (open: boolean) => void;
}

// The node directory, fetched once and shared, so a GRP_DATA beacon's sender
// (a pubkey prefix) can be resolved to a friendly name in the detail sheet.
let nodeDirCache: Promise<MeshNode[]> | null = null;
function loadNodeDir(): Promise<MeshNode[]> {
  if (!nodeDirCache) {
    nodeDirCache = fetch("/~/api/nodes")
      .then((r) => (r.ok ? r.json() : { nodes: [] }))
      .then((d) => (d.nodes ?? []) as MeshNode[])
      .catch(() => []);
  }
  return nodeDirCache;
}

export default function PacketDetail({ open, loading, detail, onOpenChange }: Props) {
  const p = detail?.packet;

  // known channels (public + user-added on the Channels page, from localStorage)
  // — lets us show the plaintext of GRP_TXT packets we hold the key for
  const [channels, setChannels] = useState<Channel[]>([]);
  useEffect(() => {
    loadAllChannels().then(setChannels).catch(() => {});
  }, []);
  const message = useMemo(() => {
    const raw = (p as any)?.raw as string | undefined;
    if (p?.payload_type !== 5 || !raw || channels.length === 0) return null;
    return decodeGroupText(raw, channels);
  }, [p, channels]);

  // GRP_DATA (type 6): same channel keys, but the plaintext is an app datagram —
  // we surface the channel and, for fast-GPS beacons, the reported position.
  const [nodeDir, setNodeDir] = useState<MeshNode[]>([]);
  useEffect(() => {
    loadNodeDir().then(setNodeDir).catch(() => {});
  }, []);
  const groupData = useMemo(() => {
    const raw = (p as any)?.raw as string | undefined;
    if (p?.payload_type !== 6 || !raw || channels.length === 0) return null;
    return decodeGroupData(raw, channels);
  }, [p, channels]);
  const beaconName = useMemo(() => {
    const loc = groupData?.location;
    if (!loc) return null;
    return nodeForHash(loc.pubkeyPrefix, nodeDir)?.name || loc.pubkeyPrefix.slice(0, 12);
  }, [groupData, nodeDir]);
  const beacon: BeaconPoint | null = groupData?.location
    ? { lat: groupData.location.lat, lon: groupData.location.lon, label: beaconName ?? "reported position" }
    : null;

  // A reception can be selected to inspect the exact path *it* heard. The
  // default Path/Map view uses detail.hops (the packet's authoritative path);
  // selecting a reception rebuilds the hop chain from that reception's own path.
  const [selectedRec, setSelectedRec] = useState<number | null>(null);
  useEffect(() => {
    setSelectedRec(null); // reset when a different packet opens
  }, [detail?.packet?.id]);
  const activeHops: Hop[] = useMemo(() => {
    if (!detail) return [];
    if (selectedRec == null) return detail.hops;
    const rec = detail.receptions[selectedRec];
    if (!rec) return detail.hops;
    return rec.path.map((hash) => ({ hash, node: nodeForHash(hash, nodeDir) }));
  }, [detail, selectedRec, nodeDir]);

  // TRACE (type 9): the path IS the traceroute, and decoded.traceSnrs carries
  // the per-link SNR each repeater measured. Only annotate the packet's own
  // route (a selected reception path has no per-hop SNR).
  const traceSnrs = detail?.decoded?.traceSnrs ?? null;
  const showTrace = p?.payload_type === 9 && selectedRec == null && Array.isArray(traceSnrs);

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
            {detail?.decoded && scopeLabel(detail.decoded.scope, p?.route) && (
              <Badge variant="outline" className="font-mono">
                {scopeLabel(detail.decoded.scope, p?.route)}
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

            {message && (
              <Section title={`Message · #${message.channel}`}>
                <div className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{message.sender ?? "unknown sender"}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatDateTime(message.timestamp * 1000)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words">{message.text}</p>
                </div>
              </Section>
            )}
            {!message && p.payload_type === 5 && (
              <p className="text-muted-foreground text-xs">
                Encrypted group message — no matching channel key in this browser. Add the
                channel on the <a href="/channels/" className="underline underline-offset-2">Channels</a> page to decrypt it.
              </p>
            )}

            {groupData && (
              <Section title={`Group data · #${groupData.channel}`}>
                <div className="rounded-md border px-3 py-2">
                  {groupData.location ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{beaconName ?? "unknown node"}</span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {formatDateTime(p.last_seen)}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Shared GPS position ·{" "}
                        <span className="font-mono">
                          {groupData.location.lat.toFixed(5)}, {groupData.location.lon.toFixed(5)}
                        </span>
                        {groupData.location.speed > 0 && (
                          <> · <span className="font-mono">{groupData.location.speed} km/h</span></>
                        )}
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Application datagram (data-type 0x
                      {groupData.dataType.toString(16).padStart(4, "0")}) — no known format to decode.
                    </p>
                  )}
                </div>
              </Section>
            )}
            {!groupData && p.payload_type === 6 && (
              <p className="text-muted-foreground text-xs">
                Encrypted group datagram — no matching channel key in this browser. Add the
                channel on the <a href="/channels/" className="underline underline-offset-2">Channels</a> page to decode it.
              </p>
            )}

            {(hasGeo(detail.advert, activeHops) || beacon) && (
              <DetailMap advert={detail.advert} hops={activeHops} beacon={beacon} />
            )}

            <Section title="Overview">
              <Field label="Packet ID" value={`#${p.id}`} />
              <Field label="Type" value={`${payloadTypeName(p.payload_type)} (${p.payload_type ?? "?"})`} />
              <Field label="Route" value={routeLabel(p.route)} />
              {detail.decoded?.transportCodes && (
                <Field
                  label="Region scope"
                  value={
                    detail.decoded.scope
                      ? `#${detail.decoded.scope}`
                      : detail.decoded.transportCodes[0] === 0 && detail.decoded.transportCodes[1] === 0
                        ? "none (Share — direct neighbours only)"
                        : `unknown region (code 0x${detail.decoded.transportCodes[0].toString(16).padStart(4, "0")})`
                  }
                />
              )}
              {detail.decoded && <Field label="Version" value={`v${detail.decoded.version + 1}`} />}
              <Field label="Direction" value={p.direction ?? "—"} />
              <Field label="Length" value={`${p.len ?? "—"} B (payload ${p.payload_len ?? "—"} B)`} />
              <Field label="Best SNR" value={p.best_snr == null ? "—" : `${p.best_snr} dB`} />
              <Field label="Best RSSI" value={p.best_rssi == null ? "—" : `${p.best_rssi} dBm`} />
              <Field label="First heard" value={formatDateTime(p.first_seen)} />
              <Field label="Last heard" value={formatDateTime(p.last_seen)} />
            </Section>

            <Section
              title={`${showTrace ? "Traceroute" : "Path"} (${activeHops.length} hop${activeHops.length === 1 ? "" : "s"})`}
            >
              {showTrace && (
                <p className="text-muted-foreground mb-2 text-xs">
                  Diagnostic route — each repeater appends the SNR it heard from the previous hop, so the
                  link quality is mapped step by step. {traceSnrs!.length} of {Math.max(0, activeHops.length - 1)}{" "}
                  link{activeHops.length - 1 === 1 ? "" : "s"} measured.
                </p>
              )}
              {selectedRec != null && (
                <p className="text-muted-foreground mb-2 text-xs">
                  Path heard by{" "}
                  <span className="font-medium">
                    {detail.receptions[selectedRec]?.origin ||
                      detail.receptions[selectedRec]?.iata ||
                      "observer"}
                  </span>
                  .{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => setSelectedRec(null)}
                  >
                    Show packet path
                  </button>
                </p>
              )}
              {activeHops.length === 0 ? (
                <p className="text-muted-foreground">No path recorded (direct reception).</p>
              ) : (
                <ol className="space-y-1">
                  {activeHops.map((h, i) => (
                    <li key={`${h.hash}-${i}`} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground w-5 text-right tabular-nums">{i + 1}.</span>
                        <Badge variant="outline" className="font-mono">{h.hash}</Badge>
                        <span>{h.node ? h.node.name || "(unnamed node)" : <span className="text-muted-foreground">unknown node</span>}</span>
                      </div>
                      {showTrace && i < activeHops.length - 1 && (
                        <div className="text-muted-foreground flex items-center gap-2 pl-7 text-xs">
                          <span aria-hidden>↓</span>
                          {traceSnrs![i] != null ? (
                            <span className={cn("font-mono tabular-nums", snrClass(traceSnrs![i]))}>
                              {traceSnrs![i].toFixed(2)} dB
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
                {detail.receptions.map((r, i) => {
                  const selected = selectedRec === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelectedRec(selected ? null : i)}
                      aria-pressed={selected}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left transition-colors",
                        "hover:border-primary/50 hover:bg-muted/50",
                        selected && "border-primary bg-primary/5 ring-1 ring-primary/30"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{r.origin || r.iata || "observer"}</span>
                        <span className="text-muted-foreground text-xs tabular-nums">{formatDateTime(r.received_at)}</span>
                      </div>
                      <div className="text-muted-foreground text-xs tabular-nums">
                        SNR {r.snr ?? "—"} dB · RSSI {r.rssi ?? "—"} dBm
                        {r.path.length ? ` · path ${r.path.join("→")}` : ""}
                      </div>
                    </button>
                  );
                })}
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

function hasGeo(advert: Detail["advert"], hops: Hop[]): boolean {
  // Only mesh geography counts — observers aren't drawn on the map.
  return Boolean(advert?.hasLatLon) || hops.some((h) => h.node);
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
