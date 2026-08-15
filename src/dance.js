// Choreography for dance mode: choose which nodes step where on a given tick.
// Pure, so the awkward parts — staying on the grid, not landing two nodes on the
// same point — are testable without a canvas or a timer.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Offsets are always measured from the drawing's resting positions rather than
// from wherever the last tick left things, so the shape wobbles around its
// original instead of random-walking away from it.
export function pickMoves(nodes, count, cols, rows, rand = Math.random) {
  const taken = new Set(nodes.map(([x, y]) => `${x},${y}`));
  const pool = [...nodes];
  const moves = [];
  const n = Math.min(count, pool.length);

  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));   // partial Fisher-Yates
    [pool[i], pool[j]] = [pool[j], pool[i]];
    const from = pool[i];

    for (const [dx, dy] of shuffled(DIRS, rand)) {
      const to = [from[0] + dx, from[1] + dy];
      if (to[0] < 0 || to[1] < 0 || to[0] >= cols || to[1] >= rows) continue;
      const k = `${to[0]},${to[1]}`;
      if (taken.has(k)) continue;   // two nodes on one point would weld together
      taken.delete(`${from[0]},${from[1]}`);
      taken.add(k);
      moves.push([from, to]);
      break;
    }
  }
  return moves;
}

function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
