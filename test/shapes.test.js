import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFaces } from '../src/planar.js';
import { shapeNodes, translate, applyMoves } from '../src/shapes.js';

const segs = (...pairs) => pairs.map((p, id) => ({ id, a: [p[0], p[1]], b: [p[2], p[3]] }));
const occupied = (...pairs) => {
  const s = new Set();
  for (const [ax, ay, bx, by] of pairs) s.add(`${ax},${ay}`).add(`${bx},${by}`);
  return s;
};
const sorted = (nodes) => nodes.map(([x, y]) => `${x},${y}`).sort();

test('a plain square hands back its four corners', () => {
  const lines = [[2, 2, 4, 2], [4, 2, 4, 4], [4, 4, 2, 4], [2, 4, 2, 2]];
  const [face] = computeFaces(segs(...lines));
  assert.deepEqual(sorted(shapeNodes(face, occupied(...lines))), ['2,2', '2,4', '4,2', '4,4']);
});

test('a crossing between dots is not a node, however much it looks like a corner', () => {
  // Two diagonals meeting at (2.5, 1.5), closed off by one vertical.
  const lines = [[0, 0, 5, 3], [0, 3, 5, 0], [0, 0, 0, 3]];
  const [face] = computeFaces(segs(...lines));
  assert.ok(face.pts.some(([x, y]) => x === 2.5 && y === 1.5));
  assert.deepEqual(sorted(shapeNodes(face, occupied(...lines))), ['0,0', '0,3']);
});

test('a crossing that lands on a dot is still not a node', () => {
  // A long line slices the square; it crosses the sides at (2,3) and (4,3),
  // both grid points, but no line ends there.
  const lines = [[2, 2, 4, 2], [4, 2, 4, 4], [4, 4, 2, 4], [2, 4, 2, 2], [0, 3, 9, 3]];
  const top = computeFaces(segs(...lines)).find((f) => f.pts.some(([, y]) => y === 2));
  assert.deepEqual(sorted(shapeNodes(top, occupied(...lines))), ['2,2', '4,2']);
});

test('translate refuses a step that would take any node off the sheet', () => {
  const nodes = [[0, 1], [1, 1]];
  assert.equal(translate(nodes, [-1, 0], 10, 10), null);
  assert.equal(translate([[8, 1]], [1, 0], 9, 10), null);   // cols is exclusive
  assert.deepEqual([...translate(nodes, [1, 0], 10, 10)], [['0,1', [1, 1]], ['1,1', [2, 1]]]);
});

test('a group move does not trip over itself', () => {
  // Shifting both ends right by one: the naive sequential version welds (3,5)
  // onto (4,5) and then carries both to (5,5).
  const lines = [[3, 5, 4, 5]];
  const deltas = translate([[3, 5], [4, 5]], [1, 0], 10, 10);
  assert.equal(applyMoves(lines, deltas), true);
  assert.deepEqual(lines, [[4, 5, 5, 5]]);
});

test('a shape carries the lines welded to it and stretches the rest', () => {
  const square = [[2, 2, 4, 2], [4, 2, 4, 4], [4, 4, 2, 4], [2, 4, 2, 2]];
  const tether = [2, 2, 0, 0];                         // hangs off one corner
  const lines = [...square, tether];
  const [face] = computeFaces(segs(...square));
  const deltas = translate(shapeNodes(face, occupied(...lines)), [1, 0], 10, 10);

  applyMoves(lines, deltas);
  assert.deepEqual(lines.slice(0, 4), [[3, 2, 5, 2], [5, 2, 5, 4], [5, 4, 3, 4], [3, 4, 3, 2]]);
  assert.deepEqual(lines[4], [3, 2, 0, 0]);            // near end followed, far end stayed
});

test('a no-op move reports nothing happened', () => {
  const lines = [[3, 5, 4, 5]];
  assert.equal(applyMoves(lines, translate([[3, 5]], [0, 0], 10, 10)), false);
  assert.deepEqual(lines, [[3, 5, 4, 5]]);
});
