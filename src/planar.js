// Planar subdivision: a pile of straight segments in, the enclosed regions
// ("pockets") out. Pure geometry, no DOM, no app state — so it can be called
// once per edit today and once per animation frame later.

const EPS = 1e-9;
const Q = 1e6; // vertex quantization: coordinates snap to 1e-6 grid units

const key = (x, y) => `${Math.round(x * Q)},${Math.round(y * Q)}`;
const snap = (x) => Math.round(x * Q) / Q;
const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// Where does point p fall along segment a->b? Returns the parameter, or null if
// p isn't on the segment. Covers T-junctions and collinear overlap in one test.
function paramOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return null;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < -EPS || t > 1 + EPS) return null;
  const perp = cross(dx, dy, px - ax, py - ay) / Math.sqrt(len2);
  return Math.abs(perp) < 1e-7 ? t : null;
}

// segments: [{ id, a: [x, y], b: [x, y] }] — endpoints may be any floats.
// Returns { verts: Map(key -> [x, y]), edges: [{ u, v, lines: [id] }] }.
function subdivide(segments) {
  const splits = segments.map(() => [0, 1]);

  for (let i = 0; i < segments.length; i++) {
    const [ax, ay] = segments[i].a, [bx, by] = segments[i].b;
    const d1x = bx - ax, d1y = by - ay;

    for (let j = i + 1; j < segments.length; j++) {
      const [cx, cy] = segments[j].a, [dx, dy] = segments[j].b;
      const d2x = dx - cx, d2y = dy - cy;

      // proper crossing
      const denom = cross(d1x, d1y, d2x, d2y);
      if (Math.abs(denom) > 1e-12) {
        const t = cross(cx - ax, cy - ay, d2x, d2y) / denom;
        const u = cross(cx - ax, cy - ay, d1x, d1y) / denom;
        if (t > -EPS && t < 1 + EPS && u > -EPS && u < 1 + EPS) {
          splits[i].push(t);
          splits[j].push(u);
        }
      }

      // endpoints of one lying on the other (T-junctions, collinear overlap)
      for (const [px, py] of [segments[j].a, segments[j].b]) {
        const t = paramOnSegment(px, py, ax, ay, bx, by);
        if (t !== null) splits[i].push(t);
      }
      for (const [px, py] of [segments[i].a, segments[i].b]) {
        const u = paramOnSegment(px, py, cx, cy, dx, dy);
        if (u !== null) splits[j].push(u);
      }
    }
  }

  const verts = new Map();
  const edges = new Map(); // "u|v" (sorted) -> { u, v, lines: Set }

  segments.forEach((seg, i) => {
    const [ax, ay] = seg.a, [bx, by] = seg.b;
    const ts = [...new Set(splits[i])].sort((p, q) => p - q);

    let prev = null;
    for (const t of ts) {
      const tc = Math.min(1, Math.max(0, t));
      const x = snap(ax + (bx - ax) * tc), y = snap(ay + (by - ay) * tc);
      const k = key(x, y);
      if (!verts.has(k)) verts.set(k, [x, y]);
      if (prev !== null && prev !== k) {
        const ek = prev < k ? `${prev}|${k}` : `${k}|${prev}`;
        const e = edges.get(ek) || { u: prev, v: k, lines: new Set() };
        e.lines.add(seg.id);
        edges.set(ek, e);
      }
      prev = k;
    }
  });

  return {
    verts,
    edges: [...edges.values()].map((e) => ({ u: e.u, v: e.v, lines: [...e.lines].sort((a, b) => a - b) })),
  };
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// Half-edge traversal. At each vertex the neighbours are sorted counter-clockwise;
// arriving along u->v we leave along the neighbour just *before* u in that order
// (the sharpest clockwise turn), which traces bounded faces counter-clockwise and
// the unbounded outer face clockwise.
function facesFrom({ verts, edges }) {
  const adj = new Map();
  const lineOf = new Map();
  for (const e of edges) {
    for (const [u, v] of [[e.u, e.v], [e.v, e.u]]) {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push(v);
      lineOf.set(`${u}|${v}`, e.lines);
    }
  }
  for (const [k, nbrs] of adj) {
    const [x, y] = verts.get(k);
    nbrs.sort((p, q) => {
      const [px, py] = verts.get(p), [qx, qy] = verts.get(q);
      return Math.atan2(py - y, px - x) - Math.atan2(qy - y, qx - x);
    });
  }

  const visited = new Set();
  const out = [];

  for (const e of edges) {
    for (const start of [`${e.u}|${e.v}`, `${e.v}|${e.u}`]) {
      if (visited.has(start)) continue;
      let [u, v] = start.split('|');
      const walk = [];
      const lines = new Set();

      while (!visited.has(`${u}|${v}`)) {
        visited.add(`${u}|${v}`);
        walk.push(u);
        for (const id of lineOf.get(`${u}|${v}`)) lines.add(id);
        const nbrs = adj.get(v);
        const i = nbrs.indexOf(u);
        const w = nbrs[(i - 1 + nbrs.length) % nbrs.length];
        u = v;
        v = w;
      }

      const pts = walk.map((k) => verts.get(k));
      const area = signedArea(pts);
      // Negative = the outer face. Near-zero = a walk that only doubled back
      // along dangling edges and encloses nothing.
      if (area > 1e-7) out.push({ pts, area, lines: [...lines].sort((a, b) => a - b) });
    }
  }

  // Face key: which source lines bound it, plus an index to separate faces that
  // happen to share the same bounding set. Survives endpoints being animated
  // around; only a topology change invalidates it.
  const groups = new Map();
  for (const f of out) {
    const base = f.lines.join(',');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  for (const [base, group] of groups) {
    group.sort((a, b) => centroid(a.pts)[0] - centroid(b.pts)[0] || centroid(a.pts)[1] - centroid(b.pts)[1]);
    group.forEach((f, i) => { f.key = `${base}#${i}`; });
  }

  return out;
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

export function computeFaces(segments) {
  if (segments.length < 2) return [];
  return facesFrom(subdivide(segments));
}

function contains(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Perpendicular distance from a point to a segment, clamped to its ends so the
// area beyond a tip doesn't count as near the line.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// Which drawn line is under the finger. Nearest wins rather than first, so
// tapping a crossing picks the line you were actually closest to. Returns the
// segment's id, since that's what a color is stored against.
export function lineAt(segments, x, y, tol) {
  let best = null, near = tol;
  for (const s of segments) {
    const d = distToSegment(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (d <= near) { near = d; best = s.id; }
  }
  return best;
}

// Smallest face containing the point, so nested pockets resolve to the innermost.
export function faceAt(faces, x, y) {
  let best = null;
  for (const f of faces) {
    if (contains(f.pts, x, y) && (!best || f.area < best.area)) best = f;
  }
  return best;
}
