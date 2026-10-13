// Users' own words and proposals: one user's words never reach another
// user, a word entering the shared vocabulary absorbs everyone's copies
// (keeping their progress), proposals go through review, and translation
// still writes only to the shared vocabulary. Throwaway copy of the database:
//   npm run test:vocab-scopes
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-vscope-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0' });

const { db } = await import('../db.js');
const { createSession, createUser } = await import('../auth/store.js');
const { saveTranslation, loadVocabState } = await import('../paragraphTranslation.js');
const { normalizeTerm } = await import('../normalize.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const now = Date.now();
const alice = createUser({ email: `alice-${now}@test.local`, name: 'Alice', roles: ['learner'] });
const bob = createUser({ email: `bob-${now}@test.local`, name: 'Bob', roles: ['learner'] });
const guest = createUser({ email: `guest-${now}@test.local`, name: 'Guest', roles: ['guest'] });
const editor = createUser({ email: `editor-${now}@test.local`, name: 'Editor', roles: ['editor'] });
const tokens = Object.fromEntries([['alice', alice], ['bob', bob], ['guest', guest], ['editor', editor]].map(([k, u]) => [k, createSession(u.id).token]));
// From a public book: a restricted one would answer 404 to these users.
const PUBLIC = "JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id JOIN books b ON b.id = c.book_id WHERE b.visibility = 'public'";
const anyParagraph = db.prepare(`SELECT p.id, p.section_id, p.order_index, p.english_md, p.citation_en_md, p.citation_vi_md FROM paragraphs p ${PUBLIC} ORDER BY p.id LIMIT 1`).get();
const publicChapter = db.prepare("SELECT c.id FROM chapters c JOIN books b ON b.id = c.book_id WHERE b.visibility = 'public' ORDER BY c.id LIMIT 1").get().id;
const sharedWord = db.prepare('SELECT id, term FROM vocabulary WHERE owner_id IS NULL LIMIT 1').get();

await test('the shared-key index is per scope', () => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_vocab_term_unique'").get().sql;
  assert.match(sql, /WHERE owner_id IS NULL/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_vocab_private_term'").get());
});
// (the connection stays open: WAL lets the server process share the file)

const port = 39000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const call = async (method, p, { as, body } = {}) => {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', Cookie: `bt_session=${tokens[as]}` }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
};
const MARK = 'MARKER-ALICE-PRIVATE';

try {
  let aliceWord;
  await test('a learner adds a word of their own; it is theirs alone', async () => {
    const r = await call('POST', '/api/vocabulary', { as: 'alice', body: { term: 'Zzprivatealpha', meaning_vi: MARK, word_type: 'Noun', example: MARK, source_paragraph_id: anyParagraph.id } });
    assert.equal(r.status, 201, r.text);
    aliceWord = r.json;
    assert.equal(aliceWord.owner_id, alice.id);
    const own = await call('GET', '/api/vocabulary?scope=own', { as: 'alice' });
    assert.ok(own.json.rows.some((w) => w.id === aliceWord.id));
    // the detector works: Alice herself sees the marker
    assert.ok((await call('GET', '/api/vocabulary?search=zzprivatealpha', { as: 'alice' })).text.includes(MARK));
  });

  await test('no route shows Alice\'s word to Bob, and none acts on it', async () => {
    const lists = [
      '/api/vocabulary?search=zzprivatealpha', '/api/vocabulary?pageSize=200', '/api/vocabulary?scope=own', '/api/vocabulary?scope=mine',
      '/api/vocabulary/stats', '/api/vocabulary/export', '/api/vocabulary/export?format=tsv', '/api/vocabulary/due?limit=200',
      '/api/vocabulary/review?limit=200', '/api/vocabulary/review-stats', `/api/vocabulary/${sharedWord.id}/links`, '/api/me/home',
      `/api/chapters/${publicChapter}`, '/api/vocabulary/duplicates',
    ];
    for (const p of lists) {
      const r = await call('GET', p, { as: 'bob' });
      assert.ok(r.status < 400, `${p} ${r.status}`);
      assert.ok(!r.text.includes(MARK) && !r.text.includes('Zzprivatealpha'), `${p} leaked`);
    }
    const id = aliceWord.id;
    for (const [m, p, body] of [['GET', `/api/vocabulary/${id}/links`], ['PATCH', `/api/vocabulary/${id}`, { status: 'Thành thạo' }],
      ['PATCH', `/api/vocabulary/${id}`, { meaning_vi: 'x' }], ['DELETE', `/api/vocabulary/${id}`], ['POST', `/api/vocabulary/${id}/review`, { grade: 'good' }],
      ['PUT', `/api/vocabulary/${id}/mine`, { note: 'x' }], ['POST', `/api/vocabulary/${id}/propose`, {}]]) {
      const r = await call(m, p, { as: 'bob', body });
      assert.ok(r.status === 404, `${m} ${p} → ${r.status}`);
      assert.ok(!r.text.includes(MARK));
    }
  });

  await test('Alice reviews her word; she cannot change shared content but can track it', async () => {
    assert.equal((await call('POST', `/api/vocabulary/${aliceWord.id}/review`, { as: 'alice', body: { grade: 'good' } })).status, 200);
    assert.equal((await call('PATCH', `/api/vocabulary/${sharedWord.id}`, { as: 'alice', body: { meaning_vi: 'hack' } })).status, 403);
    assert.equal((await call('PATCH', `/api/vocabulary/${sharedWord.id}`, { as: 'alice', body: { status: 'Đang học' } })).status, 200);
    assert.equal((await call('PATCH', `/api/vocabulary/${aliceWord.id}`, { as: 'alice', body: { meaning_vi: `${MARK} sửa` } })).status, 200);
    assert.equal((await call('POST', '/api/vocabulary/merge', { as: 'editor', body: { keepId: sharedWord.id, mergeIds: [aliceWord.id] } })).status, 404);
  });

  await test('a word the shared vocabulary has goes on "my list" instead, with a note', async () => {
    const r = await call('POST', '/api/vocabulary', { as: 'alice', body: { term: sharedWord.term, meaning_vi: 'x' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.scope, 'shared');
    const put = await call('PUT', `/api/vocabulary/${sharedWord.id}/mine`, { as: 'alice', body: { note: 'ghi chú của Alice' } });
    assert.equal(put.json.in_my_list, 1);
    assert.equal(put.json.my_note, 'ghi chú của Alice');
    assert.ok((await call('GET', '/api/vocabulary?scope=mine&pageSize=200', { as: 'alice' })).json.rows.some((w) => w.id === sharedWord.id));
    assert.ok(!(await call('GET', `/api/vocabulary?search=${encodeURIComponent(sharedWord.term)}`, { as: 'bob' })).text.includes('ghi chú của Alice'));
  });

  await test('guests may not add words', async () => {
    assert.equal((await call('POST', '/api/vocabulary', { as: 'guest', body: { term: 'Zzguest', meaning_vi: 'x' } })).status, 403);
  });

  await test('a proposal is reviewed by an editor and becomes shared, keeping Alice\'s progress', async () => {
    assert.equal((await call('GET', '/api/vocabulary/proposals', { as: 'bob' })).status, 403);
    assert.equal((await call('POST', `/api/vocabulary/${aliceWord.id}/propose`, { as: 'alice', body: { note: 'từ hay' } })).json.proposal_status, 'pending');
    const list = (await call('GET', '/api/vocabulary/proposals', { as: 'editor' })).json;
    assert.ok(list.some((p) => p.id === aliceWord.id && p.owner_name === 'Alice'));
    assert.equal((await call('GET', '/api/vocabulary/stats', { as: 'editor' })).json.scopes.proposals >= 1, true);
    const ok = await call('POST', `/api/vocabulary/proposals/${aliceWord.id}/approve`, { as: 'editor', body: { meaning_vi: 'nghĩa đã duyệt' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.id, aliceWord.id);
    assert.equal(ok.json.owner_id, null);
    const asAlice = (await call('GET', '/api/vocabulary?search=zzprivatealpha', { as: 'alice' })).json.rows[0];
    assert.equal(asAlice.repetitions, 1, 'Alice keeps her review progress');
    assert.equal(asAlice.in_my_list, 1);
    assert.equal((await call('GET', '/api/vocabulary?search=zzprivatealpha', { as: 'bob' })).json.rows[0].meaning_vi, 'nghĩa đã duyệt');
  });

  await test('a rejected proposal stays Alice\'s, marked rejected', async () => {
    const w = (await call('POST', '/api/vocabulary', { as: 'alice', body: { term: 'Zzrejectme', meaning_vi: 'x' } })).json;
    await call('POST', `/api/vocabulary/${w.id}/propose`, { as: 'alice' });
    assert.equal((await call('POST', `/api/vocabulary/proposals/${w.id}/reject`, { as: 'editor', body: { note: 'quá dễ' } })).status, 200);
    const mine = (await call('GET', '/api/vocabulary?search=zzrejectme', { as: 'alice' })).json.rows[0];
    assert.equal(mine.proposal_status, 'rejected');
    assert.equal(mine.proposal_note, 'quá dễ');
    assert.equal((await call('GET', '/api/vocabulary?search=zzrejectme', { as: 'bob' })).json.rows.length, 0);
  });

  await test('when a word enters the shared vocabulary, everyone\'s own copies fold into it', async () => {
    const a = (await call('POST', '/api/vocabulary', { as: 'alice', body: { term: 'Zzsameword', meaning_vi: 'nghĩa Alice' } })).json;
    const b = (await call('POST', '/api/vocabulary', { as: 'bob', body: { term: 'zzsamewords', meaning_vi: 'nghĩa Bob' } })).json;
    assert.notEqual(a.id, b.id, 'two users may have the same word');
    await call('POST', `/api/vocabulary/${b.id}/review`, { as: 'bob', body: { grade: 'easy' } });
    const shared = await call('POST', '/api/vocabulary', { as: 'editor', body: { term: 'Zzsameword', meaning_vi: 'nghĩa chung' } });
    assert.equal(shared.status, 201);
    const bobView = (await call('GET', '/api/vocabulary?search=zzsameword', { as: 'bob' })).json.rows;
    assert.equal(bobView.length, 1);
    assert.equal(bobView[0].id, shared.json.id);
    assert.equal(bobView[0].repetitions, 1, "Bob's progress moved over");
    assert.match(bobView[0].my_note, /nghĩa Bob/);
    const aliceView = (await call('GET', '/api/vocabulary?search=zzsameword', { as: 'alice' })).json.rows;
    assert.equal(aliceView.length, 1);
    assert.match(aliceView[0].my_note, /nghĩa Alice/);
    assert.equal(aliceView[0].meaning_vi, 'nghĩa chung', 'own meanings never overwrite the shared one');
  });

} catch (err) {
  console.error(out);
  throw err;
} finally {
  await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
}

// translation writes only to the shared vocabulary, and absorbs own copies
await test('translation adds shared words and absorbs a user\'s copy of them', async () => {
  const own = db.prepare("INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, owner_id) VALUES ('Zztranslated', ?, '', 'Noun', 'riêng', '', 'Khác', '2026-01-01', ?)").run(normalizeTerm('Zztranslated'), bob.id).lastInsertRowid;
  const db2 = db;
  const state = loadVocabState();
  assert.ok(!state.normalizedSet.has(normalizeTerm('Zztranslated')), 'own words do not count as known for translation');
  const p = db2.prepare('SELECT * FROM paragraphs WHERE id = ?').get(anyParagraph.id);
  const before = { vi: p.vietnamese_md, vocab: p.vocabulary_md };
  const res = saveTranslation(p, { english_md: p.english_md, vietnamese_md: p.vietnamese_md, new_words: [{ term: 'Zztranslated', ipa: '', word_type: 'Noun', meaning_vi: 'nghĩa dịch', example: '', topic: 'Khác' }], phrases: [] }, state);
  assert.equal(res.insertedWordCount, 1);
  const rows = db2.prepare('SELECT id, owner_id FROM vocabulary WHERE term_normalized = ?').all(normalizeTerm('Zztranslated'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, null);
  assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE id = ?').get(own).c, 0);
  db2.prepare('UPDATE paragraphs SET vietnamese_md = ?, vocabulary_md = ? WHERE id = ?').run(before.vi, before.vocab, p.id);
});

await test('VOCAB_PRIVATE=0 stops new own words and proposals; existing ones stay', async () => {
  const p2 = port + 1;
  const off = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(p2), VOCAB_PRIVATE: '0' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`http://localhost:${p2}/api/health`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const req = (method, p, body) => fetch(`http://localhost:${p2}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', Cookie: `bt_session=${tokens.alice}` }, body: body && JSON.stringify(body) });
    assert.equal((await req('POST', '/api/vocabulary', { term: 'Zzswitchoff', meaning_vi: 'x' })).status, 403);
    const mine = await (await req('GET', '/api/vocabulary?search=zzrejectme')).json();
    assert.equal(mine.rows.length, 1);
    assert.equal((await req('POST', `/api/vocabulary/${mine.rows[0].id}/propose`, {})).status, 403);
  } finally {
    await new Promise((r) => { off.once('exit', r); off.kill('SIGTERM'); });
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`vocabulary scopes: ${passed} checks passed`);
