// Board generation: hex island, vertices (build spots), edges (roads), ports.
// Server is authoritative; it computes pixel layout and topology, sends to clients.

const SQRT3 = Math.sqrt(3);

// Pointy-top hex layout. size = 1 unit; client scales to canvas.
function axialToPixel(q, r, size = 1) {
  const x = size * SQRT3 * (q + r / 2);
  const y = size * 1.5 * r;
  return { x, y };
}

function hexCorners(cx, cy, size = 1) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 30);
    out.push({ x: cx + size * Math.cos(ang), y: cy + size * Math.sin(ang) });
  }
  return out;
}

const key = (x, y) => `${Math.round(x * 1e4) / 1e4},${Math.round(y * 1e4) / 1e4}`;

// Cube distance for circular island selection.
function hexesInRadius(R) {
  const list = [];
  for (let q = -R; q <= R; q++) {
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      list.push({ q, r });
    }
  }
  return list;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Resource weights mirror Catan's 4/4/4/3/3 over 18 land hexes.
const RES_WEIGHTS = [
  ['wood', 4], ['sheep', 4], ['wheat', 4], ['brick', 3], ['ore', 3],
];
// Standard token distribution (no 7). 6 & 8 are the hot numbers.
const TOKEN_BAG = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

function buildResourceBag(landCount) {
  const bag = [];
  const totalW = RES_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  for (const [res, w] of RES_WEIGHTS) {
    const n = Math.max(1, Math.round((w / totalW) * landCount));
    for (let i = 0; i < n; i++) bag.push(res);
  }
  while (bag.length < landCount) bag.push('wheat');
  while (bag.length > landCount) bag.pop();
  return bag;
}

function buildTokenBag(landCount) {
  const bag = [];
  while (bag.length < landCount) {
    for (const t of TOKEN_BAG) {
      if (bag.length >= landCount) break;
      bag.push(t);
    }
  }
  return bag;
}

// Radius scales board to player count.
export const MIN_RADIUS = 2; // 19 hexes
export const MAX_RADIUS = 5; // 91 hexes
export function radiusForPlayers(p) {
  if (p <= 4) return 2;   // 19 hexes
  if (p <= 7) return 3;   // 37 hexes
  return 4;               // 61 hexes
}

export function generateBoard(playerCount, radiusOverride) {
  const R = radiusOverride != null
    ? Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radiusOverride))
    : radiusForPlayers(playerCount);
  const size = 1;
  const cells = hexesInRadius(R);

  // Decide deserts: ~1 per 19 land hexes.
  const desertCount = Math.max(1, Math.round(cells.length / 19));
  const landCount = cells.length - desertCount;

  const resBag = shuffle(buildResourceBag(landCount));
  const tokenBag = shuffle(buildTokenBag(landCount));

  // Randomly choose which cells are desert.
  const idxs = shuffle(cells.map((_, i) => i));
  const desertSet = new Set(idxs.slice(0, desertCount));

  const hexes = [];
  let robberHex = null;
  let ri = 0, ti = 0;
  cells.forEach((c, i) => {
    const { x, y } = axialToPixel(c.q, c.r, size);
    const isDesert = desertSet.has(i);
    const hex = {
      id: i, q: c.q, r: c.r, x, y,
      type: isDesert ? 'desert' : resBag[ri++],
      token: isDesert ? null : tokenBag[ti++],
    };
    if (isDesert && robberHex === null) robberHex = i;
    hexes.push(hex);
  });
  if (robberHex === null) robberHex = [...desertSet][0] ?? 0;

  // Build vertices & edges by deduping hex corners.
  const vertMap = new Map();   // key -> vertex
  const edgeMap = new Map();   // key -> edge
  const vertices = [];
  const edges = [];

  function getVertex(x, y) {
    const k = key(x, y);
    let v = vertMap.get(k);
    if (!v) {
      v = { id: vertices.length, x, y, hexes: [], edges: [], verts: [] };
      vertMap.set(k, v);
      vertices.push(v);
    }
    return v;
  }
  function getEdge(a, b) {
    const k = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    let e = edgeMap.get(k);
    if (!e) {
      e = { id: edges.length, v1: a.id, v2: b.id, hexes: [],
            x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      edgeMap.set(k, e);
      edges.push(e);
      if (!a.verts.includes(b.id)) a.verts.push(b.id);
      if (!b.verts.includes(a.id)) b.verts.push(a.id);
      if (!a.edges.includes(e.id)) a.edges.push(e.id);
      if (!b.edges.includes(e.id)) b.edges.push(e.id);
    }
    return e;
  }

  for (const hex of hexes) {
    const corners = hexCorners(hex.x, hex.y, size).map(c => getVertex(c.x, c.y));
    for (const c of corners) if (!c.hexes.includes(hex.id)) c.hexes.push(hex.id);
    for (let i = 0; i < 6; i++) {
      const e = getEdge(corners[i], corners[(i + 1) % 6]);
      if (!e.hexes.includes(hex.id)) e.hexes.push(hex.id);
    }
  }

  const ports = buildPorts(edges, vertices, hexes);

  // Bounds for client auto-fit.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vertices) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }

  return {
    radius: R,
    hexes,
    vertices: vertices.map(v => ({
      id: v.id, x: v.x, y: v.y, hexes: v.hexes, edges: v.edges, verts: v.verts,
    })),
    edges: edges.map(e => ({
      id: e.id, v1: e.v1, v2: e.v2, x: e.x, y: e.y, hexes: e.hexes,
    })),
    ports,
    robberHex,
    bounds: { minX, minY, maxX, maxY },
  };
}

// Place ports on coastal edges (edges touching exactly one hex), spaced out.
function buildPorts(edges, vertices, hexes) {
  const coastal = edges.filter(e => e.hexes.length === 1);
  if (!coastal.length) return [];

  // center of island
  const cx = hexes.reduce((s, h) => s + h.x, 0) / hexes.length;
  const cy = hexes.reduce((s, h) => s + h.y, 0) / hexes.length;
  coastal.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  const portCount = Math.max(4, Math.round(coastal.length / 3.5));
  const types = [];
  const specific = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  for (let i = 0; i < portCount; i++) {
    // ~2/5 specific (2:1), rest generic (3:1)
    if (i % 2 === 0) types.push('3:1');
    else types.push(specific[(i >> 1) % specific.length]);
  }

  const ports = [];
  const step = coastal.length / portCount;
  const used = new Set();
  for (let i = 0; i < portCount; i++) {
    const e = coastal[Math.floor(i * step) % coastal.length];
    if (used.has(e.id)) continue;
    used.add(e.id);
    ports.push({ edgeId: e.id, type: types[i], vertices: [e.v1, e.v2], x: e.x, y: e.y });
  }
  return ports;
}
