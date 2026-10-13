// Meanings of a shared word that depend on the book.
//
// vocabulary.meaning_vi stays the word's general meaning — the one it was
// collected with, from its source book — and everything that reads it keeps
// working. vocab_senses adds the meaning a word has in one particular book
// ("attachment" is "sự gắn bó" in a psychology book, "tệp đính kèm" in a
// manual). For a given book the meaning is, in order:
//   1. the sense written for that book;
//   2. the general meaning, when the word came from that book or from a
//      book of the same field (books.domain);
//   3. a sense written for another book of the same field;
//   4. the general meaning.
// Translation treats a word as "already known" for a book only through
// 1–3; in a book of another field the model may explain it again, and its
// meaning there is saved as a new sense instead of being dropped as a
// duplicate. VOCAB_SENSES=0 switches all of this off (general meaning
// everywhere, every word known), keeping the senses stored.
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS vocab_senses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    meaning_vi TEXT NOT NULL,
    example TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (vocabulary_id, book_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vocab_senses_book ON vocab_senses(book_id);
`);

export const sensesEnabled = () => process.env.VOCAB_SENSES !== '0';
const field = (d) => String(d || '').trim().toLowerCase();
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// What resolution needs about one shared entry: { id, meaning, bookId,
// domain, senses: [{ id, book_id, domain, meaning_vi }] }.
const ENTRY_SQL = `
  SELECT v.id, v.term, v.term_normalized, v.meaning_vi AS meaning, sb.id AS bookId, sb.domain
  FROM vocabulary v LEFT JOIN paragraphs sp ON sp.id = v.source_paragraph_id LEFT JOIN sections ss ON ss.id = sp.section_id
  LEFT JOIN chapters sc ON sc.id = ss.chapter_id LEFT JOIN books sb ON sb.id = sc.book_id
  WHERE v.owner_id IS NULL`;
const SENSE_SQL = 'SELECT s.id, s.vocabulary_id, s.book_id, s.meaning_vi, b.domain FROM vocab_senses s JOIN books b ON b.id = s.book_id';

// Every shared entry by its key, with its senses — for translation, which
// looks up many words per paragraph.
export function loadSenseIndex() {
  const byId = new Map(db.prepare(ENTRY_SQL).all().map((e) => [e.id, { ...e, senses: [] }]));
  for (const s of db.prepare(SENSE_SQL).all()) byId.get(s.vocabulary_id)?.senses.push(s);
  return new Map([...byId.values()].map((e) => [e.term_normalized, e]));
}

// The senses of some entries, by entry id (for a chapter's words).
export function sensesFor(ids) {
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  for (const s of db.prepare(`${SENSE_SQL} WHERE s.vocabulary_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) out.get(s.vocabulary_id)?.push(s);
  return out;
}

// Whether the entry's meaning already holds in `book` (rules 1–3).
export function knownForBook(info, book) {
  if (!sensesEnabled() || !info || !book) return true;
  if (!info.bookId || info.bookId === book.id) return true;
  const f = field(book.domain);
  if (f && field(info.domain) === f) return true;
  return info.senses.some((s) => s.book_id === book.id || (f && field(s.domain) === f));
}

// The meaning in `book`, and the sense it came from (null: the general one).
export function meaningForBook(info, book) {
  if (!info) return { meaning: '', sense: null };
  const general = { meaning: info.meaning, sense: null };
  if (!sensesEnabled() || !book) return general;
  const own = info.senses.find((s) => s.book_id === book.id);
  if (own) return { meaning: own.meaning_vi, sense: own };
  if (info.bookId === book.id) return general;
  const f = field(book.domain);
  if (f && field(info.domain) === f) return general;
  const sameField = f && info.senses.find((s) => field(s.domain) === f);
  return sameField ? { meaning: sameField.meaning_vi, sense: sameField } : general;
}

// ---- reading and writing senses ------------------------------------------------

export function listSenses(vocabularyId) {
  return db.prepare(`
    SELECT s.*, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title, b.title_en AS book_title_en, b.domain
    FROM vocab_senses s JOIN books b ON b.id = s.book_id WHERE s.vocabulary_id = ? ORDER BY b.id
  `).all(vocabularyId);
}

export function getSense(id) {
  return db.prepare('SELECT * FROM vocab_senses WHERE id = ?').get(id);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Adds or replaces the sense of a shared word for a book. A meaning equal
// to the general one is not stored (it would say nothing new).
export function upsertSense({ vocabularyId, bookId, meaning_vi, example = '', note = '', userId = null }) {
  const entry = db.prepare('SELECT id, meaning_vi FROM vocabulary WHERE id = ? AND owner_id IS NULL').get(vocabularyId);
  if (!entry) throw httpError(404, 'Chỉ từ trong kho chung mới có nghĩa theo sách.');
  if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId)) throw httpError(404, 'Không tìm thấy sách.');
  const meaning = String(meaning_vi || '').trim();
  if (!meaning) throw httpError(400, 'Hãy nhập nghĩa.');
  if (same(meaning, entry.meaning_vi)) return null;
  db.prepare(`
    INSERT INTO vocab_senses (vocabulary_id, book_id, meaning_vi, example, note, created_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vocabulary_id, book_id) DO UPDATE SET meaning_vi = excluded.meaning_vi,
      example = CASE WHEN excluded.example != '' THEN excluded.example ELSE vocab_senses.example END,
      note = CASE WHEN excluded.note != '' THEN excluded.note ELSE vocab_senses.note END, updated_at = datetime('now')
  `).run(vocabularyId, bookId, meaning, String(example || '').trim(), String(note || '').trim().slice(0, 500), userId);
  return db.prepare('SELECT * FROM vocab_senses WHERE vocabulary_id = ? AND book_id = ?').get(vocabularyId, bookId);
}

export function updateSense(id, { meaning_vi, example, note }) {
  const s = getSense(id);
  if (!s) throw httpError(404, 'Không tìm thấy nghĩa này.');
  const next = {
    meaning_vi: meaning_vi !== undefined ? String(meaning_vi).trim() : s.meaning_vi,
    example: example !== undefined ? String(example).trim() : s.example,
    note: note !== undefined ? String(note).trim().slice(0, 500) : s.note,
  };
  if (!next.meaning_vi) throw httpError(400, 'Hãy nhập nghĩa.');
  db.prepare("UPDATE vocab_senses SET meaning_vi = @meaning_vi, example = @example, note = @note, updated_at = datetime('now') WHERE id = @id").run({ ...next, id });
  return getSense(id);
}

export function deleteSense(id) {
  if (!db.prepare('DELETE FROM vocab_senses WHERE id = ?').run(id).changes) throw httpError(404, 'Không tìm thấy nghĩa này.');
}

// When entries merge, the merged one's senses move to the kept entry unless
// it already has one for that book. Returns the senses as they were, for undo.
export function moveSenses(fromId, toId) {
  const rows = db.prepare('SELECT * FROM vocab_senses WHERE vocabulary_id = ?').all(fromId);
  for (const s of rows) db.prepare('UPDATE OR IGNORE vocab_senses SET vocabulary_id = ? WHERE id = ?').run(toId, s.id);
  return rows;
}

export function restoreSenses(rows, vocabularyId) {
  for (const s of rows || []) {
    db.prepare(`INSERT OR REPLACE INTO vocab_senses (id, vocabulary_id, book_id, meaning_vi, example, note, created_by, created_at, updated_at)
      VALUES (@id, @vid, @book_id, @meaning_vi, @example, @note, @created_by, @created_at, @updated_at)`).run({ ...s, vid: vocabularyId });
  }
}
