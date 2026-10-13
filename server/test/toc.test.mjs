// The standard table of contents (server/toc.js) and its normalizer
// (scripts/normalizeToc.mjs): title prefixes, front/back matter, numbering,
// a worksheet-style book split by a spec, undo restoring every row, the
// safety stop for referenced heading paragraphs, and the API's new fields.
// Throwaway copy of the database:
//   npm run test:toc
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-toc-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
const env = { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0', COVER_DIR: path.join(tmp, 'covers') };
Object.assign(process.env, env);

const { db } = await import('../db.js');
const { stripNumberPrefix, classifyTitle, numberToc, titleCase, cleanTitle } = await import('../toc.js');
const { createSession } = await import('../auth/store.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const normalize = (...args) => spawnSync(process.execPath, ['server/scripts/normalizeToc.mjs', ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

await test('chapter and part number prefixes leave the title', () => {
  assert.deepEqual(stripNumberPrefix('CHAPTER 3: WHY WE’VE COME UNDONE'), { title: 'WHY WE’VE COME UNDONE', number: 3 });
  assert.deepEqual(stripNumberPrefix('Chương 12 – Nghiệp'), { title: 'Nghiệp', number: 12 });
  assert.deepEqual(stripNumberPrefix('PART 1 : The phenomenon', 'part'), { title: 'The phenomenon', number: 1 });
  assert.deepEqual(stripNumberPrefix('Part Two. Sabotaged', 'part'), { title: 'Sabotaged', number: 2 });
  assert.deepEqual(stripNumberPrefix('Chapter IV'), { title: 'Chapter IV', number: 4 });
  assert.deepEqual(stripNumberPrefix('The Flood of Tears'), { title: 'The Flood of Tears', number: null });
  assert.deepEqual(stripNumberPrefix('Chapter and verse'), { title: 'Chapter and verse', number: null });
});

await test('ALL CAPS English titles become Title Case; mixed case and invisible characters are handled', () => {
  assert.equal(titleCase('FROM HELP TO HINDRANCE: WHEN ATTACHMENT WORKS AGAINST US'), 'From Help to Hindrance: When Attachment Works Against Us');
  assert.equal(titleCase('A WAKE-UP CALL'), 'A Wake-Up Call');
  assert.equal(titleCase('PEER-ORIENTED KIDS ARE MORE VULNERABLE'), 'Peer-Oriented Kids Are More Vulnerable');
  assert.equal(titleCase('The phenomenon of peer orientation'), 'The phenomenon of peer orientation');
  assert.equal(cleanTitle('Hãy Gắn Kết Với \u200b\u200bCon  Bạn'), 'Hãy Gắn Kết Với Con Bạn');
});

await test('front and back matter are recognized in English and Vietnamese', () => {
  for (const t of ['Preface', '**Dedication**', 'Lời tựa', 'About This Book', 'Đôi nét về Thiền sư S.N. Goenka', 'Foreword']) assert.equal(classifyTitle(t), 'front', t);
  for (const t of ['Glossary', 'Appendix: The Art of Living', 'Acknowledgments', 'Lời cảm ơn', 'Bảng chú giải thuật ngữ', 'Phụ lục']) assert.equal(classifyTitle(t), 'back', t);
  for (const t of ['The Buddha’s Wisdom', 'Kamma—the Real Inheritance', 'WHY PARENTS MATTER MORE THAN EVER']) assert.equal(classifyTitle(t), null, t);
});

await test('only body chapters are numbered, in reading order; TOC_STANDARD=0 turns labels off', () => {
  const chapters = [
    { id: 1, order_index: 0, kind: 'front' }, { id: 2, order_index: 2, kind: 'chapter' },
    { id: 3, order_index: 1, kind: 'chapter' }, { id: 4, order_index: 3, kind: 'back' },
  ];
  const out = numberToc({ chapters, parts: [{ id: 9, order_index: 0 }] });
  assert.deepEqual(out.chapters.map((c) => [c.id, c.number, c.label, c.label_vi]), [[1, null, null, null], [2, 2, 'Chapter 2', 'Chương 2'], [3, 1, 'Chapter 1', 'Chương 1'], [4, null, null, null]]);
  assert.deepEqual([out.parts[0].label, out.parts[0].label_vi], ['Part 1', 'Phần 1']);
  // as the book prints it: "Part One", or no numbers at all
  assert.equal(numberToc({ chapters, parts: [{ id: 9, order_index: 0 }], numbering: 'words' }).parts[0].label, 'Part One');
  const none = numberToc({ chapters, parts: [{ id: 9, order_index: 0 }], numbering: 'none' });
  assert.ok(none.chapters.every((c) => c.label == null) && none.parts[0].label == null);
  assert.equal(none.chapters.find((c) => c.id === 3).number, 1, 'the reading-order number stays');
  process.env.TOC_STANDARD = '0';
  const off = numberToc({ chapters });
  assert.ok(off.chapters.every((c) => c.kind === 'chapter' && c.number == null && c.label == null));
  delete process.env.TOC_STANDARD;
});

// A worksheet-style book: one "chapter" bundles front matter and two real
// chapters; headings sit at the top of paragraphs.
function seedWorksheetBook() {
  const bookId = db.prepare("INSERT INTO books (title_en) VALUES ('TOC test book')").run().lastInsertRowid;
  const chapter = (title, i) => db.prepare('INSERT INTO chapters (book_id, order_index, title) VALUES (?, ?, ?)').run(bookId, i, title).lastInsertRowid;
  const section = (c) => db.prepare('INSERT INTO sections (chapter_id, order_index) VALUES (?, 0)').run(c).lastInsertRowid;
  const para = (s, i, en, vi) => db.prepare("INSERT INTO paragraphs (section_id, order_index, english_md, vietnamese_md, status) VALUES (?, ?, ?, ?, 'translated')").run(s, i, en, vi).lastInsertRowid;
  const s1 = section(chapter('001 Front', 0));
  const ids = [
    para(s1, 0, 'A verse to open the book.', 'Một câu kệ mở đầu.'),
    para(s1, 1, '**Preface**', '**Lời tựa**'),
    para(s1, 2, 'Why this book was written.', 'Vì sao có sách này.'),
  ];
  const s2 = section(chapter('002 Stories', 1));
  ids.push(
    para(s2, 0, 'The First Story\n\nIt began one morning.', 'Câu chuyện thứ nhất\n\nMọi chuyện bắt đầu vào một buổi sáng.'),
    para(s2, 1, 'It went on.', 'Rồi tiếp diễn.'),
    para(s2, 2, 'A Second Story', 'Câu chuyện thứ hai'),
    para(s2, 3, 'Another morning.', 'Một buổi sáng khác.'),
    para(s2, 4, 'Later\n\nMuch later.', 'Về sau\n\nRất lâu về sau.'),
  );
  return { bookId, ids };
}
const spec = {
  chapters: [
    { kind: 'front', title_en: 'Epigraph', title_vi: 'Đề từ', start: 'A verse', headingBlocks: 0, blockType: 'epigraph' },
    { kind: 'front', title_en: 'Preface', start: 'Preface' },
    { title_en: 'The First Story', start: 'The First Story', sections: [{ heading_en: 'Later', start: 'Later' }] },
    { title_en: 'A Second Story', start: 'A Second Story' },
  ],
};
// The spec's sections must come after the chapter start; "Later" is in the
// second story, so it belongs to that chapter instead.
spec.chapters[2].sections = [];
spec.chapters[3].sections = [{ heading_en: 'Later', start: 'Later' }];
const specFile = path.join(tmp, 'spec.json');
fs.writeFileSync(specFile, JSON.stringify(spec));
const snapshot = (bookId) => JSON.stringify({
  chapters: db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY id').all(bookId),
  sections: db.prepare('SELECT s.* FROM sections s JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ? ORDER BY s.id').all(bookId),
  paragraphs: db.prepare('SELECT p.* FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ? ORDER BY p.id').all(bookId),
});

const { bookId, ids } = seedWorksheetBook();
const before = snapshot(bookId);

await test('a dry run reports the new TOC and writes nothing', () => {
  const r = normalize('--book', String(bookId), '--spec', specFile);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PHẦN ĐẦU SÁCH/);
  assert.match(r.stdout, /Chương 2 +A Second Story +— +Câu chuyện thứ hai/);
  assert.equal(snapshot(bookId), before);
});

let runId;
await test('applying splits chapters, lifts headings into bilingual titles and keeps paragraph ids', () => {
  const r = normalize('--book', String(bookId), '--spec', specFile, '--apply');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  runId = r.stdout.match(/lượt (toc-[\w-]+)/)[1];
  const chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY order_index').all(bookId);
  assert.deepEqual(chapters.map((c) => [c.kind, c.title, c.title_vi]), [
    ['front', 'Epigraph', 'Đề từ'], ['front', 'Preface', 'Lời tựa'],
    ['chapter', 'The First Story', 'Câu chuyện thứ nhất'], ['chapter', 'A Second Story', 'Câu chuyện thứ hai'],
  ]);
  const paras = db.prepare('SELECT p.*, s.heading, s.heading_vi, s.chapter_id FROM paragraphs p JOIN sections s ON s.id = p.section_id WHERE p.id IN (' + ids.join(',') + ') ORDER BY p.id').all();
  const byId = new Map(paras.map((p) => [p.id, p]));
  assert.equal(byId.get(ids[0]).block_type, 'epigraph');
  assert.equal(byId.has(ids[1]), false, 'the heading-only "Preface" paragraph is gone');
  assert.equal(byId.has(ids[5]), false, 'the heading-only "A Second Story" paragraph is gone');
  assert.equal(byId.get(ids[3]).english_md, 'It began one morning.');
  assert.equal(byId.get(ids[3]).vietnamese_md, 'Mọi chuyện bắt đầu vào một buổi sáng.');
  assert.equal(byId.get(ids[7]).english_md, 'Much later.');
  assert.deepEqual([byId.get(ids[7]).heading, byId.get(ids[7]).heading_vi], ['Later', 'Về sau']);
  assert.equal(byId.get(ids[6]).chapter_id, chapters[3].id, 'paragraphs moved to the split chapter');
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

await test('undo restores every chapter, section and paragraph exactly', () => {
  const r = normalize('--undo', runId);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(snapshot(bookId), before);
});

await test('a heading paragraph someone marked stops the run, and nothing is written', () => {
  const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
  db.prepare('INSERT INTO paragraph_marks (user_id, paragraph_id, is_bookmarked) VALUES (?, ?, 1)').run(admin.id, ids[1]);
  const r = normalize('--book', String(bookId), '--spec', specFile, '--apply');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /đang được tham chiếu/);
  assert.equal(snapshot(bookId), before);
  db.prepare('DELETE FROM paragraph_marks WHERE paragraph_id = ?').run(ids[1]);
});

await test('a spec entry that cannot be found stops the run', () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ chapters: [...spec.chapters, { title_en: 'Missing', start: 'No such text' }] }));
  const r = normalize('--book', String(bookId), '--spec', bad, '--apply');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Không tìm thấy chương "Missing"/);
  assert.equal(snapshot(bookId), before);
});

await test('a titles file sets bilingual titles by English title, and an unknown title stops the run', () => {
  const ok = path.join(tmp, 'titles.json');
  fs.writeFileSync(ok, JSON.stringify({ chapters: [{ en: '002 Stories', title_en: 'Stories', title_vi: 'Những câu chuyện' }] }));
  const r = normalize('--book', String(bookId), '--titles', ok, '--apply');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const run = r.stdout.match(/lượt (toc-[\w-]+)/)[1];
  assert.deepEqual({ ...db.prepare("SELECT title, title_vi, title_original FROM chapters WHERE book_id = ? AND title = 'Stories'").get(bookId) },
    { title: 'Stories', title_vi: 'Những câu chuyện', title_original: '002 Stories' });
  assert.equal(normalize('--undo', run).status, 0);
  assert.equal(snapshot(bookId), before);
  const bad = path.join(tmp, 'titles-bad.json');
  fs.writeFileSync(bad, JSON.stringify({ sections: [{ en: 'No such heading', heading_vi: 'x' }] }));
  const r2 = normalize('--book', String(bookId), '--titles', bad, '--apply');
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /File tiêu đề không khớp/);
  assert.equal(snapshot(bookId), before);
});

// ---- API ---------------------------------------------------------------------------
normalize('--book', String(bookId), '--spec', specFile, '--apply');
const otherPart = db.prepare("INSERT INTO parts (book_id, order_index, title) VALUES ((SELECT MIN(id) FROM books WHERE id <> ?), 99, 'Other book part')").run(bookId).lastInsertRowid;
const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const token = createSession(admin.id).token;
const { createUser } = await import('../auth/store.js');
const guestToken = createSession(createUser({ email: `toc-guest-${Date.now()}@test.local`, roles: ['guest'] }).id).token;
const port = 39000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const call = (method, url, body, as = token) => fetch(`http://localhost:${port}/api${url}`, {
  method, headers: { 'x-books-translate': '1', Cookie: `bt_session=${as}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

try {
  const chapters = db.prepare('SELECT id FROM chapters WHERE book_id = ? ORDER BY order_index').all(bookId).map((c) => c.id);

  await test('the book and chapter answers carry kind, number, label and the Vietnamese title', async () => {
    const book = await (await call('GET', `/books/${bookId}`)).json();
    assert.deepEqual(book.chaptersWithoutPart.map((c) => [c.kind, c.number, c.label, c.title_vi]), [
      ['front', null, null, 'Đề từ'], ['front', null, null, 'Lời tựa'],
      ['chapter', 1, 'Chapter 1', 'Câu chuyện thứ nhất'], ['chapter', 2, 'Chapter 2', 'Câu chuyện thứ hai'],
    ]);
    const ch = await (await call('GET', `/chapters/${chapters[3]}`)).json();
    assert.deepEqual([ch.kind, ch.number, ch.label, ch.label_vi], ['chapter', 2, 'Chapter 2', 'Chương 2']);
    assert.equal(ch.prevChapter.label, 'Chapter 1');
    // a book that prints no numbers shows none; a bad style is refused
    assert.equal((await call('PATCH', `/books/${bookId}`, { toc_numbering: 'roman' })).status, 400);
    assert.equal((await call('PATCH', `/books/${bookId}`, { toc_numbering: 'none' })).status, 200);
    const plain = await (await call('GET', `/books/${bookId}`)).json();
    assert.ok(plain.chaptersWithoutPart.every((c) => c.label == null));
    assert.equal((await (await call('GET', `/chapters/${chapters[3]}`)).json()).label, null);
    await call('PATCH', `/books/${bookId}`, { toc_numbering: 'numeric' });
    assert.equal(ch.sections.find((s) => s.heading === 'Later').heading_vi, 'Về sau');
  });

  await test('PATCH checks kind, part ownership and keeps the other title when one is sent', async () => {
    assert.equal((await call('PATCH', `/chapters/${chapters[2]}`, { kind: 'appendix' })).status, 400);
    assert.equal((await call('PATCH', `/chapters/${chapters[2]}`, { partId: otherPart })).status, 400);
    assert.equal((await call('PATCH', `/chapters/${chapters[2]}`, { title: 42 })).status, 400);
    const r = await call('PATCH', `/chapters/${chapters[2]}`, { kind: 'back', title_vi: 'Chuyện một' });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.deepEqual([saved.title, saved.title_vi, saved.kind], ['The First Story', 'Chuyện một', 'back']);
    const section = db.prepare("SELECT s.id FROM sections s WHERE s.chapter_id = ? AND s.heading = 'Later'").get(chapters[3]);
    const s = await (await call('PATCH', `/sections/${section.id}`, { heading_vi: 'Mãi về sau' })).json();
    assert.deepEqual([s.heading, s.heading_vi], ['Later', 'Mãi về sau']);
  });

  await test('an outline completes the TOC with empty chapters that only editors see, numbered as printed', async () => {
    const outline = path.join(tmp, 'outline.json');
    fs.writeFileSync(outline, JSON.stringify({
      front: [{ title_en: 'Epigraph' }, { title_en: 'Preface' }],
      parts: [{ title_en: 'Part of Stories', title_vi: 'Phần truyện', chapters: [
        { title_en: 'The First Story' }, { title_en: 'Not Yet Imported', title_vi: 'Chưa nhập' }, { title_en: 'A Second Story' },
      ] }],
      back: [{ title_en: 'Notes', title_vi: 'Chú thích' }],
    }));
    const missing = path.join(tmp, 'outline-missing.json');
    fs.writeFileSync(missing, JSON.stringify({ parts: [{ title_en: 'X', chapters: [{ title_en: 'The First Story' }] }] }));
    const bad = normalize('--book', String(bookId), '--outline', missing, '--apply');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /không có trong outline/);

    const r = normalize('--book', String(bookId), '--outline', outline, '--apply');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const asAdmin = await (await call('GET', `/books/${bookId}`)).json();
    assert.deepEqual(asAdmin.parts[0].chapters.map((c) => [c.number, c.title]), [[1, 'The First Story'], [2, 'Not Yet Imported'], [3, 'A Second Story']]);
    assert.deepEqual(asAdmin.chaptersWithoutPart.map((c) => [c.kind, c.title]), [['front', 'Epigraph'], ['front', 'Preface'], ['back', 'Notes']]);

    const asGuest = await (await call('GET', `/books/${bookId}`, null, guestToken)).json();
    assert.deepEqual(asGuest.parts[0].chapters.map((c) => [c.number, c.title]), [[1, 'The First Story'], [3, 'A Second Story']]);
    assert.ok(!asGuest.chaptersWithoutPart.some((c) => c.title === 'Notes'), 'empty back matter hidden from readers');
    const first = asGuest.parts[0].chapters[0];
    const ch = await (await call('GET', `/chapters/${first.id}`, null, guestToken)).json();
    assert.equal(ch.nextChapter.title, 'A Second Story', 'readers step over the empty chapter');
    const chAdmin = await (await call('GET', `/chapters/${first.id}`)).json();
    assert.equal(chAdmin.nextChapter.title, 'Not Yet Imported');
  });
} finally {
  await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (/\[error\]/.test(out)) { console.error(out); process.exit(1); }
console.log(`toc: ${passed} checks passed`);
