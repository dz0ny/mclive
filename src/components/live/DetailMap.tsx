import { useEffect, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
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
import Stroke from "ol/style/Stroke";
import Fill from "ol/style/Fill";
import CircleStyle from "ol/style/Circle";
import { defaults as defaultInteractions } from "ol/interaction";
import "ol/ol.css";
import type { AdvertInfo, Hop } from "@/lib/meshcore";

interface Props {
  advert: AdvertInfo | null;
  hops: Hop[];
}

const CYAN = "#22d3ee";
const ROSE = "#f43f5e";

function dot(radius: number, color: string, stroke: number) {
  return new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color }),
      stroke: new Stroke({ color, width: stroke }),
    }),
  });
}

/**
 * Static map for the detail sheet: the source node (advert location) and the
 * relay chain the packet travelled. The observer (local receiver) is not drawn
 * — it isn't part of the mesh path.
 */
export default function DetailMap({ advert, hops }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const darkTheme = document.documentElement.classList.contains("dark");

    const base = new TileLayer({
      source: darkTheme
        ? new XYZ({ url: "https://{a-c}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", maxZoom: 19 })
        : new OSM(),
    });

    const src = new VectorSource();
    const map = new Map({
      target: containerRef.current,
      controls: [],
      interactions: defaultInteractions({ mouseWheelZoom: false }),
      layers: [base, new VectorLayer({ source: src })],
      view: new View({ center: fromLonLat([-122.33, 47.6]), zoom: 9 }),
    });

    const pts: number[][] = [];
    const source =
      advert?.hasLatLon &&
      advert.lat != null &&
      advert.lon != null &&
      !(advert.lat === 0 && advert.lon === 0) // no GPS fix → 0,0, don't draw
        ? fromLonLat([advert.lon, advert.lat])
        : null;

    // hop nodes, in path order (path[0] = nearest sender … last = nearest observer)
    const hopCoords: number[][] = [];
    hops.forEach((h, i) => {
      if (!h.node) return;
      const c = fromLonLat([h.node.lon, h.node.lat]);
      hopCoords.push(c);
      pts.push(c);
      const f = new Feature({ geometry: new Point(c), label: `${i + 1}. ${h.node.name || h.hash}` });
      f.setStyle(dot(5, CYAN, 2));
      src.addFeature(f);
    });

    // the relay chain, in order: source → hop0 → … → hopN (the observer/local
    // receiver is intentionally not drawn — it isn't part of the mesh path)
    const chain: number[][] = [];
    if (source) chain.push(source);
    chain.push(...hopCoords);
    if (chain.length >= 2) {
      const line = new Feature(new LineString(chain));
      line.setStyle(new Style({ stroke: new Stroke({ color: CYAN, width: 2, lineDash: [4, 4] }) }));
      src.addFeature(line);
    }

    // source marker on top
    if (source) {
      pts.push(source);
      const f = new Feature({ geometry: new Point(source), label: advert?.name || "source" });
      f.setStyle(dot(8, ROSE, 3));
      src.addFeature(f);
    }

    if (pts.length) {
      map.getView().fit(boundingExtent(pts), { padding: [30, 30, 30, 30], maxZoom: 12 });
    }

    // hover tooltip
    const tip = document.createElement("div");
    tip.className = "mclive-tooltip";
    const tooltip = new Overlay({ element: tip, offset: [0, -14], positioning: "bottom-center" });
    map.addOverlay(tooltip);
    map.on("pointermove", (e) => {
      if (e.dragging) return;
      const f = map.forEachFeatureAtPixel(e.pixel, (ft) => (ft.get("label") ? ft : undefined), {
        hitTolerance: 4,
      });
      const label = f?.get("label") as string | undefined;
      if (label) {
        tip.textContent = label;
        tooltip.setPosition(e.coordinate);
        tip.style.display = "block";
      } else {
        tip.style.display = "none";
      }
    });

    return () => map.setTarget(undefined);
  }, [advert, hops]);

  return <div ref={containerRef} className="h-56 w-full overflow-hidden rounded-md border" />;
}
