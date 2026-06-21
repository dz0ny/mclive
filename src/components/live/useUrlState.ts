import { useCallback, useEffect, useRef, useState } from "react";
import type { SortDir } from "./table-filters";

/**
 * Table filter/sort state mirrored into the URL query string so views are
 * shareable. Uses replaceState (typing in a filter shouldn't grow history) and
 * re-reads on popstate so back/forward across ?p= pushes stays consistent.
 * Values equal to the default are removed from the URL to keep links clean.
 *
 * Each value is also persisted to localStorage, namespaced by pathname, so
 * returning to a view with no query params restores the last filters/sort.
 * The URL always wins when a param is present; localStorage is the fallback.
 * Keys reused across views (e.g. ?type=) don't collide because the namespace
 * includes the path.
 */

const LS_NS = "mclive:filter";

function storageKey(key: string): string {
  return `${LS_NS}:${window.location.pathname}:${key}`;
}

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value == null) window.localStorage.removeItem(storageKey(key));
    else window.localStorage.setItem(storageKey(key), value);
  } catch {
    // private mode / quota — persistence is best-effort
  }
}

function readParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

/** URL param if present, else the last persisted value. */
function readInitial(key: string): string | null {
  return readParam(key) ?? readStored(key);
}

function writeParam(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value == null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  history.replaceState(history.state, "", url);
  writeStored(key, value);
}

function useUrlState<T>(
  key: string,
  parse: (raw: string | null) => T,
  format: (v: T) => string | null
): [T, (v: T) => void] {
  // codec in a ref so inline parse/format don't re-subscribe the listener
  const codec = useRef({ parse, format });
  codec.current = { parse, format };

  const [val, setVal] = useState<T>(() => codec.current.parse(readInitial(key)));

  // On mount, if the value was restored from storage (no URL param), reflect
  // it back into the URL so the view stays shareable and consistent.
  useEffect(() => {
    if (readParam(key) == null) {
      const restored = codec.current.format(codec.current.parse(readStored(key)));
      if (restored != null) writeParam(key, restored);
    }
  }, [key]);

  useEffect(() => {
    const sync = () => setVal(codec.current.parse(readParam(key)));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [key]);

  const set = useCallback((v: T) => {
    setVal(v);
    writeParam(key, codec.current.format(v));
  }, [key]);

  return [val, set];
}

/** Text filter ↔ ?key=value (omitted when equal to the default). */
export function useUrlString(key: string, def = ""): [string, (v: string) => void] {
  return useUrlState(
    key,
    (raw) => raw ?? def,
    (v) => (v === def ? null : v)
  );
}

/** Multi-select of numbers ↔ ?key=1,2 (omitted when empty). */
export function useUrlNumSet(key: string): [Set<number>, (v: Set<number>) => void] {
  return useUrlState(
    key,
    (raw) =>
      new Set(
        (raw ?? "")
          .split(",")
          .map((s) => parseInt(s, 10))
          .filter((n) => !Number.isNaN(n))
      ),
    (v) => (v.size ? [...v].sort((a, b) => a - b).join(",") : null)
  );
}

/** Multi-select of strings ↔ ?key=a,b (omitted when empty). */
export function useUrlStrSet<T extends string>(key: string): [Set<T>, (v: Set<T>) => void] {
  return useUrlState(
    key,
    (raw) => new Set((raw ?? "").split(",").filter(Boolean) as T[]),
    (v) => (v.size ? [...v].sort().join(",") : null)
  );
}

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/** Column sort ↔ ?sort=col (asc) / ?sort=-col (desc); omitted when unsorted. */
export function useUrlSort<K extends string>(
  key = "sort"
): [SortState<K> | null, (v: SortState<K> | null) => void] {
  return useUrlState<SortState<K> | null>(
    key,
    (raw) =>
      raw
        ? raw.startsWith("-")
          ? { key: raw.slice(1) as K, dir: -1 }
          : { key: raw as K, dir: 1 }
        : null,
    (v) => (v ? (v.dir === -1 ? `-${v.key}` : v.key) : null)
  );
}
