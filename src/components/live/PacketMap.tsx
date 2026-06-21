import { useEffect, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import type { FeatureLike } from "ol/Feature";
import Overlay from "ol/Overlay";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import Polygon from "ol/geom/Polygon";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import { boundingExtent } from "ol/extent";
import Style from "ol/style/Style";
import Icon from "ol/style/Icon";
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import CircleStyle from "ol/style/Circle";
import Control from "ol/control/Control";
import "ol/ol.css";
import type { MeshNode, Packet } from "@/lib/meshcore";
import { hashColor, nodeForHash } from "@/lib/meshcore";

// Per-type node markers (lucide-style inline SVG): 1=chat(person), 2=repeater
// (radio tower), 3=room server (home), 4=sensor (activity).
const TYPE_STYLE: Record<number, { color: string; svg: string }> = {
  1: {
    color: "#0ea5e9",
    svg: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  },
  2: {
    color: "#16a34a",
    svg: '<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.1.8 7.47"/><path d="M19.1 1.9a9.9 9.9 0 0 1 0 14.1"/><path d="M9.5 18h5"/><path d="m8 22 4-11 4 11"/>',
  },
  3: {
    color: "#9333ea",
    svg: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
  },
  4: {
    color: "#ea580c",
    svg: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  },
};

// A 26px white disc with a coloured border and the type glyph, encoded as an SVG
// data-URI so OpenLayers can draw it as an Icon (no per-node DOM overlay).
function nodeIconSrc(n: MeshNode): string {
  const style =
    TYPE_STYLE[n.adv_type ?? 0] ?? { color: hashColor(n.hash_prefix), svg: '<circle cx="12" cy="12" r="6"/>' };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">` +
    `<circle cx="13" cy="13" r="11" fill="#fff" stroke="${style.color}" stroke-width="2"/>` +
    `<svg x="6" y="6" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${style.color}" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${style.svg}</svg>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Coverage transmitter origin: a rose teardrop pin with a radio-tower glyph,
// distinct from the round node markers. Anchored at the tip (bottom-centre).
function coverageIconSrc(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">` +
    `<path d="M16 39C16 39 29 24 29 14A13 13 0 0 0 3 14C3 24 16 39 16 39Z" fill="#f43f5e" stroke="#fff" stroke-width="2"/>` +
    `<svg x="8" y="5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.1.8 7.47"/><path d="M19.1 1.9a9.9 9.9 0 0 1 0 14.1"/><path d="M9.5 18h5"/><path d="m8 22 4-11 4 11"/>` +
    `</svg></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Live position beacon (GRP_DATA fast-GPS): an amber disc with a navigation
// glyph, distinct from the node discs and the rose coverage pins. The fix is a
// node's *current* GPS, separate from its static advert location.
function positionIconSrc(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
    `<circle cx="14" cy="14" r="12" fill="#f59e0b" stroke="#fff" stroke-width="2"/>` +
    `<svg x="6" y="6" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<polygon points="3 11 22 2 13 21 11 13 3 11"/>` +
    `</svg></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const BASEMAPS: { name: string; make: () => TileLayer }[] = [
  { name: "Light", make: () => new TileLayer({ source: new OSM() }) },
  {
    // mapy.cz tourist style, relayed through the worker (referer-gated upstream).
    // Retina tiles are 512px, so the source must declare tileSize 512.
    name: "Tourist",
    make: () =>
      new TileLayer({
        source: new XYZ({
          url: "/~/api/tiles/turist-en/{z}/{x}/{y}",
          attributions: "© Seznam.cz a.s. · mapy.cz",
          tileSize: 512,
          maxZoom: 19,
        }),
      }),
  },
  {
    name: "Dark",
    make: () =>
      new TileLayer({
        source: new XYZ({
          url: "https://{a-c}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          attributions: "© OpenStreetMap © CARTO",
          maxZoom: 19,
        }),
      }),
  },
  {
    name: "Topo",
    make: () =>
      new TileLayer({
        source: new XYZ({
          url: "https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png",
          attributions: "© OpenStreetMap © OpenTopoMap (CC-BY-SA)",
          maxZoom: 17,
        }),
      }),
  },
  {
    name: "Satellite",
    make: () =>
      new TileLayer({
        source: new XYZ({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          attributions: "Tiles © Esri",
          maxZoom: 19,
        }),
      }),
  },
];

export interface MapViewState {
  lat: number;
  lon: number;
  zoom: number;
}

/** A node's live GPS fix shared in a GRP_DATA fast-GPS beacon. */
export interface LivePosition {
  /** sender pubkey prefix (hex) — stable key per node */
  key: string;
  lat: number;
  lon: number;
  /** resolved node name, or null when the sender isn't in the directory */
  name: string | null;
  /** when we last heard a fix (reception time, ms) — for the "ago" label */
  at: number;
  /** the resolved node, when known — lets a click open its page */
  node: MeshNode | null;
}

/** One grid cell of the GRP_DATA coverage aggregate (/~/api/coverage-cells). */
export interface CoverageCell {
  /** cell-centre latitude */
  lat: number;
  /** cell-centre longitude */
  lon: number;
  /** GRP_DATA fixes that fell in this cell */
  fixes: number;
  /** distinct nodes that reported from this cell */
  nodes: number;
}

// Heat ramp shared by the coverage grid fill and the legend gradient: blue
// (sparse) → cyan → green → yellow → red (dense). `t` in [0,1].
const HEAT_STOPS: [number, [number, number, number]][] = [
  [0, [37, 99, 235]],
  [0.25, [6, 182, 212]],
  [0.5, [34, 197, 94]],
  [0.75, [234, 179, 8]],
  [1, [239, 68, 68]],
];

export function heatColor(t: number, alpha = 0.55): string {
  const x = Math.min(Math.max(t, 0), 1);
  let lo = HEAT_STOPS[0];
  let hi = HEAT_STOPS[HEAT_STOPS.length - 1];
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    if (x <= HEAT_STOPS[i][0]) {
      lo = HEAT_STOPS[i - 1];
      hi = HEAT_STOPS[i];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (x - lo[0]) / span;
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** An RF coverage overlay minted by the worker (/~/api/coverage). */
export interface CoverageLayer {
  /** tile URL template, already pointing at our cached proxy */
  url: string;
  /** layer bounds as a lon/lat extent [minLon, minLat, maxLon, maxLat] */
  extent: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
}

interface Props {
  nodes: MeshNode[];
  /** newest packet — identity change triggers a trace animation */
  latest: Packet | null;
  /** selected packet's path (hex hashes) — drawn as a persistent highlight */
  pinnedPath?: string[] | null;
  /** container classes (height etc.) */
  className?: string;
  /** start at this center/zoom (e.g. from a shared URL) instead of auto-fitting the nodes */
  initialView?: MapViewState | null;
  /** clicking a node marker */
  onNodeClick?: (node: MeshNode) => void;
  /** visible extent in lon/lat [minLon, minLat, maxLon, maxLat], after every pan/zoom/resize */
  onViewChange?: (extent: [number, number, number, number], view: MapViewState) => void;
  /** skip live traces whose path uses ambiguous 1-byte hop hashes */
  skipSingleByte?: boolean;
  /** RF coverage overlays to render (already filtered to the visible ones) */
  coverages?: CoverageLayer[];
  /** coverage transmitter origins to mark on the map (visible ones) */
  coveragePoints?: { lat: number; lon: number }[];
  /** when true, a map click picks a coverage transmitter point instead of filtering */
  coverageMode?: boolean;
  /** click handler while coverageMode is on — a node's location, or the clicked point */
  onPickPoint?: (lat: number, lon: number) => void;
  /** live GPS positions (GRP_DATA beacons) to mark on the map */
  positions?: LivePosition[];
  /** "ago" formatter for the position tooltip (injected to avoid a now-tick here) */
  formatAgo?: (ms: number) => string;
  /** GRP_DATA coverage grid cells to shade (empty = layer off) */
  coverageCells?: CoverageCell[];
  /** grid resolution in degrees, from the API (cell rectangle size) */
  coverageCellDeg?: number;
  /** highest fix count across the cells, for the heat scale */
  coverageMaxFixes?: number;
}

export default function PacketMap({
  nodes,
  latest,
  pinnedPath = null,
  className,
  initialView = null,
  onNodeClick,
  onViewChange,
  skipSingleByte = false,
  coverages = [],
  coveragePoints = [],
  coverageMode = false,
  onPickPoint,
  positions = [],
  formatAgo,
  coverageCells = [],
  coverageCellDeg = 0.005,
  coverageMaxFixes = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const nodeSource = useRef<VectorSource | null>(null);
  const pinnedSource = useRef<VectorSource | null>(null);
  // current node directory, for resolving variable-length path hashes
  const nodesRef = useRef<MeshNode[]>([]);
  nodesRef.current = nodes;
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const coverageModeRef = useRef(coverageMode);
  coverageModeRef.current = coverageMode;
  const onPickPointRef = useRef(onPickPoint);
  onPickPointRef.current = onPickPoint;
  const coverageLayersRef = useRef<TileLayer[]>([]);
  const coverageGridRef = useRef<VectorLayer | null>(null);
  const coverageMarkerRef = useRef<VectorLayer | null>(null);
  const positionMarkerRef = useRef<VectorLayer | null>(null);
  const formatAgoRef = useRef(formatAgo);
  formatAgoRef.current = formatAgo;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const skipRef = useRef(skipSingleByte);
  skipRef.current = skipSingleByte;
  // a shared-URL view is applied once at init; the map effect runs with [] deps
  const initialViewRef = useRef(initialView);
  // fit bounds only once — live packet/advert updates must not reset the
  // user's pan/zoom. A view restored from a URL counts as already fitted.
  const didFit = useRef(initialView != null);

  // init map once
  useEffect(() => {
    if (!containerRef.current) return;

    // basemaps: all created, only the active one visible; choice persists.
    const baseLayers = BASEMAPS.map(({ make }) => make());
    const stored = localStorage.getItem("mclive.basemap");
    // default to the Tourist (mapy.cz) basemap; a saved choice still wins
    const initialName =
      (stored && BASEMAPS.some((b) => b.name === stored) && stored) || "Tourist";
    const applyBasemap = (name: string) => {
      BASEMAPS.forEach((b, i) => baseLayers[i].setVisible(b.name === name));
    };
    applyBasemap(initialName);

    const nodeSrc = new VectorSource();
    const pinnedSrc = new VectorSource();
    nodeSource.current = nodeSrc;
    pinnedSource.current = pinnedSrc;

    const map = new Map({
      target: containerRef.current,
      layers: [
        ...baseLayers,
        new VectorLayer({ source: nodeSrc, zIndex: 20 }),
        new VectorLayer({
          source: pinnedSrc,
          zIndex: 40,
          style: pinnedStyle,
        }),
      ],
      view: new View(
        initialViewRef.current
          ? {
              center: fromLonLat([initialViewRef.current.lon, initialViewRef.current.lat]),
              zoom: initialViewRef.current.zoom,
            }
          : { center: fromLonLat([-122.33, 47.6]), zoom: 9 }
      ),
    });

    // basemap switcher (bottom-right, above the zoom buttons)
    const switcher = document.createElement("div");
    switcher.className = "ol-control mclive-basemap";
    const select = document.createElement("select");
    for (const b of BASEMAPS) {
      const opt = document.createElement("option");
      opt.value = b.name;
      opt.textContent = b.name;
      select.appendChild(opt);
    }
    select.value = initialName;
    select.addEventListener("change", () => {
      applyBasemap(select.value);
      try {
        localStorage.setItem("mclive.basemap", select.value);
      } catch {}
    });
    switcher.appendChild(select);
    map.addControl(new Control({ element: switcher }));

    // hover tooltip
    const tip = document.createElement("div");
    tip.className = "mclive-tooltip";
    const tooltip = new Overlay({ element: tip, offset: [0, -16], positioning: "bottom-center" });
    map.addOverlay(tooltip);

    const nodeAt = (pixel: number[]) =>
      map.forEachFeatureAtPixel(pixel, (f) => (f.get("node") ? (f as Feature) : undefined), {
        hitTolerance: 4,
      });
    const positionAt = (pixel: number[]) =>
      map.forEachFeatureAtPixel(pixel, (f) => (f.get("position") ? (f as Feature) : undefined), {
        hitTolerance: 4,
      });
    const cellAt = (pixel: number[]) =>
      map.forEachFeatureAtPixel(pixel, (f) => (f.get("cell") ? (f as Feature) : undefined));

    map.on("pointermove", (e) => {
      if (e.dragging) return;
      const f = nodeAt(e.pixel);
      const node = f?.get("node") as MeshNode | undefined;
      const pos = positionAt(e.pixel)?.get("position") as LivePosition | undefined;
      const el = map.getTargetElement();
      const cov = coverageModeRef.current;
      if (cov) {
        // in coverage mode every point is clickable; a node just gives a precise origin
        tip.textContent = node
          ? `${node.name || "node"} — map coverage from here`
          : "map coverage from this point";
        tooltip.setPosition(e.coordinate);
        tip.style.display = "block";
        el.style.cursor = "crosshair";
      } else if (pos) {
        const ago = formatAgoRef.current?.(pos.at);
        tip.textContent = `${pos.name || pos.key.slice(0, 12)} — live position${ago ? ` · ${ago}` : ""}`;
        tooltip.setPosition(e.coordinate);
        tip.style.display = "block";
        el.style.cursor = pos.node ? "pointer" : "";
      } else if (node) {
        tip.textContent = `${node.name || "node"} · ${node.hash_prefix} — click to filter packets`;
        tooltip.setPosition(e.coordinate);
        tip.style.display = "block";
        el.style.cursor = "pointer";
      } else {
        const cell = cellAt(e.pixel)?.get("cell") as CoverageCell | undefined;
        if (cell) {
          tip.textContent = `coverage · ${cell.fixes} fix${cell.fixes === 1 ? "" : "es"} · ${cell.nodes} node${cell.nodes === 1 ? "" : "s"}`;
          tooltip.setPosition(e.coordinate);
          tip.style.display = "block";
          el.style.cursor = "";
        } else {
          tip.style.display = "none";
          el.style.cursor = "";
        }
      }
    });

    map.on("click", (e) => {
      const f = nodeAt(e.pixel);
      const node = f?.get("node") as MeshNode | undefined;
      const pos = positionAt(e.pixel)?.get("position") as LivePosition | undefined;
      if (coverageModeRef.current) {
        const [lon, lat] = node ? [node.lon, node.lat] : toLonLat(e.coordinate);
        onPickPointRef.current?.(lat, lon);
        return;
      }
      if (pos?.node) {
        onNodeClickRef.current?.(pos.node);
        return;
      }
      if (node) onNodeClickRef.current?.(node);
    });

    // report the visible extent (lon/lat) + center/zoom after every view change
    const emitView = () => {
      const size = map.getSize();
      if (!size || !size[0] || !size[1]) return;
      const view = map.getView();
      const ext = transformExtent(view.calculateExtent(size), "EPSG:3857", "EPSG:4326");
      const [lon, lat] = toLonLat(view.getCenter() ?? [0, 0]);
      onViewChangeRef.current?.(ext as [number, number, number, number], {
        lat,
        lon,
        zoom: view.getZoom() ?? 0,
      });
    };
    map.on("moveend", emitView);
    map.once("postrender", emitView);

    // the container resizes when the sidebar toggles — OL only watches window resize
    const ro = new ResizeObserver(() => {
      map.updateSize();
      emitView();
    });
    ro.observe(containerRef.current);

    mapRef.current = map;
    return () => {
      ro.disconnect();
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

  // (re)build the RF coverage tile overlays — one per visible point
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const l of coverageLayersRef.current) map.removeLayer(l);
    coverageLayersRef.current = coverages.map((cov) => {
      const layer = new TileLayer({
        source: new XYZ({
          url: cov.url,
          minZoom: cov.minZoom ?? 1,
          maxZoom: cov.maxZoom ?? 12,
          attributions: "Coverage © meshcore.nz",
        }),
        extent: transformExtent(cov.extent, "EPSG:4326", "EPSG:3857"),
        opacity: 0.6,
        zIndex: 10, // above basemap, below node markers (20)
      });
      map.addLayer(layer);
      return layer;
    });
    return () => {
      for (const l of coverageLayersRef.current) map.removeLayer(l);
      coverageLayersRef.current = [];
    };
  }, [coverages]);

  // shade the GRP_DATA coverage grid — one heat-coloured rectangle per cell,
  // intensity log-scaled against the busiest cell so a few hot spots don't flatten
  // the rest. Sits above the basemap, below the RF coverage tiles and markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (coverageGridRef.current) {
      map.removeLayer(coverageGridRef.current);
      coverageGridRef.current = null;
    }
    if (coverageCells.length === 0) return;
    const half = coverageCellDeg / 2;
    const denom = Math.log1p(coverageMaxFixes);
    const src = new VectorSource();
    for (const cell of coverageCells) {
      const t = denom > 0 ? Math.log1p(cell.fixes) / denom : 1;
      const minLon = cell.lon - half;
      const maxLon = cell.lon + half;
      const minLat = cell.lat - half;
      const maxLat = cell.lat + half;
      const ring = [
        fromLonLat([minLon, minLat]),
        fromLonLat([maxLon, minLat]),
        fromLonLat([maxLon, maxLat]),
        fromLonLat([minLon, maxLat]),
        fromLonLat([minLon, minLat]),
      ];
      const f = new Feature({ geometry: new Polygon([ring]), cell });
      f.setStyle(new Style({ fill: new Fill({ color: heatColor(t) }) }));
      src.addFeature(f);
    }
    const layer = new VectorLayer({ source: src, zIndex: 8 });
    map.addLayer(layer);
    coverageGridRef.current = layer;
    return () => {
      map.removeLayer(layer);
      if (coverageGridRef.current === layer) coverageGridRef.current = null;
    };
  }, [coverageCells, coverageCellDeg, coverageMaxFixes]);

  // draw the coverage origin pins (a single layer holding one marker per point)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (coverageMarkerRef.current) {
      map.removeLayer(coverageMarkerRef.current);
      coverageMarkerRef.current = null;
    }
    if (coveragePoints.length === 0) return;
    const src = new VectorSource();
    const style = new Style({ image: new Icon({ src: coverageIconSrc(), anchor: [0.5, 1], scale: 1 }) });
    for (const p of coveragePoints) {
      const f = new Feature(new Point(fromLonLat([p.lon, p.lat])));
      f.setStyle(style);
      src.addFeature(f);
    }
    const layer = new VectorLayer({ source: src, zIndex: 26 }); // above node markers
    map.addLayer(layer);
    coverageMarkerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      if (coverageMarkerRef.current === layer) coverageMarkerRef.current = null;
    };
  }, [coveragePoints]);

  // draw the live GPS position beacons (one amber marker per node's latest fix)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (positionMarkerRef.current) {
      map.removeLayer(positionMarkerRef.current);
      positionMarkerRef.current = null;
    }
    if (positions.length === 0) return;
    const src = new VectorSource();
    const style = new Style({ image: new Icon({ src: positionIconSrc(), anchor: [0.5, 0.5], scale: 1 }) });
    for (const p of positions) {
      const f = new Feature({ geometry: new Point(fromLonLat([p.lon, p.lat])), position: p });
      f.setStyle(style);
      src.addFeature(f);
    }
    const layer = new VectorLayer({ source: src, zIndex: 28 }); // above node + coverage markers
    map.addLayer(layer);
    positionMarkerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      if (positionMarkerRef.current === layer) positionMarkerRef.current = null;
    };
  }, [positions]);

  // (re)draw node markers whenever the directory changes
  useEffect(() => {
    const src = nodeSource.current;
    if (!src) return;
    src.clear();

    const coords: number[][] = [];
    for (const n of nodes) {
      const c = fromLonLat([n.lon, n.lat]);
      const f = new Feature({ geometry: new Point(c), node: n });
      f.setStyle(new Style({ image: new Icon({ src: nodeIconSrc(n), anchor: [0.5, 0.5], scale: 1 }) }));
      src.addFeature(f);
      coords.push(c);
    }

    // Observers (the local receivers) are intentionally not drawn — they aren't
    // part of the mesh; an observer that self-adverts appears as a node above.

    if (coords.length && mapRef.current && !didFit.current) {
      didFit.current = true;
      mapRef.current.getView().fit(boundingExtent(coords), { padding: [40, 40, 40, 40], maxZoom: 11 });
    }
  }, [nodes]);

  // animate a hop trace for each new packet (ephemeral layer, faded out)
  useEffect(() => {
    if (!latest || !mapRef.current) return;
    const map = mapRef.current;

    const coords: number[][] = [];
    for (const h of latest.path) {
      const node = nodeForHash(h, nodesRef.current);
      if (node) coords.push(fromLonLat([node.lon, node.lat]));
    }
    if (coords.length < 1) return;

    const color = latest.path.length ? hashColor(latest.path[0]) : "#eab308";
    const src = new VectorSource();
    if (coords.length >= 2) src.addFeature(new Feature(new LineString(coords)));
    for (const c of coords) src.addFeature(new Feature(new Point(c)));

    const layer = new VectorLayer({
      source: src,
      zIndex: 30,
      style: (f) =>
        f.getGeometry()?.getType() === "LineString"
          ? new Style({ stroke: new Stroke({ color, width: 3 }) })
          : new Style({
              image: new CircleStyle({ radius: 5, fill: new Fill({ color }), stroke: new Stroke({ color, width: 1 }) }),
            }),
    });
    map.addLayer(layer);

    // fade out, then remove
    let opacity = 0.9;
    layer.setOpacity(opacity);
    const fade = setInterval(() => {
      opacity -= 0.09;
      if (opacity <= 0) {
        clearInterval(fade);
        map.removeLayer(layer);
        return;
      }
      layer.setOpacity(opacity);
    }, 250);

    return () => {
      clearInterval(fade);
      map.removeLayer(layer);
    };
  }, [latest]);

  // draw the selected packet's path as a persistent highlight
  useEffect(() => {
    const src = pinnedSource.current;
    if (!src) return;
    src.clear();
    if (!pinnedPath || pinnedPath.length === 0) return;

    const coords: number[][] = [];
    for (const h of pinnedPath) {
      const node = nodeForHash(h, nodesRef.current);
      if (node) coords.push(fromLonLat([node.lon, node.lat]));
    }
    if (coords.length === 0) return;

    if (coords.length >= 2) src.addFeature(new Feature(new LineString(coords)));
    for (const c of coords) src.addFeature(new Feature(new Point(c)));

    if (mapRef.current) {
      mapRef.current.getView().fit(boundingExtent(coords), { padding: [60, 60, 60, 60], maxZoom: 12 });
    }
  }, [pinnedPath]);

  return <div ref={containerRef} className={className ?? "h-[420px] w-full rounded-lg border"} />;
}

// Persistent style for the pinned-path highlight (rose line + dots).
function pinnedStyle(feature: FeatureLike): Style {
  const rose = "#f43f5e";
  return feature.getGeometry()?.getType() === "LineString"
    ? new Style({ stroke: new Stroke({ color: rose, width: 4 }) })
    : new Style({
        image: new CircleStyle({ radius: 7, fill: new Fill({ color: rose }), stroke: new Stroke({ color: "#fff", width: 2 }) }),
      });
}
