// Activity log: classification, redaction, batching, retention, and the
// real server end to end (sign-in, edits, refusals, admin API, overhead).
// Runs on a throwaway copy of the database, never on server/data:
//   npm run test:activity
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-activity-'));
const dbPath = path.join(tmp, 'books.db');
const source = process.env.SOURCE_DB || path.join(root, 'server/data/books.db');
if (fs.existsSync(source)) {
  const { default: Database } = await import('better-sqlite3');
  await new Database(source, { readonly: true }).backup(dbPath);
}
process.env.BOOKS_DB_PATH = dbPath;

const { db } = await import('../db.js');
const log = await import('../activityLog.js');
const { createSession, createUser } = await import('../auth/store.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// ---- unit ---------------------------------------------------------------
await test('reads are not logged; edits are named by action', () => {
  assert.equal(log.classify('GET', '/api/vocabulary'), null);
  assert.deepEqual(log.classify('PATCH', '/api/vocabulary/12'), { action: 'vocab.update', entityType: 'vocabulary', entityId: 12 });
  assert.equal(log.classify('POST', '/api/paragraphs/5/translate').action, 'paragraph.translate');
  assert.equal(log.classify('POST', '/api/paragraphs/5/assistant/9/approve').action, 'assistant.approve');
  assert.equal(log.classify('POST', '/api/paragraphs/5/assistant').action, 'assistant.ask');
  assert.equal(log.classify('POST', '/api/auth/login').action, 'auth.login');
  assert.equal(log.classify('POST', '/api/vocabulary/merge').action, 'vocab.merge');
  assert.equal(log.classify('DELETE', '/api/chapters/3').entityType, 'chapters');
  assert.equal(log.classify('POST', '/api/something/new').action, 'other.post');
});

await test('noisy requests are skipped', () => {
  for (const [m, p] of [['PUT', '/api/me/reading'], ['PUT', '/api/me/preferences'], ['POST', '/api/tts/speak'], ['POST', '/api/vocabulary/3/review'], ['POST', '/api/vocabulary/suggest']]) {
    assert.equal(log.classify(m, p), null, `${m} ${p}`);
  }
});

await test('bodies are reduced to field names; secrets never kept', () => {
  const d = log.safeDetail('/api/settings', { provider: 'openai', openai: { apiKey: 'sk-SECRET' }, apiKey: 'sk-SECRET', password: 'hunter2' });
  assert.deepEqual(d.fields, ['provider', 'openai']);
  assert.ok(!JSON.stringify(d).includes('SECRET'));
  assert.ok(!JSON.stringify(d).includes('hunter2'));
  const login = log.safeDetail('/api/auth/login', { email: ' A@B.c ', password: 'hunter2' });
  assert.equal(login.email, 'a@b.c');
  assert.ok(!JSON.stringify(login).includes('hunter2'));
  const merge = log.safeDetail('/api/vocabulary/merge', { keepId: 3, mergeIds: [4, '5'] });
  assert.deepEqual([merge.keepId, merge.mergeIds], [3, [4, 5]]);
  const para = log.safeDetail('/api/paragraphs/1', { vietnamese_md: 'nội dung sách', status: 'translated' });
  assert.ok(!JSON.stringify(para).includes('nội dung'));
  assert.deepEqual(log.safeDetail('/x', null), {});
  assert.deepEqual(log.safeDetail('/x', [1, 2]), {});
});

await test('rows are batched and written in one flush', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c;
  for (let i = 0; i < 50; i += 1) {
    log.record({ at: new Date().toISOString(), user_id: null, action: 'test.batch', method: 'POST', path: '/t', entity_type: null, entity_id: null, status: 200, ms: 1, ip: '', detail: '{}' });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM activity_log').get().c, before, 'nothing written before flush');
  assert.equal(log.flush(), 50);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'test.batch'").get().c, 50);
});

await test('a failing row is counted, not thrown, and the rest of its batch is kept', () => {
  const dropped = log.stats.dropped;
  const row = (action, user_id = null) => ({ at: new Date().toISOString(), user_id, action, method: 'POST', path: '/t', entity_type: null, entity_id: null, status: 200, ms: 1, ip: '', detail: '{}' });
  log.record(row('test.good'));
  log.record(row('test.fk', 999999999));
  log.record(row('test.good'));
  let written;
  assert.doesNotThrow(() => { written = log.flush(); });
  assert.equal(written, 2);
  assert.equal(log.stats.dropped, dropped + 1);
  assert.match(log.stats.lastError, /FOREIGN KEY/);
});

await test('retention deletes only old rows', () => {
  db.prepare("INSERT INTO activity_log (at, action, method, path, status) VALUES ('2000-01-01T00:00:00.000Z', 'test.old', 'POST', '/t', 200)").run();
  log.prune(30);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'test.old'").get().c, 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'test.batch'").get().c > 0);
});

await test('ACTIVITY_LOG=0 switches recording off', () => {
  process.env.ACTIVITY_LOG = '0';
  const before = log.stats.written;
  log.record({ at: new Date().toISOString(), user_id: null, action: 'test.off', method: 'POST', path: '/t', entity_type: null, entity_id: null, status: 200, ms: 1, ip: '', detail: '{}' });
  log.flush();
  assert.equal(log.stats.written, before);
  delete process.env.ACTIVITY_LOG;
});

await test('every logged action has a Vietnamese label on the admin page', () => {
  const src = fs.readFileSync(path.join(root, 'server/activityLog.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src/components/admin/ActivityLog.jsx'), 'utf8');
  const actions = [...src.matchAll(/, '([a-z_.]+)', (?:'[a-z]+'|null)\]/g)].map((m) => m[1]);
  assert.ok(actions.length > 30);
  assert.deepEqual(actions.filter((a) => !ui.includes(`'${a}'`)), []);
});

// ---- the real server ----------------------------------------------------
let admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
if (!admin) admin = { id: createUser({ email: 'admin@test.local', roles: ['admin'] }).id };
const { token } = createSession(admin.id);
const guestId = createUser({ email: `guest-${Date.now()}@test.local`, roles: ['guest'] }).id;
const guestToken = createSession(guestId).token;
log.flush();
db.close();

const port = 39000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root, env: { ...process.env, BOOKS_DB_PATH: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const base = `http://localhost:${port}`;
const call = (method, p, { body, as = token } = {}) => fetch(base + p, {
  method,
  headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', ...(as ? { Cookie: `bt_session=${as}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

try {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  await test('edits, refusals and failed sign-ins all reach the log, without secrets', async () => {
    const v = await (await call('GET', '/api/vocabulary?pageSize=1')).json();
    const id = v.rows[0].id;
    assert.equal((await call('PATCH', `/api/vocabulary/${id}`, { body: { status: 'Đang học' } })).status, 200);
    assert.equal((await call('DELETE', `/api/vocabulary/${id}`, { as: guestToken })).status, 403);
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nobody@test.local', password: 'Wrong-pass-123' }, as: null })).status, 401);
    const list = await (await call('GET', '/api/admin/activity?pageSize=20')).json();
    const actions = list.rows.map((r) => `${r.action}:${r.status}`);
    assert.ok(actions.includes('vocab.update:200'), actions.join(' '));
    assert.ok(actions.includes('vocab.delete:403'), actions.join(' '));
    assert.ok(actions.includes('auth.login:401'), actions.join(' '));
    const refused = list.rows.find((r) => r.action === 'vocab.delete');
    assert.equal(refused.user_id, guestId);
    assert.equal(refused.entity_id, id);
    assert.ok(!JSON.stringify(list).includes('Wrong-pass-123'));
  });

  await test('filters, summary and health answer', async () => {
    const failed = await (await call('GET', '/api/admin/activity?failed=1')).json();
    assert.ok(failed.rows.length > 0 && failed.rows.every((r) => r.status >= 400));
    const vocab = await (await call('GET', '/api/admin/activity?group=vocab')).json();
    assert.ok(vocab.rows.every((r) => r.action.startsWith('vocab.')));
    const summary = await (await call('GET', '/api/admin/activity/summary?days=7')).json();
    assert.ok(summary.users.find((u) => u.id === admin.id).actions['vocab.update'] >= 1);
    assert.ok(summary.failedLogins >= 1);
    const health = await (await call('GET', '/api/admin/activity/health')).json();
    assert.equal(health.enabled, true);
    assert.ok(health.rows > 0);
  });

  await test('only admins can read the log', async () => {
    assert.equal((await call('GET', '/api/admin/activity', { as: guestToken })).status, 403);
    assert.equal((await call('GET', '/api/admin/activity', { as: null })).status, 401);
  });

  await test('logging adds no noticeable latency (200 edits)', async () => {
    const v = await (await call('GET', '/api/vocabulary?pageSize=1')).json();
    const id = v.rows[0].id;
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) await call('PATCH', `/api/vocabulary/${id}`, { body: { status: 'Đang học' } });
    const perRequest = (performance.now() - t0) / 200;
    console.log(`    ${perRequest.toFixed(2)} ms per PATCH including logging`);
    assert.ok(perRequest < 50, `too slow: ${perRequest} ms`);
    const health = await (await call('GET', '/api/admin/activity/health')).json();
    assert.equal(health.dropped, 0, health.lastError);
  });
} catch (err) {
  console.error(serverOut);
  throw err;
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`activity log: ${passed} checks passed`);
