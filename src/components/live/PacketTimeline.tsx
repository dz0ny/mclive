import { useMemo, useRef, useState } from "react";
import type { Packet } from "@/lib/meshcore";
import { formatTime, payloadTypeColor, payloadTypeName } from "@/lib/meshcore";

interface Props {
  packets: Packet[];
  /** currently scrubbed-to epoch ms, or null when nothing is selected */
  scrubTs: number | null;
  /** fired as the playhead moves; null when the selection is cleared */
  onScrub: (ts: number | null) => void;
}

const BUCKETS = 64;

interface Bucket {
  start: number;
  /** packet count per payload type in this slice of time */
  counts: Map<number, number>;
  total: number;
}

/**
 * A stacked histogram of packet activity over the visible window, colored by
 * payload type, with a draggable playhead. Scrubbing emits the time under the
 * cursor so the table can follow along.
 */
export default function PacketTimeline({ packets, scrubTs, onScrub }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  // bucket index under the cursor, for the hover tooltip (independent of scrub)
  const [hover, setHover] = useState<number | null>(null);

  const { buckets, t0, t1, maxTotal, types, span } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of packets) {
      if (p.last_seen < lo) lo = p.last_seen;
      if (p.last_seen > hi) hi = p.last_seen;
    }
    if (!Number.isFinite(lo) || hi <= lo) {
      return { buckets: [] as Bucket[], t0: lo, t1: hi, maxTotal: 0, types: [] as number[], span: 0 };
    }
    const range = hi - lo;
    const bs: Bucket[] = Array.from({ length: BUCKETS }, (_, i) => ({
      start: lo + (range * i) / BUCKETS,
      counts: new Map<number, number>(),
      total: 0,
    }));
    const present = new Set<number>();
    for (const p of packets) {
      const i = Math.min(BUCKETS - 1, Math.floor(((p.last_seen - lo) / range) * BUCKETS));
      const t = p.payload_type ?? -1;
      const b = bs[i];
      b.counts.set(t, (b.counts.get(t) ?? 0) + 1);
      b.total++;
      present.add(t);
    }
    const max = bs.reduce((m, b) => Math.max(m, b.total), 0);
    // legend order: most frequent types first
    const totals = new Map<number, number>();
    for (const b of bs) for (const [t, c] of b.counts) totals.set(t, (totals.get(t) ?? 0) + c);
    const sortedTypes = [...present].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
    return { buckets: bs, t0: lo, t1: hi, maxTotal: max, types: sortedTypes, span: range };
  }, [packets]);

  if (buckets.length === 0 || maxTotal === 0) return null;

  // clientX → epoch ms within [t0, t1]
  function tsFromEvent(clientX: number): number {
    const el = stripRef.current;
    if (!el) return t0;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return t0 + frac * span;
  }

  function bucketAt(ts: number): number {
    return Math.min(BUCKETS - 1, Math.max(0, Math.floor(((ts - t0) / span) * BUCKETS)));
  }

  const scrubFrac = scrubTs != null ? Math.min(1, Math.max(0, (scrubTs - t0) / span)) : null;
  const tipBucket = hover != null ? buckets[hover] : scrubTs != null ? buckets[bucketAt(scrubTs)] : null;
  const tipTs = hover != null ? buckets[hover].start : scrubTs;
  // anchor the tooltip over the active bucket (hover wins, else scrub)
  const tipIdx = hover != null ? hover : scrubTs != null ? bucketAt(scrubTs) : null;

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Activity over time · {packets.length} packet{packets.length === 1 ? "" : "s"}
        </span>
        {scrubTs != null && (
          <button
            type="button"
            onClick={() => onScrub(null)}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <span className="tabular-nums">{formatTime(scrubTs)}</span>
            <span aria-hidden>✕</span>
          </button>
        )}
      </div>

      <div className="relative">
        {/* tooltip */}
        {tipIdx != null && tipBucket && (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 rounded-md border px-2 py-1.5 text-xs shadow-md"
            style={{ left: `${((tipIdx + 0.5) / BUCKETS) * 100}%` }}
          >
            <div className="text-muted-foreground mb-1 tabular-nums">{tipTs != null ? formatTime(tipTs) : ""}</div>
            {tipBucket.total === 0 ? (
              <div className="text-muted-foreground">no packets</div>
            ) : (
              <div className="space-y-0.5">
                {[...tipBucket.counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([t, c]) => (
                    <div key={t} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: payloadTypeColor(t) }} />
                      <span className="font-mono">{payloadTypeName(t)}</span>
                      <span className="text-muted-foreground tabular-nums">{c}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* bars + scrub surface */}
        <div
          ref={stripRef}
          className="relative flex h-20 cursor-crosshair touch-none items-end gap-px"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            onScrub(tsFromEvent(e.clientX));
          }}
          onPointerMove={(e) => {
            setHover(bucketAt(tsFromEvent(e.clientX)));
            if (e.buttons === 1) onScrub(tsFromEvent(e.clientX));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {buckets.map((b, i) => (
            <div key={i} className="flex h-full flex-1 flex-col justify-end">
              {types
                .filter((t) => b.counts.has(t))
                .map((t) => (
                  <div
                    key={t}
                    style={{
                      height: `${((b.counts.get(t) ?? 0) / maxTotal) * 100}%`,
                      background: payloadTypeColor(t),
                    }}
                    className="w-full first:rounded-t-sm"
                  />
                ))}
            </div>
          ))}

          {/* playhead */}
          {scrubFrac != null && (
            <div
              className="bg-foreground pointer-events-none absolute top-0 bottom-0 w-px"
              style={{ left: `${scrubFrac * 100}%` }}
            >
              <div className="bg-foreground absolute -top-1 -left-[3px] h-1.5 w-1.5 rotate-45" />
            </div>
          )}
        </div>

        {/* time axis */}
        <div className="text-muted-foreground mt-1 flex justify-between text-[10px] tabular-nums">
          <span>{formatTime(t0)}</span>
          <span>{formatTime(t0 + span / 2)}</span>
          <span>{formatTime(t1)}</span>
        </div>
      </div>

      {/* legend */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {types.map((t) => (
          <span key={t} className="text-muted-foreground inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: payloadTypeColor(t) }} />
            <span className="font-mono">{payloadTypeName(t)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
