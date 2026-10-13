// A small graph-based workflow engine. A workflow is a set of nodes (async
// steps) and edges that decide, from the state after each step, which node
// runs next — so a run can branch, loop back to repair what a check found,
// run independent steps side by side, or stop and wait for a person — instead
// of a fixed chain of calls.
//
//   defineGraph({
//     name, start,
//     nodes: { name: async (state, ctx) => patch },     // patch is merged into state
//     edges: { name: 'next' | (state) => 'next' | parallel(['a', 'b'], 'then') },
//     limits: { maxSteps, timeoutMs, fallback },         // fallback: node run once when a limit is hit
//   })
//
// A node returning { $interrupt: { reason, resumeAt } } pauses the run
// (status "waiting"); resumeRun(id, patch) continues it at `resumeAt`.
// Every step is recorded (store.js) unless the run is a dry run, so a run can
// be inspected afterwards and survives a server restart while waiting.
import { createRun, recordStep, updateRun, getRun } from './store.js';

export const END = 'end';

export function defineGraph(def) {
  for (const [from, edge] of Object.entries(def.edges || {})) {
    if (!def.nodes[from]) throw new Error(`Graph ${def.name}: edge from unknown node "${from}"`);
    for (const to of staticTargets(edge)) {
      if (to !== END && !def.nodes[to]) throw new Error(`Graph ${def.name}: edge ${from} → unknown node "${to}"`);
    }
  }
  if (!def.nodes[def.start]) throw new Error(`Graph ${def.name}: unknown start node "${def.start}"`);
  return { limits: {}, ...def };
}

// Run nodes `names` at the same time, merge their patches (in list order),
// then go to `then`.
export function parallel(names, then) {
  return { parallel: names, then };
}

function staticTargets(edge) {
  if (typeof edge === 'string') return [edge];
  if (edge?.parallel) return [...edge.parallel, edge.then];
  return [];
}

// Short, JSON-safe summary of a patch for the step log.
function summarize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return depth > 2 ? `[${value.length}]` : value.slice(0, 8).map((v) => summarize(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([k, v]) => [k, summarize(v, depth + 1)]));
  }
  return String(value);
}

class LimitReached extends Error {}

// Runs `graph` from its start node (or from `resume.at` with `resume.state`).
// Options: dryRun (nothing recorded), subject (e.g. "paragraph:12"), userId,
// onEvent({ type, node, ... }) for progress.
export async function runGraph(graph, input, { dryRun = false, subject = '', userId = null, onEvent, resume } = {}) {
  const limits = { maxSteps: 25, timeoutMs: 180000, ...graph.limits };
  const started = Date.now();
  let state = resume ? resume.state : { ...input };
  const runId = resume?.runId ?? (dryRun ? null : createRun({ graph: graph.name, subject, userId, state }));
  const trace = resume?.trace ? [...resume.trace] : [];
  const ctx = { runId, dryRun, userId, llmCalls: 0, emit: (e) => onEvent?.({ runId, ...e }) };
  let current = resume ? resume.at : graph.start;
  let usedFallback = false;

  const runNode = async (name) => {
    const t0 = Date.now();
    ctx.emit({ type: 'node:start', node: name });
    try {
      const patch = (await graph.nodes[name](state, ctx)) || {};
      const step = { node: name, ms: Date.now() - t0, status: patch.$interrupt ? 'interrupted' : 'ok', patch: summarize(patch) };
      trace.push(step);
      if (!dryRun) recordStep(runId, step);
      ctx.emit({ type: 'node:done', node: name, ms: step.ms });
      return patch;
    } catch (err) {
      const step = { node: name, ms: Date.now() - t0, status: 'error', patch: { error: err.message } };
      trace.push(step);
      if (!dryRun) recordStep(runId, step);
      ctx.emit({ type: 'node:error', node: name, error: err.message });
      throw err;
    }
  };
  const merge = (patch) => {
    const { $interrupt, ...rest } = patch;
    state = { ...state, ...rest };
    return $interrupt;
  };

  try {
    while (current && current !== END) {
      const over = trace.length >= limits.maxSteps || Date.now() - started > limits.timeoutMs;
      // The fallback node, once chosen, gets to run.
      if (over && !(usedFallback && current === limits.fallback)) {
        if (limits.fallback && !usedFallback && current !== limits.fallback) {
          usedFallback = true;
          state = { ...state, limitReached: trace.length >= limits.maxSteps ? 'steps' : 'time' };
          current = limits.fallback;
          continue;
        }
        throw new LimitReached(`Workflow ${graph.name} vượt giới hạn (${trace.length} bước, ${Date.now() - started} ms).`);
      }
      const interrupt = merge(await runNode(current));
      if (interrupt) {
        if (!dryRun) updateRun(runId, { status: 'waiting', state, currentNode: interrupt.resumeAt, note: interrupt.reason });
        ctx.emit({ type: 'run:waiting', reason: interrupt.reason });
        return { runId, status: 'waiting', state, trace, waitingFor: interrupt, llmCalls: ctx.llmCalls, ms: Date.now() - started };
      }

      const edge = graph.edges[current];
      let next = typeof edge === 'function' ? edge(state) : edge;
      if (next?.parallel) {
        const patches = await Promise.all(next.parallel.map(runNode));
        for (const p of patches) merge(p);
        next = next.then;
        if (typeof next === 'function') next = next(state);
      }
      current = next || END;
      if (!dryRun) updateRun(runId, { status: 'running', state, currentNode: current });
    }
    if (!dryRun) updateRun(runId, { status: 'done', state, currentNode: null, finished: true });
    ctx.emit({ type: 'run:done' });
    return { runId, status: 'done', state, trace, llmCalls: ctx.llmCalls, ms: Date.now() - started };
  } catch (err) {
    if (!dryRun) updateRun(runId, { status: 'failed', state, currentNode: current, note: err.message, finished: true });
    ctx.emit({ type: 'run:failed', error: err.message });
    err.workflow = { runId, trace };
    throw err;
  }
}

// Continues a waiting run, with `patch` (e.g. the decision a person made)
// merged into its state first.
export async function resumeRun(graph, runId, patch = {}, options = {}) {
  const run = getRun(runId);
  if (!run || run.status !== 'waiting') throw new Error('Không có lượt chạy nào đang chờ với mã này.');
  return runGraph(graph, null, {
    ...options,
    resume: { runId, at: run.current_node, state: { ...run.state, ...patch }, trace: run.steps },
  });
}
