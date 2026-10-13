// Book scopes: a restricted book must not leak through ANY route to a user
// who may not see it, and must stay fully usable for those who may.
// A restricted book is seeded with marker strings in every field; every
// route is called as an outsider and no answer may contain a marker.
// Runs on a throwaway copy of the database:
//   npm run test:access
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-access-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0' });

const { db } = await import('../db.js');
const access = await import('../bookAccess.js');
const { createSession, createUser } = await import('../auth/store.js');
await import('../discussions.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// ---- seed ------------------------------------------------------------------
const M = { title: 'MARKER-BOOK-TITLE', chapter: 'MARKER-CHAPTER', part: 'MARKER-PART', section: 'MARKER-SECTION', text: 'MARKER-PARAGRAPH-TEXT', vi: 'MARKER-VIETNAMESE', thread: 'markerthreadterm', post: 'MARKER-POST-BODY', gloss: 'MARKER-GLOSSARY', example: 'MARKER-EXAMPLE' };
const markers = Object.values(M);
const now = Date.now();
const mkUser = (name, roles) => createUser({ email: `${name}-${now}@test.local`, name, roles });
const outsider = mkUser('outsider', ['learner']);
const outsiderEditor = mkUser('outsider-editor', ['editor']);
const invited = mkUser('invited', ['learner']);
const viaGroup = mkUser('viagroup', ['learner']);
const owner = mkUser('owner', ['editor']);
const admin = db.prepare("SELECT u.* FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const groupId = db.prepare('INSERT INTO groups (name) VALUES (?)').run(`readers-${now}`).lastInsertRowid;
db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, viaGroup.id);

const secret = {};
secret.book = db.prepare("INSERT INTO books (title_en, title_vi, context_note) VALUES (?, ?, ?)").run(M.title, M.title, M.title).lastInsertRowid;
secret.part = db.prepare('INSERT INTO parts (book_id, order_index, title) VALUES (?, 0, ?)').run(secret.book, M.part).lastInsertRowid;
secret.chapter = db.prepare('INSERT INTO chapters (book_id, part_id, order_index, title) VALUES (?, ?, 0, ?)').run(secret.book, secret.part, M.chapter).lastInsertRowid;
secret.section = db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, 0, ?)').run(secret.chapter, M.section).lastInsertRowid;
secret.paragraph = db.prepare("INSERT INTO paragraphs (section_id, order_index, english_md, vietnamese_md, status) VALUES (?, 0, ?, ?, 'pending')").run(secret.section, `${M.text} zzlinkword`, M.vi).lastInsertRowid;
secret.thread = db.prepare(`INSERT INTO term_threads (book_id, chapter_id, section_id, paragraph_id, term, term_normalized, context)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(secret.book, secret.chapter, secret.section, secret.paragraph, M.thread, M.thread, M.text).lastInsertRowid;
secret.post = db.prepare("INSERT INTO term_posts (thread_id, user_id, kind, body) VALUES (?, ?, 'comment', ?)").run(secret.thread, owner.id, M.post).lastInsertRowid;
secret.glossary = db.prepare("INSERT INTO glossary (book_id, term, term_normalized, meaning_vi, note) VALUES (?, 'markerglossterm', 'markerglossterm', ?, ?)").run(secret.book, M.gloss, M.gloss).lastInsertRowid;
secret.assignment = db.prepare("INSERT INTO work_assignments (book_id, chapter_id, user_id, role) VALUES (?, ?, ?, 'translator')").run(secret.book, secret.chapter, outsider.id).lastInsertRowid;
secret.word = db.prepare(`INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, source_paragraph_id)
  VALUES ('Zzmarkerword', 'zzmarkerword', '', 'Noun', 'nghĩa', ?, 'Khác', '2026-01-01', ?)`).run(M.example, secret.paragraph).lastInsertRowid;
// the outsider once read it and marked it (before it was restricted)
db.prepare('INSERT INTO user_reading (user_id, book_id, chapter_id, paragraph_id) VALUES (?, ?, ?, ?)').run(outsider.id, secret.book, secret.chapter, secret.paragraph);
db.prepare('INSERT INTO paragraph_marks (user_id, paragraph_id, is_bookmarked) VALUES (?, ?, 1)').run(outsider.id, secret.paragraph);
access.setAccess(secret.book, { visibility: 'restricted', userIds: [invited.id], groupIds: [groupId], ownerId: owner.id });
// a word that occurs only in the restricted paragraph: its links must not show it
const linkWord = db.prepare("INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added) VALUES ('Zzlinkword', 'zzlinkword', '', 'Noun', 'x', '', 'Khác', '2026-01-01')").run().lastInsertRowid;
const publicChapter = db.prepare("SELECT c.id FROM chapters c JOIN books b ON b.id = c.book_id WHERE b.visibility = 'public' LIMIT 1").get().id;

const tokens = Object.fromEntries([['outsider', outsider], ['outsiderEditor', outsiderEditor], ['invited', invited], ['viaGroup', viaGroup], ['owner', owner], ['admin', admin]]
  .map(([k, u]) => [k, createSession(u.id).token]));

// ---- unit ----------------------------------------------------------------------
await test('names in path, query and body resolve to their book', () => {
  const refs = access.referencedEntities(`/api/discussions/posts/${secret.post}/vote`, { chapterId: String(secret.chapter) }, { source_paragraph_id: secret.paragraph });
  assert.deepEqual(refs, [['post', secret.post], ['chapter', secret.chapter], ['paragraph', secret.paragraph]]);
  for (const [kind, id] of [['book', secret.book], ['part', secret.part], ['chapter', secret.chapter], ['section', secret.section], ['paragraph', secret.paragraph], ['thread', secret.thread], ['post', secret.post], ['glossary', secret.glossary], ['assignment', secret.assignment]]) {
    assert.equal(access.bookOf(kind, id), Number(secret.book), kind);
  }
  assert.equal(access.bookOf('paragraph', 99999999), undefined);
});

await test('who sees the restricted book', () => {
  const req = (u, perms = []) => ({ user: u, permissions: new Set(perms) });
  assert.equal(access.canSeeBook(req(outsider), secret.book), false);
  assert.equal(access.canSeeBook(req(invited), secret.book), true);
  assert.equal(access.canSeeBook(req(viaGroup), secret.book), true);
  assert.equal(access.canSeeBook(req(owner), secret.book), true);
  assert.equal(access.canSeeBook(req(outsider, ['users.manage']), secret.book), true);
  assert.equal(access.canSeeBook(req(outsider), db.prepare("SELECT id FROM books WHERE visibility = 'public' LIMIT 1").get().id), true);
});

db.close();

// ---- HTTP -----------------------------------------------------------------------
async function startServer(env = {}) {
  const port = 39000 + Math.floor(Math.random() * 900);
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const call = async (method, p, { as, body } = {}) => {
    const res = await fetch(`http://localhost:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', Cookie: `bt_session=${tokens[as]}` }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  };
  return { call, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); }), log: () => out };
}

const S = secret;
// Requests that NAME the restricted book's content. Every one must be refused.
const NAMED = [
  ['GET', `/api/books/${S.book}`], ['GET', `/api/books/${S.book}/marks`], ['GET', `/api/books/${S.book}/access`],
  ['GET', `/api/chapters/${S.chapter}`], ['GET', `/api/paragraphs/${S.paragraph}/assistant`], ['GET', `/api/paragraphs/${S.paragraph}/workflows`],
  ['GET', `/api/discussions/${S.thread}`], ['GET', `/api/discussions?bookId=${S.book}`], ['GET', `/api/discussions?chapterId=${S.chapter}`],
  ['GET', `/api/discussions?paragraphId=${S.paragraph}`], ['GET', `/api/glossary?bookId=${S.book}`], ['GET', `/api/assignments?bookId=${S.book}`],
  ['GET', `/api/assignments?paragraphId=${S.paragraph}`], ['GET', `/api/vocabulary?bookId=${S.book}`], ['GET', `/api/vocabulary/due?chapterId=${S.chapter}`],
  ['GET', `/api/vocabulary/review?chapterId=${S.chapter}`], ['GET', `/api/vocabulary/export?bookId=${S.book}`],
  ['PATCH', `/api/books/${S.book}`, { title_en: 'x' }], ['DELETE', `/api/books/${S.book}`], ['PUT', `/api/books/${S.book}/access`, { visibility: 'public' }],
  ['POST', `/api/books/${S.book}/chapters`, { title: 'x' }], ['PATCH', `/api/parts/${S.part}`, { title: 'x' }], ['PATCH', `/api/chapters/${S.chapter}`, { title: 'x' }],
  ['POST', `/api/chapters/${S.chapter}/sections`, {}], ['PATCH', `/api/sections/${S.section}`, { heading: 'x' }],
  ['PATCH', `/api/paragraphs/${S.paragraph}`, { is_bookmarked: 1 }], ['POST', `/api/paragraphs/${S.paragraph}/assistant`, { message: 'x' }],
  ['POST', `/api/paragraphs/${S.paragraph}/translate`, {}], ['POST', '/api/discussions', { paragraphId: S.paragraph, term: 'x', body: 'x' }],
  ['POST', `/api/discussions/${S.thread}/posts`, { body: 'x' }], ['POST', `/api/discussions/posts/${S.post}/vote`, {}],
  ['PATCH', `/api/discussions/posts/${S.post}`, { body: 'x' }], ['PATCH', `/api/glossary/${S.glossary}`, { meaning_vi: 'x' }],
  ['POST', '/api/glossary', { term: 'x', meaning_vi: 'x', bookId: S.book }], ['DELETE', `/api/assignments/${S.assignment}`],
  ['POST', '/api/assignments', { chapterId: S.chapter, userId: S.book, role: 'translator' }], ['PUT', '/api/me/reading', { chapterId: S.chapter }],
  ['POST', '/api/vocabulary', { term: 'zzleak', meaning_vi: 'x', source_paragraph_id: S.paragraph }],
  ['POST', '/api/vocabulary/suggest', { term: 'x', paragraphId: S.paragraph }],
];
// Requests that list across books. They answer, but without the book.
const LISTS = [
  '/api/books', '/api/me/home', '/api/me/reading', '/api/discussions', '/api/discussions/summary', '/api/glossary', '/api/glossary?scope=all',
  '/api/assignments/mine', '/api/vocabulary?search=zzmarkerword', '/api/vocabulary?pageSize=200', `/api/vocabulary/${S.word}/links`, `/api/vocabulary/${linkWord}/links`,
  '/api/vocabulary/stats', '/api/vocabulary/export', '/api/vocabulary/export?format=tsv', '/api/vocabulary/due?limit=200', '/api/vocabulary/review?limit=200',
  `/api/chapters/${publicChapter}`,
];
const leaks = (text) => markers.filter((m) => text.includes(m));

const server = await startServer();
try {
  await test(`an outsider is refused on all ${NAMED.length} requests naming the book, and none leaks it`, async () => {
    for (const as of ['outsider', 'outsiderEditor']) {
      for (const [method, p, body] of NAMED) {
        const r = await server.call(method, p, { as, body });
        assert.ok(r.status >= 400, `${as} ${method} ${p} answered ${r.status}`);
        assert.deepEqual(leaks(r.text), [], `${as} ${method} ${p} leaked`);
      }
    }
  });

  await test(`lists across books (${LISTS.length}) answer without the book`, async () => {
    for (const p of LISTS) {
      const r = await server.call('GET', p, { as: 'outsider' });
      assert.ok(r.status < 400, `${p} answered ${r.status}`);
      assert.deepEqual(leaks(r.text), [], `${p} leaked`);
    }
    // the word itself stays in the shared vocabulary, without its source
    const words = JSON.parse((await server.call('GET', '/api/vocabulary?search=zzmarkerword', { as: 'outsider' })).text);
    assert.equal(words.rows[0].term, 'Zzmarkerword');
    assert.equal(words.rows[0].source_book_id, null);
    assert.equal(words.rows[0].example, '');
  });

  await test('a refusal looks like "not found", not "forbidden"', async () => {
    const r = await server.call('GET', `/api/chapters/${S.chapter}`, { as: 'outsider' });
    assert.equal(r.status, 404);
  });

  await test('invited user, group member, owner and admin read and use the book', async () => {
    for (const as of ['invited', 'viaGroup', 'owner', 'admin']) {
      assert.ok(JSON.parse((await server.call('GET', '/api/books', { as })).text).some((b) => b.id === Number(S.book)), `${as} library`);
      const ch = await server.call('GET', `/api/chapters/${S.chapter}`, { as });
      assert.equal(ch.status, 200, `${as} chapter`);
      assert.ok(ch.text.includes(M.text));
      const words = JSON.parse((await server.call('GET', '/api/vocabulary?search=zzmarkerword', { as })).text);
      assert.equal(words.rows[0].example, M.example, `${as} sees the example`);
    }
    assert.equal((await server.call('PATCH', `/api/paragraphs/${S.paragraph}`, { as: 'invited', body: { is_bookmarked: 1 } })).status, 200);
  });

  await test('only admins and the owner change who sees it', async () => {
    assert.equal((await server.call('PUT', `/api/books/${S.book}/access`, { as: 'invited', body: { visibility: 'public' } })).status, 403);
    const byOwner = await server.call('PUT', `/api/books/${S.book}/access`, { as: 'owner', body: { visibility: 'restricted', userIds: [invited.id, viaGroup.id], groupIds: [groupId], ownerId: outsider.id } });
    assert.equal(byOwner.status, 200);
    assert.equal(JSON.parse(byOwner.text).owner.id, owner.id, 'an owner cannot hand the book away');
    const bad = await server.call('PUT', `/api/books/${S.book}/access`, { as: 'admin', body: { visibility: 'secret' } });
    assert.equal(bad.status, 400);
    // admin opens it up: now the outsider sees it
    assert.equal((await server.call('PUT', `/api/books/${S.book}/access`, { as: 'admin', body: { visibility: 'public', userIds: [], groupIds: [] } })).status, 200);
    assert.equal((await server.call('GET', `/api/chapters/${S.chapter}`, { as: 'outsider' })).status, 200);
    // and restricts it again
    assert.equal((await server.call('PUT', `/api/books/${S.book}/access`, { as: 'admin', body: { visibility: 'restricted', userIds: [invited.id], groupIds: [groupId] } })).status, 200);
    assert.equal((await server.call('GET', `/api/chapters/${S.chapter}`, { as: 'outsider' })).status, 404);
  });

  await test('a book an editor creates is theirs', async () => {
    const r = JSON.parse((await server.call('POST', '/api/books', { as: 'outsiderEditor', body: { title_en: 'Editor book' } })).text);
    const acc = JSON.parse((await server.call('GET', `/api/books/${r.id}/access`, { as: 'outsiderEditor' })).text);
    assert.equal(acc.owner.id, outsiderEditor.id);
    assert.equal(acc.visibility, 'public');
    assert.equal(acc.canManage, true);
  });

  await test('the admin workspace view shows what a user can see', async () => {
    const ws = JSON.parse((await server.call('GET', `/api/admin/activity/users/${outsider.id}`, { as: 'admin' })).text);
    assert.equal(ws.books.find((b) => b.id === Number(S.book)).visible, false);
    const wsInvited = JSON.parse((await server.call('GET', `/api/admin/activity/users/${viaGroup.id}`, { as: 'admin' })).text);
    assert.equal(wsInvited.books.find((b) => b.id === Number(S.book)).via, 'group');
    assert.equal((await server.call('GET', `/api/admin/activity/users/${outsider.id}`, { as: 'outsider' })).status, 403);
  });

  await test('scopes cost little: library and chapter as an outsider', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i += 1) {
      await server.call('GET', '/api/books', { as: 'outsider' });
      await server.call('GET', `/api/chapters/${publicChapter}`, { as: 'outsider' });
    }
    const ms = (performance.now() - t0) / 100;
    console.log(`    ${ms.toFixed(1)} ms per request`);
    assert.ok(ms < 150);
  });
} catch (err) {
  console.error(server.log());
  throw err;
} finally {
  await server.stop();
}

await test('BOOK_SCOPES=0 turns scopes off (everything visible, as before)', async () => {
  const off = await startServer({ BOOK_SCOPES: '0' });
  try {
    assert.equal((await off.call('GET', `/api/chapters/${S.chapter}`, { as: 'outsider' })).status, 200);
    // The leak checks above can see a leak: with scopes off, the same
    // lists DO contain the markers. (If this failed, the checks would be
    // looking in the wrong place and prove nothing.)
    let seen = 0;
    const quiet = [];
    for (const p of LISTS) {
      const r = await off.call('GET', p, { as: 'outsider' });
      assert.ok(r.status < 400, `${p} answered ${r.status}`);
      if (leaks(r.text).length) seen += 1; else quiet.push(p);
    }
    console.log(`    no marker even with scopes off (nothing of the book in them): ${quiet.join(' ')}`);
    console.log(`    with scopes off, ${seen}/${LISTS.length} lists show the restricted book`);
    assert.ok(seen >= 10, `only ${seen} lists would show a leak`);
  } finally {
    await off.stop();
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`book access: ${passed} checks passed`);
