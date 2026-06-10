/**
 * IATA airport code -> [lat, lon] lookup for placing observer devices on the map.
 *
 * MeshCore observers tag their MQTT topic with an IATA code (`set mqtt.iata`).
 * This is a compact starter set; add the codes your devices actually use.
 * Coordinates are the airport reference points (approximate is fine here).
 */
export const IATA = {
  // North America
  SEA: [47.4502, -122.3088],
  PDX: [45.5887, -122.5975],
  SFO: [37.6213, -122.379],
  LAX: [33.9416, -118.4085],
  SJC: [37.3639, -121.9289],
  DEN: [39.8561, -104.6737],
  ORD: [41.9742, -87.9073],
  DFW: [32.8998, -97.0403],
  ATL: [33.6407, -84.4277],
  JFK: [40.6413, -73.7781],
  EWR: [40.6895, -74.1745],
  BOS: [42.3656, -71.0096],
  IAD: [38.9531, -77.4565],
  MIA: [25.7959, -80.287],
  YVR: [49.1967, -123.1815],
  YYZ: [43.6777, -79.6248],
  // Europe
  LHR: [51.47, -0.4543],
  LGW: [51.1537, -0.1821],
  AMS: [52.3105, 4.7683],
  FRA: [50.0379, 8.5622],
  CDG: [49.0097, 2.5479],
  MUC: [48.3538, 11.7861],
  BER: [52.3667, 13.5033],
  MAD: [40.4983, -3.5676],
  BCN: [41.2974, 2.0833],
  FCO: [41.8003, 12.2389],
  ZRH: [47.4647, 8.5492],
  VIE: [48.1103, 16.5697],
  CPH: [55.618, 12.6508],
  ARN: [59.6519, 17.9186],
  OSL: [60.1939, 11.1004],
  HEL: [60.3172, 24.9633],
  DUB: [53.4264, -6.2499],
  WAW: [52.1657, 20.9671],
  PRG: [50.1008, 14.26],
  LJU: [46.2237, 14.4576],
  ZAG: [45.7429, 16.0688],
  VCE: [45.5053, 12.3519],
  BUD: [47.4369, 19.2556],
  // Asia / Pacific / other
  NRT: [35.772, 140.3929],
  HND: [35.5494, 139.7798],
  SIN: [1.3644, 103.9915],
  HKG: [22.308, 113.9185],
  SYD: [-33.9399, 151.1753],
  AKL: [-37.0082, 174.785],
  DXB: [25.2532, 55.3657],
};

/** Return [lat, lon] for an IATA code, or null if unknown. */
export function iataLatLon(code) {
  if (!code) return null;
  return IATA[code.toUpperCase()] || null;
}
