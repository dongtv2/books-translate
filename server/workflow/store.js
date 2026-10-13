// Recorded workflow runs and their steps (engine.js), for inspecting what a
// run did and for resuming a run that waits for a person.
import { db } from '../db.js';
import '../auth/store.js'; // users table

db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    graph TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting', 'done', 'failed')),
    current_node TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_subject ON workflow_runs(subject, created_at);
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    node TEXT NOT NULL,
    status TEXT NOT NULL,
    ms INTEGER NOT NULL DEFAULT 0,
    patch_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id, seq);
`);

// Big values (vocabulary sets, prompts) are not worth keeping per run.
const STATE_SKIP = new Set(['vocabState', 'ctx']);
const stateJson = (state) => JSON.stringify(state, (k, v) => (STATE_SKIP.has(k) ? undefined : v instanceof Set ? [...v] : v instanceof Map ? undefined : v));

export function createRun({ graph, subject, userId, state }) {
  return db.prepare('INSERT INTO workflow_runs (graph, subject, started_by, state_json) VALUES (?, ?, ?, ?)')
    .run(graph, subject, userId, stateJson(state)).lastInsertRowid;
}

export function recordStep(runId, step) {
  const seq = db.prepare('SELECT COUNT(*) AS c FROM workflow_steps WHERE run_id = ?').get(runId).c;
  db.prepare('INSERT INTO workflow_steps (run_id, seq, node, status, ms, patch_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, seq, step.node, step.status, step.ms, JSON.stringify(step.patch ?? {}));
}

export function updateRun(runId, { status, state, currentNode, note, finished }) {
  db.prepare(`
    UPDATE workflow_runs SET status = ?, state_json = ?, current_node = ?, note = COALESCE(?, note), updated_at = datetime('now'),
      finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
    WHERE id = ?
  `).run(status, stateJson(state), currentNode, note ?? null, finished ? 1 : 0, runId);
}

export function getRun(runId) {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const steps = db.prepare('SELECT node, status, ms, patch_json, created_at FROM workflow_steps WHERE run_id = ? ORDER BY seq').all(runId)
    .map(({ patch_json: p, ...s }) => ({ ...s, patch: JSON.parse(p) }));
  const { state_json: sj, ...rest } = run;
  return { ...rest, state: JSON.parse(sj), steps };
}

export function runsFor(subject, limit = 10) {
  return db.prepare('SELECT id, graph, status, note, created_at, finished_at FROM workflow_runs WHERE subject = ? ORDER BY id DESC LIMIT ?').all(subject, limit);
}
