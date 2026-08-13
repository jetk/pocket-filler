import { computeFaces, faceAt } from './planar.js';

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

const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d');
let cols = 0, rows = 0, ox = 0, oy = 0;   // grid extent and screen origin
let faces = [];
let facesStale = true;
let hover = null;                         // rubber-band target (mouse only)

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

  if (state.mode === 'fill') {
    const f = faceAt(getFaces(), gx, gy);
    if (!f) return;
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
  state.lines.push([a[0], a[1], b[0], b[1]]);
  facesStale = true;
}

let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const held = Date.now() - down.t;
  down = null;
  if (moved > 10 || held > 500) return;   // a drag or a long press is not a tap
  const r = canvas.getBoundingClientRect();
  tap(e.clientX - r.left, e.clientY - r.top);
});
canvas.addEventListener('pointercancel', () => { down = null; });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !state.chain) return;
  const r = canvas.getBoundingClientRect();
  const n = nearestNode(...toGrid(e.clientX - r.left, e.clientY - r.top));
  const changed = !!n !== !!hover || (n && hover && !same(n, hover));
  hover = n;
  if (changed) draw();
});

// --- persistence -----------------------------------------------------------

const encode = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (s) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ l: state.lines, f: state.fills })); } catch {}
  }, 250);
}

function load() {
  // A shared link wins over whatever was left in this browser.
  const src = location.hash.length > 1
    ? (() => { try { return decode(location.hash.slice(1)); } catch { return null; } })()
    : (() => { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } })();
  if (!src || !Array.isArray(src.l)) return;
  state.lines = src.l;
  state.fills = src.f || {};
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
  state.mode = state.mode === 'draw' ? 'fill' : 'draw';
  modeBtn.dataset.mode = state.mode;
  modeBtn.textContent = state.mode === 'draw' ? 'Draw' : 'Fill';
  state.chain = null;
  hover = null;
  draw();
};

document.getElementById('undo').onclick = () => {
  state.lines.pop();
  state.chain = null;
  facesStale = true;
  save();
  draw();
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
  state.lines = [];
  state.fills = {};
  state.chain = null;
  facesStale = true;
  history.replaceState(null, '', location.pathname);
  save();
  draw();
};

document.getElementById('share').onclick = async (e) => {
  location.hash = encode({ l: state.lines, f: state.fills });
  try {
    await navigator.clipboard.writeText(location.href);
    const b = e.currentTarget;
    b.textContent = '✓';
    setTimeout(() => { b.innerHTML = '&#8599;'; }, 1200);
  } catch {}
};

// ponytail: stale fill keys are left in state.fills on purpose — undo brings the
// pocket and its color back together. They cost a few bytes and nothing else.

new ResizeObserver(resize).observe(canvas);
load();
resize();
