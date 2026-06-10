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
import { fromLonLat } from "ol/proj";
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

const BASEMAPS: { name: string; make: () => TileLayer }[] = [
  { name: "Light", make: () => new TileLayer({ source: new OSM() }) },
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

interface Props {
  nodes: MeshNode[];
  /** newest packet — identity change triggers a trace animation */
  latest: Packet | null;
  /** selected packet's path (hex hashes) — drawn as a persistent highlight */
  pinnedPath?: string[] | null;
  /** container classes (height etc.) */
  className?: string;
  /** clicking a node marker */
  onNodeClick?: (node: MeshNode) => void;
  /** skip live traces whose path uses ambiguous 1-byte hop hashes */
  skipSingleByte?: boolean;
}

export default function PacketMap({
  nodes,
  latest,
  pinnedPath = null,
  className,
  onNodeClick,
  skipSingleByte = false,
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
  const skipRef = useRef(skipSingleByte);
  skipRef.current = skipSingleByte;
  // fit bounds only once — live packet/advert updates must not reset the
  // user's pan/zoom
  const didFit = useRef(false);

  // init map once
  useEffect(() => {
    if (!containerRef.current) return;

    // basemaps: all created, only the active one visible; choice persists.
    const baseLayers = BASEMAPS.map(({ make }) => make());
    const stored = localStorage.getItem("mclive.basemap");
    const isDark = document.documentElement.classList.contains("dark");
    const initialName =
      (stored && BASEMAPS.some((b) => b.name === stored) && stored) || (isDark ? "Dark" : "Light");
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
      view: new View({ center: fromLonLat([-122.33, 47.6]), zoom: 9 }),
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

    map.on("pointermove", (e) => {
      if (e.dragging) return;
      const f = nodeAt(e.pixel);
      const node = f?.get("node") as MeshNode | undefined;
      const el = map.getTargetElement();
      if (node) {
        tip.textContent = `${node.name || "node"} · ${node.hash_prefix} — click to filter packets`;
        tooltip.setPosition(e.coordinate);
        tip.style.display = "block";
        el.style.cursor = "pointer";
      } else {
        tip.style.display = "none";
        el.style.cursor = "";
      }
    });

    map.on("click", (e) => {
      const f = nodeAt(e.pixel);
      const node = f?.get("node") as MeshNode | undefined;
      if (node) onNodeClickRef.current?.(node);
    });

    mapRef.current = map;
    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

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
