// Meanings per book: resolution rules, translation (known words, new
// senses), the reader, the senses API with book scopes, exchange, merge/undo,
// the off switch — and that the one existing book translates exactly as
// before. Throwaway copy of the database:
//   npm run test:vocab-senses
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-senses-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0' });

const { db } = await import('../db.js');
const { createSession, createUser } = await import('../auth/store.js');
const { normalizeTerm, relevantTerms } = await import('../normalize.js');
const senses = await import('../vocabSenses.js');
const pt = await import('../paragraphTranslation.js');
const vocab = await import('../vocabStore.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// ---- seed: a book of the same field as book 1, and one of another field ---------
const book1 = db.prepare('SELECT id, domain FROM books ORDER BY id LIMIT 1').get();
function addBook(title, domain, text) {
  const b = db.prepare('INSERT INTO books (title_en, domain) VALUES (?, ?)').run(title, domain).lastInsertRowid;
  const c = db.prepare('INSERT INTO chapters (book_id, order_index, title) VALUES (?, 0, ?)').run(b, `${title} ch1`).lastInsertRowid;
  const s = db.prepare('INSERT INTO sections (chapter_id, order_index) VALUES (?, 0)').run(c).lastInsertRowid;
  const p = db.prepare("INSERT INTO paragraphs (section_id, order_index, english_md) VALUES (?, 0, ?)").run(s, text).lastInsertRowid;
  return { id: Number(b), chapter: Number(c), paragraph: Number(p) };
}
const sameField = addBook('Another Parenting Book', book1.domain, 'A secure zzwidget helps the child.');
const techBook = addBook('Email Handbook', 'Công nghệ thông tin', 'Open the zzwidget in the email before replying.');
// The test's own word, collected from book 1 (so it does not depend on
// which words the real vocabulary happens to hold).
const book1Paragraph = db.prepare('SELECT p.id FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ? LIMIT 1').get(book1.id).id;
const attachmentId = db.prepare(`INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, source_paragraph_id)
  VALUES ('Zzwidget', ?, '', 'Noun', 'sự gắn bó (thử)', '', 'Khác', '2026-01-01', ?)`).run(normalizeTerm('Zzwidget'), book1Paragraph).lastInsertRowid;
const attachment = db.prepare('SELECT id, term, meaning_vi FROM vocabulary WHERE id = ?').get(attachmentId);
const paragraph = (id) => db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(id);

await test('book 1 translates exactly as before: every relevant word is "known"', () => {
  const state = pt.loadVocabState();
  for (const p of db.prepare('SELECT p.* FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ? LIMIT 40').all(book1.id)) {
    const before = relevantTerms(`${p.english_md}\n${p.citation_en_md || ''}`, state.terms);
    const ctx = pt.translationContext(p, state);
    assert.deepEqual(ctx.existingTerms, before, `paragraph ${p.id}`);
    for (const t of ctx.existingTerms) assert.equal(ctx.meanings.get(t), state.meanings.get(t));
  }
});

await test('a word is known in a book of the same field, not in another field', () => {
  const state = pt.loadVocabState();
  assert.ok(pt.translationContext(paragraph(sameField.paragraph), state).existingTerms.includes(attachment.term));
  assert.ok(!pt.translationContext(paragraph(techBook.paragraph), state).existingTerms.includes(attachment.term));
});

await test('explained again in the other field, the meaning becomes that book\'s sense', () => {
  const state = pt.loadVocabState();
  const res = pt.saveTranslation(paragraph(techBook.paragraph), {
    english_md: paragraph(techBook.paragraph).english_md, vietnamese_md: 'Mở tệp đính kèm…',
    new_words: [{ term: 'zzwidget', ipa: '', word_type: 'Noun', meaning_vi: 'tệp đính kèm', example: 'Open the zzwidget', topic: 'Khác' }], phrases: [],
  }, state);
  assert.equal(res.insertedWordCount, 0, 'no second entry');
  assert.equal(db.prepare('SELECT meaning_vi FROM vocabulary WHERE id = ?').get(attachment.id).meaning_vi, attachment.meaning_vi, 'general meaning untouched');
  const s = senses.listSenses(attachment.id);
  assert.equal(s.length, 1);
  assert.equal(s[0].book_id, techBook.id);
  assert.equal(s[0].meaning_vi, 'tệp đính kèm');
  assert.match(res.paragraph.vocabulary_md, /tệp đính kèm \*\(nghĩa trong sách này\)\*/);
  // now known there, with that meaning
  const ctx = pt.translationContext(paragraph(techBook.paragraph), state);
  assert.ok(ctx.existingTerms.includes(attachment.term));
  assert.equal(ctx.meanings.get(attachment.term), 'tệp đính kèm');
});

await test('in a book of the same field nothing new is stored', () => {
  const state = pt.loadVocabState();
  pt.saveTranslation(paragraph(sameField.paragraph), {
    english_md: paragraph(sameField.paragraph).english_md, vietnamese_md: 'x',
    new_words: [{ term: 'zzwidget', ipa: '', word_type: 'Noun', meaning_vi: 'sự quyến luyến', example: '', topic: 'Khác' }], phrases: [],
  }, state);
  assert.equal(senses.listSenses(attachment.id).length, 1);
  // and a meaning equal to the general one is never stored
  assert.equal(senses.upsertSense({ vocabularyId: attachment.id, bookId: sameField.id, meaning_vi: ` ${attachment.meaning_vi.toUpperCase()} ` }), null);
});

await test('resolution order: own sense, same field, other sense of the field, general', () => {
  const info = { meaning: 'chung', bookId: 1, domain: 'A', senses: [{ id: 9, book_id: 3, domain: 'B', meaning_vi: 'nghĩa B' }] };
  assert.equal(senses.meaningForBook(info, { id: 1, domain: 'A' }).meaning, 'chung');
  assert.equal(senses.meaningForBook(info, { id: 2, domain: 'a ' }).meaning, 'chung', 'same field (case/space-insensitive)');
  assert.equal(senses.meaningForBook(info, { id: 3, domain: 'B' }).meaning, 'nghĩa B');
  assert.equal(senses.meaningForBook(info, { id: 4, domain: 'B' }).meaning, 'nghĩa B', 'another book of field B');
  assert.equal(senses.meaningForBook(info, { id: 5, domain: 'C' }).meaning, 'chung');
  assert.equal(senses.knownForBook(info, { id: 5, domain: 'C' }), false);
  assert.equal(senses.knownForBook(info, { id: 5, domain: '' }), false);
  assert.equal(senses.knownForBook({ ...info, bookId: null }, { id: 5, domain: 'C' }), true, 'words with no source book hold everywhere');
});

await test('merging moves senses; undo puts them back', () => {
  const add = (term) => db.prepare("INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added) VALUES (?, ?, '', 'Noun', 'x', '', 'Khác', '2026-01-01')").run(term, normalizeTerm(term)).lastInsertRowid;
  const keep = add('Zzkeepsense');
  const other = add('Zzothersense');
  senses.upsertSense({ vocabularyId: other, bookId: techBook.id, meaning_vi: 'nghĩa công nghệ' });
  vocab.mergeVocab(keep, [other], { reason: 'manual' });
  assert.equal(senses.listSenses(keep)[0].meaning_vi, 'nghĩa công nghệ');
  vocab.undoMerge(vocab.mergeHistory().find((m) => m.merged_id === Number(other)).id);
  assert.equal(senses.listSenses(other)[0].meaning_vi, 'nghĩa công nghệ');
  assert.equal(senses.listSenses(keep).length, 0);
});

// ---- HTTP ------------------------------------------------------------------------
const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const learner = createUser({ email: `l-${Date.now()}@test.local`, roles: ['learner'] });
const outsiderEditor = createUser({ email: `e-${Date.now()}@test.local`, roles: ['editor'] });
const tokens = { admin: createSession(admin.id).token, learner: createSession(learner.id).token, editor: createSession(outsiderEditor.id).token };
const techSense = senses.listSenses(attachment.id)[0];

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
  const call = async (method, p, { as = 'admin', body } = {}) => {
    const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', Cookie: `bt_session=${tokens[as]}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  return { call, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); }), log: () => out };
}

const word = (chapterJson) => chapterJson.knownTerms.find((v) => v.id === attachment.id);
const server = await startServer();
try {
  await test('the reader shows each book\'s meaning', async () => {
    const tech = word((await server.call('GET', `/api/chapters/${techBook.chapter}`)).json);
    assert.equal(tech.meaning_vi, 'tệp đính kèm');
    assert.equal(tech.meaning_general, attachment.meaning_vi);
    assert.equal(tech.sense_id, techSense.id);
    const same = word((await server.call('GET', `/api/chapters/${sameField.chapter}`)).json);
    assert.equal(same.meaning_vi, attachment.meaning_vi);
    assert.equal(same.sense_id, null);
  });

  await test('senses API: editors add, change and remove; learners may not', async () => {
    const links = (await server.call('GET', `/api/vocabulary/${attachment.id}/links`)).json;
    assert.deepEqual(links.senses.map((x) => x.meaning_vi), ['tệp đính kèm']);
    assert.equal((await server.call('POST', `/api/vocabulary/${attachment.id}/senses`, { as: 'learner', body: { bookId: sameField.id, meaning_vi: 'x' } })).status, 403);
    const created = await server.call('POST', `/api/vocabulary/${attachment.id}/senses`, { body: { bookId: sameField.id, meaning_vi: 'sự gắn kết (sách 2)' } });
    assert.equal(created.status, 201);
    assert.equal((await server.call('PATCH', `/api/vocabulary/senses/${created.json.id}`, { body: { meaning_vi: 'sửa' } })).json.meaning_vi, 'sửa');
    assert.equal((await server.call('DELETE', `/api/vocabulary/senses/${created.json.id}`)).status, 200);
    assert.equal((await server.call('POST', `/api/vocabulary/${attachment.id}/senses`, { body: { bookId: sameField.id, meaning_vi: attachment.meaning_vi } })).status, 400);
  });

  await test('a sense of a restricted book is hidden from those who may not see the book', async () => {
    const { db: d } = await import('../db.js');
    d.prepare("UPDATE books SET visibility = 'restricted' WHERE id = ?").run(techBook.id);
    const links = (await server.call('GET', `/api/vocabulary/${attachment.id}/links`, { as: 'editor' })).json;
    assert.equal(links.senses.length, 0);
    assert.equal((await server.call('PATCH', `/api/vocabulary/senses/${techSense.id}`, { as: 'editor', body: { meaning_vi: 'x' } })).status, 404);
    assert.equal((await server.call('POST', `/api/vocabulary/${attachment.id}/senses`, { as: 'editor', body: { bookId: techBook.id, meaning_vi: 'x' } })).status, 404);
    const exported = (await server.call('GET', '/api/vocabulary/export', { as: 'editor' })).text;
    assert.ok(!exported.includes('tệp đính kèm'));
    d.prepare("UPDATE books SET visibility = 'public' WHERE id = ?").run(techBook.id);
  });

  await test('export carries senses and import restores them', async () => {
    const file = (await server.call('GET', '/api/vocabulary/export')).json;
    assert.equal(file.version, 2);
    const entry = file.entries.find((e) => e.term === attachment.term);
    assert.deepEqual(entry.senses, [{ book: 'Email Handbook', meaning_vi: 'tệp đính kèm', example: 'Open the zzwidget', note: '' }]);
    await server.call('DELETE', `/api/vocabulary/senses/${techSense.id}`);
    const report = (await server.call('POST', '/api/vocabulary/import', { body: { format: file.format, entries: [entry, { ...entry, term: 'Zzunknownbook', senses: [{ book: 'No Such Book', meaning_vi: 'x' }] }], mode: 'fill' } })).json;
    assert.equal(report.senses, 1);
    assert.deepEqual(report.unknownBooks, ['No Such Book']);
    assert.equal(word((await server.call('GET', `/api/chapters/${techBook.chapter}`)).json).meaning_vi, 'tệp đính kèm');
  });
} catch (err) {
  console.error(server.log());
  throw err;
} finally {
  await server.stop();
}

await test('VOCAB_SENSES=0: general meaning everywhere, senses kept', async () => {
  const off = await startServer({ VOCAB_SENSES: '0' });
  try {
    assert.equal(word((await off.call('GET', `/api/chapters/${techBook.chapter}`)).json).meaning_vi, attachment.meaning_vi);
    assert.equal((await off.call('GET', `/api/vocabulary/${attachment.id}/links`)).json.senses.length, 1);
  } finally {
    await off.stop();
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`vocabulary senses: ${passed} checks passed`);
