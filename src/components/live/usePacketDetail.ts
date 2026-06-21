import { useCallback, useEffect, useState } from "react";
import type { PacketDetail as Detail } from "@/lib/meshcore";

/**
 * Shared packet/advert detail state with deep linking (?p=<id>). Fetches the
 * enriched /~/api/packets/:id payload and keeps the URL in sync.
 */
export function usePacketDetail() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const open = useCallback((id: number, pushUrl = true) => {
    setSelectedId(id);
    setDetail(null);
    setLoading(true);
    if (pushUrl) {
      // keep filter/sort params intact — only the p param changes
      const url = new URL(location.href);
      url.searchParams.set("p", String(id));
      history.pushState({ p: id }, "", url);
    }
    fetch(`/~/api/packets/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const close = useCallback((pushUrl = true) => {
    setSelectedId(null);
    setDetail(null);
    if (pushUrl) {
      const url = new URL(location.href);
      url.searchParams.delete("p");
      history.pushState({}, "", url);
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const id = parseInt(new URLSearchParams(location.search).get("p") || "", 10);
      if (!Number.isNaN(id)) open(id, false);
      else close(false);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [open, close]);

  return { selectedId, detail, loading, open, close };
}
