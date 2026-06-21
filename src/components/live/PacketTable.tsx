import { useEffect, useMemo, useRef, useState } from "react";
import { decodeGroupData, decodeGroupText, loadAllChannels, type Channel } from "@/lib/channel";
import type { MeshNode, Packet } from "@/lib/meshcore";
import {
  formatTime,
  matchesSenderQuery,
  nodeForHash,
  payloadTypeName,
  routeBadgeClass,
  routeLabel,
  scopeLabel,
  senderName,
  typeBadgeClass,
} from "@/lib/meshcore";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { OptionFilterHead, OptionRow, TextFilterHead, toggleInSet } from "./table-filters";
import { useUrlNumSet, useUrlString, useUrlStrSet } from "./useUrlState";

interface Props {
  packets: Packet[];
  selectedId: number | null;
  /** epoch ms scrubbed-to on the timeline; the nearest row is highlighted */
  scrubTs?: number | null;
  /** known nodes, for resolving the sending node from a packet's path */
  nodes?: MeshNode[];
  /** fired with the active Sender column query so the parent can pull history */
  onSenderQuery?: (q: string) => void;
  onSelect: (p: Packet) => void;
}

const rowKey = (p: Packet) => p.hash ?? `${p.id}`;

function packetNode(p: Packet, nodes: MeshNode[], channels: Channel[]): string | null {
  // Adverts carry their pubkey; REQ/RESPONSE/TXT/PATH carry a src hash
  // (pathHashSize bytes); ANON_REQ a full pubkey — all resolved from the
  // payload, never the path (path hops are relays, not the originator).
  const name = senderName(p, nodes);
  if (name) return name;
  // GRP_TXT hides the sender inside the ciphertext — decryptable on known channels.
  if (p.payload_type === 5 && p.raw && channels.length) {
    return decodeGroupText(p.raw, channels)?.sender ?? null;
  }
  // GRP_DATA location beacons carry the sender's pubkey prefix in the (decrypted)
  // blob — resolve it to a node name, else show the short prefix.
  if (p.payload_type === 6 && p.raw && channels.length) {
    const loc = decodeGroupData(p.raw, channels)?.location;
    if (loc) return nodeForHash(loc.pubkeyPrefix, nodes)?.name || loc.pubkeyPrefix.slice(0, 12);
  }
  return null;
}

// Path hash width in bytes (a hop token is hex, so 2 chars = 1 byte). Identifies
// the network generation: 1-byte = old networks, 2/3-byte = newer. 0 = no path.
function pathBytes(p: Packet): number {
  return p.path.length ? p.path[0].length >> 1 : 0;
}

export default function PacketTable({ packets, selectedId, scrubTs, nodes, onSenderQuery, onSelect }: Props) {
  // filters live in the URL so a filtered view is shareable
  const [sender, setSender] = useUrlString("sender");
  const [pathQ, setPathQ] = useUrlString("path");
  const [types, setTypes] = useUrlNumSet("type");
  const [routes, setRoutes] = useUrlStrSet("route");
  const [hashSizes, setHashSizes] = useUrlNumSet("hb");
  const [channels, setChannels] = useState<Channel[]>([]);

  // known channels (public + user-added), for decoding GRP_TXT senders
  useEffect(() => {
    loadAllChannels().then(setChannels).catch(() => {});
  }, []);

  // surface the Sender query so the parent can pull matching history from the
  // server — the live feed only holds a rolling window, so a client-side filter
  // alone would miss a quiet device's older packets.
  useEffect(() => {
    onSenderQuery?.(sender);
  }, [sender, onSenderQuery]);

  // sender label per packet, memoized — decryption/decoding is per-row work
  const senderLabels = useMemo(() => {
    const m = new Map<Packet, string | null>();
    for (const p of packets) m.set(p, packetNode(p, nodes ?? [], channels));
    return m;
  }, [packets, nodes, channels]);

  // options present in the current data
  const typeOptions = useMemo(() => {
    const s = new Set<number>();
    for (const p of packets) if (p.payload_type != null) s.add(p.payload_type);
    return [...s].sort((a, b) => a - b);
  }, [packets]);
  const routeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of packets) if (p.route) s.add(p.route);
    return [...s];
  }, [packets]);
  const hashSizeOptions = useMemo(() => {
    const s = new Set<number>();
    for (const p of packets) {
      const b = pathBytes(p);
      if (b > 0) s.add(b);
    }
    return [...s].sort((a, b) => a - b);
  }, [packets]);

  // pubkeys of nodes whose name matches a (non-hex) Sender query — lets a name
  // filter match packets the device *relayed*, not just ones it originated, so
  // it behaves like the map's device (?node=) filter.
  const senderNodeKeys = useMemo(() => {
    const sq = sender.trim().toLowerCase();
    if (!sq) return [] as string[];
    const isHex = sq.split(/\s+/).every((t) => t.length >= 2 && t.length <= 8 && t.length % 2 === 0 && /^[0-9a-f]+$/.test(t));
    if (isHex) return [];
    return (nodes ?? []).filter((n) => (n.name || "").toLowerCase().includes(sq)).map((n) => n.pubkey.toLowerCase());
  }, [sender, nodes]);

  const rows = useMemo(() => {
    const pq = pathQ.trim().toLowerCase();
    const sq = sender.trim().toLowerCase();
    const sqIsHex =
      sq.length > 0 &&
      sq.split(/\s+/).every((t) => t.length >= 2 && t.length <= 8 && t.length % 2 === 0 && /^[0-9a-f]+$/.test(t));
    return packets.filter((p) => {
      if (sq) {
        // hex → match on-wire sender hash / path hops; text → match the resolved
        // sender label OR a path hop of a same-named node (sent or relayed)
        if (sqIsHex) {
          if (!matchesSenderQuery(p, sender, nodes ?? [])) return false;
        } else {
          const labelHit = (senderLabels.get(p) ?? "").toLowerCase().includes(sq);
          const pathHit =
            senderNodeKeys.length > 0 &&
            p.path.some((h) => senderNodeKeys.some((pk) => pk.startsWith(h.toLowerCase())));
          if (!labelHit && !pathHit) return false;
        }
      }
      if (pq && !p.path.some((h) => h.toLowerCase().includes(pq))) return false;
      if (hashSizes.size && !hashSizes.has(pathBytes(p))) return false;
      if (types.size && (p.payload_type == null || !types.has(p.payload_type))) return false;
      if (routes.size && (!p.route || !routes.has(p.route))) return false;
      return true;
    });
  }, [packets, nodes, sender, senderLabels, senderNodeKeys, pathQ, hashSizes, types, routes]);

  // the visible row closest in time to the timeline playhead
  const scrubKey = useMemo(() => {
    if (scrubTs == null || rows.length === 0) return null;
    let best: Packet | null = null;
    let bestDist = Infinity;
    for (const p of rows) {
      const d = Math.abs(p.last_seen - scrubTs);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best ? rowKey(best) : null;
  }, [scrubTs, rows]);

  // bring the scrubbed-to row into view as the playhead moves
  const scrubRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (scrubKey) scrubRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrubKey]);

  return (
    <div className="rounded-lg border">
      <Table className="min-w-[560px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[90px]">Time</TableHead>
            <TableHead>
              <TextFilterHead
                label="Sender"
                value={sender}
                onChange={setSender}
                placeholder="Name, or hash(es): a3 7f, baba…"
              />
            </TableHead>
            <TableHead>
              <OptionFilterHead label="Type" active={types.size > 0} onClear={() => setTypes(new Set())}>
                {typeOptions.map((t) => (
                  <OptionRow key={t} selected={types.has(t)} onClick={() => setTypes(toggleInSet(types, t))}>
                    <Badge variant="outline" className={cn("font-mono", typeBadgeClass(t))}>
                      {payloadTypeName(t)}
                    </Badge>
                  </OptionRow>
                ))}
              </OptionFilterHead>
            </TableHead>
            <TableHead>
              <OptionFilterHead label="Route" active={routes.size > 0} onClear={() => setRoutes(new Set())}>
                {routeOptions.map((r) => (
                  <OptionRow key={r} selected={routes.has(r)} onClick={() => setRoutes(toggleInSet(routes, r))}>
                    <Badge variant="outline" className={routeBadgeClass(r)}>
                      {routeLabel(r)}
                    </Badge>
                  </OptionRow>
                ))}
              </OptionFilterHead>
            </TableHead>
            <TableHead className="text-right">Len</TableHead>
            <TableHead>
              <span className="flex items-center gap-2">
                <TextFilterHead label="Path" value={pathQ} onChange={setPathQ} placeholder="Filter by hop hash…" />
                <OptionFilterHead
                  label="bytes"
                  active={hashSizes.size > 0}
                  onClear={() => setHashSizes(new Set())}
                  align="end"
                >
                  {hashSizeOptions.length === 0 && (
                    <span className="text-muted-foreground block px-2 py-1.5 text-xs">no paths yet</span>
                  )}
                  {hashSizeOptions.map((b) => (
                    <OptionRow key={b} selected={hashSizes.has(b)} onClick={() => setHashSizes(toggleInSet(hashSizes, b))}>
                      <span className="font-mono text-xs">
                        {b}-byte <span className="text-muted-foreground">{b === 1 ? "(old)" : "(new)"}</span>
                      </span>
                    </OptionRow>
                  ))}
                </OptionFilterHead>
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                {packets.length === 0 ? "Waiting for packets…" : "No packets match the filters."}
              </TableCell>
            </TableRow>
          )}
          {rows.map((p) => {
            const isScrub = scrubKey != null && rowKey(p) === scrubKey;
            return (
            <TableRow
              key={rowKey(p)}
              ref={isScrub ? scrubRowRef : undefined}
              onClick={() => onSelect(p)}
              className={cn(
                "cursor-pointer",
                selectedId === p.id && "bg-muted/60 hover:bg-muted",
                isScrub && "ring-primary bg-primary/5 ring-2 ring-inset"
              )}
            >
              <TableCell className="font-mono text-xs tabular-nums">{formatTime(p.last_seen)}</TableCell>
              <TableCell className="text-xs">
                {senderLabels.get(p) ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={cn("font-mono", typeBadgeClass(p.payload_type))}>
                  {payloadTypeName(p.payload_type)}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={routeBadgeClass(p.route)}>
                  {routeLabel(p.route)}
                </Badge>
                {scopeLabel(p.scope, p.route) && (
                  <span className="text-muted-foreground ml-1.5 font-mono text-xs">
                    {scopeLabel(p.scope, p.route)}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{p.len ?? "—"}</TableCell>
              <TableCell className="font-mono text-xs">{p.path.length ? p.path.join("→") : "—"}</TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
