import { computeFaces, faceAt, lineAt } from './planar.js';
import { encode, decode, decodeLegacy, INK } from './codec.js';
import { pickMoves, pickDancers, wander } from './dance.js';
import { shapeNodes, translate, applyMoves, wouldWeld } from './shapes.js';
import { createListener, CHROMA_CONFIG } from './listen.js';
import { sounding, started, inReadingOrder, notesToMoves, trackEnergy } from './notes.js';
import { beatMs, clampBpm, fires, fireCount, tapTempo, scaleBpm, DIVS, MIN_BPM, MAX_BPM } from './clock.js';
import { shiftColor, popScale, scaleAbout, strobing, revealed, faceReady } from './looks.js';
import { adjacency, advance, positionOf, onGraph, spawn } from './trace.js';
import { walkers, nextMove, step, segmentAt, valid as pathValid } from './paths.js';

// px per grid unit. Nominally 1 cm (96 CSS px per inch), but CSS px drift from
// physical size per device — hold a ruler to the screen and tune this.
const CM = 96 / 2.54;
const MARGIN = 0.6 * CM;   // keep dots off the very edge
const SNAP = 0.45;         // tap-to-node radius, in grid units
const PALETTE = ['#e0655c', '#ec9c46', '#e8c84e', '#68b877', '#579fd8', '#a077cc'];
const STORE = 'pocket-filler';
const SLOTS = 'pocket-filler-presets';

// INK comes from codec.js, which is where it has to be validated. It means "the
// sheet's own line color" and is one past the palette — a real choice rather
// than the absence of one: picking it is how you paint a line or a node back to
// plain, and it's what's selected at startup so a fresh drawing comes out
// exactly as it always did.
if (INK !== PALETTE.length) throw new Error('INK must sit one past the palette');
const TAP_LINE = 0.28;   // how near a line counts as tapping it, in grid units

// How far from home a shape may drift, and how far a pop throws a shape past
// its own size. The leash is on a slider because it changes the feel; the pop
// is not, because past about a third the shapes start overlapping their
// neighbours and it stops reading as a pulse.
const POP = 0.3;

// The sheet's colors live in index.html so there's one place to change them.
// Read once a frame rather than per shape — the same call the dots already made.
const theme = { ink: '#222222', paper: '#ffffff', dot: '#c9c9c9' };
// A color index resolves against the palette, except INK which is the theme's.
const colorOf = (i) => (i === INK ? theme.ink : state.palette[i]);

function readTheme() {
  const s = getComputedStyle(document.body);
  for (const k of Object.keys(theme)) {
    const v = s.getPropertyValue(`--${k}`).trim();
    if (v) theme[k] = v;
  }
}

// lines: [ax, ay, bx, by] in grid units; the array index is the line's id, which
// is what face keys are built from — so ordering must stay stable.
// `dots` is a view preference, not part of the drawing: it persists locally but
// stays out of the share codec, so a link never imposes your grid on someone else.
// `palette` goes the other way — fills store an index into it, so a drawing
// shared without its palette would arrive in somebody else's colors.
// lineColors and nodeColors are sparse: a line with no entry is ink, a node
// with no entry isn't painted at all. Sparse so a plain drawing carries nothing
// extra, on disk or in a link.
// `paths` is authored movement: a route per node, keyed by that node's resting
// position, with the node itself as the route's first point.
const state = {
  lines: [], fills: {}, mode: 'draw', color: INK, chain: null,
  dots: true, palette: [...PALETTE], lineColors: {}, nodeColors: {}, paths: {},
};
const MODES = ['draw', 'fill', 'move', 'path'];
// "Fill" stopped being the truth when it grew to paint lines and nodes as well
// as pockets. The internal name stays, since face keys and saved drawings don't
// care what the button says.
const MODE_LABEL = { draw: 'Draw', fill: 'Paint', move: 'Move', path: 'Path' };

// Everything the animation is configured to do. Separate from `state` because
// it is a way of playing the drawing rather than part of it: it saves locally,
// stays out of share links, and is what a preset slot copies.
const anim = {
  bpm: 128,
  countIn: false,
  move: 'none',                 // none | point | shape | path
  moveDiv: 1,
  counts: { point: 3, shape: 2 },
  leash: 2,
  drop: true,
  looks: {
    cycle:  { on: false, div: 4, ripple: false },
    pop:    { on: false, div: 1 },
    strobe: { on: false, div: 4 },
    trace:  { on: false, div: 1, n: 1, follow: false },
    reveal: { on: false, div: 1 },
  },
};

const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d');
let cols = 0, rows = 0, ox = 0, oy = 0;   // grid extent and screen origin
let faces = [];
let facesStale = true;
let hover = null;                         // rubber-band target (mouse only)
let drag = null;                          // { at: [x, y] } while a node is being moved
let draft = null;                         // { pts, closed } while a path is being laid
let perf = null;                          // the running performance, or nothing

const toGrid = (px, py) => [(px - ox) / CM, (py - oy) / CM];
const toPx = (gx, gy) => [ox + gx * CM, oy + gy * CM];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const nodeKey = ([x, y]) => `${x},${y}`;

function getFaces() {
  if (facesStale) {
    faces = computeFaces(state.lines.map((l, id) => ({ id, a: [l[0], l[1]], b: [l[2], l[3]] })));
    facesStale = false;
  }
  return faces;
}

function nearestNode(gx, gy) {
  const i = Math.round(gx), j = Math.round(gy);
  if (i < 0 || j < 0 || i >= cols || j >= rows) return null;
  return Math.hypot(gx - i, gy - j) <= SNAP ? [i, j] : null;
}

// Nodes are identified by position, not by id: every line endpoint sitting on a
// grid point is the same node. Coordinates are exact integers, so equality is
// safe, and dragging keeps them welded because they all land on the same target.
function occupiedNodes() {
  const s = new Set();
  for (const [ax, ay, bx, by] of state.lines) s.add(`${ax},${ay}`).add(`${bx},${by}`);
  return s;
}

// The animation seam. A drag is just repeated calls to this, and anything
// driving the drawing programmatically should come through here too.
//
// ponytail: a line whose ends meet is left in place rather than deleted.
// Removing it would renumber every later line and break the fill keys that
// are built from those numbers; kept, it costs 4 URL characters and comes
// back intact when the node is dragged away again.
export function moveNodes(deltas) {
  const touched = applyMoves(state.lines, deltas);
  if (touched) {
    // A painted node is keyed by where it is, so moving the node has to carry
    // its color along or the paint stays behind on an empty grid point. Same
    // hazard as a fill losing its pocket, one level down.
    const moved = {};
    for (const [at, c] of Object.entries(state.nodeColors)) {
      const to = deltas.get(at);
      moved[to ? `${to[0]},${to[1]}` : at] = c;
    }
    state.nodeColors = moved;
    // A path is keyed the same way and follows a dragged node for the same
    // reason — but only when the user is doing the dragging. During a
    // performance the node is being moved BY its path, and carrying the path
    // along with it would have the route chase its own walker down the sheet.
    if (!perf) remapPaths(deltas);
    facesStale = true;
  }
  return touched;
}

function remapPaths(deltas) {
  const moved = {};
  for (const [at, path] of Object.entries(state.paths)) {
    const to = deltas.get(at);
    if (!to) { moved[at] = path; continue; }
    // The anchor is the route's first point, so moving the node moves the whole
    // route with it rather than leaving the node attached to a route it has
    // walked away from.
    const [dx, dy] = [to[0] - path.pts[0][0], to[1] - path.pts[0][1]];
    const pts = path.pts.map(([x, y]) => [x + dx, y + dy]);
    if (pts.every(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows)) {
      moved[nodeKey(to)] = { ...path, pts };
    }
    // A route that would leave the sheet is dropped rather than clipped: half a
    // route is a different route, and a silent change of shape is worse than
    // losing one you can draw again.
  }
  state.paths = moved;
}

export function moveNode([fx, fy], to) {
  return moveNodes(new Map([[`${fx},${fy}`, to]]));
}

// --- shapes ----------------------------------------------------------------

// A colored pocket is the closest thing to a shape this drawing has. The user
// has already pointed at the region that means something, so there's nothing to
// infer and no clustering heuristic to get wrong; uncolored pockets stay
// anonymous. Fills outlive their pocket on purpose (see the note by the bottom
// of this file), so a key with no live face is simply not a shape today.
export function shapes() {
  const occupied = occupiedNodes();
  return getFaces()
    .filter((f) => state.fills[f.key] !== undefined)
    .map((f) => ({ key: f.key, color: state.fills[f.key], nodes: shapeNodes(f, occupied) }));
}

// Tethered, not detached: nodes are shared by position, so a line that merely
// touches the shape follows by one end and stretches. That's the whole of the
// "rigid body" here — the shape keeps its own form, the web around it gives.
export function moveShape(key, delta) {
  const shape = shapes().find((s) => s.key === key);
  if (!shape) return false;
  const deltas = translate(shape.nodes, delta, cols, rows);
  if (!deltas) return false;

  // Two nodes on one grid point weld permanently (see invariant 2), and two
  // shapes meeting corner to corner cut no edge, so the topology check below
  // would wave it through. Refuse before it happens.
  if (wouldWeld(deltas, occupiedNodes())) return false;

  const before = JSON.stringify(state.lines);
  moveNodes(deltas);
  // A step that re-cuts the pocket re-keys the face, which strands the fill.
  const stillThere = computeFaces(state.lines.map((l, id) => ({ id, a: [l[0], l[1]], b: [l[2], l[3]] })))
    .some((f) => f.key === key);
  if (!stillThere) {
    state.lines = JSON.parse(before);
    facesStale = true;
    return false;
  }
  return true;
}

// --- undo ------------------------------------------------------------------

const undoStack = [];
function snapshot() {
  undoStack.push(JSON.stringify({
    l: state.lines, f: state.fills,
    lc: state.lineColors, nc: state.nodeColors, pa: state.paths,
  }));
  if (undoStack.length > 60) undoStack.shift();
}

// --- rendering -------------------------------------------------------------

let frame = 0;
const draw = () => { frame ||= requestAnimationFrame(render); };

// Which looks need a frame of their own rather than one per beat. The colour
// cycle and the reveal change only when a beat fires, so they are free; a pop
// decays, a strobe expires and a tracer travels, so those three keep the loop
// turning. When none of them is on, rendering goes back to being the
// once-per-change thing it has always been, and an idle page costs nothing.
const continuous = () => !!perf && (anim.looks.pop.on || anim.looks.strobe.on || anim.looks.trace.on);

// How the looks read this frame. Gathered in one place so render() reads a plain
// description of what to draw rather than recomputing envelopes inline, and so
// that with no performance running every value here is the identity.
function lookNow(now) {
  const L = anim.looks;
  const beat = beatMs(anim.bpm);
  const since = (name) => now - (perf?.firedAt[name] ?? -Infinity);
  const live = (name) => !!perf && L[name].on;
  return {
    shift: live('cycle') ? fireCount(perf.beat, L.cycle.div) - 1 : 0,
    ripple: live('cycle') && L.cycle.ripple,
    pop: live('pop') ? popScale(since('pop'), beat, POP) : 1,
    strobe: live('strobe') && strobing(since('strobe'), beat),
    shown: live('reveal')
      ? revealed(fireCount(perf.beat, L.reveal.div), state.lines.length)
      : state.lines.length,
  };
}

function render() {
  frame = 0;
  const now = performance.now();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const look = lookNow(now);

  // Ripple staggers the colour change by where a shape sits, so the cycle
  // travels across the drawing rather than landing everywhere at once. Reading
  // order rather than face order because face order is an artefact of how the
  // geometry was walked and would look arbitrary.
  const rip = new Map();
  if (look.ripple) {
    getFaces()
      .filter((f) => state.fills[f.key] !== undefined)
      .map((f) => [f, centroid(f.pts)])
      .sort((a, b) => a[1][1] - b[1][1] || a[1][0] - b[1][0])
      .forEach(([f], i) => rip.set(f.key, i));
  }
  const tint = (c, key) => colorOf(shiftColor(c, look.shift + (rip.get(key) || 0), INK));

  // The strobe knocks the fills out to paper for a sliver of the beat, leaving
  // the lines, so the drawing reads as a wireframe of itself for an instant.
  if (!look.strobe) {
    const popping = perf && anim.looks.pop.on && look.pop !== 1;
    for (const f of getFaces()) {
      const c = state.fills[f.key];
      if (c === undefined) continue;
      // A pocket waits for every line that bounds it, or it would colour itself
      // in across a gap the reveal hasn't drawn yet.
      if (!faceReady(f, look.shown)) continue;
      const pts = popping && chosenFor(f.key) ? scaleAbout(f.pts, look.pop) : f.pts;
      ctx.fillStyle = tint(c, f.key);
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [px, py] = toPx(x, y);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
    }
  }

  // Dots off is just a quieter sheet — the grid still snaps, it's only hidden.
  if (state.dots) {
    ctx.fillStyle = theme.dot;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        ctx.beginPath();
        ctx.arc(ox + i * CM, oy + j * CM, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // One path per color rather than one per line: a drawing only ever has seven
  // of them, so this stays a handful of strokes however many lines there are.
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const byColor = new Map();
  state.lines.forEach((l, id) => {
    if (id >= look.shown) return;   // the reveal hasn't got to this one yet
    const c = state.lineColors[id] ?? INK;
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(l);
  });
  for (const [c, group] of byColor) {
    ctx.strokeStyle = tint(c);
    ctx.beginPath();
    for (const [ax, ay, bx, by] of group) {
      ctx.moveTo(...toPx(ax, ay));
      ctx.lineTo(...toPx(bx, by));
    }
    ctx.stroke();
  }

  // Painted nodes sit on top of the lines that meet them, so a junction reads
  // as one dot rather than as whatever crosses it last.
  //
  // The key is always where the paint is *now*: moveNodes carries a node's
  // colour along with it (invariant 5), so during a performance nodeColors has
  // already been remapped to this beat's positions. This used to go through
  // perf.at, which maps resting positions to current ones — a lookup that was
  // redundant for a node that hadn't moved and wrong for one that had landed on
  // a point another mover had just vacated, since that key is in the map and
  // answers with somebody else's destination.
  for (const [at, c] of Object.entries(state.nodeColors)) {
    const here = at.split(',').map(Number);
    const [px, py] = toPx(here[0], here[1]);
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = tint(c);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.ink;
    ctx.stroke();
  }

  if (perf && anim.looks.trace.on) drawTracers(now);
  // Routes show while you're laying them and nowhere else — not once the clock
  // is running, even though laying one and pressing play without leaving Path
  // mode is the obvious way to use this. They are scaffolding for the
  // animation, and scaffolding in the frame is scaffolding in the reel.
  if (state.mode === 'path' && !perf) drawPaths();

  // In move mode the nodes you can actually grab need to be visible.
  if (state.mode === 'move') {
    for (const k of occupiedNodes()) {
      const [gx, gy] = k.split(',').map(Number);
      const [x, y] = toPx(gx, gy);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = theme.paper;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.ink;
      ctx.stroke();
    }
    if (drag) ring(drag.at, '#c0392b', true);
  }

  // Who you've picked to dance, in that layer's colour.
  if (perf && perf.chosen.size) {
    if (perf.move === 'shape') {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#1f8a80';
      for (const f of getFaces()) {
        if (!perf.chosen.has(f.key)) continue;
        ctx.beginPath();
        f.pts.forEach(([x, y], i) => {
          const [px, py] = toPx(x, y);
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    } else {
      for (const k of perf.chosen) {
        const at = perf.at.get(k);
        if (at) ring(at, '#7a4fbf', true);
      }
    }
  }

  if (state.chain) {
    const first = state.chain[0], last = state.chain.at(-1);
    if (hover && !same(hover, last)) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = theme.ink + '66';
      ctx.beginPath();
      ctx.moveTo(...toPx(...last));
      ctx.lineTo(...toPx(...hover));
      ctx.stroke();
      ctx.restore();
    }
    ring(last, theme.ink, true);
    if (state.chain.length >= 3) ring(first, theme.ink, false);
  }

  // A look with an envelope keeps the loop turning; the rest of the app goes
  // back to drawing once per change.
  if (continuous()) draw();
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

// Pop respects the same picking the movement layers do: with nothing chosen
// every filled pocket pulses, and once you've tapped some, only those.
function chosenFor(key) {
  return !perf || !perf.chosen.size || perf.move !== 'shape' ? true : perf.chosen.has(key);
}

function ring([gx, gy], color, filled) {
  const [x, y] = toPx(gx, gy);
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  if (filled) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
}

// --- tracers ---------------------------------------------------------------
//
// A glowing point running the drawing. Its position is fractional, and because
// it is never stored it never has to survive codec.js — which is why this is
// smooth while everything that IS stored stays snapped to the grid.

function drawTracers(now) {
  const cfg = anim.looks.trace;
  const adj = adjacency(state.lines);
  const dt = Math.min(120, now - (perf.tracedAt || now));   // a backgrounded tab must not teleport them
  perf.tracedAt = now;
  const steps = dt / (beatMs(anim.bpm) * cfg.div);

  while (perf.tracers.length > cfg.n) perf.tracers.pop();
  while (perf.tracers.length < cfg.n) {
    const t = spawnTracer(adj);
    if (!t) break;
    perf.tracers.push(t);
  }

  const color = colorOf(state.color);
  for (const t of perf.tracers) {
    // The ground can go: a line undone, or a movement layer pulling the node
    // out from under it. Restart somewhere real rather than gliding into space.
    if (!t.route && !onGraph(t, adj)) {
      const fresh = spawnTracer(adj);
      if (!fresh) continue;
      Object.assign(t, fresh);
    }
    Object.assign(t, t.route ? alongRoute(t, steps) : advance(t, steps, adj));
    const at = positionOf(t);
    t.trail.push(at);
    if (t.trail.length > 22) t.trail.shift();

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    for (let i = 1; i < t.trail.length; i++) {
      const k = i / t.trail.length;
      ctx.globalAlpha = k * 0.5;
      ctx.lineWidth = 1 + 3 * k;
      ctx.beginPath();
      ctx.moveTo(...toPx(...t.trail[i - 1]));
      ctx.lineTo(...toPx(...t.trail[i]));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 14;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(...toPx(...at), 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fill();   // twice, because one pass of shadow on white is barely a glow
    ctx.restore();
  }
}

// Follow mode puts tracers on the authored routes instead of letting them roam,
// so the same drawing gesture feeds both the walking node and the light that
// runs ahead of it. A route tracer carries the route it is on rather than
// looking its next edge up in the graph — a route may cross bare grid the lines
// never reach, and a tracer that fell back to the graph at the first junction
// would abandon the route it was asked to run.
function spawnTracer(adj) {
  const cfg = anim.looks.trace;
  const routes = Object.values(state.paths).filter((r) => r.pts.length >= 2);
  if (cfg.follow && routes.length) {
    const route = routes[Math.floor(Math.random() * routes.length)];
    const [from, to] = segmentAt(route, 0, 1);
    return { route, i: 0, dir: 1, from, to, t: 0, trail: [] };
  }
  const t = spawn(adj);
  return t && { ...t, trail: [] };
}

// The same walk the node itself takes — closed routes loop, open ones ping-pong
// — so the light and the walker trace the same figure.
function alongRoute(t, steps) {
  let { i, dir, t: at } = t;
  at += steps;
  let guard = 64;
  while (at >= 1 && guard--) {
    at -= 1;
    [i, dir] = step(i, dir, t.route.pts.length, t.route.closed);
  }
  const [from, to] = segmentAt(t.route, i, dir);
  return { i, dir, from, to, t: Math.min(at, 1) };
}

// --- routes ----------------------------------------------------------------

function drawPaths() {
  const all = [...Object.values(state.paths), ...(draft ? [draft] : [])];
  if (!all.length) return;
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const accent = getComputedStyle(document.body).getPropertyValue('--path').trim() || '#b8562f';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;

  for (const p of all) {
    if (p.pts.length < 2) {
      // A route with only its anchor: mark the node so a half-laid path is
      // visible rather than being a gesture with nothing on screen.
      ctx.setLineDash([]);
      ring(p.pts[0], accent, false);
      ctx.setLineDash([5, 5]);
      continue;
    }
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => {
      const [px, py] = toPx(x, y);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    if (p.closed) ctx.closePath();
    ctx.stroke();

    ctx.save();
    ctx.setLineDash([]);
    for (const [x, y] of p.pts.slice(1)) {
      ctx.beginPath();
      ctx.arc(...toPx(x, y), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // The anchor is the node that walks, so it gets a ring rather than a dot.
    ring(p.pts[0], accent, true);
    ctx.restore();
  }
  ctx.restore();
}

function resize() {
  readTheme();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cols = Math.max(1, Math.floor((w - 2 * MARGIN) / CM) + 1);
  rows = Math.max(1, Math.floor((h - 2 * MARGIN) / CM) + 1);
  ox = (w - (cols - 1) * CM) / 2;
  oy = (h - (rows - 1) * CM) / 2;
  draw();
}

// --- interaction -----------------------------------------------------------

// Tapping during a performance picks who moves. An empty set means the slider is
// in charge; once anything is picked, only those move and the slider steps aside.
// The node you tap is the one under your finger *now*, which during a point
// dance is not where it rests — perf.at is what maps the two.
function pickDancer(gx, gy) {
  const toggle = (k) => (perf.chosen.has(k) ? perf.chosen.delete(k) : perf.chosen.add(k));

  if (perf.move === 'shape') {
    const f = faceAt(getFaces(), gx, gy);
    if (!f || state.fills[f.key] === undefined) return;
    toggle(f.key);
  } else if (perf.move === 'point') {
    const n = nearestNode(gx, gy);
    if (!n) return;
    const hit = [...perf.at].find(([, [x, y]]) => x === n[0] && y === n[1]);
    if (!hit) return;
    toggle(hit[0]);
  } else {
    return;   // routes are chosen by drawing them, and the looks move everything
  }
  danceBar.classList.toggle('picking', perf.chosen.size > 0);
  draw();
}

function tap(px, py) {
  const [gx, gy] = toGrid(px, py);

  if (perf) return pickDancer(gx, gy);
  if (state.mode === 'move') return;   // move mode works by dragging, not tapping
  if (state.mode === 'fill') return paint(gx, gy);
  if (state.mode === 'path') return layPath(gx, gy);

  const n = nearestNode(gx, gy);
  if (!n) return;

  if (!state.chain) { state.chain = [n]; return draw(); }

  const first = state.chain[0], last = state.chain.at(-1);
  if (same(n, last)) { state.chain = null; return draw(); }          // finish (or cancel, if nothing drawn)
  if (state.chain.length >= 3 && same(n, first)) {                   // close the loop and finish
    addLine(last, first);
    state.chain = null;
  } else {
    addLine(last, n);
    state.chain.push(n);
  }
  save();
  draw();
}

// Laying a route reuses the rules Draw already taught, verbatim: tap the point
// you're standing on to finish, tap the first one to close the loop. The only
// new thing is where you start — on a node with lines on it, because a route
// moves a node and a route anchored to bare grid would move nothing.
//
// Starting on a node that already has a route picks that route up for editing,
// so tapping an anchor twice (start, then finish with nothing added) is how a
// route is deleted. Same gesture as cancelling a chain.
function layPath(gx, gy) {
  const n = nearestNode(gx, gy);
  if (!n) return;

  if (!draft) {
    if (!occupiedNodes().has(nodeKey(n))) return toast('Start a route on a node with lines on it.');
    const existing = state.paths[nodeKey(n)];
    snapshot();
    if (existing) {
      delete state.paths[nodeKey(n)];
      draft = { pts: [...existing.pts], closed: false };
    } else {
      draft = { pts: [n], closed: false };
    }
    return draw();
  }

  const first = draft.pts[0], last = draft.pts.at(-1);
  if (same(n, last)) return finishPath();
  if (draft.pts.length >= 3 && same(n, first)) {
    draft.closed = true;
    return finishPath();
  }
  draft.pts.push(n);
  draw();
}

function finishPath() {
  if (draft.pts.length >= 2) state.paths[nodeKey(draft.pts[0])] = draft;
  else undoStack.pop();          // picked up and put straight back down; not a step
  draft = null;
  save();
  draw();
}

// Fill grew into paint: one mode that puts the selected color on whatever you
// tapped. A node beats a line beats a pocket, because a node is the smallest
// target and sits on top of the other two — tapping a corner should never fill
// the region behind it. Tapping the same thing in the same color takes the
// color off again, which is the rule fills already had.
function paint(gx, gy) {
  const at = nearestNode(gx, gy);
  const key = at && `${at[0]},${at[1]}`;
  const paintNode = () => {
    snapshot();
    if (state.nodeColors[key] === state.color) delete state.nodeColors[key];
    else state.nodeColors[key] = state.color;
    return done();
  };

  if (key && occupiedNodes().has(key)) return paintNode();

  const id = lineAt(state.lines.map((l, i) => ({ id: i, a: [l[0], l[1]], b: [l[2], l[3]] })),
                    gx, gy, TAP_LINE);
  if (id !== null) {
    snapshot();
    // Ink is a line's natural color, so painting one ink is the same as saying
    // it has none — stored as absence rather than as an entry that means "plain".
    if (state.color === INK || state.lineColors[id] === state.color) delete state.lineColors[id];
    else state.lineColors[id] = state.color;
    return done();
  }

  const f = faceAt(getFaces(), gx, gy);
  if (f) {
    snapshot();
    if (state.fills[f.key] === state.color) delete state.fills[f.key];
    else state.fills[f.key] = state.color;
    return done();
  }

  // A bare grid point with no line on it comes last, not first. The tap radius
  // covers about two thirds of every cell, and pockets are full of dots, so
  // letting any dot win would leave almost nowhere to tap that fills a pocket.
  // Last means a bare dot is painted exactly where nothing else claims the tap,
  // which is what "unattached" means anyway. The cost: a bare dot inside a
  // pocket can't be painted while the pocket is there.
  if (key) return paintNode();
}

function done() {
  save();
  draw();
}

function addLine(a, b) {
  snapshot();
  const id = state.lines.push([a[0], a[1], b[0], b[1]]) - 1;
  // A line drawn while a color is selected is born that color. Ink is the
  // startup selection, so a drawing made without touching the swatches comes
  // out exactly as it always did.
  if (state.color !== INK) state.lineColors[id] = state.color;
  facesStale = true;
}

let down = null;
const local = (e) => {
  const r = canvas.getBoundingClientRect();
  return toGrid(e.clientX - r.left, e.clientY - r.top);
};

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: Date.now() };
  // A tap during a performance picks dancers; a drag would only be thrown away
  // by the snap back, so nothing past here runs while one is playing.
  if (perf || state.mode !== 'move') return;
  const n = nearestNode(...local(e));
  if (!n || !occupiedNodes().has(`${n[0]},${n[1]}`)) return;
  snapshot();
  drag = { at: n, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch {}   // capture is a nicety, not a requirement
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const n = nearestNode(...local(e));
    if (n && moveNode(drag.at, n)) { drag.at = n; drag.moved = true; draw(); }
    return;
  }
  if (e.pointerType !== 'mouse' || !(state.chain || draft)) return;
  const n = nearestNode(...local(e));
  const changed = !!n !== !!hover || (n && hover && !same(n, hover));
  hover = n;
  if (changed) draw();
});

canvas.addEventListener('pointerup', (e) => {
  if (drag) {
    if (!drag.moved) undoStack.pop();   // a grab that went nowhere is not a step
    else save();
    drag = null;
    down = null;
    return draw();
  }
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const held = Date.now() - down.t;
  down = null;
  if (moved > 10 || held > 500) return;   // a drag or a long press is not a tap
  const r = canvas.getBoundingClientRect();
  tap(e.clientX - r.left, e.clientY - r.top);
});

canvas.addEventListener('pointercancel', () => {
  if (drag) { undo(); drag = null; }
  down = null;
});

// --- persistence -----------------------------------------------------------

const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Never write a performed frame. While one runs, state.lines holds a
    // displaced drawing that the snap-back is about to throw away, so writing it
    // would leave disk disagreeing with the screen and hand back the wobble on
    // the next load. The resting copy is what the user actually drew.
    const l = perf ? JSON.parse(perf.resting) : state.lines;
    const nc = perf ? JSON.parse(perf.restingPaint) : state.nodeColors;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        l, f: state.fills, d: state.dots, p: state.palette,
        lc: state.lineColors, nc, pa: state.paths, a: anim,
      }));
    } catch {}
  }, 250);
}

function fromLocal() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(j?.l) ? j : null;
  } catch { return null; }
}

function load() {
  // A shared link wins over whatever was left in this browser — but a broken
  // link must say so and hand the sheet back, not blank it in silence.
  let src = null;
  const hash = location.hash.slice(1);
  if (hash) {
    try {
      src = decode(hash);
    } catch {
      try {
        src = decodeLegacy(hash);
      } catch {
        toast('That link is incomplete — it was probably cut short when shared.');
      }
    }
  }
  const local = fromLocal();
  // How the drawing is animated is a local preference like the dots and the
  // tempo before it: a link carries a drawing, not a way of playing it.
  if (local?.a) adoptAnim(local.a);
  src ||= local;
  if (!src) return;
  state.lines = src.l;
  state.fills = src.f || {};
  state.lineColors = src.lc || {};
  state.nodeColors = src.nc || {};
  state.paths = src.pa || {};
  state.dots = src.d !== false;   // a shared link carries no preference; dots stay on
  // A link written before palettes existed, or one on the stock colors, carries
  // no palette section — those drawings are meant to arrive in the defaults.
  if (Array.isArray(src.p) && src.p.length === PALETTE.length) state.palette = src.p;
  facesStale = true;
}

// A stored config is merged field by field rather than assigned wholesale, so a
// config written before a look existed simply keeps that look's defaults instead
// of arriving with it missing.
function adoptAnim(saved) {
  if (typeof saved !== 'object' || !saved) return;
  if (saved.bpm >= MIN_BPM && saved.bpm <= MAX_BPM) anim.bpm = clampBpm(saved.bpm);
  for (const k of ['countIn', 'drop']) if (typeof saved[k] === 'boolean') anim[k] = saved[k];
  if (MOVES.includes(saved.move)) anim.move = saved.move;
  if (DIVS.includes(saved.moveDiv)) anim.moveDiv = saved.moveDiv;
  if (saved.leash >= 1 && saved.leash <= 4) anim.leash = saved.leash;
  if (saved.counts) for (const k of Object.keys(anim.counts)) {
    if (Number.isInteger(saved.counts[k])) anim.counts[k] = saved.counts[k];
  }
  for (const [name, cfg] of Object.entries(anim.looks)) {
    const s = saved.looks?.[name];
    if (!s) continue;
    if (typeof s.on === 'boolean') cfg.on = s.on;
    if (DIVS.includes(s.div)) cfg.div = s.div;
    if (typeof s.ripple === 'boolean') cfg.ripple = s.ripple;
    if (typeof s.follow === 'boolean') cfg.follow = s.follow;
    if (Number.isInteger(s.n) && s.n >= 1 && s.n <= 5) cfg.n = s.n;
  }
}

// --- toolbar ---------------------------------------------------------------

const swatches = document.getElementById('swatches');
const palettePanel = document.getElementById('palette');
const pcells = document.getElementById('pcells');
const editBtn = document.getElementById('editpalette');

function paintSwatches() {
  for (const el of swatches.children) {
    const c = +el.dataset.color;
    el.style.background = colorOf(c);
    el.setAttribute('aria-pressed', String(c === state.color));
  }
  [...pcells.children].forEach((el, j) => { el.value = state.palette[j]; });
}

// A swatch only ever picks a color. Editing used to be a second tap on the
// selected one, which was tidy and undiscoverable — the first person to use it
// asked where the palette was. It lives behind its own button now.
// Ink leads the row: it's the startup selection, it's what a line already is,
// and picking it is how you paint one back to plain.
[INK, ...PALETTE.keys()].forEach((i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = i;
  const name = i === INK ? 'Ink' : `Color ${i + 1}`;
  b.setAttribute('aria-label', name);
  b.title = name;
  b.onclick = () => { state.color = i; paintSwatches(); draw(); };
  swatches.append(b);
  if (i === INK) return;   // ink isn't one of the six the palette panel edits

  // One color input per slot: every browser ships one, so a cell is a single
  // tap into a picker the user already knows, and all six are on screen at once
  // rather than one at a time behind a gesture.
  const cell = document.createElement('input');
  cell.type = 'color';
  cell.className = 'pcell';
  cell.setAttribute('aria-label', `Color ${i + 1}`);
  cell.oninput = () => {
    state.palette[i] = cell.value;
    paintSwatches();
    save();
    draw();
  };
  pcells.append(cell);
});

function showPalette(on) {
  palettePanel.hidden = !on;
  editBtn.setAttribute('aria-pressed', String(on));
  danceBar.classList.toggle('stepped', on);
}
editBtn.onclick = () => showPalette(palettePanel.hidden);

document.getElementById('palettereset').onclick = () => {
  state.palette = [...PALETTE];
  paintSwatches();
  save();
  draw();
};

const modeBtn = document.getElementById('mode');
modeBtn.onclick = () => {
  stopPerf();
  state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
  modeBtn.dataset.mode = state.mode;
  modeBtn.textContent = MODE_LABEL[state.mode];
  state.chain = null;
  if (draft) finishPath();
  hover = null;
  drag = null;
  draw();
};

const dotsBtn = document.getElementById('dots');
function paintDotsBtn() {
  dotsBtn.setAttribute('aria-pressed', String(state.dots));
  dotsBtn.title = state.dots ? 'Hide the dot grid' : 'Show the dot grid';
}
// Fine to toggle mid-performance: it changes what's painted, never the drawing,
// and save() knows to write the resting copy rather than the frame on screen.
dotsBtn.onclick = () => {
  state.dots = !state.dots;
  paintDotsBtn();
  save();
  draw();
};

function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  const { l, f, lc, nc, pa } = JSON.parse(prev);
  state.lines = l;
  state.fills = f;
  state.lineColors = lc || {};
  state.nodeColors = nc || {};
  state.paths = pa || {};
  state.chain = null;
  draft = null;
  facesStale = true;
  save();
  draw();
}

document.getElementById('undo').onclick = () => { stopPerf(); undo(); };

// --- the clock -------------------------------------------------------------
//
// One clock, many layers. Everything that animates subscribes to the same beat
// and says how often it wants one, which is the difference between a drawing
// that twitches and one that looks arranged: the colour can turn over on the
// bar while the shapes drift on the beat.
//
// Layers come in two kinds, and the split is what makes stacking safe:
//
//   movement  mutates state.lines, so exactly one may run. They all own every
//             node, and two of them would each be restoring over the other.
//             Snapshot on start, restore on stop.
//   looks     change how the drawing is *drawn* and never touch state, so any
//             number can run at once, over any movement layer, with nothing to
//             restore and nothing that can reach disk.

const MOVES = ['none', 'point', 'shape', 'path'];
const MOVE_LABEL = { point: 'Dancers', shape: 'Movers' };
const MOVE_MAX = { point: 12, shape: 6 };

const danceBar = document.getElementById('dancebar');
const count = document.getElementById('count');
const countGroup = document.getElementById('countgroup');
const countLabel = document.getElementById('countlabel');
const countOut = document.getElementById('countout');
const bpmOut = document.getElementById('bpmout');
const dBpmOut = document.getElementById('dbpmout');
const beatDot = document.getElementById('beatdot');
const countdown = document.getElementById('countdown');
const playBtn = document.getElementById('play');

// The point layer picks loose nodes and nudges them, pulling the lines out of
// shape. It re-derives from the resting drawing every beat, which is what keeps
// a random walk from carrying the drawing away.
function pointTick() {
  state.lines = JSON.parse(perf.resting);
  state.nodeColors = JSON.parse(perf.restingPaint);
  const nodes = [...occupiedNodes()].map((k) => k.split(',').map(Number));
  const only = perf.chosen.size ? perf.chosen : null;
  const moves = pickMoves(nodes, only ? only.size : anim.counts.point, cols, rows, Math.random, only);

  // Where each resting node ended up this beat. A tap has to select the node it
  // landed on, not whatever happens to rest under the finger, and the highlight
  // has to follow the node rather than stay behind at its resting place.
  perf.at = new Map(nodes.map(([x, y]) => [`${x},${y}`, [x, y]]));
  for (const [from, to] of moves) {
    moveNode(from, to);
    perf.at.set(`${from[0]},${from[1]}`, to);
  }
  facesStale = true;
}

// The shape layer moves a whole filled pocket at a time, so the shape holds its
// form and the web around it gives. It can't re-derive from rest each beat: that
// would mean re-applying every shape's offset every time, so the cost would
// track how many shapes exist rather than how many are moving, and the count
// slider would buy nothing — measured, 95 ms a beat at 32 filled pockets against
// a 350 ms budget, versus 8 ms when only two shapes move. Instead each shape
// carries an offset that never leaves the leash, so it stays near home by
// construction, and stopping restores the resting drawing outright.
function shapeTick() {
  const all = shapes();
  const picked = perf.chosen.size ? all.map((s) => s.key).filter((k) => perf.chosen.has(k)) : null;
  const moving = new Set(picked ?? pickDancers(all.map((s) => s.key), anim.counts.shape));
  for (const s of all) {
    if (!moving.has(s.key)) continue;
    const from = perf.offsets.get(s.key) || [0, 0];
    const to = wander(from, anim.leash);
    const step = [to[0] - from[0], to[1] - from[1]];
    if ((step[0] || step[1]) && moveShape(s.key, step)) perf.offsets.set(s.key, to);
  }
}

// Authored routes: every walker takes one hop along its own. A hop that would
// weld two nodes together, or leave the sheet, is refused and the walker stalls
// where it is until the next beat — which on a four-to-the-floor reads as a held
// note rather than as a fault.
function pathTick() {
  const occupied = occupiedNodes();
  for (const w of perf.walkers) {
    const m = nextMove(w);
    if (!m) continue;
    const deltas = new Map([[nodeKey(m.from), m.to]]);
    if (wouldWeld(deltas, occupied)) continue;
    if (m.to[0] < 0 || m.to[1] < 0 || m.to[0] >= cols || m.to[1] >= rows) continue;
    if (moveNodes(deltas)) m.commit();
  }
  perf.at = new Map([...occupiedNodes()].map((k) => [k, k.split(',').map(Number)]));
}

const MOVE_TICK = { point: pointTick, shape: shapeTick, path: pathTick };

// One beat. Movement first so the looks read a settled drawing, then every look
// whose division comes up records that it fired — the envelopes in looks.js are
// all functions of how long ago that was.
function runBeat() {
  const b = perf.beat;
  if (b >= 0) {
    if (anim.move !== 'none' && fires(b, anim.moveDiv)) MOVE_TICK[anim.move]();
    const now = performance.now();
    for (const [name, cfg] of Object.entries(anim.looks)) {
      if (cfg.on && fires(b, cfg.div)) perf.firedAt[name] = now;
    }
  }
  flashBeat();
  draw();
}

// Each beat books the next one rather than running on a fixed interval, so a
// beat that overruns delays the following one instead of stacking up behind
// it — and a tempo change simply lands on the next beat, with nothing to reset.
function schedule() {
  perf.timer = setTimeout(() => {
    if (!perf) return;
    perf.beat++;
    runBeat();
    schedule();
  }, beatMs(anim.bpm));
}

function flashBeat() {
  beatDot.classList.add('lit');
  clearTimeout(perf.litTimer);
  perf.litTimer = setTimeout(() => beatDot.classList.remove('lit'), Math.min(110, beatMs(anim.bpm) / 3));
  // During the count-in nothing on the sheet moves, so the number is the only
  // thing telling you the clock is already turning.
  countdown.textContent = perf.beat < 0 ? String(-perf.beat) : '';
}

function anythingOn() {
  return anim.move !== 'none' || Object.values(anim.looks).some((l) => l.on);
}

function startPerf() {
  if (perf) return;
  if (!state.lines.length) return toast('Draw something first.');
  if (!anythingOn()) return toast('Nothing to play — turn on a movement or a look in ⚙.');
  if (anim.move === 'shape' && !shapes().length) {
    return toast('Shapes moves filled pockets — fill one first.');
  }
  if (anim.move === 'path' && !Object.keys(state.paths).length) {
    return toast('No routes yet — switch to Path mode and draw one.');
  }
  toastEl.classList.remove('show');   // the pill lands where the toast sits
  if (draft) finishPath();

  const occupied = occupiedNodes();
  // A route whose anchor lost its lines, or that ran off a narrower screen, has
  // nothing to move; dropping it here beats moving a node that isn't there.
  const live = Object.fromEntries(
    Object.entries(state.paths).filter(([, p]) => pathValid(p, occupied, cols, rows)));

  perf = {
    move: anim.move,
    resting: JSON.stringify(state.lines),
    restingPaint: JSON.stringify(state.nodeColors),
    beat: anim.countIn ? -4 : 0,
    timer: 0, litTimer: 0, tracedAt: 0,
    offsets: new Map(),
    // `chosen` starts empty, meaning "let the slider decide". Tapping fills it,
    // and stopping and starting again is how you empty it.
    chosen: new Set(), at: new Map(),
    walkers: walkers(live),
    tracers: [],
    firedAt: {},
    ears: { slow: null, fast: null, firedAt: -Infinity },
  };
  state.chain = null;
  drag = null;
  paintPlay();
  danceBar.hidden = false;
  paintPill();
  runBeat();
  if (!ears) schedule();   // while listening, the music books the beats
}

function stopPerf() {
  if (!perf) return;
  clearTimeout(perf.timer);
  clearTimeout(perf.litTimer);
  state.lines = JSON.parse(perf.resting);   // snap back to where it started
  state.nodeColors = JSON.parse(perf.restingPaint);
  perf = null;
  beatDot.classList.remove('lit');
  countdown.textContent = '';
  danceBar.hidden = true;
  danceBar.classList.remove('picking');
  paintPlay();
  facesStale = true;
  draw();
}

function paintPlay() {
  playBtn.setAttribute('aria-pressed', String(!!perf));
  playBtn.innerHTML = perf ? '&#9632;' : '&#9654;';
  playBtn.title = perf ? 'Stop' : 'Start the animation';
  document.body.dataset.move = perf ? perf.move : anim.move;
}

// The pill carries only what gets reached for mid-performance. The count slider
// means a different thing per movement layer and has nothing to say for routes,
// where every walker walks.
function paintPill() {
  const m = perf ? perf.move : anim.move;
  const shows = m === 'point' || m === 'shape';
  countGroup.hidden = !shows;
  if (shows) {
    countLabel.textContent = MOVE_LABEL[m];
    count.max = MOVE_MAX[m];
    count.value = anim.counts[m];
    countOut.textContent = anim.counts[m];
  }
}

playBtn.onclick = () => (perf ? stopPerf() : startPerf());

count.oninput = () => {
  const m = perf ? perf.move : anim.move;
  if (!MOVE_LABEL[m]) return;
  anim.counts[m] = +count.value;
  countOut.textContent = count.value;
  save();
  // The point layer redraws from rest every beat, so showing the new number at
  // once is free. The shape layer would have to step its shapes to show it,
  // which is a move the user didn't ask for; it waits for the next beat.
  if (perf?.move === 'point') { pointTick(); draw(); }
};

// --- tempo -----------------------------------------------------------------

function paintBpm() {
  bpmOut.textContent = anim.bpm;
  dBpmOut.textContent = anim.bpm;
}

function setBpm(v) {
  if (v == null) return;
  anim.bpm = clampBpm(v);
  paintBpm();
  save();
}

const nudge = (d) => () => setBpm(anim.bpm + d);
document.getElementById('bpmdown').onclick = nudge(-1);
document.getElementById('bpmup').onclick = nudge(1);
document.getElementById('dbpmdown').onclick = nudge(-1);
document.getElementById('dbpmup').onclick = nudge(1);

// Halving and doubling land on the tempo you meant far more often than walking
// there one BPM at a time. Out of range they refuse and say so, rather than
// clamping to the end and looking like they did something else.
const scale = (f) => () => {
  const next = scaleBpm(anim.bpm, f);
  if (next === null) return toast(`${anim.bpm} ${f > 1 ? 'doubled' : 'halved'} is outside ${MIN_BPM}–${MAX_BPM} BPM.`);
  setBpm(next);
};
document.getElementById('half').onclick = scale(0.5);
document.getElementById('double').onclick = scale(2);

// Tap four times along with the track. This is the one tempo control that sets
// where beat one *is* as well as how fast they come: the last tap restarts the
// clock, so the drawing lands on the downbeat you tapped rather than wherever
// the previous beat happened to leave it.
let taps = [];
function tapped() {
  const now = performance.now();
  if (taps.length && now - taps.at(-1) > 2000) taps = [];
  taps.push(now);
  if (taps.length > 8) taps.shift();
  const found = tapTempo(taps);
  if (found) setBpm(found);
  if (perf) {
    clearTimeout(perf.timer);
    perf.beat = 0;
    runBeat();
    if (!ears) schedule();
  }
  if (!found) toast('Keep tapping — two taps in time is the least it can read.');
}
document.getElementById('taptempo').onclick = tapped;
document.getElementById('dtap').onclick = tapped;

// --- the drawer ------------------------------------------------------------

const drawer = document.getElementById('drawer');
const animBtn = document.getElementById('animate');

function showDrawer(on) {
  drawer.hidden = !on;
  animBtn.setAttribute('aria-pressed', String(on));
  if (on) showPalette(false);
}
animBtn.onclick = () => showDrawer(drawer.hidden);
document.getElementById('drawerclose').onclick = () => showDrawer(false);

// Divisions read as musical time rather than as numbers: "every bar" is what a
// four is, and a menu that says four makes you do the arithmetic yourself.
const DIV_LABEL = { 1: 'every beat', 2: 'every 2', 4: 'every bar', 8: 'every 2 bars', 16: 'every 4 bars' };
function divSelect(value, onchange) {
  const sel = document.createElement('select');
  for (const d of DIVS) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = DIV_LABEL[d];
    sel.append(o);
  }
  sel.value = value;
  sel.onchange = () => onchange(+sel.value);
  return sel;
}

const moveSeg = document.getElementById('movement');
const moveOpts = document.getElementById('moveopts');
const leashGroup = document.getElementById('leashgroup');
const leash = document.getElementById('leash');
const leashOut = document.getElementById('leashout');
const moveDivSel = divSelect(anim.moveDiv, (v) => { anim.moveDiv = v; save(); });
moveDivSel.id = 'movediv';
document.getElementById('movediv').replaceWith(moveDivSel);

function paintMovement() {
  for (const b of moveSeg.children) b.setAttribute('aria-pressed', String(b.dataset.move === anim.move));
  moveOpts.hidden = anim.move === 'none';
  leashGroup.hidden = anim.move !== 'shape';
  moveDivSel.value = anim.moveDiv;
  leash.value = anim.leash;
  leashOut.textContent = anim.leash;
  paintPill();
  paintPlay();
}

moveSeg.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  anim.move = b.dataset.move;
  // Movement layers own every node, so switching is a restart rather than a
  // handover — the running one has to put the drawing back before the next
  // takes a snapshot of it.
  if (perf) { stopPerf(); startPerf(); }
  paintMovement();
  save();
};

leash.oninput = () => {
  anim.leash = +leash.value;
  leashOut.textContent = leash.value;
  save();
};

// One row per look, built from the table rather than from markup, so the next
// look to be added is an entry in `anim.looks` plus a line here.
const LOOK_META = {
  cycle:  { label: '&#9673; Colour cycle', hint: 'Walk every fill and line through the palette' },
  pop:    { label: '&#9670; Shape pop', hint: 'Filled pockets pulse on the beat' },
  strobe: { label: '&#9728; Strobe', hint: 'Fills blink out, leaving the wireframe' },
  trace:  { label: '&#10022; Path trace', hint: 'A glowing point runs the lines' },
  reveal: { label: '&#9608; Build on', hint: 'Lines appear one at a time' },
};

const looksBox = document.getElementById('looks');
// Every control that shows a value registers how to put that value back, so
// loading a preset repaints the whole panel rather than the toggles alone —
// half a repainted panel is a panel that lies about what is running.
const repaint = [];

for (const [name, cfg] of Object.entries(anim.looks)) {
  const row = document.createElement('div');
  row.className = 'look';

  const toggle = document.createElement('button');
  toggle.innerHTML = LOOK_META[name].label;
  toggle.title = LOOK_META[name].hint;
  toggle.onclick = () => {
    cfg.on = !cfg.on;
    toggle.setAttribute('aria-pressed', String(cfg.on));
    save();
    // Turning a look on mid-performance should show immediately rather than
    // waiting for its division to come round.
    if (perf) { perf.firedAt[name] = performance.now(); draw(); }
  };
  repaint.push(() => toggle.setAttribute('aria-pressed', String(cfg.on)));

  const div = divSelect(cfg.div, (v) => { cfg.div = v; save(); });
  repaint.push(() => { div.value = cfg.div; });
  row.append(toggle, div);

  // Per-look extras. Kept beside the toggle rather than in a submenu: there are
  // at most two, and a menu to reach one checkbox is a worse trade than the
  // width it saves.
  if (name === 'cycle') {
    const rip = document.createElement('button');
    rip.className = 'step wide';
    rip.textContent = 'Ripple';
    rip.title = 'Stagger the change across the drawing instead of all at once';
    rip.onclick = () => {
      cfg.ripple = !cfg.ripple;
      rip.setAttribute('aria-pressed', String(cfg.ripple));
      save();
      draw();
    };
    repaint.push(() => rip.setAttribute('aria-pressed', String(cfg.ripple)));
    row.append(rip);
  }
  if (name === 'trace') {
    const n = document.createElement('input');
    n.type = 'range'; n.min = 1; n.max = 5; n.value = cfg.n;
    n.style.width = '54px';
    n.title = 'How many points are running';
    const out = document.createElement('output');
    out.textContent = cfg.n;
    n.oninput = () => { cfg.n = +n.value; out.textContent = n.value; save(); };
    const follow = document.createElement('button');
    follow.className = 'step wide';
    follow.textContent = 'Routes';
    follow.title = 'Run the drawn routes instead of roaming the lines';
    follow.onclick = () => {
      cfg.follow = !cfg.follow;
      follow.setAttribute('aria-pressed', String(cfg.follow));
      if (perf) perf.tracers = [];   // re-spawn onto whichever track it is now
      save();
    };
    repaint.push(() => {
      follow.setAttribute('aria-pressed', String(cfg.follow));
      n.value = cfg.n;
      out.textContent = cfg.n;
    });
    row.append(n, out, follow);
  }
  row.dataset.look = name;
  looksBox.append(row);
}

const paintLooks = () => repaint.forEach((f) => f());

const countIn = document.getElementById('countin');
countIn.onchange = () => { anim.countIn = countIn.checked; save(); };
const dropFx = document.getElementById('dropfx');
dropFx.onchange = () => { anim.drop = dropFx.checked; save(); };

function paintDrawer() {
  paintMovement();
  paintLooks();
  paintBpm();
  countIn.checked = anim.countIn;
  dropFx.checked = anim.drop;
}

// --- presets ---------------------------------------------------------------
//
// A whole configuration under one button, because rebuilding a look on a phone
// while a track is playing is not something anyone does twice. Saving is armed
// first and then aimed, like Clear: a slot is overwritten for good, and a
// mis-aimed thumb should not be able to do that in one tap.

const slotBox = document.getElementById('slots');
const saveSlot = document.getElementById('saveslot');
let arming = false;

const readSlots = () => { try { return JSON.parse(localStorage.getItem(SLOTS)) || {}; } catch { return {}; } };

function paintSlots() {
  const slots = readSlots();
  for (const b of slotBox.querySelectorAll('[data-slot]')) {
    b.classList.toggle('filled', !!slots[b.dataset.slot]);
  }
  saveSlot.textContent = arming ? 'Pick one' : 'Save';
  saveSlot.classList.toggle('armed', arming);
}

saveSlot.onclick = () => { arming = !arming; paintSlots(); };

slotBox.onclick = (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b) return;
  const slots = readSlots();
  if (arming) {
    slots[b.dataset.slot] = JSON.parse(JSON.stringify(anim));
    try { localStorage.setItem(SLOTS, JSON.stringify(slots)); } catch {}
    arming = false;
    paintSlots();
    return toast(`Saved to ${b.textContent}.`);
  }
  if (!slots[b.dataset.slot]) return toast('Nothing in that slot yet — set a look up, then Save.');
  adoptAnim(slots[b.dataset.slot]);
  paintDrawer();
  save();
  if (perf) { stopPerf(); startPerf(); }
};

// --- listening -------------------------------------------------------------

// Experimental. Two readings of "dance to the music", switchable so they can be
// compared against the same track:
//
//   notes — every sounding pitch class displaces the one node it owns, and the
//           node returns when the note stops. A trill between two pitches reads
//           as two nodes flicking at each other, which is the point.
//   beats — a new note fires one ordinary beat of whatever is running.
//           Keeps the existing feel and just takes the clock off the metronome.
//
// listen.js gives twelve pitch-class levels, not notes, so "a note" is a class
// loud enough to count. Coarse on purpose: this isn't transcription.
const listenBtn = document.getElementById('listen');
const hearing = document.getElementById('hearing');
const mapNotesBtn = document.getElementById('mapnotes');
const mapBeatsBtn = document.getElementById('mapbeats');

let ears = null;   // { ctx, stream, listener, frame, on: [pitch classes] }
let mapping = 'notes';

function setMapping(m) {
  mapping = m;
  mapNotesBtn.setAttribute('aria-pressed', String(m === 'notes'));
  mapBeatsBtn.setAttribute('aria-pressed', String(m === 'beats'));
}
mapNotesBtn.onclick = () => setMapping('notes');
mapBeatsBtn.onclick = () => setMapping('beats');

// Every sounding class holds its node out of place for as long as it sounds, so
// the drawing is a picture of what's playing rather than a reaction to it. The
// set of sounding classes changes a handful of times a second while the frames
// come sixty times a second, so redoing the geometry only when that set changes
// keeps computeFaces off all but a few frames.
function notesTick(now) {
  const levels = ears.listener.read(now);
  const on = sounding(levels, ears.on);
  const fired = started(on, ears.on);
  ears.on = on;

  // A drop is the one moment in an EDM track that everything should answer at
  // once, so it fires every look regardless of its division and gives the
  // movement layer an extra beat.
  if (anim.drop) {
    const e = trackEnergy(perf.ears, levels, now * 1000);
    perf.ears = e;
    if (e.dropped) {
      const at = performance.now();
      for (const [name, cfg] of Object.entries(anim.looks)) if (cfg.on) perf.firedAt[name] = at;
      if (anim.move !== 'none') MOVE_TICK[anim.move]();
      flashBeat();
      draw();
    }
  }

  if (mapping === 'beats') {
    if (fired.length) { perf.beat++; runBeat(); }
    return;
  }

  if (anim.move === 'none') return;   // the looks are on the clock; only movement reads notes
  const key = on.join(',');
  if (key === ears.shown) return;
  ears.shown = key;

  state.lines = JSON.parse(perf.resting);
  state.nodeColors = JSON.parse(perf.restingPaint);
  facesStale = true;
  const ordered = inReadingOrder([...occupiedNodes()].map((k) => k.split(',').map(Number)));
  moveNodes(notesToMoves(on, ordered, cols, rows));
  perf.at = new Map(ordered.map((n) => [n.join(','), n]));
  draw();
}

async function startListening() {
  // On an origin the browser doesn't trust, navigator.mediaDevices isn't merely
  // refused, it's absent — so this has to be said before anything asks it for a
  // stream, or the failure reads as "no audio anywhere" when it really means
  // "wrong address". localhost, 127.0.0.1 and [::1] count as trustworthy;
  // [::] and a LAN address do not.
  if (!navigator.mediaDevices) {
    return toast(window.isSecureContext
      ? "This browser can't capture audio."
      : 'Audio capture needs https, or http://localhost — not this address.');
  }

  // A tab carries the music itself; a microphone carries the room. Tab capture
  // is Chrome and Edge on desktop only, so the phone falls back to the mic.
  let stream = null;
  try {
    if (navigator.mediaDevices?.getDisplayMedia) {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        return toast('Shared without audio — pick the tab again and tick "Also share tab audio".');
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  } catch (e) {
    if (e?.name === 'NotAllowedError' && stream === null) return;   // picker dismissed
    return toast("Couldn't hear anything — this needs a tab with audio, or a microphone.");
  }

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  // sefirograph lets a note fall away over 0.18s, which reads as sustain behind
  // a glow. A step is discrete, so here the fall has to be done before the next
  // note lands or a trill just holds both nodes out: measured against an 8
  // notes/sec trill, 0.18 gave 3 changes in four seconds and 0.09 gave 65.
  // Overridden from this side so the vendored file stays a copy, not a fork.
  const heard = { ...CHROMA_CONFIG, releaseTau: 0.09 };
  ears = { ctx: actx, stream, listener: createListener(actx, stream, heard), on: [], shown: '', frame: 0 };
  stream.getAudioTracks()[0].onended = () => stopListening();

  // Listening drives whatever is running, so without anything there is nothing
  // to hear it. Start the point layer rather than doing nothing.
  if (!perf) {
    if (anim.move === 'none' && !Object.values(anim.looks).some((l) => l.on)) {
      anim.move = 'point';
      paintMovement();
    }
    startPerf();
  }
  if (!perf) return stopListening();   // it refused — nothing to draw, most likely

  clearTimeout(perf.timer);            // the music books the beats from here
  listenBtn.classList.add('listening');
  listenBtn.setAttribute('aria-pressed', 'true');
  hearing.hidden = false;
  tempoGroup(false);

  const loop = () => {
    if (!ears) return;
    if (perf) notesTick(ears.ctx.currentTime);
    ears.frame = requestAnimationFrame(loop);
  };
  ears.frame = requestAnimationFrame(loop);
}

function stopListening() {
  if (!ears) return;
  cancelAnimationFrame(ears.frame);
  ears.listener.dispose();
  ears.stream.getTracks().forEach((t) => t.stop());
  ears.ctx.close().catch(() => {});
  ears = null;
  listenBtn.classList.remove('listening');
  listenBtn.setAttribute('aria-pressed', 'false');
  hearing.hidden = true;
  tempoGroup(true);
  if (perf) {
    state.lines = JSON.parse(perf.resting);
    state.nodeColors = JSON.parse(perf.restingPaint);
    facesStale = true;
    schedule();                        // the metronome takes the clock back
    draw();
  }
}

// The tempo controls have nothing to say while the music is the clock.
function tempoGroup(show) {
  for (const el of [bpmOut, document.getElementById('bpmdown'),
                    document.getElementById('bpmup'),
                    document.getElementById('taptempo'),
                    document.querySelector('label[for="bpmout"]')]) {
    el.hidden = !show;
  }
}

listenBtn.onclick = () => (ears ? stopListening() : startListening());

// --- performance mode ------------------------------------------------------
//
// The toolbar is in the screen recording, so there has to be a way to take it
// out. What there must not be is a way out with no way back: an invisible tap
// target to restore the chrome would be the palette gesture all over again, so
// a small chevron stays on screen and says where to press.

const unhide = document.getElementById('unhide');
function setPerform(on) {
  document.body.classList.toggle('perform', on);
  unhide.hidden = !on;
  if (on) { showDrawer(false); showPalette(false); }
}
document.getElementById('perform').onclick = () => setPerform(true);
unhide.onclick = () => setPerform(false);

// --- clear and share -------------------------------------------------------

// Two taps to clear, rather than confirm() — embedded webviews suppress or hang
// on modal dialogs, and a modal is a poor fit for a thumb anyway.
const clearBtn = document.getElementById('clear');
let armedUntil = 0, disarmTimer = 0;

function disarm() {
  clearTimeout(disarmTimer);
  armedUntil = 0;
  clearBtn.innerHTML = '&#10005;';
  clearBtn.classList.remove('armed');
}

clearBtn.onclick = () => {
  stopPerf();
  if (!state.lines.length) return;
  // Ignore a second tap that lands too fast to be a decision — a stray
  // double-tap should not be able to wipe the sheet.
  if (armedUntil && armedUntil - Date.now() > 2750) return;
  if (Date.now() > armedUntil) {
    armedUntil = Date.now() + 3000;
    clearBtn.textContent = 'Sure?';
    clearBtn.classList.add('armed');
    clearTimeout(disarmTimer);
    disarmTimer = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  snapshot();
  state.lines = [];
  state.fills = {};
  state.lineColors = {};
  state.nodeColors = {};
  state.paths = {};
  state.chain = null;
  draft = null;
  facesStale = true;
  history.replaceState(null, '', location.pathname);
  save();
  draw();
};

document.getElementById('share').onclick = async (e) => {
  stopPerf();   // share the drawing, not a random frame of it
  if (!state.lines.length) return;
  // Only fills whose pocket still exists are worth sending.
  const live = new Set(getFaces().map((f) => f.key));
  const f = Object.fromEntries(Object.entries(state.fills).filter(([k]) => live.has(k)));

  const custom = state.palette.some((c, i) => c !== PALETTE[i]);
  // Every painted point travels, attached to a line or not: a dot on its own is
  // something the user put there, not paint left behind by a node that's gone.
  const nc = state.nodeColors;
  try {
    history.replaceState(null, '', '#' + encode({
      l: state.lines, f, p: custom ? state.palette : undefined,
      lc: state.lineColors, nc, pa: state.paths,
    }));
  } catch (err) {
    return toast(err.message);
  }

  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(location.href);
    b.textContent = '✓';
    setTimeout(() => { b.innerHTML = '&#8599;'; }, 1200);
  } catch {
    toast('Clipboard blocked — the link is in the address bar.');
  }
  if (location.href.length > 1800) toast('This link is very long; some apps may cut it short.');
};

// ponytail: stale fill keys are left in state.fills on purpose — undo brings the
// pocket and its color back together. They cost a few bytes and nothing else.

// Console handle for driving the drawing programmatically — the groundwork for
// animation. moveNode is the same call the drag uses:
//   pf.moveNode([3, 5], [4, 6]); pf.redraw();
//   pf.shapes();                             // one entry per filled pocket
//   pf.moveShape(pf.shapes()[0].key, [1, 0]); pf.redraw();
window.pf = {
  state, anim, moveNode, moveNodes, shapes, moveShape,
  redraw: () => { facesStale = true; draw(); },
  faces: getFaces,
  play: startPerf, stop: stopPerf,
};

new ResizeObserver(resize).observe(canvas);
load();
// Everything below paints from state, so it has to run after load() has had its
// say — a drawing arriving with a custom palette needs it on the swatches too,
// not just in the fills, and a stored animation config needs to reach the
// drawer rather than sitting in `anim` with the panel showing defaults.
paintSwatches();
paintDotsBtn();
paintDrawer();
paintSlots();
resize();
