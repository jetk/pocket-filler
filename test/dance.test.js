import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMoves, pickDancers, wander } from '../src/dance.js';

// deterministic stand-in for Math.random
const seeded = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

// step 1 packs nodes solid, so neighbours block each other; real drawings are
// spread out, which is what `step` is for.
const grid = (w, h, step = 1) => {
  const out = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) out.push([x * step, y * step]);
  return out;
};

test('moves exactly as many nodes as asked', () => {
  const moves = pickMoves(grid(4, 4, 3), 5, 20, 20, seeded(1));
  assert.equal(moves.length, 5);
});

test('never asks for more nodes than exist', () => {
  const moves = pickMoves([[0, 0], [2, 2]], 9, 20, 20, seeded(2));
  assert.equal(moves.length, 2);
});

test('each node moves exactly one grid position', () => {
  for (const [from, to] of pickMoves(grid(4, 4, 3), 12, 20, 20, seeded(3))) {
    const dx = Math.abs(to[0] - from[0]), dy = Math.abs(to[1] - from[1]);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, `bad step ${from} -> ${to}`);
  }
});

test('never steps off the grid', () => {
  // a 3x3 grid of nodes filling a 3x3 board: every legal step is inward
  for (let s = 0; s < 40; s++) {
    for (const [, to] of pickMoves(grid(3, 3), 9, 3, 3, seeded(s))) {
      assert.ok(to[0] >= 0 && to[0] < 3 && to[1] >= 0 && to[1] < 3, `off grid: ${to}`);
    }
  }
});

test('no two nodes land on the same point, which would weld them', () => {
  for (let s = 0; s < 40; s++) {
    const nodes = grid(4, 4, 2);   // gaps between nodes, so collisions are reachable
    const moves = pickMoves(nodes, 16, 8, 8, seeded(s));
    const occupied = new Set(nodes.map((n) => n.join(',')));
    for (const [from, to] of moves) {
      occupied.delete(from.join(','));
      assert.ok(!occupied.has(to.join(',')), `collision at ${to} (seed ${s})`);
      occupied.add(to.join(','));
    }
    assert.equal(occupied.size, nodes.length);
  }
});

test('a fully boxed-in node is skipped rather than forced', () => {
  // the centre of a full 3x3 block on a 3x3 board has nowhere legal to go
  const moves = pickMoves(grid(3, 3), 9, 3, 3, seeded(7));
  assert.ok(moves.length < 9);
});

test('picks a different set from tick to tick', () => {
  const a = JSON.stringify(pickMoves(grid(4, 4, 3), 4, 20, 20, seeded(11)));
  const b = JSON.stringify(pickMoves(grid(4, 4, 3), 4, 20, 20, seeded(12)));
  assert.notEqual(a, b);
});

// --- shape dance: one offset per shape, wandering on a leash ---------------

test('a drifting shape never leaves its leash', () => {
  for (let s = 0; s < 20; s++) {
    const rand = seeded(s + 1);
    let off = [0, 0];
    for (let t = 0; t < 200; t++) {
      off = wander(off, 2, rand);
      assert.ok(Math.abs(off[0]) <= 2 && Math.abs(off[1]) <= 2, `escaped: ${off}`);
    }
  }
});

test('each tick drifts by at most one grid unit per axis', () => {
  const rand = seeded(5);
  let off = [0, 0];
  for (let t = 0; t < 200; t++) {
    const next = wander(off, 3, rand);
    assert.ok(Math.abs(next[0] - off[0]) <= 1 && Math.abs(next[1] - off[1]) <= 1,
      `jumped ${off} -> ${next}`);
    off = next;
  }
});

test('a leash of zero pins the shape at rest', () => {
  const rand = seeded(9);
  let off = [0, 0];
  for (let t = 0; t < 30; t++) off = wander(off, 0, rand);
  assert.deepEqual(off, [0, 0]);
});

test('picks exactly as many shapes as asked, without repeats', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const picked = pickDancers(keys, 3, seeded(1));
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
  assert.ok(picked.every((k) => keys.includes(k)));
});

test('never picks more shapes than there are', () => {
  assert.equal(pickDancers(['a', 'b'], 6, seeded(2)).length, 2);
  assert.deepEqual(pickDancers([], 4, seeded(3)), []);
});

test('leaves the caller list alone', () => {
  const keys = ['a', 'b', 'c', 'd'];
  pickDancers(keys, 2, seeded(4));
  assert.deepEqual(keys, ['a', 'b', 'c', 'd']);
});

test('spreads the picks around rather than favouring the same shapes', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const rand = seeded(6);
  const seen = new Set();
  for (let t = 0; t < 40; t++) for (const k of pickDancers(keys, 2, rand)) seen.add(k);
  assert.equal(seen.size, keys.length);
});

test('the drift actually roams rather than sitting still', () => {
  const rand = seeded(13);
  let off = [0, 0];
  const seen = new Set();
  for (let t = 0; t < 200; t++) { off = wander(off, 2, rand); seen.add(off.join(',')); }
  assert.ok(seen.size > 8, `only reached ${seen.size} offsets`);
});
