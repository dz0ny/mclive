import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveFeed } from "./useLiveFeed";
import { usePacketDetail } from "./usePacketDetail";
import { StatCard, StatusPill } from "./ui-bits";
import { ADV_TYPE_NAMES, formatDateTime } from "@/lib/meshcore";
import { classifyAdvertHealth, fmtDur, type AdvertHealth, type HealthLabel } from "@/lib/advertHealth";
import { countryFlag, countryName } from "@/lib/countries";
import { Badge } from "@/components/ui/badge";
import PacketDetailSheet from "./PacketDetail";
import NodeAdvertSheet from "./NodeAdvertSheet";
import { cn } from "@/lib/utils";
import {
  OptionFilterHead,
  OptionRow,
  SortToggle,
  TextFilterHead,
  toggleInSet,
} from "./table-filters";
import { useUrlNumSet, useUrlSort, useUrlString, useUrlStrSet } from "./useUrlState";
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
  country: string | null; // ISO2 (resolved by point-in-polygon), or null
  name: string;
  advTimestamp: number;
  hash: string | null;
  last_seen: number;
  reception_count: number;
  // cadence stats over the node's full advert history (advert_pubkey index)
  advert_count: number;
  first_advert: number;
  last_advert: number;
}

type SortKey = "health" | "interval" | "count" | "last";

const TYPE_VARIANT: Record<number, "default" | "secondary" | "outline"> = {
  2: "default", // repeater
};

export default function Adverts() {
  const { latest, status } = useLiveFeed();
  const { selectedId, detail, loading, open, close } = usePacketDetail();
  const [adverts, setAdverts] = useState<Advert[]>([]);
  // pubkey of the node whose advert history/health sheet is open — in the URL
  // (?node=…) so a node view is directly shareable / deep-linkable
  const [openKey, setOpenKey] = useUrlString("node");

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

  // --- filters & sorting (mirrored into the URL so views are shareable) ---
  const [advName, setAdvName] = useUrlString("name");
  const [advKey, setAdvKey] = useUrlString("key");
  const [advTypes, setAdvTypes] = useUrlNumSet("type");
  const [advHealth, setAdvHealth] = useUrlStrSet<HealthLabel>("health");
  const [advCountries, setAdvCountries] = useUrlStrSet<string>("country");
  const [sort, setSort] = useUrlSort<SortKey>();

  const toggleSort = (key: SortKey) =>
    setSort(sort?.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : null);

  const advTypeOptions = useMemo(
    () => [...new Set(adverts.map((a) => a.advType))].sort((a, b) => a - b),
    [adverts]
  );

  // countries actually present among located adverts, sorted by display name
  const countryOptions = useMemo(
    () =>
      [...new Set(adverts.map((a) => a.country).filter((c): c is string => !!c))].sort((a, b) =>
        countryName(a).localeCompare(countryName(b))
      ),
    [adverts]
  );

  // attach cadence health to each node, judged against its own advert rhythm
  const enriched = useMemo(() => {
    const now = Date.now();
    return adverts.map((a) => {
      const gaps = (a.advert_count ?? 1) - 1;
      // mean interval over the node's full history (median lives in the sheet)
      const typical = gaps >= 2 ? (a.last_advert - a.first_advert) / gaps : null;
      const lastHeard = Math.max(a.last_advert ?? 0, a.last_seen);
      const health = classifyAdvertHealth(typical, gaps, now - lastHeard);
      return { ...a, typical, health };
    });
  }, [adverts]);

  // resolve the open pubkey to its row (for the header name + row highlight);
  // the sheet itself fetches history by pubkey, so a deep link works even
  // before this node appears in the current adverts list
  const healthNode = useMemo(
    () => (openKey ? enriched.find((a) => a.pubkey === openKey) ?? null : null),
    [enriched, openKey]
  );

  const healthOptions = useMemo(() => {
    const present = new Map<HealthLabel, AdvertHealth>();
    for (const a of enriched) if (!present.has(a.health.label)) present.set(a.health.label, a.health);
    return [...present.values()].sort((a, b) => a.rank - b.rank);
  }, [enriched]);

  const shownAdverts = useMemo(() => {
    const n = advName.trim().toLowerCase();
    const k = advKey.trim().toLowerCase();
    const out = enriched.filter((a) => {
      if (n && !(a.name || "").toLowerCase().includes(n)) return false;
      if (k && !a.pubkey.toLowerCase().includes(k)) return false;
      if (advTypes.size && !advTypes.has(a.advType)) return false;
      if (advHealth.size && !advHealth.has(a.health.label)) return false;
      if (advCountries.size && !(a.country && advCountries.has(a.country))) return false;
      return true;
    });
    if (sort) {
      const { key, dir } = sort;
      out.sort((a, b) => {
        let d = 0;
        if (key === "health") d = a.health.rank - b.health.rank;
        else if (key === "interval") d = (a.typical ?? Infinity) - (b.typical ?? Infinity);
        else if (key === "count") d = a.advert_count - b.advert_count;
        else d = a.last_seen - b.last_seen;
        return d * dir;
      });
    }
    return out;
  }, [enriched, advName, advKey, advTypes, advHealth, advCountries, sort]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Adverts</h1>
          <p className="text-muted-foreground text-sm">
            Decoded MeshCore identity advertisements — node name, type, and self-reported location.
            Click a node for its advert history and health.
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Nodes advertising" value={adverts.length} />
        <StatCard label="With location" value={located} />
        <StatCard label="Countries" value={countryOptions.length} />
        <StatCard label="Repeaters" value={adverts.filter((a) => a.advType === 2).length} />
      </div>

      <div className="rounded-lg border">
        <Table className="min-w-[880px]">
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
              <TableHead>
                <span className="flex items-center gap-1">
                  <OptionFilterHead label="Health" active={advHealth.size > 0} onClear={() => setAdvHealth(new Set())}>
                    {healthOptions.map((h) => (
                      <OptionRow
                        key={h.label}
                        selected={advHealth.has(h.label)}
                        onClick={() => setAdvHealth(toggleInSet(advHealth, h.label))}
                      >
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", h.cls)}>
                          {h.label}
                        </span>
                      </OptionRow>
                    ))}
                  </OptionFilterHead>
                  <SortToggle dir={sort?.key === "health" ? sort.dir : null} onClick={() => toggleSort("health")} />
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  Interval
                  <SortToggle dir={sort?.key === "interval" ? sort.dir : null} onClick={() => toggleSort("interval")} />
                </span>
              </TableHead>
              <TableHead>
                <OptionFilterHead
                  label="Location"
                  active={advCountries.size > 0}
                  onClear={() => setAdvCountries(new Set())}
                >
                  {countryOptions.length === 0 && (
                    <p className="text-muted-foreground px-2 py-1.5 text-xs">No located nodes yet</p>
                  )}
                  {countryOptions.map((c) => (
                    <OptionRow
                      key={c}
                      selected={advCountries.has(c)}
                      onClick={() => setAdvCountries(toggleInSet(advCountries, c))}
                    >
                      <span className="flex items-center gap-2">
                        <span aria-hidden>{countryFlag(c)}</span>
                        {countryName(c)}
                      </span>
                    </OptionRow>
                  ))}
                </OptionFilterHead>
              </TableHead>
              <TableHead>
                <TextFilterHead label="Public key" value={advKey} onChange={setAdvKey} placeholder="Filter by pubkey…" />
              </TableHead>
              <TableHead className="text-right">
                <span className="flex items-center justify-end gap-1">
                  Adverts
                  <SortToggle dir={sort?.key === "count" ? sort.dir : null} onClick={() => toggleSort("count")} />
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  Last heard
                  <SortToggle dir={sort?.key === "last" ? sort.dir : null} onClick={() => toggleSort("last")} />
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownAdverts.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
                  {adverts.length === 0 ? "No adverts decoded yet…" : "No adverts match the filters."}
                </TableCell>
              </TableRow>
            )}
            {shownAdverts.map((a) => (
              <TableRow
                key={a.pubkey}
                onClick={() => setOpenKey(a.pubkey)}
                className={cn(
                  "cursor-pointer",
                  openKey === a.pubkey && "bg-muted/60 hover:bg-muted"
                )}
              >
                <TableCell className="font-medium">{a.name || "(unnamed)"}</TableCell>
                <TableCell>
                  <Badge variant={TYPE_VARIANT[a.advType] ?? "outline"}>
                    {ADV_TYPE_NAMES[a.advType] ?? `type ${a.advType}`}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span
                    title={a.health.detail}
                    className={cn(
                      "whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      a.health.cls
                    )}
                  >
                    {a.health.label}
                  </span>
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {a.typical != null ? `~${fmtDur(a.typical)}` : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="tabular-nums">
                  {a.hasLatLon ? (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {a.country && (
                        <span title={countryName(a.country)} aria-label={countryName(a.country)}>
                          {countryFlag(a.country)}
                        </span>
                      )}
                      {a.lat?.toFixed(4)}, {a.lon?.toFixed(4)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {a.pubkey.slice(0, 12)}…
                </TableCell>
                <TableCell className="text-right tabular-nums">{a.advert_count}</TableCell>
                <TableCell className="text-xs tabular-nums">{formatDateTime(a.last_seen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <NodeAdvertSheet
        pubkey={openKey || null}
        fallbackName={healthNode?.name}
        onClose={() => setOpenKey("")}
        onOpenPacket={(id) => {
          setOpenKey("");
          open(id);
        }}
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
