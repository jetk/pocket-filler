import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeLegacy } from '../src/codec.js';

const drawing = {
  l: [[3, 2, 6, 2], [6, 2, 5, 5], [5, 5, 3, 2]],
  f: { '0,1,2#0': 4 },
};

test('round-trips lines and fills', () => {
  assert.deepEqual(decode(encode(drawing)), drawing);
});

test('round-trips an empty drawing', () => {
  assert.deepEqual(decode(encode({ l: [], f: {} })), { l: [], f: {} });
});

test('round-trips line ids past 63, which need two chars', () => {
  const d = { l: Array.from({ length: 80 }, (_, i) => [i % 9, 1, i % 9, 2]), f: { '0,63,64,79#1': 2 } };
  assert.deepEqual(decode(encode(d)), d);
});

test('every character is URL-unreserved, so nothing gets escaped', () => {
  const s = encode(drawing);
  assert.equal(encodeURIComponent(s), s);
});

test('four chars per line beats base64 JSON by a wide margin', () => {
  const many = { l: Array.from({ length: 70 }, (_, i) => [i % 9, i % 16, (i + 3) % 9, (i + 1) % 16]), f: {} };
  const compact = encode(many).length;
  const legacy = Buffer.from(JSON.stringify(many)).toString('base64').length;
  assert.ok(compact * 3 < legacy, `expected big win, got ${compact} vs ${legacy}`);
});

test('truncation is rejected rather than silently half-loaded', () => {
  const s = encode(drawing);
  assert.throws(() => decode(s.slice(0, s.length - 1)));
  assert.throws(() => decode('eyJsIjpbWzMsMiw2LDJdLFs2'));  // a cut-off legacy link
});

test('coordinates off the shareable grid are refused, not mangled', () => {
  assert.throws(() => encode({ l: [[0, 0, 64, 0]] }), RangeError);
  assert.throws(() => encode({ l: [[0, 0, 2.5, 0]] }), RangeError);
});

// --- palette, an optional trailing section ---------------------------------

const palette = ['#e0655c', '#ec9c46', '#e8c84e', '#68b877', '#579fd8', '#a077cc'];

test('round-trips a custom palette', () => {
  const d = { ...drawing, p: ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#123456'] };
  assert.deepEqual(decode(encode(d)), d);
});

test('a palette costs four characters a color and nothing when absent', () => {
  const withPal = encode({ ...drawing, p: palette });
  const without = encode(drawing);
  assert.equal(withPal.length - without.length, 1 + 6 * 4);   // the '.' plus six colors
  assert.equal(without.split('.').length, 3);                 // no trailing section at all
});

test('a link written before palettes existed still loads', () => {
  const old = encode(drawing);            // three sections, as it always was
  const back = decode(old);
  assert.equal(back.p, undefined);        // absent, not empty — the caller defaults it
  assert.deepEqual(back, drawing);
});

test('palette survives the round trip byte for byte, including leading zeros', () => {
  const d = { l: [], f: {}, p: ['#000000', '#000001', '#010000', '#0000ff', '#00ff00', '#ffffff'] };
  assert.deepEqual(decode(encode(d)).p, d.p);
});

test('a half-delivered palette is rejected rather than half-applied', () => {
  const s = encode({ ...drawing, p: palette });
  assert.throws(() => decode(s.slice(0, s.length - 1)), SyntaxError);
});

test('palette colors must be #rrggbb', () => {
  assert.throws(() => encode({ ...drawing, p: ['red', '#fff', '#ec9c46', '#68b877', '#579fd8', '#a077cc'] }), RangeError);
});

test('a palette link is still URL-clean', () => {
  const s = encode({ ...drawing, p: ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#123456'] });
  assert.equal(encodeURIComponent(s), s);
});

// --- line and node colours, two more optional sections ---------------------

test('round-trips coloured lines and nodes', () => {
  const d = { ...drawing, lc: { 0: 2, 2: 6 }, nc: { '3,2': 0, '6,2': 5 } };
  assert.deepEqual(decode(encode(d)), d);
});

test('a drawing with no coloured anything is the link it always was', () => {
  assert.equal(encode(drawing), encode({ ...drawing, lc: {}, nc: {} }));
});

test('colours ride behind the palette, and an absent palette leaves a gap', () => {
  const s = encode({ ...drawing, lc: { 0: 1 } });
  // version, lines, fills, palette, lineInk
  assert.equal(s.split('.').length, 5);
  assert.equal(s.split('.')[3], '', 'the palette section is present but empty');
  assert.deepEqual(decode(s).lc, { 0: 1 });
  assert.equal(decode(s).p, undefined);
});

test('a link written before either existed still loads', () => {
  const back = decode('1.DCGCGCFFFFDC.');
  assert.equal(back.lc, undefined);
  assert.equal(back.nc, undefined);
});

test('half-delivered colour data is rejected rather than half-applied', () => {
  const s = encode({ ...drawing, nc: { '3,2': 4 } });
  assert.throws(() => decode(s.slice(0, s.length - 1)), SyntaxError);
});

test('a colour outside the palette plus ink is refused', () => {
  assert.throws(() => encode({ ...drawing, lc: { 0: 7 } }), RangeError);
  assert.throws(() => encode({ ...drawing, nc: { '3,2': -1 } }), RangeError);
});

test('legacy base64 links still load', () => {
  const s = btoa(JSON.stringify(drawing)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(decodeLegacy(s), drawing);
});
