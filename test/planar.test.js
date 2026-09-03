import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFaces, faceAt, lineAt } from '../src/planar.js';

const segs = (...pairs) => pairs.map((p, id) => ({ id, a: [p[0], p[1]], b: [p[2], p[3]] }));
const areas = (faces) => faces.map((f) => +f.area.toFixed(6)).sort((a, b) => a - b);

test('an X encloses nothing', () => {
  assert.equal(computeFaces(segs([0, 0, 2, 2], [0, 2, 2, 0])).length, 0);
});

test('triangle is one face with the analytic area', () => {
  const f = computeFaces(segs([0, 0, 4, 0], [4, 0, 2, 3], [2, 3, 0, 0]));
  assert.equal(f.length, 1);
  assert.equal(+f[0].area.toFixed(6), 6);
});

test('square plus a diagonal is two faces', () => {
  const f = computeFaces(segs(
    [0, 0, 2, 0], [2, 0, 2, 2], [2, 2, 0, 2], [0, 2, 0, 0], [0, 0, 2, 2],
  ));
  assert.deepEqual(areas(f), [2, 2]);
});

test('star of David: two triangles make six points and a hexagon', () => {
  const f = computeFaces(segs(
    [0, 0, 4, 0], [4, 0, 2, 3], [2, 3, 0, 0],       // pointing up
    [0, 2, 4, 2], [4, 2, 2, -1], [2, -1, 0, 2],     // pointing down
  ));
  assert.equal(f.length, 7);
  const a = areas(f);
  // six congruent points, then the hexagon
  assert.equal(a.filter((v) => Math.abs(v - a[0]) < 1e-6).length, 6);
  assert.ok(a[6] > a[0]);
});

test('a dangling edge inside a triangle does not invent a face', () => {
  const f = computeFaces(segs(
    [0, 0, 4, 0], [4, 0, 2, 3], [2, 3, 0, 0], [0, 0, 2, 1],
  ));
  assert.equal(f.length, 1);
  assert.equal(+f[0].area.toFixed(6), 6);
});

test('collinear overlapping segments collapse instead of duplicating', () => {
  const f = computeFaces(segs(
    [0, 0, 4, 0], [1, 0, 3, 0], [4, 0, 2, 3], [2, 3, 0, 0],
  ));
  assert.equal(f.length, 1);
  assert.equal(+f[0].area.toFixed(6), 6);
});

test('faceAt picks the innermost pocket and rejects outside points', () => {
  const f = computeFaces(segs(
    [0, 0, 2, 0], [2, 0, 2, 2], [2, 2, 0, 2], [0, 2, 0, 0], [0, 0, 2, 2],
  ));
  assert.equal(+faceAt(f, 1.5, 0.5).area.toFixed(6), 2);
  assert.equal(faceAt(f, 5, 5), null);
});

test('face keys are stable when endpoints move without changing topology', () => {
  const before = computeFaces(segs([0, 0, 4, 0], [4, 0, 2, 3], [2, 3, 0, 0]));
  const after = computeFaces(segs([0, 0, 4, 0], [4, 0, 2.4, 3.2], [2.4, 3.2, 0, 0]));
  assert.equal(before[0].key, after[0].key);
});

// --- lineAt: which drawn line is under the finger ---------------------------

const hit = segs([0, 0, 4, 0], [0, 2, 4, 2]);

test('lineAt finds the line you tapped', () => {
  assert.equal(lineAt(hit, 2, 0.05, 0.3), 0);
  assert.equal(lineAt(hit, 2, 1.95, 0.3), 1);
});

test('lineAt ignores a tap that is merely near the line', () => {
  assert.equal(lineAt(hit, 2, 1, 0.3), null);
});

test('lineAt stops at the ends rather than running on forever', () => {
  // straight off the end of segment 0, no nearer to it than the tolerance
  assert.equal(lineAt(hit, 5, 0, 0.3), null);
  assert.equal(lineAt(hit, 4.2, 0, 0.3), 0);
});

test('lineAt picks the nearer of two lines at a crossing', () => {
  const cross = segs([0, 0, 4, 0], [2, -2, 2, 2]);
  assert.equal(lineAt(cross, 2.0, 0.1, 0.5), 1, 'closer to the vertical');
  assert.equal(lineAt(cross, 2.3, 0.02, 0.5), 0, 'closer to the horizontal');
});
