/**
 * Country resolution from a lat/lon, by point-in-polygon against European
 * country borders. Bounding boxes alone misclassify nodes near borders (the
 * Slovenian mesh sits where SI/IT/AT/HU/HR bounding boxes overlap almost
 * entirely), so we test the actual polygons.
 *
 * Borders: a stripped + 4-decimal-rounded (~11 m) build of the leakyMirror
 * "map-of-europe" GeoJSON (worker/lib/europe-borders.json). Each feature is
 * { c: ISO2, n: name, g: [polygon, …] } where a polygon is [outerRing, …holes]
 * and a ring is an array of [lon, lat] pairs. Coverage is Europe only — points
 * outside any covered country resolve to null.
 */
import borders from "./europe-borders.json";

// Attach a bounding box to each country once, as a cheap reject before the
// per-ring ray cast.
let prepared = null;
function prepare() {
  if (prepared) return prepared;
  prepared = borders.map((f) => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const poly of f.g) {
      for (const [lon, lat] of poly[0]) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return { c: f.c, n: f.n, g: f.g, bbox: [minLon, minLat, maxLon, maxLat] };
  });
  return prepared;
}

/** Ray-casting point-in-ring (ring is [[lon,lat], …]). */
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
function pointInPolygon(lon, lat, poly) {
  if (!pointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(lon, lat, poly[h])) return false;
  }
  return true;
}

/**
 * Resolve a coordinate to its country.
 * @returns {{code: string, name: string} | null} ISO2 code + name, or null when
 *   the point is outside every covered (European) country or the input is bad.
 */
export function resolveCountry(lat, lon) {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  for (const f of prepare()) {
    const [minLon, minLat, maxLon, maxLat] = f.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    for (const poly of f.g) {
      if (pointInPolygon(lon, lat, poly)) return { code: f.c, name: f.n };
    }
  }
  return null;
}
