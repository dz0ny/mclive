import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAgo } from "@/lib/meshcore";
import { countryFlag, countryName } from "@/lib/countries";
import { classifyAdvertHealth, fmtDur, type AdvertHealth, type HealthLabel } from "@/lib/advertHealth";
import { cn } from "@/lib/utils";
import {
  OptionFilterHead,
  OptionRow,
  SortToggle,
  TextFilterHead,
  toggleInSet,
} from "./table-filters";
import { useUrlSort, useUrlString, useUrlStrSet } from "./useUrlState";
import { StatCard, StatusPill } from "./ui-bits";
import type { FeedStatus } from "./useLiveFeed";
import RepeaterDetail from "./RepeaterDetail";

interface RepeaterRow {
  pubkey: string;
  hash_prefix: string;
  name: string | null;
  adv_type: number | null;
  lat: number | null;
  lon: number | null;
  country: string | null; // ISO2, resolved from lat/lon (or null)
  last_advert_ts: number | null;
  updated_at: number;
  telemetry_at: number | null;
  telemetry_observer: string | null;
  telemetry_snr: number | null;
  telemetry_rssi: number | null;
  has_telemetry: boolean;
  // cadence stats over the node's full advert history (advert_pubkey index)
  advert_count: number;
  first_advert: number;
  last_advert: number;
}

type SortKey = "health" | "telemetry" | "last";
type TelOpt = "yes" | "no";

function isLocated(r: RepeaterRow): boolean {
  return r.lat != null && r.lon != null && !(r.lat === 0 && r.lon === 0);
}

export default function Repeaters() {
  const [repeaters, setRepeaters] = useState<RepeaterRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  // selected repeater pubkey — in the URL (?pk=…) so the page is deep-linkable
  const [pk, setPk] = useUrlString("pk");

  // --- filters & sorting (mirrored into the URL so views are shareable) ---
  const [fName, setFName] = useUrlString("name");
  const [fKey, setFKey] = useUrlString("key");
  const [fTel, setFTel] = useUrlStrSet<TelOpt>("tel");
  const [fHealth, setFHealth] = useUrlStrSet<HealthLabel>("health");
  const [fCountries, setFCountries] = useUrlStrSet<string>("country");
  const [sort, setSort] = useUrlSort<SortKey>();

  const toggleSort = (key: SortKey) =>
    setSort(sort?.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : null);

  const load = useCallback(() => {
    fetch("/~/api/repeaters")
      .then((r) => r.json())
      .then((d) => setRepeaters(d.repeaters ?? []))
      .catch(() => {});
  }, []);

  // initial + periodic refresh, and a prompt refresh when telemetry lands
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    const es = new EventSource("/~/stream");
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("offline");
    es.onmessage = (e) => {
      let evt: any;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      // a fresh telemetry snapshot or a new repeater advert is worth a refresh
      if (evt.type === "telemetry" || (evt.type === "node" && evt.node?.adv_type === 2)) load();
    };
    return () => {
      clearInterval(t);
      es.close();
    };
  }, [load]);

  const now = Date.now();
  const withTelemetry = repeaters.filter((r) => r.has_telemetry).length;

  // countries actually present among located repeaters, sorted by display name
  const countryOptions = useMemo(
    () =>
      [...new Set(repeaters.map((r) => r.country).filter((c): c is string => !!c))].sort((a, b) =>
        countryName(a).localeCompare(countryName(b))
      ),
    [repeaters]
  );

  // attach advert-cadence health to each node, judged against its own rhythm
  // (identical to the Adverts table)
  const enriched = useMemo(() => {
    const t = Date.now();
    return repeaters.map((r) => {
      const gaps = (r.advert_count ?? 1) - 1;
      const typical = gaps >= 2 ? (r.last_advert - r.first_advert) / gaps : null;
      const lastHeard = Math.max(r.last_advert ?? 0, r.last_advert_ts ?? 0, r.updated_at);
      const health = classifyAdvertHealth(typical, gaps, t - lastHeard);
      return { ...r, typical, health };
    });
  }, [repeaters]);

  const healthOptions = useMemo(() => {
    const present = new Map<HealthLabel, AdvertHealth>();
    for (const r of enriched) if (!present.has(r.health.label)) present.set(r.health.label, r.health);
    return [...present.values()].sort((a, b) => a.rank - b.rank);
  }, [enriched]);

  const shown = useMemo(() => {
    const n = fName.trim().toLowerCase();
    const k = fKey.trim().toLowerCase();
    const out = enriched.filter((r) => {
      if (n && !(r.name || "").toLowerCase().includes(n)) return false;
      if (k && !r.pubkey.toLowerCase().includes(k)) return false;
      if (fTel.size && !fTel.has(r.has_telemetry ? "yes" : "no")) return false;
      if (fHealth.size && !fHealth.has(r.health.label)) return false;
      if (fCountries.size && !(r.country && fCountries.has(r.country))) return false;
      return true;
    });
    if (sort) {
      const { key, dir } = sort;
      out.sort((a, b) => {
        const d =
          key === "health"
            ? a.health.rank - b.health.rank
            : key === "telemetry"
              ? (a.telemetry_at ?? 0) - (b.telemetry_at ?? 0)
              : a.updated_at - b.updated_at;
        return d * dir;
      });
    }
    return out;
  }, [enriched, fName, fKey, fTel, fHealth, fCountries, sort]);

  const selectedName = useMemo(
    () => repeaters.find((r) => r.pubkey === pk)?.name ?? undefined,
    [repeaters, pk]
  );

  if (pk) {
    return (
      <RepeaterDetail pubkey={pk} fallbackName={selectedName || undefined} onBack={() => setPk("")} />
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Repeaters</h1>
          <p className="text-muted-foreground text-sm">
            Repeater nodes on the mesh. Observers auto-probe each repeater after hearing its advert —
            click one for its latest telemetry and traceroute.
          </p>
        </div>
        <StatusPill status={status} />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Repeaters" value={repeaters.length} />
        <StatCard label="With telemetry" value={withTelemetry} />
        <StatCard label="Located" value={repeaters.filter(isLocated).length} />
        <StatCard label="Countries" value={countryOptions.length} />
      </div>

      <div className="rounded-lg border">
        <Table className="min-w-[920px]">
          <TableHeader>
            <TableRow>
              <TableHead>
                <TextFilterHead label="Name" value={fName} onChange={setFName} placeholder="Filter by name…" />
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  <OptionFilterHead
                    label="Telemetry"
                    active={fTel.size > 0}
                    onClear={() => setFTel(new Set())}
                  >
                    <OptionRow selected={fTel.has("yes")} onClick={() => setFTel(toggleInSet(fTel, "yes"))}>
                      <Badge variant="outline" className="text-green-600 dark:text-green-400">
                        ✓ has telemetry
                      </Badge>
                    </OptionRow>
                    <OptionRow selected={fTel.has("no")} onClick={() => setFTel(toggleInSet(fTel, "no"))}>
                      <span className="text-muted-foreground text-xs">— none yet</span>
                    </OptionRow>
                  </OptionFilterHead>
                  <SortToggle dir={sort?.key === "telemetry" ? sort.dir : null} onClick={() => toggleSort("telemetry")} />
                </span>
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  <OptionFilterHead label="Health" active={fHealth.size > 0} onClear={() => setFHealth(new Set())}>
                    {healthOptions.map((h) => (
                      <OptionRow
                        key={h.label}
                        selected={fHealth.has(h.label)}
                        onClick={() => setFHealth(toggleInSet(fHealth, h.label))}
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
                <span className="flex items-center gap-1">Interval</span>
              </TableHead>
              <TableHead>
                <OptionFilterHead
                  label="Location"
                  active={fCountries.size > 0}
                  onClear={() => setFCountries(new Set())}
                >
                  {countryOptions.length === 0 && (
                    <p className="text-muted-foreground px-2 py-1.5 text-xs">No located repeaters yet</p>
                  )}
                  {countryOptions.map((c) => (
                    <OptionRow
                      key={c}
                      selected={fCountries.has(c)}
                      onClick={() => setFCountries(toggleInSet(fCountries, c))}
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
                <TextFilterHead label="Public key" value={fKey} onChange={setFKey} placeholder="Filter by pubkey…" />
              </TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  Last advert
                  <SortToggle dir={sort?.key === "last" ? sort.dir : null} onClick={() => toggleSort("last")} />
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  {repeaters.length === 0 ? "No repeaters seen yet…" : "No repeaters match the filters."}
                </TableCell>
              </TableRow>
            )}
            {shown.map((r) => (
              <TableRow key={r.pubkey} onClick={() => setPk(r.pubkey)} className="cursor-pointer">
                <TableCell className="font-medium">{r.name || "(unnamed)"}</TableCell>
                <TableCell>
                  {r.has_telemetry ? (
                    <Badge variant="outline" className="text-green-600 dark:text-green-400">
                      ✓ {r.telemetry_at != null ? formatAgo(r.telemetry_at, now) : ""}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    title={r.health.detail}
                    className={cn(
                      "whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      r.health.cls
                    )}
                  >
                    {r.health.label}
                  </span>
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.typical != null ? `~${fmtDur(r.typical)}` : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="tabular-nums">
                  {isLocated(r) ? (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {r.country && (
                        <span title={countryName(r.country)} aria-label={countryName(r.country)}>
                          {countryFlag(r.country)}
                        </span>
                      )}
                      {r.lat?.toFixed(4)}, {r.lon?.toFixed(4)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {r.pubkey.slice(0, 12)}…
                </TableCell>
                <TableCell className="text-xs tabular-nums">{formatAgo(r.updated_at, now)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
