import { useEffect, useRef, useState } from "react";
import type { Device, MeshNode, Packet } from "@/lib/meshcore";

export type FeedStatus = "connecting" | "live" | "offline";

const MAX_ROWS = 200;

/**
 * Shared live feed: loads the initial snapshot and subscribes to the SSE stream.
 * Packets are deduped by hash and kept newest-first.
 */
export function useLiveFeed() {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [nodes, setNodes] = useState<MeshNode[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [latest, setLatest] = useState<Packet | null>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const receptions = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, nRes] = await Promise.all([
          fetch("/~/api/packets?limit=150").then((r) => r.json()),
          fetch("/~/api/nodes").then((r) => r.json()),
        ]);
        if (cancelled) return;
        setPackets(pRes.packets ?? []);
        setNodes(nRes.nodes ?? []);
        setDevices(nRes.devices ?? []);
      } catch {
        /* worker may not be up yet; SSE will retry */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
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
      if (evt.type === "packet") {
        receptions.current += 1;
        if (evt.packet.self_advert) return; // observer self-advert: feeds map, not the packet list
        setPackets((prev) => upsertByHash(prev, evt.packet));
        setLatest(evt.packet);
      } else if (evt.type === "node") {
        setNodes((prev) => [evt.node, ...prev.filter((n) => n.pubkey !== evt.node.pubkey)]);
      }
    };
    return () => es.close();
  }, []);

  return { packets, nodes, devices, latest, status, receptions };
}

/** Upsert a logical packet by hash, keeping the list sorted newest-first. */
export function upsertByHash(prev: Packet[], pkt: Packet): Packet[] {
  const map = new Map(prev.map((p) => [p.hash ?? String(p.id), p]));
  map.set(pkt.hash ?? String(pkt.id), pkt);
  return [...map.values()].sort((a, b) => b.last_seen - a.last_seen).slice(0, MAX_ROWS);
}
