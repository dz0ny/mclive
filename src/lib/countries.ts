// ISO2 → display name for the European countries the worker can resolve
// (worker/lib/geo.js point-in-polygon coverage). The API returns just the ISO2
// code per advert; this maps it to a name and flag for the adverts table.

export const COUNTRY_NAMES: Record<string, string> = {
  AD: "Andorra",
  AL: "Albania",
  AM: "Armenia",
  AT: "Austria",
  AZ: "Azerbaijan",
  BA: "Bosnia and Herzegovina",
  BE: "Belgium",
  BG: "Bulgaria",
  BY: "Belarus",
  CH: "Switzerland",
  CY: "Cyprus",
  CZ: "Czech Republic",
  DE: "Germany",
  DK: "Denmark",
  EE: "Estonia",
  ES: "Spain",
  FI: "Finland",
  FO: "Faroe Islands",
  FR: "France",
  GB: "United Kingdom",
  GE: "Georgia",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IL: "Israel",
  IS: "Iceland",
  IT: "Italy",
  LI: "Liechtenstein",
  LT: "Lithuania",
  LU: "Luxembourg",
  LV: "Latvia",
  MC: "Monaco",
  MD: "Moldova",
  ME: "Montenegro",
  MK: "North Macedonia",
  MT: "Malta",
  NL: "Netherlands",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  RS: "Serbia",
  RU: "Russia",
  SE: "Sweden",
  SI: "Slovenia",
  SK: "Slovakia",
  SM: "San Marino",
  TR: "Turkey",
  UA: "Ukraine",
  VA: "Vatican City",
};

/** Full name for an ISO2 code, falling back to the code itself. */
export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}

/** Regional-indicator flag emoji for an ISO2 code (e.g. "SI" → 🇸🇮). */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  const base = 0x1f1e6;
  const cc = code.toUpperCase();
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65, base + cc.charCodeAt(1) - 65);
}
