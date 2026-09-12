import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatMs, clampBpm, fires, fireCount, tapTempo, scaleBpm, DIVS } from '../src/clock.js';

test('a beat is the tempo turned upside down', () => {
  assert.equal(beatMs(60), 1000);
  assert.equal(Math.round(beatMs(128)), 469);
});

test('nothing fires during the count-in', () => {
  for (const div of DIVS) {
    assert.equal(fires(-1, div), false);
    assert.equal(fires(-4, div), false);
  }
  assert.equal(fires(0, 1), true);
});

test('a division fires every that-many beats', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((b) => fires(b, 4)), [true, false, false, false, true]);
});

test('fireCount counts fires, not beats, and stays at zero while counting in', () => {
  assert.equal(fireCount(-2, 1), 0);
  assert.equal(fireCount(0, 4), 1);
  assert.equal(fireCount(3, 4), 1);
  assert.equal(fireCount(4, 4), 2);
});

test('tapping four times on the beat reads that tempo', () => {
  assert.equal(tapTempo([0, 500, 1000, 1500]), 120);
});

test('one sloppy tap does not move the answer much', () => {
  // the third tap lands 80ms late; a mean would follow it, a median shrugs
  assert.equal(tapTempo([0, 500, 1080, 1500, 2000]), 120);
});

test('a long pause starts the count again rather than averaging the gap in', () => {
  // two taps at 120, a ten second wait, then four taps at 60
  assert.equal(tapTempo([0, 500, 10500, 11500, 12500, 13500]), 60);
});

test('a single tap says nothing at all', () => {
  assert.equal(tapTempo([1000]), null);
  assert.equal(tapTempo([]), null);
});

test('tapping absurdly fast or slow is clamped into range', () => {
  assert.equal(tapTempo([0, 50, 100, 150]), 240);
  assert.equal(tapTempo([0, 1900, 3800]), 32);   // 1900ms a beat, rounded
});

test('halving and doubling refuse rather than clamp', () => {
  assert.equal(scaleBpm(128, 0.5), 64);
  assert.equal(scaleBpm(128, 2), null);      // 256 is past the top
  assert.equal(scaleBpm(50, 0.5), null);     // 25 is below the bottom
  assert.equal(scaleBpm(100, 2), 200);
});

test('clampBpm keeps the range whole', () => {
  assert.equal(clampBpm(1), 30);
  assert.equal(clampBpm(1000), 240);
  assert.equal(clampBpm(127.6), 128);
});
