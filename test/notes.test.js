import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ON, OFF, sounding, started, inReadingOrder, nodeFor, notesToMoves } from '../src/notes.js';

const levels = (pairs) => {
  const l = new Array(12).fill(0);
  for (const [pc, v] of pairs) l[pc] = v;
  return l;
};

test('a class counts as sounding once it crosses the top threshold', () => {
  assert.deepEqual(sounding(levels([[0, ON + 0.01], [3, ON - 0.01]])), [0]);
});

test('a class already sounding holds on down to the lower threshold', () => {
  const held = sounding(levels([[0, (ON + OFF) / 2]]), [0]);
  assert.deepEqual(held, [0], 'should stay on between the two thresholds');
  const fresh = sounding(levels([[0, (ON + OFF) / 2]]), []);
  assert.deepEqual(fresh, [], 'but should not switch on there');
});

test('it lets go below the lower threshold', () => {
  assert.deepEqual(sounding(levels([[0, OFF - 0.01]]), [0]), []);
});

test('starts are the classes that were not sounding before', () => {
  assert.deepEqual(started([0, 4, 7], [0, 7]), [4]);
  assert.deepEqual(started([0, 7], [0, 7]), []);
});

test('reading order is top to bottom, then left to right', () => {
  const order = inReadingOrder([[5, 9], [1, 2], [7, 2], [0, 9]]);
  assert.deepEqual(order, [[1, 2], [7, 2], [0, 9], [5, 9]]);
});

test('a pitch class always lands on the same node, and neighbours stay neighbours', () => {
  const ordered = inReadingOrder([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  assert.deepEqual(nodeFor(1, ordered), [1, 0]);
  assert.deepEqual(nodeFor(2, ordered), [2, 0]);      // a semitone up is one node along
  assert.deepEqual(nodeFor(1, ordered), [1, 0]);      // and it doesn't drift
  assert.deepEqual(nodeFor(6, ordered), [1, 0]);      // wraps once past the end
});

// --- note -> node ----------------------------------------------------------

const square = inReadingOrder([[2, 2], [6, 2], [6, 6], [2, 6]]);

test('each sounding class displaces its own node, once', () => {
  const moves = notesToMoves([0, 1], square, 20, 20);
  assert.equal(moves.size, 2);
  assert.deepEqual(moves.get('2,2'), [3, 2]);    // class 0 steps right
  assert.deepEqual(moves.get('6,2'), [5, 2]);    // class 1 steps left
});

test('silence moves nothing', () => {
  assert.equal(notesToMoves([], square, 20, 20).size, 0);
});

test('a step off the sheet is dropped rather than clamped', () => {
  const edge = inReadingOrder([[0, 0]]);
  assert.equal(notesToMoves([1], edge, 20, 20).size, 0);   // class 1 steps left, off the grid
  assert.equal(notesToMoves([0], edge, 20, 20).size, 1);   // class 0 steps right, fine
});

test('two notes are never sent to the same square', () => {
  // Two adjacent nodes whose fixed directions both aim at (3,0).
  const pair = inReadingOrder([[2, 0], [4, 0]]);
  const moves = notesToMoves([0, 1], pair, 20, 20);   // 0 steps right from (2,0), 1 steps left from (4,0)
  const landings = [...moves.values()].map((v) => v.join(','));
  assert.equal(new Set(landings).size, landings.length, `collided: ${landings}`);
});

test('a note will not weld its node onto one that is staying put', () => {
  const row = inReadingOrder([[2, 0], [3, 0], [9, 9]]);
  // class 0 owns (2,0) and steps right, straight into (3,0), which isn't moving.
  assert.equal(notesToMoves([0], row, 20, 20).has('2,0'), false);
});

test('the same classes give the same moves every time', () => {
  const a = [...notesToMoves([0, 2, 5], square, 20, 20)];
  const b = [...notesToMoves([0, 2, 5], square, 20, 20)];
  assert.deepEqual(a, b);
});
