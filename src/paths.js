// Authored routes. A path belongs to a node and says where that node goes, one
// waypoint per beat — but the same route is also something a tracer can run
// along, so one drawing gesture feeds two animations.
//
// A path's first point IS the node it belongs to, and is also the key it's
// stored under. Keeping the anchor inside the sequence rather than beside it
// means there is one list to walk, close and reverse, and no second copy of the
// node position to fall out of step with the first.
//
// Pure: which waypoint is next, and whether a route still makes sense, are the
// parts worth testing, and neither needs a canvas.

export const anchorOf = (path) => path.pts[0];
export const keyOf = (path) => path.pts[0].join(',');

// Where the walker goes next. A closed path cycles; an open one ping-pongs,
// because a walker that teleported home from the far end would read as a
// glitch rather than as a return.
export function step(i, dir, len, closed) {
  if (len < 2) return [0, 1];
  if (closed) return [(i + 1) % len, 1];
  const next = i + dir;
  if (next >= len) return [len - 2, -1];
  if (next < 0) return [1, 1];
  return [next, dir];
}

// The segment a tracer is on when the walker is at `i` heading `dir`: from where
// it stands to wherever it's bound. Same rule as the walker, so a tracer shown
// on a path traces exactly the route the node will take.
export function segmentAt(path, i, dir) {
  const [j] = step(i, dir, path.pts.length, path.closed);
  return [path.pts[i], path.pts[j]];
}

// A path is only worth keeping while its anchor is still a node with lines on it
// and every waypoint is on the sheet. Undo can take the lines out from under a
// path, and a path to nowhere would quietly move a node that isn't there.
export function valid(path, occupied, cols, rows) {
  if (!path.pts.length || path.pts.length < 2) return false;
  if (!occupied.has(keyOf(path))) return false;
  return path.pts.every(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows);
}

// Walking a path is the same displacement any other movement layer makes, so it
// goes through moveNodes and obeys the same refusals. This is only the bookkeeping
// around it: where the walker is now, and where it wants to be next.
export function walkers(paths) {
  return Object.values(paths).map((path) => ({ path, i: 0, dir: 1 }));
}

// Advance one walker, returning the move it wants as [from, to] — or null when
// it has nowhere to go. The caller applies it and decides what a refusal means;
// a walker whose step was refused stalls where it is and tries again next beat,
// which on a four-to-the-floor reads as a held note rather than as a fault.
export function nextMove(w) {
  const pts = w.path.pts;
  if (pts.length < 2) return null;
  const [j, dir] = step(w.i, w.dir, pts.length, w.path.closed);
  return { from: pts[w.i], to: pts[j], commit: () => { w.i = j; w.dir = dir; } };
}
