// Team work on the words and phrases of a book: discussion threads about how
// to translate a term in a paragraph, proposals people vote on, and the
// decision ("chốt") that files the agreed translation in the glossary.
//
// The glossary is the team's decided terminology, per book (or for every
// book), by topic. It is given to the AI as binding context whenever a
// paragraph of that book is translated or discussed with the assistant
// (paragraphTranslation.js, assistant.js) — unlike the vocabulary, which is
// what learners review and may hold AI-chosen meanings nobody checked.
//
// Assignments put people or groups on a book, chapter, section or paragraph
// as translator or reviewer; a reviewer may decide the threads in their
// scope without the glossary.manage permission.
import { db } from './db.js';
import './auth/store.js'; // users and groups tables
import { normalizeTerm } from './normalize.js';
import { containsTerm } from '../src/lib/vocabMatch.js';
import { plainText } from '../src/lib/inlineMarkdown.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL: applies to every book
    book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    term_normalized TEXT NOT NULL,
    meaning_vi TEXT NOT NULL,
    word_type TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    vocabulary_id INTEGER REFERENCES vocabulary(id) ON DELETE SET NULL,
    thread_id INTEGER REFERENCES term_threads(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_term ON glossary(COALESCE(book_id, 0), term_normalized);

  -- One thread per term in one paragraph. The chapter/section/book columns
  -- are copied from the paragraph so lists filter without joins and a thread
  -- goes away with the part of the book it belongs to.
  CREATE TABLE IF NOT EXISTS term_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    term_normalized TEXT NOT NULL,
    -- the column the words were picked from: 'en' source term, 'vi' wording
    side TEXT NOT NULL DEFAULT 'en' CHECK (side IN ('en', 'vi')),
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution_vi TEXT NOT NULL DEFAULT '',
    glossary_id INTEGER REFERENCES glossary(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_term_threads_paragraph ON term_threads(paragraph_id);
  CREATE INDEX IF NOT EXISTS idx_term_threads_book ON term_threads(book_id, status);

  -- comment: discussion; proposal: a candidate translation (meaning_vi) that
  -- can be voted for and picked; event: "chốt" / "mở lại", written by the app.
  CREATE TABLE IF NOT EXISTS term_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES term_threads(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('comment', 'proposal', 'event')),
    body TEXT NOT NULL DEFAULT '',
    meaning_vi TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_term_posts_thread ON term_posts(thread_id);

  CREATE TABLE IF NOT EXISTS term_votes (
    post_id INTEGER NOT NULL REFERENCES term_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  );

  -- When each user last opened each thread, for "chưa đọc".
  CREATE TABLE IF NOT EXISTS term_thread_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES term_threads(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, thread_id)
  );

  -- The most specific non-null column is the scope (book < chapter <
  -- section < paragraph); exactly one of user_id / group_id is set.
  CREATE TABLE IF NOT EXISTS work_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
    section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
    paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('translator', 'reviewer')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_work_assignments_book ON work_assignments(book_id);
`);

// Where in the paragraph the discussed words were picked: offsets into the
// column's plain text (inlineMarkdown.plainText) and the exact text there,
// so the reader can mark them and jump to them. If the paragraph is edited
// later, the client finds the text again near the old place.
{
  const cols = db.prepare('PRAGMA table_info(term_threads)').all().map((c) => c.name);
  if (!cols.includes('anchor_start')) db.exec('ALTER TABLE term_threads ADD COLUMN anchor_start INTEGER');
  if (!cols.includes('anchor_end')) db.exec('ALTER TABLE term_threads ADD COLUMN anchor_end INTEGER');
  if (!cols.includes('anchor_text')) db.exec("ALTER TABLE term_threads ADD COLUMN anchor_text TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('discussion_status')) db.exec("ALTER TABLE term_threads ADD COLUMN discussion_status TEXT NOT NULL DEFAULT 'open'");
  if (!cols.includes('discussion_closed_by')) db.exec('ALTER TABLE term_threads ADD COLUMN discussion_closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!cols.includes('discussion_closed_at')) db.exec('ALTER TABLE term_threads ADD COLUMN discussion_closed_at TEXT');
}

export const ASSIGNMENT_ROLES = {
  translator: 'Dịch',
  reviewer: 'Duyệt',
};

// ---- where a paragraph sits ------------------------------------------------

const findPlace = db.prepare(`
  SELECT p.id AS paragraph_id, p.section_id, s.chapter_id, c.book_id
  FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id
  WHERE p.id = ?
`);
export const placeOfParagraph = (paragraphId) => findPlace.get(paragraphId) || null;

// ---- assignments --------------------------------------------------------------

// Assignments that cover a place: those on its book, its chapter, its section
// or the paragraph itself. `place` may stop at any level (a chapter has no
// section_id / paragraph_id).
export function assignmentsCovering(place) {
  return db.prepare(`
    SELECT a.*, u.name AS user_name, u.email AS user_email, g.name AS group_name
    FROM work_assignments a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN groups g ON g.id = a.group_id
    WHERE a.book_id = @book_id
      AND (a.chapter_id IS NULL OR a.chapter_id = @chapter_id)
      AND (a.section_id IS NULL OR a.section_id = @section_id)
      AND (a.paragraph_id IS NULL OR a.paragraph_id = @paragraph_id)
    ORDER BY (a.chapter_id IS NOT NULL) + (a.section_id IS NOT NULL) + (a.paragraph_id IS NOT NULL), a.id
  `).all({ chapter_id: null, section_id: null, paragraph_id: null, ...place });
}

const groupsOf = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?');
const userGroupIds = (userId) => groupsOf.all(userId).map((r) => r.group_id);

export function assignmentMatchesUser(a, userId, groupIds = userGroupIds(userId)) {
  return a.user_id === userId || (a.group_id != null && groupIds.includes(a.group_id));
}

export function isReviewerFor(userId, place) {
  const groupIds = userGroupIds(userId);
  return assignmentsCovering(place).some((a) => a.role === 'reviewer' && assignmentMatchesUser(a, userId, groupIds));
}

// SQL condition (on alias t of term_threads) for "threads in a scope the
// user is assigned to", for the "Được giao cho tôi" filter and the badge.
export function assignedThreadsCondition(userId) {
  const groupIds = userGroupIds(userId);
  const who = groupIds.length ? `(a.user_id = ${Number(userId)} OR a.group_id IN (${groupIds.map(Number).join(',')}))` : `a.user_id = ${Number(userId)}`;
  return `EXISTS (SELECT 1 FROM work_assignments a WHERE ${who} AND a.book_id = t.book_id
    AND (a.chapter_id IS NULL OR a.chapter_id = t.chapter_id)
    AND (a.section_id IS NULL OR a.section_id = t.section_id)
    AND (a.paragraph_id IS NULL OR a.paragraph_id = t.paragraph_id))`;
}

// ---- glossary as context ------------------------------------------------------

// The decided terms that occur in `text`, for a book: the book's own entry
// wins over an every-book entry for the same term.
export function glossaryFor(bookId, text) {
  const plain = plainText(text || '');
  if (!plain.trim()) return [];
  const rows = db.prepare(`
    SELECT id, book_id, term, term_normalized, meaning_vi, word_type, topic, note FROM glossary
    WHERE book_id IS NULL OR book_id = ? ORDER BY book_id IS NULL
  `).all(bookId ?? -1);
  const seen = new Set();
  return rows.filter((g) => {
    if (seen.has(g.term_normalized)) return false;
    seen.add(g.term_normalized);
    return containsTerm(plain, g.term);
  });
}

// The block added to translation prompts.
export function glossaryPromptBlock(entries) {
  if (!entries.length) return '';
  return `BẢNG THUẬT NGỮ ĐÃ THỐNG NHẤT (nhóm dịch đã chốt — bắt buộc dùng đúng cách dịch này, kể cả khi từ đã có trong kho từ vựng):\n${
    entries.map((g) => `- ${g.term} = ${g.meaning_vi}${g.note ? ` (${g.note})` : ''}`).join('\n')}`;
}

// Inserts or updates the glossary entry for a term in a scope (bookId null
// = every book). Returns its id.
export function upsertGlossary({ bookId = null, term, meaning_vi, word_type = '', topic = '', note = '', vocabularyId = null, threadId = null, userId = null }) {
  const term_normalized = normalizeTerm(term);
  const existing = db.prepare('SELECT id FROM glossary WHERE COALESCE(book_id, 0) = ? AND term_normalized = ?').get(bookId ?? 0, term_normalized);
  if (existing) {
    db.prepare(`
      UPDATE glossary SET term = ?, meaning_vi = ?, word_type = ?, topic = ?, note = ?,
        vocabulary_id = COALESCE(?, vocabulary_id), thread_id = COALESCE(?, thread_id), updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(term, meaning_vi, word_type, topic, note, vocabularyId, threadId, userId, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO glossary (book_id, term, term_normalized, meaning_vi, word_type, topic, note, vocabulary_id, thread_id, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, term, term_normalized, meaning_vi, word_type, topic, note, vocabularyId, threadId, userId, userId).lastInsertRowid;
}
