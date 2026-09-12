import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, segmentAt, valid, walkers, nextMove, keyOf } from '../src/paths.js';

const open3 = { pts: [[1, 1], [2, 1], [3, 1]], closed: false };
const loop3 = { pts: [[1, 1], [2, 1], [2, 2]], closed: true };

test('a path is keyed by the node it belongs to, which is its first point', () => {
  assert.equal(keyOf(loop3), '1,1');
});

test('a closed path cycles forever in one direction', () => {
  let [i, dir] = [0, 1];
  const seen = [];
  for (let n = 0; n < 7; n++) { [i, dir] = step(i, dir, 3, true); seen.push(i); }
  assert.deepEqual(seen, [1, 2, 0, 1, 2, 0, 1]);
});

test('an open path ping-pongs rather than teleporting home', () => {
  let [i, dir] = [0, 1];
  const seen = [];
  for (let n = 0; n < 6; n++) { [i, dir] = step(i, dir, 3, false); seen.push(i); }
  assert.deepEqual(seen, [1, 2, 1, 0, 1, 2]);
});

test('a path of one point goes nowhere and says so calmly', () => {
  assert.deepEqual(step(0, 1, 1, false), [0, 1]);
  assert.deepEqual(step(0, 1, 1, true), [0, 1]);
});

test('the segment under a walker is where it stands to where it is bound', () => {
  assert.deepEqual(segmentAt(loop3, 0, 1), [[1, 1], [2, 1]]);
  assert.deepEqual(segmentAt(loop3, 2, 1), [[2, 2], [1, 1]], 'the closing edge');
  assert.deepEqual(segmentAt(open3, 2, 1), [[3, 1], [2, 1]], 'the far end turns back');
});

test('a path whose anchor has no lines on it is not worth keeping', () => {
  assert.equal(valid(loop3, new Set(['1,1']), 8, 8), true);
  assert.equal(valid(loop3, new Set(['5,5']), 8, 8), false);
});

test('a path off the sheet is refused', () => {
  assert.equal(valid({ pts: [[1, 1], [9, 1]], closed: false }, new Set(['1,1']), 8, 8), false);
});

test('a path needs somewhere to go beyond where it starts', () => {
  assert.equal(valid({ pts: [[1, 1]], closed: false }, new Set(['1,1']), 8, 8), false);
});

test('a walker starts at the anchor and asks for one hop at a time', () => {
  const [w] = walkers({ '1,1': loop3 });
  const m = nextMove(w);
  assert.deepEqual([m.from, m.to], [[1, 1], [2, 1]]);
  assert.equal(w.i, 0, 'asking does not move it — the caller may refuse');
  m.commit();
  assert.equal(w.i, 1);
  assert.deepEqual([nextMove(w).from, nextMove(w).to], [[2, 1], [2, 2]]);
});

test('a refused step leaves the walker where it was, to try again next beat', () => {
  const [w] = walkers({ '1,1': loop3 });
  nextMove(w);            // asked, never committed
  nextMove(w);
  const m = nextMove(w);
  assert.deepEqual([m.from, m.to], [[1, 1], [2, 1]], 'still asking for the same hop');
});
