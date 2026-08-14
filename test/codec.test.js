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

test('legacy base64 links still load', () => {
  const s = btoa(JSON.stringify(drawing)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(decodeLegacy(s), drawing);
});
