// Engine checks without any model call: branching, loops, parallel steps,
// limits with a fallback, waiting for a person and resuming, recorded steps.
//   BOOKS_DB_PATH=/tmp/copy.db node server/workflow/test/engine.test.mjs
import assert from 'node:assert/strict';
import { defineGraph, parallel, runGraph, resumeRun, END } from '../engine.js';
import { getRun } from '../store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// branching, a loop, two steps side by side
const g1 = defineGraph({
  name: 'test-branch', start: 'a',
  nodes: {
    a: () => ({ n: 0 }), inc: (s) => ({ n: s.n + 1 }), fork: () => ({}),
    x: async () => { await sleep(50); return { x: 1 }; }, y: async () => { await sleep(50); return { y: 2 }; }, done: () => ({ ok: true }),
  },
  edges: { a: 'inc', inc: (s) => (s.n < 3 ? 'inc' : 'fork'), fork: parallel(['x', 'y'], 'done'), done: END },
});
const t = Date.now();
const r1 = await runGraph(g1, {}, { subject: 'test:1' });
assert.equal(r1.state.n, 3);
assert.equal(r1.state.x + r1.state.y, 3);
assert.ok(Date.now() - t < 95, 'x and y ran side by side');
assert.deepEqual(r1.trace.map((s) => s.node), ['a', 'inc', 'inc', 'inc', 'fork', 'x', 'y', 'done']);
assert.equal(getRun(r1.runId).steps.length, 8);
assert.equal(getRun(r1.runId).status, 'done');

// a step limit hands over to the fallback node, which runs
const g2 = defineGraph({
  name: 'test-limit', start: 'loop',
  nodes: { loop: () => ({}), fb: (s) => ({ fell: s.limitReached }) },
  edges: { loop: 'loop', fb: END }, limits: { maxSteps: 5, fallback: 'fb' },
});
const r2 = await runGraph(g2, {}, { dryRun: true });
assert.equal(r2.state.fell, 'steps');
assert.equal(r2.runId, null, 'dry runs are not recorded');

// waiting for a person, then resuming with their answer
const g3 = defineGraph({
  name: 'test-wait', start: 'ask',
  nodes: { ask: (s) => (s.answer ? {} : { $interrupt: { reason: 'need a person', resumeAt: 'use' } }), use: (s) => ({ result: s.answer * 2 }) },
  edges: { ask: 'use', use: END },
});
const r3 = await runGraph(g3, {}, { subject: 'test:3' });
assert.equal(r3.status, 'waiting');
assert.equal(getRun(r3.runId).status, 'waiting');
const r3b = await resumeRun(g3, r3.runId, { answer: 21 });
assert.equal(r3b.state.result, 42);
assert.equal(getRun(r3.runId).status, 'done');

// a failing node fails the run, recorded
const g4 = defineGraph({ name: 'test-fail', start: 'boom', nodes: { boom: () => { throw new Error('boom'); } }, edges: {} });
const err = await runGraph(g4, {}, {}).catch((e) => e);
assert.equal(err.message, 'boom');
assert.equal(getRun(err.workflow.runId).status, 'failed');

// an edge to a node that does not exist is caught when the graph is defined
assert.throws(() => defineGraph({ name: 'bad', start: 'a', nodes: { a: () => ({}) }, edges: { a: 'nope' } }));

console.log('engine: all checks passed');
