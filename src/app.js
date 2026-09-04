import { computeFaces, faceAt, lineAt } from './planar.js';
import { encode, decode, decodeLegacy, INK } from './codec.js';
import { pickMoves, pickDancers, wander } from './dance.js';
import { shapeNodes, translate, applyMoves, wouldWeld } from './shapes.js';
import { createListener, CHROMA_CONFIG } from './listen.js';
import { sounding, started, inReadingOrder, notesToMoves } from './notes.js';

// px per grid unit. Nominally 1 cm (96 CSS px per inch), but CSS px drift from
// physical size per device — hold a ruler to the screen and tune this.
const CM = 96 / 2.54;
const MARGIN = 0.6 * CM;   // keep dots off the very edge
const SNAP = 0.45;         // tap-to-node radius, in grid units
const PALETTE = ['#e0655c', '#ec9c46', '#e8c84e', '#68b877', '#579fd8', '#a077cc'];
const STORE = 'pocket-filler';

// INK comes from codec.js, which is where it has to be validated. It means "the
// sheet's own line color" and is one past the palette — a real choice rather
// than the absence of one: picking it is how you paint a line or a node back to
// plain, and it's what's selected at startup so a fresh drawing comes out
// exactly as it always did.
if (INK !== PALETTE.length) throw new Error('INK must sit one past the palette');
const TAP_LINE = 0.28;   // how near a line counts as tapping it, in grid units

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
const state = {
  lines: [], fills: {}, mode: 'draw', color: INK, chain: null,
  dots: true, palette: [...PALETTE], lineColors: {}, nodeColors: {},
};
const MODES = ['draw', 'fill', 'move'];
// "Fill" stopped being the truth when it grew to paint lines and nodes as well
// as pockets. The internal name stays, since face keys and saved drawings don't
// care what the button says.
const MODE_LABEL = { draw: 'Draw', fill: 'Paint', move: 'Move' };

const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d');
let cols = 0, rows = 0, ox = 0, oy = 0;   // grid extent and screen origin
let faces = [];
let facesStale = true;
let hover = null;                         // rubber-band target (mouse only)
let drag = null;                          // { at: [x, y] } while a node is being moved
let dance = null;                         // { resting, timer } while dancing

const toGrid = (px, py) => [(px - ox) / CM, (py - oy) / CM];
const toPx = (gx, gy) => [ox + gx * CM, oy + gy * CM];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

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
    facesStale = true;
  }
  return touched;
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
  if (!deltas) return false;                      // would leave the sheet

  // The guard below only notices a move that re-cuts a pocket. Two shapes
  // meeting corner to corner cut nothing — they just weld, and thereafter drag
  // each other around and past their leash. The point dance already refuses
  // this for single nodes; this is the same rule, shape-sized.
  if (wouldWeld(deltas, occupiedNodes())) return false;

  const before = JSON.stringify(state.lines);
  if (!moveNodes(deltas)) return false;

  // A step that crosses another line re-cuts the pocket, and the new face is
  // keyed off a different set of bounding lines — so the color would be left
  // behind on a pocket that no longer exists. Refusing the step is cheaper than
  // re-homing the fill, and keeps the shape a shape.
  if (!getFaces().some((f) => f.key === key)) {
    state.lines = JSON.parse(before);
    facesStale = true;
    return false;
  }
  return true;
}

// Snapshots, not an operation log: uniform across draw, fill and move, and a
// drag undoes as one step because the snapshot is taken when it starts.
const undoStack = [];
function snapshot() {
  undoStack.push(JSON.stringify({
    l: state.lines, f: state.fills, lc: state.lineColors, nc: state.nodeColors,
  }));
  if (undoStack.length > 50) undoStack.shift();
}

// --- rendering -------------------------------------------------------------

let frame = 0;
const draw = () => { frame ||= requestAnimationFrame(render); };

function render() {
  frame = 0;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  for (const f of getFaces()) {
    const c = state.fills[f.key];
    if (c === undefined) continue;
    ctx.fillStyle = colorOf(c);
    ctx.beginPath();
    f.pts.forEach(([x, y], i) => {
      const [px, py] = toPx(x, y);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
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
    const c = state.lineColors[id] ?? INK;
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(l);
  });
  for (const [c, group] of byColor) {
    ctx.strokeStyle = colorOf(c);
    ctx.beginPath();
    for (const [ax, ay, bx, by] of group) {
      ctx.moveTo(...toPx(ax, ay));
      ctx.lineTo(...toPx(bx, by));
    }
    ctx.stroke();
  }

  // Painted nodes sit on top of the lines that meet them, so a junction reads
  // as one dot rather than as whatever crosses it last. While a dance is
  // running the paint is still keyed to the resting node, so it's looked up
  // through dance.at to find where that node is this beat.
  for (const [at, c] of Object.entries(state.nodeColors)) {
    const here = dance?.at?.get(at) ?? at.split(',').map(Number);
    const [px, py] = toPx(here[0], here[1]);
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(c);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.ink;
    ctx.stroke();
  }

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

  // Who you've picked to dance, in that dance's colour.
  if (dance && dance.chosen.size) {
    if (dance.kind === 'shape') {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#1f8a80';
      for (const f of getFaces()) {
        if (!dance.chosen.has(f.key)) continue;
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
      for (const k of dance.chosen) {
        const at = dance.at.get(k);
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

// Tapping during a dance picks who dances. An empty set means the slider is in
// charge; once anything is picked, only those move and the slider steps aside.
// The node you tap is the one under your finger *now*, which during a point
// dance is not where it rests — dance.at is what maps the two.
function pickDancer(gx, gy) {
  const toggle = (k) => (dance.chosen.has(k) ? dance.chosen.delete(k) : dance.chosen.add(k));

  if (dance.kind === 'shape') {
    const f = faceAt(getFaces(), gx, gy);
    if (!f || state.fills[f.key] === undefined) return;
    toggle(f.key);
  } else {
    const n = nearestNode(gx, gy);
    if (!n) return;
    const hit = [...dance.at].find(([, [x, y]]) => x === n[0] && y === n[1]);
    if (!hit) return;
    toggle(hit[0]);
  }
  danceBar.classList.toggle('picking', dance.chosen.size > 0);
  draw();
}

function tap(px, py) {
  const [gx, gy] = toGrid(px, py);

  if (dance) return pickDancer(gx, gy);
  if (state.mode === 'move') return;   // move mode works by dragging, not tapping

  if (state.mode === 'fill') return paint(gx, gy);

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
  // A tap during a dance picks dancers; a drag would only be thrown away by the
  // snap back, so nothing past here runs while one is playing.
  if (dance || state.mode !== 'move') return;
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
  if (e.pointerType !== 'mouse' || !state.chain) return;
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
    // Never write a danced frame. While a dance runs, state.lines holds a
    // displaced drawing that the snap-back is about to throw away, so writing it
    // would leave disk disagreeing with the screen and hand back the wobble on
    // the next load. The resting copy is what the user actually drew.
    const l = dance ? JSON.parse(dance.resting) : state.lines;
    const nc = dance ? JSON.parse(dance.restingPaint) : state.nodeColors;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        l, f: state.fills, d: state.dots, p: state.palette, b: +bpm.value,
        lc: state.lineColors, nc,
      }));
    } catch {}
  }, 250);
}

function fromLocal() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(j?.l)
      ? { l: j.l, f: j.f || {}, d: j.d, p: j.p, b: j.b, lc: j.lc, nc: j.nc }
      : null;
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
  src ||= fromLocal();
  if (!src) return;
  state.lines = src.l;
  state.fills = src.f;
  state.lineColors = src.lc || {};
  state.nodeColors = src.nc || {};
  state.dots = src.d !== false;   // a shared link carries no preference; dots stay on
  // A link written before palettes existed, or one on the stock colors, carries
  // no palette section — those drawings are meant to arrive in the defaults.
  if (Array.isArray(src.p) && src.p.length === PALETTE.length) state.palette = src.p;
  // Tempo is a preference like the dots, so it is local only — a link shouldn't
  // set the pace someone else's drawing runs at.
  if (src.b >= +bpm.min && src.b <= +bpm.max) {
    bpm.value = src.b;
    bpmOut.textContent = src.b;
  }
  facesStale = true;
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
  b.onclick = () => { state.color = i; paintSwatches(); };
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
paintSwatches();

function showPalette(on) {
  palettePanel.hidden = !on;
  editBtn.setAttribute('aria-pressed', String(on));
  document.getElementById('dancebar').classList.toggle('stepped', on);
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
  stopDance();
  state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
  modeBtn.dataset.mode = state.mode;
  modeBtn.textContent = MODE_LABEL[state.mode];
  state.chain = null;
  hover = null;
  drag = null;
  draw();
};

const dotsBtn = document.getElementById('dots');
function paintDotsBtn() {
  dotsBtn.setAttribute('aria-pressed', String(state.dots));
  dotsBtn.title = state.dots ? 'Hide the dot grid' : 'Show the dot grid';
}
// Fine to toggle mid-dance: it changes what's painted, never the drawing, and
// save() knows to write the resting copy rather than the frame on screen.
dotsBtn.onclick = () => {
  state.dots = !state.dots;
  paintDotsBtn();
  save();
  draw();
};

function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  const { l, f, lc, nc } = JSON.parse(prev);
  state.lines = l;
  state.fills = f;
  state.lineColors = lc || {};
  state.nodeColors = nc || {};
  state.chain = null;
  facesStale = true;
  save();
  draw();
}

document.getElementById('undo').onclick = () => { stopDance(); undo(); };

// --- dance -----------------------------------------------------------------

const danceBtn = document.getElementById('dance');
const shapeBtn = document.getElementById('shapedance');
const danceBar = document.getElementById('dancebar');
const count = document.getElementById('count');
const countLabel = document.getElementById('countlabel');
const countOut = document.getElementById('countout');
const bpm = document.getElementById('bpm');
const bpmOut = document.getElementById('bpmout');

// A tick is a beat, so the speed control is a tempo. 170 is where the dance sat
// before it was adjustable (a flat 350 ms), kept as the default so the feel
// doesn't move under anyone.
const beat = () => Math.round(60000 / +bpm.value);

// How far from home a shape may drift. Fixed rather than exposed: the slider
// is better spent on how many shapes move, which is what costs anything.
const LEASH = 2;

// Two dances. Both return the drawing exactly as they found it, but they get
// there differently, because what they move differs.
//
// The point dance picks loose nodes and nudges them, pulling the lines out of
// shape. It re-derives from the resting drawing every tick, which is what keeps
// a random walk from carrying the drawing away.
//
// The shape dance moves a whole filled pocket at a time, so the shape holds its
// form and the web around it gives. It can't re-derive from rest each tick: that
// would mean re-applying every shape's offset every time, so the cost would
// track how many shapes exist rather than how many are moving, and the Movers
// slider would buy nothing. Instead each shape carries an offset that never
// leaves the leash, so it stays near home by construction, and stopping restores
// the resting drawing outright.
// The count slider means a different thing per dance and keeps its own value,
// since going back to a dance with someone else's number would be a surprise.
const KINDS = {
  point: { btn: danceBtn, cls: 'dancing', label: 'Dancers', max: 12, count: 3 },
  shape: { btn: shapeBtn, cls: 'dancing-shapes', label: 'Movers', max: 6, count: 2 },
};

function danceTick() {
  state.lines = JSON.parse(dance.resting);
  state.nodeColors = JSON.parse(dance.restingPaint);
  const nodes = [...occupiedNodes()].map((k) => k.split(',').map(Number));
  const only = dance.chosen.size ? dance.chosen : null;
  const moves = pickMoves(nodes, only ? only.size : +count.value, cols, rows, Math.random, only);

  // Where each resting node ended up this beat. A tap has to select the node it
  // landed on, not whatever happens to rest under the finger, and the highlight
  // has to follow the node rather than stay behind at its resting place.
  dance.at = new Map(nodes.map(([x, y]) => [`${x},${y}`, [x, y]]));
  for (const [from, to] of moves) {
    moveNode(from, to);
    dance.at.set(`${from[0]},${from[1]}`, to);
  }
  facesStale = true;
  draw();
}

// Only the shapes picked this tick are touched; the rest are already where they
// belong, so they cost nothing. The recorded offset only advances on a step the
// guard allowed, which keeps it honest about where the shape actually is.
function shapeTick() {
  const all = shapes();
  const picked = dance.chosen.size ? all.map((s) => s.key).filter((k) => dance.chosen.has(k)) : null;
  const moving = new Set(picked ?? pickDancers(all.map((s) => s.key), +count.value));
  for (const s of all) {
    if (!moving.has(s.key)) continue;
    const from = dance.offsets.get(s.key) || [0, 0];
    const to = wander(from, LEASH);
    const step = [to[0] - from[0], to[1] - from[1]];
    if ((step[0] || step[1]) && moveShape(s.key, step)) dance.offsets.set(s.key, to);
  }
  draw();
}

function startDance(kind) {
  if (dance || !state.lines.length) return;
  // Shape dance has nothing to move until something is colored, and silently
  // doing nothing would read as a broken button.
  if (kind === 'shape' && !shapes().length) {
    return toast('Shape dance moves filled pockets — fill one first.');
  }
  const k = KINDS[kind];
  toastEl.classList.remove('show');   // the pill lands where the toast sits
  countLabel.textContent = k.label;
  count.max = k.max;
  count.value = k.count;
  countOut.textContent = k.count;
  danceBar.dataset.kind = kind;
  danceBar.classList.remove('picking');
  danceBar.hidden = false;

  // `chosen` starts empty, meaning "let the slider decide". Tapping fills it,
  // and switching the dance off and on again is how you empty it.
  dance = { kind, resting: JSON.stringify(state.lines),
            restingPaint: JSON.stringify(state.nodeColors),
            offsets: new Map(), timer: 0,
            chosen: new Set(), at: new Map(),
            run: kind === 'shape' ? shapeTick : danceTick };
  k.btn.classList.add(k.cls);
  k.btn.setAttribute('aria-pressed', 'true');
  state.chain = null;
  drag = null;
  dance.run();
  if (!ears) schedule();   // while listening, the music books the beats
}

// Each beat books the next one rather than running on a fixed interval, so a
// tick that overruns delays the following beat instead of stacking up behind
// it — and a tempo change simply lands on the next beat, with nothing to reset.
function schedule() {
  dance.timer = setTimeout(() => {
    if (!dance) return;
    dance.run();
    schedule();
  }, beat());
}

function stopDance() {
  if (!dance) return;
  const k = KINDS[dance.kind];
  clearTimeout(dance.timer);
  state.lines = JSON.parse(dance.resting);   // snap back to where it started
  state.nodeColors = JSON.parse(dance.restingPaint);
  dance = null;
  k.btn.classList.remove(k.cls);
  k.btn.setAttribute('aria-pressed', 'false');
  danceBar.hidden = true;
  facesStale = true;
  draw();
}

// --- listening ---------------------------------------------------------------

// Experimental. Two readings of "dance to the music", switchable so they can be
// compared against the same track:
//
//   notes — every sounding pitch class displaces the one node it owns, and the
//           node returns when the note stops. A trill between two pitches reads
//           as two nodes flicking at each other, which is the point.
//   beats — a new note fires one ordinary beat of whichever dance is running.
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
};
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

  if (mapping === 'beats') {
    if (fired.length) dance.run();
    return;
  }

  const key = on.join(',');
  if (key === ears.shown) return;
  ears.shown = key;

  state.lines = JSON.parse(dance.resting);
  state.nodeColors = JSON.parse(dance.restingPaint);
  facesStale = true;
  const ordered = inReadingOrder([...occupiedNodes()].map((k) => k.split(',').map(Number)));
  moveNodes(notesToMoves(on, ordered, cols, rows));
  dance.at = new Map(ordered.map((n) => [n.join(','), n]));
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

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  // sefirograph lets a note fall away over 0.18s, which reads as sustain behind
  // a glow. A step is discrete, so here the fall has to be done before the next
  // note lands or a trill just holds both nodes out: measured against an 8
  // notes/sec trill, 0.18 gave 3 changes in four seconds and 0.09 gave 65.
  // Overridden from this side so the vendored file stays a copy, not a fork.
  const heard = { ...CHROMA_CONFIG, releaseTau: 0.09 };
  ears = { ctx, stream, listener: createListener(ctx, stream, heard), on: [], shown: '', frame: 0 };
  stream.getAudioTracks()[0].onended = () => stopListening();

  // Listening drives whichever dance is running, so without one there is
  // nothing to hear it. Start the point dance rather than doing nothing.
  if (!dance) startDance('point');

  listenBtn.classList.add('listening');
  listenBtn.setAttribute('aria-pressed', 'true');
  hearing.hidden = false;
  tempoGroup(false);

  const loop = () => {
    if (!ears) return;
    if (dance) notesTick(ears.ctx.currentTime);
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
  if (dance) {
    state.lines = JSON.parse(dance.resting);
    state.nodeColors = JSON.parse(dance.restingPaint);
    facesStale = true;
    draw();
  }
}

// The tempo controls have nothing to say while the music is the clock.
function tempoGroup(show) {
  for (const el of [bpm, bpmOut, document.getElementById('bpmdown'),
                    document.getElementById('bpmup'),
                    document.querySelector('label[for="bpm"]')]) {
    el.hidden = !show;
  }
}

listenBtn.onclick = () => (ears ? stopListening() : startListening());

// Starting one dance stops the other: they both own every node, so running both
// would have each fighting the other's restore.
const toggle = (kind) => () => {
  const running = dance?.kind;
  stopDance();
  if (running !== kind) startDance(kind);
};
danceBtn.onclick = toggle('point');
shapeBtn.onclick = toggle('shape');

count.oninput = () => {
  countOut.textContent = count.value;
  if (dance) KINDS[dance.kind].count = +count.value;
  // The point dance redraws from rest every beat, so showing the new number at
  // once is free. The shape dance would have to step its shapes to show it,
  // which is a move the user didn't ask for; it waits for the next beat.
  if (dance?.kind === 'point') dance.run();
};

bpm.oninput = () => {
  bpmOut.textContent = bpm.value;
  save();                       // a tempo you chose should still be there later
};

// The slider covers 210 BPM in about 60px, so it can only land on every third
// value. These reach the ones in between.
const nudgeBpm = (d) => () => {
  bpm.value = Math.max(+bpm.min, Math.min(+bpm.max, +bpm.value + d));
  bpm.dispatchEvent(new Event('input'));
};
document.getElementById('bpmdown').onclick = nudgeBpm(-1);
document.getElementById('bpmup').onclick = nudgeBpm(1);

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
  stopDance();
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
  state.chain = null;
  facesStale = true;
  history.replaceState(null, '', location.pathname);
  save();
  draw();
};

document.getElementById('share').onclick = async (e) => {
  stopDance();   // share the drawing, not a random frame of it
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
      lc: state.lineColors, nc,
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
  state, moveNode, moveNodes, shapes, moveShape,
  redraw: () => { facesStale = true; draw(); },
  faces: getFaces,
};

new ResizeObserver(resize).observe(canvas);
load();
// Both of these paint from state, so they have to run after load() has had its
// say — a drawing arriving with a custom palette needs it on the swatches too,
// not just in the fills.
paintSwatches();
paintDotsBtn();
resize();
