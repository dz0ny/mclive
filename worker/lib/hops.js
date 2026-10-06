/**
 * Path hop to node resolution for the worker API and the UI.
 * A hop hash is the first 1–4 bytes of a relay pubkey, and short hashes often
 * match more than one node.
 * Only repeaters relay, so we use the matching repeaters (or all matches if no
 * repeater matches) as candidates.
 * We pick one candidate per hop so that the sum of the distances between
 * adjacent hops is smallest, because LoRa links are short.
 * If two choices have the same distance, we pick the most recent node.
 */

const ADV_TYPE_REPEATER = 2;
// A very small cost per recency rank. It breaks ties between equal distances.
const RECENCY_EPS_KM = 1e-6;

// Index of node lists by first pubkey byte, most recent first in each bucket.
// The WeakMap keys on the array, so a new node list gets a new index.
const indexCache = new WeakMap();

function byFirstByte(nodes) {
  let idx = indexCache.get(nodes);
  if (idx) return idx;
  idx = new Map();
  for (const n of nodes) {
    const key = n.pubkey.slice(0, 2).toLowerCase();
    const bucket = idx.get(key);
    if (bucket) bucket.push(n);
    else idx.set(key, [n]);
  }
  for (const bucket of idx.values()) bucket.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  indexCache.set(nodes, idx);
  return idx;
}

/** Nodes whose pubkey starts with `hash`, most recent first. */
export function nodesForHash(hash, nodes) {
  if (!hash) return [];
  const h = hash.toLowerCase();
  if (h.length < 2) {
    return nodes
      .filter((n) => n.pubkey.toLowerCase().startsWith(h))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }
  const bucket = byFirstByte(nodes).get(h.slice(0, 2)) ?? [];
  return h.length === 2 ? bucket.slice() : bucket.filter((n) => n.pubkey.toLowerCase().startsWith(h));
}

/** Hop candidates: the matching repeaters, or all matches if no repeater matches. */
export function hopCandidates(hash, nodes) {
  const all = nodesForHash(hash, nodes);
  const repeaters = all.filter((n) => n.adv_type === ADV_TYPE_REPEATER);
  return repeaters.length ? repeaters : all;
}

const located = (n) => n.lat != null && n.lon != null && !(n.lat === 0 && n.lon === 0);

/** Great-circle distance in km. It is 0 if one end has no location. */
function distKm(a, b) {
  if (!located(a) || !located(b)) return 0;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Resolve each hop of `path` (hex hashes) against `nodes`. The result has one
 * node per hop, or null if no node matches. Dynamic programming finds the
 * smallest total distance. A hop without a match splits the path. We resolve
 * each part separately.
 */
export function resolvePath(path, nodes) {
  const cands = path.map((h) => hopCandidates(h, nodes));
  const out = new Array(path.length).fill(null);
  let i = 0;
  while (i < path.length) {
    if (!cands[i].length) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < path.length && cands[end + 1].length) end++;
    resolveSegment(cands, i, end, out);
    i = end + 1;
  }
  return out;
}

function resolveSegment(cands, start, end, out) {
  // cost[k] is the cost of the best chain that ends at candidate k of this hop.
  let cost = cands[start].map((_, k) => k * RECENCY_EPS_KM);
  const back = [];
  for (let i = start + 1; i <= end; i++) {
    const prev = cands[i - 1];
    const choice = [];
    cost = cands[i].map((n, k) => {
      let best = Infinity;
      let arg = 0;
      for (let j = 0; j < prev.length; j++) {
        const c = cost[j] + distKm(prev[j], n);
        if (c < best) {
          best = c;
          arg = j;
        }
      }
      choice.push(arg);
      return best + k * RECENCY_EPS_KM;
    });
    back.push(choice);
  }
  let k = 0;
  for (let j = 1; j < cost.length; j++) if (cost[j] < cost[k]) k = j;
  for (let i = end; i >= start; i--) {
    out[i] = cands[i][k];
    if (i > start) k = back[i - start - 1][k];
  }
}
