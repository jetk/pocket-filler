import { computeFaces, faceAt } from './planar.js';
import { encode, decode, decodeLegacy } from './codec.js';
import { pickMoves } from './dance.js';
import { shapeNodes, translate, applyMoves } from './shapes.js';

// px per grid unit. Nominally 1 cm (96 CSS px per inch), but CSS px drift from
// physical size per device — hold a ruler to the screen and tune this.
const CM = 96 / 2.54;
const MARGIN = 0.6 * CM;   // keep dots off the very edge
const SNAP = 0.45;         // tap-to-node radius, in grid units
const PALETTE = ['#e0655c', '#ec9c46', '#e8c84e', '#68b877', '#579fd8', '#a077cc'];
const STORE = 'pocket-filler';

// lines: [ax, ay, bx, by] in grid units; the array index is the line's id, which
// is what face keys are built from — so ordering must stay stable.
const state = { lines: [], fills: {}, mode: 'draw', color: 0, chain: null };
const MODES = ['draw', 'fill', 'move'];

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
  if (touched) facesStale = true;
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
  undoStack.push(JSON.stringify({ l: state.lines, f: state.fills }));
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
    ctx.fillStyle = PALETTE[c];
    ctx.beginPath();
    f.pts.forEach(([x, y], i) => {
      const [px, py] = toPx(x, y);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--dot');
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      ctx.beginPath();
      ctx.arc(ox + i * CM, oy + j * CM, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = '#2a2622';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [ax, ay, bx, by] of state.lines) {
    ctx.moveTo(...toPx(ax, ay));
    ctx.lineTo(...toPx(bx, by));
  }
  ctx.stroke();

  // In move mode the nodes you can actually grab need to be visible.
  if (state.mode === 'move') {
    for (const k of occupiedNodes()) {
      const [gx, gy] = k.split(',').map(Number);
      const [x, y] = toPx(gx, gy);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#faf8f4';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2a2622';
      ctx.stroke();
    }
    if (drag) ring(drag.at, '#c0392b', true);
  }

  if (state.chain) {
    const first = state.chain[0], last = state.chain.at(-1);
    if (hover && !same(hover, last)) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = '#2a262266';
      ctx.beginPath();
      ctx.moveTo(...toPx(...last));
      ctx.lineTo(...toPx(...hover));
      ctx.stroke();
      ctx.restore();
    }
    ring(last, '#2a2622', true);
    if (state.chain.length >= 3) ring(first, '#2a2622', false);
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

function tap(px, py) {
  const [gx, gy] = toGrid(px, py);

  if (state.mode === 'move') return;   // move mode works by dragging, not tapping

  if (state.mode === 'fill') {
    const f = faceAt(getFaces(), gx, gy);
    if (!f) return;
    snapshot();
    if (state.fills[f.key] === state.color) delete state.fills[f.key];
    else state.fills[f.key] = state.color;
    save();
    return draw();
  }

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

function addLine(a, b) {
  snapshot();
  state.lines.push([a[0], a[1], b[0], b[1]]);
  facesStale = true;
}

let down = null;
const local = (e) => {
  const r = canvas.getBoundingClientRect();
  return toGrid(e.clientX - r.left, e.clientY - r.top);
};

canvas.addEventListener('pointerdown', (e) => {
  if (dance) return;   // edits during a dance would be thrown away by the snap back
  down = { x: e.clientX, y: e.clientY, t: Date.now() };
  if (state.mode !== 'move') return;
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

let toastTimer = 0;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ l: state.lines, f: state.fills })); } catch {}
  }, 250);
}

function fromLocal() {
  try {
    const j = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(j?.l) ? { l: j.l, f: j.f || {} } : null;
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
  facesStale = true;
}

// --- toolbar ---------------------------------------------------------------

const swatches = document.getElementById('swatches');
PALETTE.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.setAttribute('aria-label', `Color ${i + 1}`);
  b.setAttribute('aria-pressed', String(i === 0));
  b.onclick = () => {
    state.color = i;
    [...swatches.children].forEach((el, j) => el.setAttribute('aria-pressed', String(i === j)));
  };
  swatches.append(b);
});

const modeBtn = document.getElementById('mode');
modeBtn.onclick = () => {
  stopDance();
  state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length];
  modeBtn.dataset.mode = state.mode;
  modeBtn.textContent = state.mode[0].toUpperCase() + state.mode.slice(1);
  state.chain = null;
  hover = null;
  drag = null;
  draw();
};

function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  const { l, f } = JSON.parse(prev);
  state.lines = l;
  state.fills = f;
  state.chain = null;
  facesStale = true;
  save();
  draw();
}

document.getElementById('undo').onclick = () => { stopDance(); undo(); };

// --- dance -----------------------------------------------------------------

const TICK = 350;   // jerky on purpose for now
const danceBtn = document.getElementById('dance');
const danceBar = document.getElementById('dancebar');
const dancers = document.getElementById('dancers');
const dancerCount = document.getElementById('dancercount');

// Every tick starts from the resting drawing rather than from the last tick, so
// the shape wobbles around its original instead of wandering off — and stopping
// is the same restore the tick already does.
function danceTick() {
  state.lines = JSON.parse(dance.resting);
  const nodes = [...occupiedNodes()].map((k) => k.split(',').map(Number));
  for (const [from, to] of pickMoves(nodes, +dancers.value, cols, rows)) moveNode(from, to);
  facesStale = true;
  draw();
}

function startDance() {
  if (dance || !state.lines.length) return;
  dance = { resting: JSON.stringify(state.lines), timer: setInterval(danceTick, TICK) };
  danceBtn.classList.add('dancing');
  danceBar.hidden = false;
  state.chain = null;
  drag = null;
  danceTick();
}

function stopDance() {
  if (!dance) return;
  clearInterval(dance.timer);
  state.lines = JSON.parse(dance.resting);   // snap back to where it started
  dance = null;
  danceBtn.classList.remove('dancing');
  danceBar.hidden = true;
  facesStale = true;
  draw();
}

danceBtn.onclick = () => (dance ? stopDance() : startDance());
dancers.oninput = () => {
  dancerCount.textContent = dancers.value;
  if (dance) danceTick();
};

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

  try {
    history.replaceState(null, '', '#' + encode({ l: state.lines, f }));
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
resize();
