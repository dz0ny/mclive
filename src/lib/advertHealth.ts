// Advert-cadence health, shared by the adverts table and the node sheet.
// A node is judged against its own advertising rhythm: how long since its
// last advert, relative to the typical interval between its adverts
// (median of gaps in the sheet, mean span/gaps in the table).

export const DAY_MS = 24 * 60 * 60 * 1000;

export const HEALTH_OK =
  "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300";
export const HEALTH_WARN =
  "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300";
export const HEALTH_BAD =
  "border-red-300 bg-red-100 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300";

export type HealthLabel = "on schedule" | "recent" | "late" | "quiet" | "overdue";

export interface AdvertHealth {
  label: HealthLabel;
  cls: string;
  /** severity for sorting: 0 healthiest … 4 worst */
  rank: number;
  detail: string;
}

/** All states in severity order (healthiest first), for filter menus. */
export const HEALTH_LABELS: HealthLabel[] = ["on schedule", "recent", "late", "quiet", "overdue"];

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Classify a node's advert health.
 * @param typicalMs estimated interval between adverts, or null if unknown
 * @param gapCount  how many gaps the estimate is based on (need ≥2 to trust it)
 * @param ageMs     time since the last advert was heard
 */
export function classifyAdvertHealth(
  typicalMs: number | null,
  gapCount: number,
  ageMs: number
): AdvertHealth {
  if (typicalMs != null && typicalMs > 0 && gapCount >= 2) {
    // judge recency against the node's own cadence
    if (ageMs <= typicalMs * 1.5) {
      return {
        label: "on schedule",
        cls: HEALTH_OK,
        rank: 0,
        detail: `last advert within its usual ~${fmtDur(typicalMs)} cadence`,
      };
    }
    if (ageMs <= typicalMs * 3) {
      return {
        label: "late",
        cls: HEALTH_WARN,
        rank: 2,
        detail: `expected every ~${fmtDur(typicalMs)}, last heard ${fmtDur(ageMs)} ago`,
      };
    }
    return {
      label: "overdue",
      cls: HEALTH_BAD,
      rank: 4,
      detail: `expected every ~${fmtDur(typicalMs)}, silent for ${fmtDur(ageMs)}`,
    };
  }
  return ageMs < DAY_MS
    ? { label: "recent", cls: HEALTH_OK, rank: 1, detail: "too few adverts to estimate a cadence yet" }
    : { label: "quiet", cls: HEALTH_WARN, rank: 3, detail: "too few adverts to estimate a cadence" };
}
