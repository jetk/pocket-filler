import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacency, nextHop, advance, positionOf, onGraph, spawn } from '../src/trace.js';

// a square: (0,0)-(2,0)-(2,2)-(0,2) and back
const square = [[0, 0, 2, 0], [2, 0, 2, 2], [2, 2, 0, 2], [0, 2, 0, 0]];

test('the drawing is the graph, both ways along every line', () => {
  const adj = adjacency(square);
  assert.equal(adj.size, 4);
  assert.deepEqual(adj.get('0,0').sort(), [[0, 2], [2, 0]]);
});

test('a line whose ends met is not somewhere to run', () => {
  assert.equal(adjacency([[3, 3, 3, 3]]).size, 0);
});

test('two lines on the same pair of nodes only join them once', () => {
  const adj = adjacency([[0, 0, 1, 0], [1, 0, 0, 0]]);
  assert.equal(adj.get('0,0').length, 1);
});

test('a tracer does not turn round unless it has to', () => {
  const adj = adjacency(square);
  for (let i = 0; i < 20; i++) {
    assert.notDeepEqual(nextHop([2, 0], [0, 0], adj), [0, 0]);
  }
});

test('at a dead end it turns round rather than stopping', () => {
  const adj = adjacency([[0, 0, 1, 0]]);
  assert.deepEqual(nextHop([1, 0], [0, 0], adj), [0, 0]);
});

test('a partial step stays on its edge', () => {
  const adj = adjacency(square);
  const t = advance({ from: [0, 0], to: [2, 0], t: 0 }, 0.25, adj);
  assert.deepEqual(t.from, [0, 0]);
  assert.deepEqual(t.to, [2, 0]);
  assert.equal(t.t, 0.25);
});

test('crossing a node hands the tracer to the next edge', () => {
  const adj = adjacency(square);
  const t = advance({ from: [0, 0], to: [2, 0], t: 0.5 }, 0.75, adj);
  assert.deepEqual(t.from, [2, 0], 'it is now leaving the node it reached');
  assert.ok(Math.abs(t.t - 0.25) < 1e-9);
});

test('a step worth several edges walks them rather than teleporting', () => {
  const adj = adjacency(square);
  const t = advance({ from: [0, 0], to: [2, 0], t: 0 }, 3.5, adj);
  assert.ok(adj.has(t.from.join(',')) && adj.has(t.to.join(',')));
  assert.ok(t.t > 0 && t.t < 1);
});

test('a tracer with nowhere to go sits on the node instead of flying off', () => {
  const adj = new Map([['1,0', []]]);   // an isolated node: arrived, no way on
  const t = advance({ from: [0, 0], to: [1, 0], t: 0.9 }, 0.5, adj);
  assert.deepEqual(t.from, [1, 0]);
  assert.deepEqual(t.to, [1, 0]);
  assert.equal(positionOf(t)[0], 1);
});

test('position is the point between the ends, which is the fractional bit', () => {
  assert.deepEqual(positionOf({ from: [0, 0], to: [2, 4], t: 0.5 }), [1, 2]);
});

test('a tracer notices when its ground has gone', () => {
  const adj = adjacency(square);
  assert.equal(onGraph({ from: [0, 0], to: [2, 0] }, adj), true);
  assert.equal(onGraph({ from: [9, 9], to: [2, 0] }, adj), false);
});

test('spawning lands on the graph, and on an empty sheet lands nowhere', () => {
  const t = spawn(adjacency(square));
  assert.ok(onGraph(t, adjacency(square)));
  assert.equal(spawn(adjacency([])), null);
});
