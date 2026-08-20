// Shapes: which nodes a filled pocket owns, and moving a set of them at once.
// Pure, like planar.js — the fiddly parts (telling a movable corner from a
// crossing that only looks like one, and not letting a group move trip over
// itself) are testable without a canvas.

// A pocket's `lines` names every source line bounding it, including ones that
// run far past the pocket, so translating their endpoints would fling unrelated
// geometry across the sheet. Its `pts` are the boundary itself, but some of
// those corners are crossings, with no endpoint sitting there to move. The
// nodes a shape can be carried by are the overlap: boundary corners that a line
// genuinely ends on.
export function shapeNodes(face, occupied) {
  const seen = new Set();
  const out = [];
  for (const [x, y] of face.pts) {
    const i = Math.round(x), j = Math.round(y);
    if (Math.abs(x - i) > 1e-6 || Math.abs(y - j) > 1e-6) continue;   // a crossing off the grid
    const k = `${i},${j}`;
    if (seen.has(k) || !occupied.has(k)) continue;                    // a crossing that landed on a dot
    seen.add(k);
    out.push([i, j]);
  }
  return out;
}

// All or nothing: a step that would put one node off the sheet is refused
// rather than clamped, because clamping a single corner deforms the shape
// instead of moving it. Returns null when refused.
export function translate(nodes, [dx, dy], cols, rows) {
  const deltas = new Map();
  for (const [x, y] of nodes) {
    const tx = x + dx, ty = y + dy;
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return null;
    deltas.set(`${x},${y}`, [tx, ty]);
  }
  return deltas;
}

// deltas: Map("x,y" -> [tx, ty]). Every endpoint of a line is read before
// either is written, so a group move can't alias: shifting {(3,5),(4,5)} right
// by one would otherwise weld the first node onto the second, and then carry
// both when the second's turn came. Mutates `lines`; returns whether anything
// actually changed.
export function applyMoves(lines, deltas) {
  let touched = false;
  for (const l of lines) {
    const a = deltas.get(`${l[0]},${l[1]}`);
    const b = deltas.get(`${l[2]},${l[3]}`);
    if (a && (a[0] !== l[0] || a[1] !== l[1])) { [l[0], l[1]] = a; touched = true; }
    if (b && (b[0] !== l[2] || b[1] !== l[3])) { [l[2], l[3]] = b; touched = true; }
  }
  return touched;
}
