// Backups, rotation, integrity, merge undo, the restore script and the
// admin data API — on a throwaway copy of the database and a temp backup
// folder, never on server/data:
//   npm run test:database
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-database-'));
const dbPath = path.join(tmp, 'books.db');
const bdir = path.join(tmp, 'backups');
const source = process.env.SOURCE_DB || path.join(root, 'server/data/books.db');
await new Database(source, { readonly: true }).backup(dbPath);
// A port nothing listens on, so the restore script's "is the server
// running?" check does not see a developer's own server.
const port = 39000 + Math.floor(Math.random() * 900);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: bdir, BACKUP_AUTO: '0', PORT: String(port) });

const { db } = await import('../db.js');
const backup = await import('../backup.js');
const vocab = await import('../vocabStore.js');
const { createSession, createUser } = await import('../auth/store.js');
const { normalizeTerm } = await import('../normalize.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

await test('a backup is a checked, complete copy with its sidecar', () => {
  const b = backup.createBackup({ kind: 'manual', note: 'test' });
  const file = path.join(bdir, b.name);
  assert.ok(fs.existsSync(file) && fs.existsSync(`${file}.json`));
  assert.equal(b.integrity, 'ok');
  assert.equal(b.counts.paragraphs, count('paragraphs'));
  assert.equal(b.counts.vocabulary, count('vocabulary'));
  console.log(`    ${(b.size / 1048576).toFixed(1)} MB in ${b.ms} ms`);
  const listed = backup.listBackups()[0];
  assert.equal(listed.name, b.name);
  assert.equal(listed.verified, true);
});

await test('only listed names resolve to files', () => {
  const name = backup.listBackups()[0].name;
  assert.ok(backup.backupPath(name));
  for (const bad of ['../books.db', `../${name}`, 'books.db', '', '/etc/passwd', `${name}.json`]) assert.equal(backup.backupPath(bad), null, bad);
});

await test('a damaged file fails verification', () => {
  const bad = path.join(tmp, 'broken.db');
  fs.writeFileSync(bad, 'not a database');
  assert.equal(backup.verifyFile(bad).ok, false);
  const truncated = path.join(tmp, 'truncated.db');
  const good = fs.readFileSync(path.join(bdir, backup.listBackups()[0].name));
  fs.writeFileSync(truncated, good.subarray(0, Math.floor(good.length / 3)));
  assert.equal(backup.verifyFile(truncated).ok, false);
});

await test('rotation keeps 7 daily + weekly autos, 10 per other kind and the newest good one', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const day = (n) => new Date(now - n * 86400000).toISOString();
  const list = [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `auto-${String(i).padStart(2, '0')}`, kind: 'auto', createdAt: day(i), verified: true })),
    ...Array.from({ length: 14 }, (_, i) => ({ name: `manual-${String(i).padStart(2, '0')}`, kind: 'manual', createdAt: day(i), verified: true })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const removed = new Set(backup.rotationPlan(list, now));
  for (let i = 0; i < 7; i += 1) assert.ok(!removed.has(`auto-0${i}`), `daily ${i} kept`);
  const keptAutos = list.filter((b) => b.kind === 'auto' && !removed.has(b.name)).length;
  assert.ok(keptAutos >= 10 && keptAutos <= 12, `7 daily + weekly, got ${keptAutos}`);
  assert.ok(removed.has('auto-39'));
  assert.equal(list.filter((b) => b.kind === 'manual' && !removed.has(b.name)).length, 10);
  // the newest good backup survives even when it is the only one of its kind
  assert.deepEqual(backup.rotationPlan([{ name: 'x', kind: 'manual', createdAt: day(0), verified: true }], now), []);
});

await test('an impossible backup folder fails cleanly; a migration backup reports instead of throwing', () => {
  process.env.BACKUP_DIR = '/dev/null/nope';
  assert.throws(() => backup.createBackup({ kind: 'manual' }));
  assert.equal(backup.backupBeforeMigration('test'), null);
  assert.throws(() => backup.backupBeforeMigration('test', { required: true }));
  process.env.BACKUP_DIR = bdir;
});

await test('the live database passes the integrity check', () => {
  const r = backup.integrityReport();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(backup.tableStats().find((t) => t.name === 'paragraphs').rows > 0);
});

await test('undoing a merge puts back the entry, its progress, history and the kept entry', () => {
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const add = (term, meaning) => db.prepare(`INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added)
    VALUES (?, ?, '/x/', 'Noun', ?, 'ex', 'Khác', '2026-01-01')`).run(term, normalizeTerm(term), meaning).lastInsertRowid;
  const a = add('Zztestkeep', 'nghĩa giữ');
  const b = add('Zztestmerge', 'nghĩa gộp');
  db.prepare("INSERT INTO vocab_progress (user_id, vocabulary_id, status, repetitions, due_date, last_reviewed_at) VALUES (?, ?, 'Thành thạo', 5, '2026-12-01', '2026-01-02T00:00:00.000Z')").run(uid, b);
  const logIds = [1, 2].map(() => db.prepare("INSERT INTO review_log (vocabulary_id, grade, user_id) VALUES (?, 'good', ?)").run(b, uid).lastInsertRowid);
  const rowB = db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(b);

  vocab.mergeVocab(a, [b], { reason: 'manual', userId: uid });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE id = ?').get(b).c, 0);
  assert.equal(db.prepare('SELECT meaning_vi FROM vocabulary WHERE id = ?').get(a).meaning_vi, 'nghĩa giữ; nghĩa gộp');
  assert.equal(db.prepare('SELECT status FROM vocab_progress WHERE vocabulary_id = ? AND user_id = ?').get(a, uid).status, 'Thành thạo');

  const entry = vocab.mergeHistory().find((m) => m.merged_id === Number(b));
  assert.equal(entry.undoable, true);
  const result = vocab.undoMerge(entry.id, { userId: uid });
  assert.deepEqual(result.restored, ['Zztestmerge']);
  assert.deepEqual(db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(b), rowB);
  assert.equal(db.prepare('SELECT meaning_vi FROM vocabulary WHERE id = ?').get(a).meaning_vi, 'nghĩa giữ');
  assert.equal(db.prepare('SELECT status FROM vocab_progress WHERE vocabulary_id = ? AND user_id = ?').get(b, uid).status, 'Thành thạo');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM vocab_progress WHERE vocabulary_id = ? AND user_id = ?').get(a, uid).c, 0);
  for (const id of logIds) assert.equal(db.prepare('SELECT vocabulary_id FROM review_log WHERE id = ?').get(id).vocabulary_id, Number(b));
  assert.throws(() => vocab.undoMerge(entry.id), /đã được hoàn tác/);

  // edited after the merge: the newer content of the kept entry stays
  vocab.mergeVocab(a, [b], { reason: 'manual', userId: uid });
  db.prepare("UPDATE vocabulary SET meaning_vi = 'sửa tay', updated_at = datetime('now', '+1 minute') WHERE id = ?").run(a);
  const again = vocab.mergeHistory().find((m) => m.merged_id === Number(b) && !m.undone_at);
  const r2 = vocab.undoMerge(again.id);
  assert.equal(db.prepare('SELECT meaning_vi FROM vocabulary WHERE id = ?').get(a).meaning_vi, 'sửa tay');
  assert.ok(r2.notes.length > 0);
  db.prepare('DELETE FROM vocabulary WHERE id IN (?, ?)').run(a, b);
});

await test('merges made before undo existed are listed but not undoable', () => {
  const old = vocab.mergeHistory().filter((m) => m.reason.startsWith('normalize') || m.reason === 'cleanup');
  assert.ok(old.every((m) => !m.undoable));
});

// ---- the admin API on a real server -------------------------------------
const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const token = createSession(admin.id).token;
const guestToken = createSession(createUser({ email: `g-${Date.now()}@test.local`, roles: ['guest'] }).id).token;
db.close();

const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
const base = `http://localhost:${port}/api/admin/database`;
const call = (method, p, { body, as = token } = {}) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', Cookie: `bt_session=${as}` }, body: body ? JSON.stringify(body) : undefined,
});
try {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  await test('status, backup, download and integrity over HTTP', async () => {
    const st = await (await call('GET', '/status')).json();
    assert.ok(st.main > 0 && st.tables.length > 5);
    const created = await call('POST', '/backups', { body: { note: 'http' } });
    assert.equal(created.status, 201);
    const b = await created.json();
    const dl = await call('GET', `/backups/${b.name}/download`);
    assert.equal(dl.status, 200);
    assert.equal((await dl.arrayBuffer()).byteLength, b.size);
    assert.equal((await call('GET', `/backups/${encodeURIComponent('../books.db')}/download`)).status, 404);
    assert.equal((await (await call('POST', '/integrity')).json()).ok, true);
    assert.ok(Array.isArray(await (await call('GET', '/merges')).json()));
  });
  await test('non-admins are refused; backup actions reach the activity log', async () => {
    assert.equal((await call('GET', '/status', { as: guestToken })).status, 403);
    assert.equal((await call('POST', '/backups', { as: guestToken })).status, 403);
    const log = await (await fetch(`http://localhost:${port}/api/admin/activity?group=admin`, { headers: { Cookie: `bt_session=${token}` } })).json();
    const actions = log.rows.map((r) => r.action);
    assert.ok(actions.includes('admin.backup.create') && actions.includes('admin.backup.download'), actions.join(' '));
  });
  await test('the restore script refuses while the server runs', () => {
    const r = spawnSync(process.execPath, ['server/scripts/restoreBackup.mjs', backup.listBackups()[0].name, '--yes'], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /đang chạy/);
  });
} catch (err) {
  console.error(out);
  throw err;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
}

await test('restore brings back the backup and keeps the replaced database', () => {
  const name = backup.listBackups().find((b) => b.kind === 'manual').name;
  const live = new Database(dbPath);
  const before = live.prepare('SELECT COUNT(*) AS c FROM books').get().c;
  live.prepare("INSERT INTO books (title_en) VALUES ('Added after the backup')").run();
  live.close();
  const r = spawnSync(process.execPath, ['server/scripts/restoreBackup.mjs', name, '--yes'], { cwd: root, env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const restored = new Database(dbPath, { readonly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS c FROM books').get().c, before);
  restored.close();
  const safety = backup.listBackups().find((b) => b.kind === 'pre-migration' && /khôi phục/.test(b.note || ''));
  assert.ok(safety, 'the replaced database was backed up first');
  const kept = new Database(path.join(bdir, safety.name), { readonly: true });
  assert.equal(kept.prepare('SELECT COUNT(*) AS c FROM books').get().c, before + 1);
  kept.close();
  const bad = spawnSync(process.execPath, ['server/scripts/restoreBackup.mjs', path.join(tmp, 'broken.db'), '--yes'], { cwd: root, env: process.env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`database: ${passed} checks passed`);
