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

// --- intensity and the drop -------------------------------------------------

import { energy, trackEnergy, DROP } from '../src/notes.js';

const flat = (v) => new Array(12).fill(v);

test('energy is how much is going on across the whole spectrum', () => {
  assert.equal(energy(flat(0.5)), 0.5);
  assert.equal(energy([]), 0);
});

// Feed the tracker a run of frames and report every moment it called a drop.
function play(frames, step = 40) {
  let st = { slow: null, fast: null, firedAt: -Infinity };
  const hits = [];
  frames.forEach((v, i) => {
    st = trackEnergy(st, flat(v), i * step);
    if (st.dropped) hits.push(i);
  });
  return hits;
}

test('a steady track never reads as a drop', () => {
  assert.deepEqual(play(new Array(120).fill(0.6)), []);
});

test('silence into a wall of sound reads as one drop, not a hundred', () => {
  const hits = play([...new Array(60).fill(0.05), ...new Array(80).fill(0.9)]);
  assert.equal(hits.length, 1, `expected one hit, got ${hits.length}`);
  assert.ok(hits[0] >= 60 && hits[0] < 70, `expected it at the transition, got ${hits[0]}`);
});

test('the hold lets a second drop through once it has expired', () => {
  const quiet = new Array(60).fill(0.05), loud = new Array(80).fill(0.9);
  // two builds, far enough apart that the hold has run out between them
  const hits = play([...quiet, ...loud, ...quiet, ...loud]);
  assert.equal(hits.length, 2);
});

test('a real build is not a drop — it is the thing a drop stands out from', () => {
  // sixteen bars at 128 BPM is about 30 seconds, which at 40ms a frame is 750
  const ramp = Array.from({ length: 750 }, (_, i) => 0.05 + 0.8 * (i / 750));
  assert.deepEqual(play(ramp), []);
});

test('a steep enough rise is a hit, and that is the point rather than a flaw', () => {
  // the same climb crammed into eight seconds outruns the slow average, which
  // is exactly what the two-average test is for: it measures how fast energy
  // arrived, not how loud it got
  const fast = Array.from({ length: 200 }, (_, i) => 0.05 + 0.8 * (i / 200));
  assert.equal(play(fast).length, 1);
});

test('the margin is what decides, so a smaller one is easier to trip', () => {
  const frames = [...new Array(60).fill(0.4), ...new Array(40).fill(0.5)];
  let st = { slow: null, fast: null, firedAt: -Infinity };
  let any = false;
  frames.forEach((v, i) => { st = trackEnergy(st, flat(v), i * 40, { ...DROP, margin: 0.02 }); any ||= st.dropped; });
  assert.ok(any, 'a 0.1 jump should trip a 0.02 margin');
});
