/**
 * Region ("scope") detection for transport-routed packets.
 *
 * MeshCore scoping (see ~/mc-mq): TRANSPORT_FLOOD/DIRECT packets carry
 * transport_codes[0], computed by the sender as
 *
 *   HMAC-SHA256(region_key, payload_type(1) || payload)  -> first 2 bytes, LE
 *   (0x0000 -> 0x0001, 0xFFFF -> 0xFFFE reserved)
 *
 * For public "hashtag" regions the key is publicly derivable:
 *   key = SHA256("#name")[0:16]            (TransportKeyStore::getAutoKeyFor)
 * so anyone can detect the region the same way a repeater does
 * (RegionMap::findMatch): recompute the code per candidate name and compare.
 * Private "$name" regions use secret keys and stay undetectable.
 *
 * Codes {0,0} mean "send to nowhere" — used by the phone app's 'Share' so an
 * advert reaches direct neighbours but is never re-flooded.
 */

// Candidate public region names (mesh communities pick these by convention; the
// 2-byte code can't be reversed, only matched). The Slovenian mesh uses a
// hierarchical "si" family: "si" plus "si-<area>" sub-regions (si-got, si-not,
// …). Verified against live data: every scoped packet observed so far matches
// "si". Extend as new sub-regions appear.
const REGION_NAMES = [
  // Slovenia + sub-regions (si-<area> convention)
  "si", "si-got", "si-not",
  "si-gor", "si-dol", "si-sta", "si-pri", "si-kor", "si-pom", "si-pre",
  "si-zas", "si-pos", "si-sav", "si-bel", "si-kra", "si-ist", "si-obk",
  "si-osr", "si-jvz", "si-gos",
  "si-lj", "si-mb", "si-ce", "si-kr", "si-kp", "si-nm", "si-ms", "si-ng",
  "si-sg", "si-po", "si-za", "si-kk",
  // neighbours / wider area
  "slo", "svn", "slovenia", "slovenija",
  "it", "ita", "italy", "italia", "fvg", "friuli", "veneto", "trieste", "trst",
  "hr", "cro", "croatia", "hrvatska", "zagreb", "istra", "istria", "rijeka",
  "hu", "hun", "hungary", "budapest",
  "at", "aut", "austria", "wien", "graz", "kaernten", "steiermark",
  "balkan", "adriatic", "jadran", "alpeadria", "eu", "europe", "world",
  "global", "test", "public", "mesh",
];

/** name -> Promise<CryptoKey>, derived once (names are tried in both cases). */
const keyCache = new Map();

function candidateNames() {
  const out = new Set();
  for (const n of REGION_NAMES) {
    out.add(n);
    out.add(n.toUpperCase());
  }
  return out;
}

async function hmacKeyFor(name) {
  let p = keyCache.get(name);
  if (!p) {
    p = (async () => {
      // firmware hashes the name WITH the leading '#'
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`#${name}`)
      );
      return crypto.subtle.importKey(
        "raw",
        digest.slice(0, 16),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
    })();
    keyCache.set(name, p);
  }
  return p;
}

async function transportCode(name, payloadType, payload) {
  const key = await hmacKeyFor(name);
  const msg = new Uint8Array(1 + payload.length);
  msg[0] = payloadType;
  msg.set(payload, 1);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  let code = mac[0] | (mac[1] << 8); // uint16 LE
  if (code === 0) code = 1;
  else if (code === 0xffff) code = 0xfffe;
  return code;
}

/**
 * Detect the region a decoded packet (from decodePacket) is scoped to.
 * Returns the matched region name (e.g. "si"), "" when the packet carries
 * transport codes that match no known region, or null for non-transport
 * packets. Codes {0,0} return "" (Share / send-to-nowhere, not a region).
 */
export async function detectScope(pkt) {
  if (!pkt?.transportCodes) return null;
  const [code0, code1] = pkt.transportCodes;
  if (code0 === 0 && code1 === 0) return "";
  for (const name of candidateNames()) {
    if ((await transportCode(name, pkt.payloadType, pkt.payload)) === code0) {
      return name;
    }
  }
  return "";
}

/** True when transport codes are {0,0} — 'Share' / deliberately unroutable. */
export function isShareScope(pkt) {
  return !!pkt?.transportCodes && pkt.transportCodes[0] === 0 && pkt.transportCodes[1] === 0;
}
