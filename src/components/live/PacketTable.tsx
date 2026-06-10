import { useEffect, useMemo, useState } from "react";
import { decodeGroupText, loadAllChannels, type Channel } from "@/lib/channel";
import type { MeshNode, Packet } from "@/lib/meshcore";
import {
  formatTime,
  matchesSenderQuery,
  payloadTypeName,
  routeBadgeClass,
  routeLabel,
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

interface Props {
  packets: Packet[];
  selectedId: number | null;
  /** known nodes, for resolving the sending node from a packet's path */
  nodes?: MeshNode[];
  onSelect: (p: Packet) => void;
}

function packetNode(p: Packet, nodes: MeshNode[], channels: Channel[]): string | null {
  // Adverts carry their pubkey; REQ/RESPONSE/TXT/PATH carry a 1-byte src hash;
  // ANON_REQ a full pubkey — all resolved from the payload, never the path
  // (path hops are relays, not the originator).
  const name = senderName(p, nodes);
  if (name) return name;
  // GRP_TXT hides the sender inside the ciphertext — decryptable on known channels.
  if (p.payload_type === 5 && p.raw && channels.length) {
    return decodeGroupText(p.raw, channels)?.sender ?? null;
  }
  return null;
}

// Path hash width in bytes (a hop token is hex, so 2 chars = 1 byte). Identifies
// the network generation: 1-byte = old networks, 2/3-byte = newer. 0 = no path.
function pathBytes(p: Packet): number {
  return p.path.length ? p.path[0].length >> 1 : 0;
}

export default function PacketTable({ packets, selectedId, nodes, onSelect }: Props) {
  const [sender, setSender] = useState("");
  const [pathQ, setPathQ] = useState("");
  const [types, setTypes] = useState<Set<number>>(new Set());
  const [routes, setRoutes] = useState<Set<string>>(new Set());
  const [hashSizes, setHashSizes] = useState<Set<number>>(new Set());
  const [channels, setChannels] = useState<Channel[]>([]);

  // known channels (public + user-added), for decoding GRP_TXT senders
  useEffect(() => {
    loadAllChannels().then(setChannels).catch(() => {});
  }, []);

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

  const rows = useMemo(() => {
    const pq = pathQ.trim().toLowerCase();
    const sq = sender.trim().toLowerCase();
    const sqIsHex =
      sq.length > 0 &&
      sq.split(/\s+/).every((t) => t.length >= 2 && t.length <= 8 && t.length % 2 === 0 && /^[0-9a-f]+$/.test(t));
    return packets.filter((p) => {
      if (sq) {
        // hex → match on-wire sender hash / path hops; text → match resolved label
        if (sqIsHex) {
          if (!matchesSenderQuery(p, sender, nodes ?? [])) return false;
        } else if (!(senderLabels.get(p) ?? "").toLowerCase().includes(sq)) {
          return false;
        }
      }
      if (pq && !p.path.some((h) => h.toLowerCase().includes(pq))) return false;
      if (hashSizes.size && !hashSizes.has(pathBytes(p))) return false;
      if (types.size && (p.payload_type == null || !types.has(p.payload_type))) return false;
      if (routes.size && (!p.route || !routes.has(p.route))) return false;
      return true;
    });
  }, [packets, nodes, sender, senderLabels, pathQ, hashSizes, types, routes]);

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
          {rows.map((p) => (
            <TableRow
              key={p.hash ?? `${p.id}`}
              onClick={() => onSelect(p)}
              className={cn("cursor-pointer", selectedId === p.id && "bg-muted/60 hover:bg-muted")}
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
              </TableCell>
              <TableCell className="text-right tabular-nums">{p.len ?? "—"}</TableCell>
              <TableCell className="font-mono text-xs">{p.path.length ? p.path.join("→") : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
