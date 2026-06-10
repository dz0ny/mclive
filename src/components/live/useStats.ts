import { useEffect, useState } from "react";

export interface Stats {
  packets: number;
  nodes: number;
  devices: number;
  receptions: number;
  receptions_per_min: number;
}

/** Poll the authoritative DB-wide counts (the live feed only holds a window). */
export function useStats(intervalMs = 5000): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/~/api/stats")
        .then((r) => r.json())
        .then((s) => alive && setStats(s))
        .catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return stats;
}
