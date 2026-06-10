import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveFeed } from "./useLiveFeed";
import { usePacketDetail } from "./usePacketDetail";
import { StatCard, StatusPill } from "./ui-bits";
import { ADV_TYPE_NAMES, formatDateTime } from "@/lib/meshcore";
import { Badge } from "@/components/ui/badge";
import PacketDetailSheet from "./PacketDetail";
import { cn } from "@/lib/utils";
import { OptionFilterHead, OptionRow, TextFilterHead, toggleInSet } from "./table-filters";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Advert {
  id: number;
  pubkey: string;
  hashPrefix: string;
  advType: number;
  hasLatLon: boolean;
  lat: number | null;
  lon: number | null;
  name: string;
  advTimestamp: number;
  hash: string | null;
  last_seen: number;
  reception_count: number;
}

const TYPE_VARIANT: Record<number, "default" | "secondary" | "outline"> = {
  2: "default", // repeater
};

export default function Adverts() {
  const { latest, status, devices } = useLiveFeed();
  const { selectedId, detail, loading, open, close } = usePacketDetail();
  const [adverts, setAdverts] = useState<Advert[]>([]);

  const load = useCallback(() => {
    fetch("/~/api/adverts")
      .then((r) => r.json())
      .then((d) => setAdverts(d.adverts ?? []))
      .catch(() => {});
  }, []);

  // initial + periodic refresh
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // refresh promptly when a new advert is heard
  useEffect(() => {
    if (latest?.payload_type === 4) load();
  }, [latest, load]);

  const located = adverts.filter((a) => a.hasLatLon).length;

  // --- filters ---
  const [advName, setAdvName] = useState("");
  const [advKey, setAdvKey] = useState("");
  const [advTypes, setAdvTypes] = useState<Set<number>>(new Set());
  const [obsName, setObsName] = useState("");
  const [obsSource, setObsSource] = useState<Set<string>>(new Set());

  const advTypeOptions = useMemo(
    () => [...new Set(adverts.map((a) => a.advType))].sort((a, b) => a - b),
    [adverts]
  );

  const shownAdverts = useMemo(() => {
    const n = advName.trim().toLowerCase();
    const k = advKey.trim().toLowerCase();
    return adverts.filter((a) => {
      if (n && !(a.name || "").toLowerCase().includes(n)) return false;
      if (k && !a.pubkey.toLowerCase().includes(k)) return false;
      if (advTypes.size && !advTypes.has(a.advType)) return false;
      return true;
    });
  }, [adverts, advName, advKey, advTypes]);

  const shownDevices = useMemo(() => {
    const n = obsName.trim().toLowerCase();
    return devices.filter((d) => {
      if (n && !((d.origin || "") + (d.iata || "")).toLowerCase().includes(n)) return false;
      if (obsSource.size && !obsSource.has(d.loc_source ?? "iata")) return false;
      return true;
    });
  }, [devices, obsName, obsSource]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Adverts</h1>
          <p className="text-muted-foreground text-sm">
            Decoded MeshCore identity advertisements — node name, type, and self-reported location.
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Nodes advertising" value={adverts.length} />
        <StatCard label="With location" value={located} />
        <StatCard label="Repeaters" value={adverts.filter((a) => a.advType === 2).length} />
        <StatCard label="Observers" value={devices.length} />
      </div>

      {devices.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            Observers
          </h2>
          <div className="rounded-lg border">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <TextFilterHead label="Observer" value={obsName} onChange={setObsName} placeholder="Filter observer…" />
                  </TableHead>
                  <TableHead>IATA</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>
                    <OptionFilterHead label="Source" active={obsSource.size > 0} onClear={() => setObsSource(new Set())}>
                      {["advert", "iata"].map((s) => (
                        <OptionRow key={s} selected={obsSource.has(s)} onClick={() => setObsSource(toggleInSet(obsSource, s))}>
                          <Badge variant={s === "advert" ? "default" : "outline"}>{s === "advert" ? "self-advert" : "IATA"}</Badge>
                        </OptionRow>
                      ))}
                    </OptionFilterHead>
                  </TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownDevices.map((d) => (
                  <TableRow key={d.origin_id}>
                    <TableCell className="font-medium">{d.origin || "observer"}</TableCell>
                    <TableCell className="font-mono text-xs">{d.iata || "—"}</TableCell>
                    <TableCell className="tabular-nums">
                      {d.lat != null && d.lon != null
                        ? `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={d.loc_source === "advert" ? "default" : "outline"}>
                        {d.loc_source === "advert" ? "self-advert" : "IATA"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {formatDateTime(d.last_seen)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <div className="rounded-lg border">
        <Table className="min-w-[680px]">
          <TableHeader>
            <TableRow>
              <TableHead>
                <TextFilterHead label="Name" value={advName} onChange={setAdvName} placeholder="Filter by name…" />
              </TableHead>
              <TableHead>
                <OptionFilterHead label="Type" active={advTypes.size > 0} onClear={() => setAdvTypes(new Set())}>
                  {advTypeOptions.map((t) => (
                    <OptionRow key={t} selected={advTypes.has(t)} onClick={() => setAdvTypes(toggleInSet(advTypes, t))}>
                      <Badge variant={TYPE_VARIANT[t] ?? "outline"}>{ADV_TYPE_NAMES[t] ?? `type ${t}`}</Badge>
                    </OptionRow>
                  ))}
                </OptionFilterHead>
              </TableHead>
              <TableHead>Location</TableHead>
              <TableHead>
                <TextFilterHead label="Public key" value={advKey} onChange={setAdvKey} placeholder="Filter by pubkey…" />
              </TableHead>
              <TableHead className="text-right">Adverts</TableHead>
              <TableHead>Last heard</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownAdverts.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  {adverts.length === 0 ? "No adverts decoded yet…" : "No adverts match the filters."}
                </TableCell>
              </TableRow>
            )}
            {shownAdverts.map((a) => (
              <TableRow
                key={a.pubkey}
                onClick={() => open(a.id)}
                className={cn("cursor-pointer", selectedId === a.id && "bg-muted/60 hover:bg-muted")}
              >
                <TableCell className="font-medium">{a.name || "(unnamed)"}</TableCell>
                <TableCell>
                  <Badge variant={TYPE_VARIANT[a.advType] ?? "outline"}>
                    {ADV_TYPE_NAMES[a.advType] ?? `type ${a.advType}`}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">
                  {a.hasLatLon ? (
                    `${a.lat?.toFixed(4)}, ${a.lon?.toFixed(4)}`
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {a.pubkey.slice(0, 12)}…
                </TableCell>
                <TableCell className="text-right tabular-nums">{a.reception_count}</TableCell>
                <TableCell className="text-xs tabular-nums">{formatDateTime(a.last_seen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

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
