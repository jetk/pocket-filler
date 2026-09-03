// Drawing <-> URL fragment. Base64-of-JSON was ~22 chars per line, long enough
// that shared links got truncated in transit; this is 4.
//
// Fragment layout:  1.<lines>.<fill>~<fill>~....<palette>.<lineInk>.<nodeInk>
//   lines    four chars per line: ax ay bx by, one char each
//   fill     two chars per bounding line id, then occurrence index, then color
//   palette  optional, four chars per color (24 bits of rgb), six colors
//   lineInk  optional, three chars per colored line: two-char line id, color
//   nodeInk  optional, three chars per colored node: x, y, color
// Trailing sections are dropped when empty and empty ones in the middle are
// left as nothing between two dots, so a plain drawing's link is exactly the
// length it always was and a link written before any of this still decodes.
// The palette section is appended only when the user has changed a swatch, so
// ordinary links are exactly as short as they were before it existed, and a
// link written before it stays readable — a missing section just means the
// default palette.
// Every character is URL-unreserved, so nothing gets percent-encoded and the
// separators '.' and '~' can never collide with payload.

const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ponytail: coordinates are one char, so the grid tops out at 64 units — a 64 cm
// screen at 1 cm spacing. Line *ids* get two chars because a drawing passes 64
// lines easily. If zoom or fractional coords ever land, widen coords to two too.
const c1 = (v) => A[v];
const c2 = (v) => A[Math.floor(v / 64)] + A[v % 64];
const n1 = (s) => A.indexOf(s);
const n2 = (s) => A.indexOf(s[0]) * 64 + A.indexOf(s[1]);

// A color is 24 bits, which is exactly four of these six-bit characters.
const c4 = (v) => c1((v >> 18) & 63) + c1((v >> 12) & 63) + c1((v >> 6) & 63) + c1(v & 63);
const n4 = (s) => (n1(s[0]) << 18) | (n1(s[1]) << 12) | (n1(s[2]) << 6) | n1(s[3]);
const isHex = (h) => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h);

const isCoord = (v) => Number.isInteger(v) && v >= 0 && v < 64;

// A color is an index into the palette, or INK for the sheet's own line color,
// which is why this goes one past the six. Defined here rather than in app.js
// because this is the module that has to validate it, and app.js imports it so
// there is only ever one of it — two would agree today and drift later.
export const INK = 6;
const isColor = (v) => Number.isInteger(v) && v >= 0 && v <= INK;

export function encode({ l, f = {}, p, lc = {}, nc = {} }) {
  const flat = l.flat();
  if (!flat.every(isCoord)) throw new RangeError('coordinates outside the shareable 0-63 grid');

  const fills = Object.entries(f).map(([key, color]) => {
    const [ids, idx] = key.split('#');
    return ids.split(',').map((id) => c2(+id)).join('') + c1(+idx) + c1(color);
  });

  const pal = p ? p.map((h) => {
    if (!isHex(h)) throw new RangeError('palette colors must be #rrggbb');
    return c4(parseInt(h.slice(1), 16));
  }).join('') : '';

  const lineInk = Object.entries(lc).map(([id, c]) => {
    if (!isColor(c)) throw new RangeError('line color out of range');
    return c2(+id) + c1(c);
  }).join('');

  const nodeInk = Object.entries(nc).map(([at, c]) => {
    const [x, y] = at.split(',').map(Number);
    if (!isCoord(x) || !isCoord(y)) throw new RangeError('node outside the shareable 0-63 grid');
    if (!isColor(c)) throw new RangeError('node color out of range');
    return c1(x) + c1(y) + c1(c);
  }).join('');

  const tail = [pal, lineInk, nodeInk];
  while (tail.length && !tail[tail.length - 1]) tail.pop();
  return [`1.${flat.map(c1).join('')}`, fills.join('~'), ...tail].join('.');
}

export function decode(s) {
  const [ver, lineStr = '', fillStr = '', palStr = '', lineStr2 = '', nodeStr = ''] = s.split('.');
  if (ver !== '1') throw new SyntaxError('unknown format');
  if (lineStr.length % 4) throw new SyntaxError('truncated line data');
  if ([...lineStr + fillStr + palStr + lineStr2 + nodeStr].some((ch) => ch !== '~' && !A.includes(ch))) {
    throw new SyntaxError('corrupt characters');
  }
  if (palStr && palStr.length % 4) throw new SyntaxError('truncated palette data');
  if (lineStr2.length % 3 || nodeStr.length % 3) throw new SyntaxError('truncated color data');

  const l = [];
  for (let i = 0; i < lineStr.length; i += 4) l.push([...lineStr.slice(i, i + 4)].map(n1));

  const f = {};
  for (const entry of fillStr ? fillStr.split('~') : []) {
    if (entry.length < 4 || entry.length % 2) throw new SyntaxError('truncated fill data');
    const ids = [];
    for (let i = 0; i < entry.length - 2; i += 2) ids.push(n2(entry.slice(i, i + 2)));
    f[`${ids.join(',')}#${n1(entry.at(-2))}`] = n1(entry.at(-1));
  }

  const out = { l, f };
  if (lineStr2) {
    out.lc = {};
    for (let i = 0; i < lineStr2.length; i += 3) {
      out.lc[n2(lineStr2.slice(i, i + 2))] = n1(lineStr2[i + 2]);
    }
  }
  if (nodeStr) {
    out.nc = {};
    for (let i = 0; i < nodeStr.length; i += 3) {
      out.nc[`${n1(nodeStr[i])},${n1(nodeStr[i + 1])}`] = n1(nodeStr[i + 2]);
    }
  }
  if (palStr) {
    out.p = [];
    for (let i = 0; i < palStr.length; i += 4) {
      out.p.push('#' + n4(palStr.slice(i, i + 4)).toString(16).padStart(6, '0'));
    }
  }
  return out;
}

// Links shared before this format existed. Cheap to keep, and it saves any
// already-sent link that wasn't truncated.
export function decodeLegacy(s) {
  const j = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
  if (!Array.isArray(j.l)) throw new SyntaxError('not a drawing');
  return { l: j.l, f: j.f || {} };
}
