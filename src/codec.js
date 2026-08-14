// Drawing <-> URL fragment. Base64-of-JSON was ~22 chars per line, long enough
// that shared links got truncated in transit; this is 4.
//
// Fragment layout:  1.<lines>.<fill>~<fill>~...
//   lines  four chars per line: ax ay bx by, one char each
//   fill   two chars per bounding line id, then occurrence index, then color
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

const isCoord = (v) => Number.isInteger(v) && v >= 0 && v < 64;

export function encode({ l, f = {} }) {
  const flat = l.flat();
  if (!flat.every(isCoord)) throw new RangeError('coordinates outside the shareable 0-63 grid');

  const fills = Object.entries(f).map(([key, color]) => {
    const [ids, idx] = key.split('#');
    return ids.split(',').map((id) => c2(+id)).join('') + c1(+idx) + c1(color);
  });

  return `1.${flat.map(c1).join('')}.${fills.join('~')}`;
}

export function decode(s) {
  const [ver, lineStr = '', fillStr = ''] = s.split('.');
  if (ver !== '1') throw new SyntaxError('unknown format');
  if (lineStr.length % 4) throw new SyntaxError('truncated line data');
  if ([...lineStr + fillStr].some((ch) => ch !== '~' && !A.includes(ch))) {
    throw new SyntaxError('corrupt characters');
  }

  const l = [];
  for (let i = 0; i < lineStr.length; i += 4) l.push([...lineStr.slice(i, i + 4)].map(n1));

  const f = {};
  for (const entry of fillStr ? fillStr.split('~') : []) {
    if (entry.length < 4 || entry.length % 2) throw new SyntaxError('truncated fill data');
    const ids = [];
    for (let i = 0; i < entry.length - 2; i += 2) ids.push(n2(entry.slice(i, i + 2)));
    f[`${ids.join(',')}#${n1(entry.at(-2))}`] = n1(entry.at(-1));
  }

  return { l, f };
}

// Links shared before this format existed. Cheap to keep, and it saves any
// already-sent link that wasn't truncated.
export function decodeLegacy(s) {
  const j = JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
  if (!Array.isArray(j.l)) throw new SyntaxError('not a drawing');
  return { l: j.l, f: j.f || {} };
}
