import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftColor, popScale, scaleAbout, strobing, revealed, faceReady } from '../src/looks.js';

test('cycling walks the palette and wraps', () => {
  assert.equal(shiftColor(0, 1, 6), 1);
  assert.equal(shiftColor(5, 1, 6), 0);
  assert.equal(shiftColor(2, 10, 6), 0);
});

test('ink never cycles — the skeleton of the drawing holds still', () => {
  assert.equal(shiftColor(6, 3, 6), 6);
});

test('a backwards shift still lands in the palette', () => {
  assert.equal(shiftColor(0, -1, 6), 5);
});

test('pop snaps out on the fire and eases back towards its own size', () => {
  const beat = 400;
  assert.equal(popScale(0, beat, 0.3), 1.3);
  const mid = popScale(100, beat, 0.3);
  assert.ok(mid < 1.3 && mid > 1.05, `expected a decay, got ${mid}`);
  assert.ok(popScale(1200, beat, 0.3) < 1.01);
});

test('scaling about the centroid keeps the shape put', () => {
  const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const big = scaleAbout(square, 2);
  assert.deepEqual(big, [[-1, -1], [3, -1], [3, 3], [-1, 3]]);
  assert.equal(scaleAbout(square, 1), square, 'scale of 1 is the same array, not a copy');
});

test('the strobe is a sliver of the beat, and short in absolute time when slow', () => {
  assert.equal(strobing(0, 400), true);
  assert.equal(strobing(80, 400), false);        // past 18% of 400ms
  assert.equal(strobing(80, 4000), true);        // still inside the 90ms cap
  assert.equal(strobing(200, 4000), false);      // capped at 90ms rather than 18% of 4000
  assert.equal(strobing(-1, 400), false);        // hasn't fired yet
});

test('reveal never runs past the end of the drawing', () => {
  assert.equal(revealed(0, 5), 0);
  assert.equal(revealed(3, 5), 3);
  assert.equal(revealed(9, 5), 5);
});

test('a pocket waits for every line that bounds it', () => {
  const face = { lines: [0, 2, 4] };
  assert.equal(faceReady(face, 4), false);
  assert.equal(faceReady(face, 5), true);
});
