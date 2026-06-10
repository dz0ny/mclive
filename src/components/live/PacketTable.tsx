import { useMemo, useState } from "react";
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

function packetNode(p: Packet, nodes?: MeshNode[]): string | null {
  // Adverts carry their own sender identity; other types resolve via the path.
  return senderName(p, nodes ?? []);
}

export default function PacketTable({ packets, selectedId, nodes, onSelect }: Props) {
  const [sender, setSender] = useState("");
  const [pathQ, setPathQ] = useState("");
  const [types, setTypes] = useState<Set<number>>(new Set());
  const [routes, setRoutes] = useState<Set<string>>(new Set());

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

  const rows = useMemo(() => {
    const pq = pathQ.trim().toLowerCase();
    return packets.filter((p) => {
      if (sender.trim() && !matchesSenderQuery(p, sender, nodes ?? [])) return false;
      if (pq && !p.path.some((h) => h.toLowerCase().includes(pq))) return false;
      if (types.size && (p.payload_type == null || !types.has(p.payload_type))) return false;
      if (routes.size && (!p.route || !routes.has(p.route))) return false;
      return true;
    });
  }, [packets, nodes, sender, pathQ, types, routes]);

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
              <TextFilterHead label="Path" value={pathQ} onChange={setPathQ} placeholder="Filter by hop hash…" />
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
                {packetNode(p, nodes) ?? <span className="text-muted-foreground">—</span>}
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
