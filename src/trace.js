// A glowing point travelling the drawing. The lines already form a graph — nodes
// where they meet, edges between — so a tracer needs no authored route to have
// somewhere to go, and the drawing you made is the track it runs on.
//
// A tracer's position is fractional and never stored, so this is the one part of
// the app that can move smoothly without widening coordinates in codec.js.

const key = ([x, y]) => `${x},${y}`;

// Who is joined to whom. Built from the line list rather than from faces because
// a tracer doesn't care whether a region is enclosed — a dangling line is still
// somewhere to run.
export function adjacency(lines) {
  const adj = new Map();
  const link = (a, b) => {
    const k = key(a);
    if (!adj.has(k)) adj.set(k, []);
    if (!adj.get(k).some((p) => p[0] === b[0] && p[1] === b[1])) adj.get(k).push(b);
  };
  for (const [ax, ay, bx, by] of lines) {
    if (ax === bx && ay === by) continue;   // a line whose ends met; no edge to run
    link([ax, ay], [bx, by]);
    link([bx, by], [ax, ay]);
  }
  return adj;
}

// Where to go on arriving at `at`, having come from `from`. Turning back the way
// you came is allowed only at a dead end: without that a tracer spends most of
// its time rattling along one edge, which reads as a glitch rather than a path.
export function nextHop(at, from, adj, rand = Math.random) {
  const all = adj.get(key(at)) || [];
  if (!all.length) return null;
  const onward = from ? all.filter((p) => p[0] !== from[0] || p[1] !== from[1]) : all;
  const pool = onward.length ? onward : all;
  return pool[Math.floor(rand() * pool.length)];
}

// Advance by `steps` edge-lengths. Loops rather than assuming one hop per call,
// because a slow frame at a fast tempo can be worth more than a whole edge and
// teleporting past a junction would break the trail.
export function advance(tracer, steps, adj, rand = Math.random) {
  let t = tracer.t + steps;
  let { from, to } = tracer;
  let guard = 64;   // a tracer on a two-node drawing at speed shouldn't spin forever
  while (t >= 1 && guard--) {
    t -= 1;
    const next = nextHop(to, from, adj, rand);
    if (!next) return { from: to, to, t: 0 };   // nowhere to go; sit on the node
    from = to;
    to = next;
  }
  return { from, to, t: Math.min(t, 1) };
}

export function positionOf({ from, to, t }) {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

// A tracer that has lost its ground — the line it was running along was undone,
// or a movement layer pulled the node out from under it — restarts somewhere
// real instead of gliding off into empty space.
export function onGraph({ from, to }, adj) {
  return adj.has(key(from)) && adj.has(key(to));
}

export function spawn(adj, rand = Math.random) {
  const nodes = [...adj.keys()];
  if (!nodes.length) return null;
  const at = nodes[Math.floor(rand() * nodes.length)].split(',').map(Number);
  const next = nextHop(at, null, adj, rand);
  return next && { from: at, to: next, t: 0 };
}
