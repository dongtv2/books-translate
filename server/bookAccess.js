// Who may see which book.
//
// A book is "public" (everyone with books.read sees it — every book was,
// before this existed, and new books still are) or "restricted": then only
// its owner, the users and groups listed in book_access, and admins
// (users.manage) see it. Everything inside a book — parts, chapters,
// sections, paragraphs, discussions, assignments, glossary entries, and the
// book a vocabulary entry came from — follows the book.
//
// Enforcement has two layers:
// 1. guardBookContent (middleware on /api): every book, part, chapter,
//    section, paragraph, discussion, post, glossary entry or assignment
//    named in the path, the query or the body is resolved to its book; a
//    book the user may not see answers 404, as if it did not exist.
// 2. Lists that span books (library, home, discussions, glossary,
//    assignments, vocabulary sources) filter with visibleBookIds().
// BOOK_SCOPES=0 turns both off (every book visible, as before).
import { db } from './db.js';
// creates vocab_senses, which BOOK_OF_SQL below reads
import './vocabSenses.js';

function ensureColumn(table, column, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}
ensureColumn('books', 'visibility', "visibility TEXT NOT NULL DEFAULT 'public'");
ensureColumn('books', 'owner_id', 'owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
db.exec(`
  CREATE TABLE IF NOT EXISTS book_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((user_id IS NULL) <> (group_id IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_book_access_user ON book_access(book_id, user_id) WHERE user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_book_access_group ON book_access(book_id, group_id) WHERE group_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_book_access_book ON book_access(book_id);
`);

export const scopesEnabled = () => process.env.BOOK_SCOPES !== '0';
export const VISIBILITIES = ['public', 'restricted'];

const seesEverything = (req) => !scopesEnabled() || Boolean(req?.permissions?.has('users.manage'));

const visibleForUser = db.prepare(`
  SELECT id FROM books b
  WHERE b.visibility = 'public' OR b.owner_id = @uid
    OR EXISTS (SELECT 1 FROM book_access a WHERE a.book_id = b.id AND (a.user_id = @uid
      OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = @uid)))
`);

// The ids of the books this request may see, or null for "all of them".
// Cached on the request: lists call it several times.
export function visibleBookIds(req) {
  if (seesEverything(req)) return null;
  if (!req._visibleBooks) req._visibleBooks = new Set(visibleForUser.all({ uid: req.user?.id ?? -1 }).map((r) => r.id));
  return req._visibleBooks;
}

export function canSeeBook(req, bookId) {
  if (bookId == null) return true;
  const ids = visibleBookIds(req);
  return !ids || ids.has(Number(bookId));
}

// A SQL condition limiting `column` (a book id) to the visible books, with
// its params; "1" when everything is visible. NULL book ids (glossary
// entries for every book, words with no source) pass.
export function bookFilterSql(req, column) {
  const ids = visibleBookIds(req);
  if (!ids) return '1';
  return ids.size ? `(${column} IS NULL OR ${column} IN (${[...ids].join(',')}))` : `${column} IS NULL`;
}

// ---- resolving any id to its book -----------------------------------------------

// Prepared on first use: some of these tables are created by modules loaded
// after this one (discussions.js, vocabSenses.js…), so a fresh database
// would not have them yet at import time.
const BOOK_OF_SQL = {
  book: 'SELECT id AS book_id FROM books WHERE id = ?',
  part: 'SELECT book_id FROM parts WHERE id = ?',
  chapter: 'SELECT book_id FROM chapters WHERE id = ?',
  section: 'SELECT c.book_id FROM sections s JOIN chapters c ON c.id = s.chapter_id WHERE s.id = ?',
  paragraph: 'SELECT c.book_id FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE p.id = ?',
  thread: 'SELECT book_id FROM term_threads WHERE id = ?',
  post: 'SELECT t.book_id FROM term_posts p JOIN term_threads t ON t.id = p.thread_id WHERE p.id = ?',
  glossary: 'SELECT book_id FROM glossary WHERE id = ?',
  assignment: 'SELECT book_id FROM work_assignments WHERE id = ?',
  sense: 'SELECT book_id FROM vocab_senses WHERE id = ?',
};
const bookOfStatements = new Map();
function bookOfStatement(kind) {
  if (!BOOK_OF_SQL[kind]) return null;
  if (!bookOfStatements.has(kind)) bookOfStatements.set(kind, db.prepare(BOOK_OF_SQL[kind]));
  return bookOfStatements.get(kind);
}

// The book an entity belongs to: a number, null (exists but belongs to no
// book, e.g. an every-book glossary entry) or undefined (no such entity —
// left to the route to answer 404 in its own words).
export function bookOf(kind, id) {
  const row = bookOfStatement(kind)?.get(Number(id));
  return row ? row.book_id : undefined;
}

// Path patterns naming an entity, in the order they are tried.
const PATH_KINDS = [
  [/^\/api\/books\/(\d+)/, 'book'],
  [/^\/api\/parts\/(\d+)/, 'part'],
  [/^\/api\/chapters\/(\d+)/, 'chapter'],
  [/^\/api\/sections\/(\d+)/, 'section'],
  [/^\/api\/paragraphs\/(\d+)/, 'paragraph'],
  [/^\/api\/discussions\/posts\/(\d+)/, 'post'],
  [/^\/api\/discussions\/(\d+)/, 'thread'],
  [/^\/api\/glossary\/(\d+)/, 'glossary'],
  [/^\/api\/assignments\/(\d+)/, 'assignment'],
  [/^\/api\/vocabulary\/senses\/(\d+)/, 'sense'],
];
// Query / body keys naming an entity.
const FIELD_KINDS = {
  bookId: 'book', chapterId: 'chapter', sectionId: 'section', paragraphId: 'paragraph',
  source_paragraph_id: 'paragraph', threadId: 'thread',
};

// Every [kind, id] a request names.
export function referencedEntities(path, query = {}, body = {}) {
  const out = [];
  for (const [re, kind] of PATH_KINDS) {
    const m = path.match(re);
    if (m) { out.push([kind, Number(m[1])]); break; }
  }
  for (const source of [query, body && typeof body === 'object' && !Array.isArray(body) ? body : {}]) {
    for (const [key, kind] of Object.entries(FIELD_KINDS)) {
      const v = source?.[key];
      if (v != null && v !== '' && Number.isInteger(Number(v)) && Number(v) > 0) out.push([kind, Number(v)]);
    }
  }
  return out;
}

const NOT_FOUND = { error: 'Không tìm thấy nội dung này.' };

// Layer 1. Runs after authentication; never blocks requests that name no
// book content.
export function guardBookContent(req, res, next) {
  if (!req.user || seesEverything(req)) return next();
  const path = req.originalUrl.split('?')[0];
  for (const [kind, id] of referencedEntities(path, req.query, req.body)) {
    const bookId = bookOf(kind, id);
    if (bookId != null && !canSeeBook(req, bookId)) return res.status(404).json(NOT_FOUND);
  }
  next();
}

// ---- managing a book's access ---------------------------------------------------

// Admins, and the book's owner when they may edit books.
export function canManageAccess(req, book) {
  if (req.permissions?.has('users.manage')) return true;
  return Boolean(book.owner_id && book.owner_id === req.user?.id && req.permissions?.has('books.edit'));
}

export function accessOf(bookId) {
  const book = db.prepare('SELECT id, visibility, owner_id FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  return {
    visibility: book.visibility,
    owner: book.owner_id ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(book.owner_id) || null : null,
    users: db.prepare('SELECT u.id, u.name, u.email FROM book_access a JOIN users u ON u.id = a.user_id WHERE a.book_id = ? ORDER BY u.name, u.email').all(bookId),
    groups: db.prepare('SELECT g.id, g.name FROM book_access a JOIN groups g ON g.id = a.group_id WHERE a.book_id = ? ORDER BY g.name').all(bookId),
  };
}

// Replaces a book's visibility and its user/group lists in one go.
export function setAccess(bookId, { visibility, userIds = [], groupIds = [], ownerId }, byUserId = null) {
  if (!VISIBILITIES.includes(visibility)) throw new Error('Chế độ hiển thị không hợp lệ.');
  const users = [...new Set(userIds.map(Number).filter(Boolean))];
  const groups = [...new Set(groupIds.map(Number).filter(Boolean))];
  for (const id of users) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new Error(`Không có người dùng #${id}.`);
  for (const id of groups) if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) throw new Error(`Không có nhóm #${id}.`);
  db.transaction(() => {
    db.prepare('UPDATE books SET visibility = ? WHERE id = ?').run(visibility, bookId);
    if (ownerId !== undefined) db.prepare('UPDATE books SET owner_id = ? WHERE id = ?').run(Number(ownerId) || null, bookId);
    db.prepare('DELETE FROM book_access WHERE book_id = ?').run(bookId);
    for (const id of users) db.prepare('INSERT INTO book_access (book_id, user_id, created_by) VALUES (?, ?, ?)').run(bookId, id, byUserId);
    for (const id of groups) db.prepare('INSERT INTO book_access (book_id, group_id, created_by) VALUES (?, ?, ?)').run(bookId, id, byUserId);
  })();
  return accessOf(bookId);
}

// The user who created a book owns it (they keep seeing it if restricted).
export function setOwner(bookId, userId) {
  if (userId) db.prepare('UPDATE books SET owner_id = ? WHERE id = ? AND owner_id IS NULL').run(userId, bookId);
}

// Vocabulary is shared, but where a word came from is book content: for a
// source book the user may not see, the source fields and the example
// sentence (quoted from that book) are blanked.
export function redactSources(req, rows) {
  const ids = visibleBookIds(req);
  if (!ids) return rows;
  return rows.map((r) => (r?.source_book_id != null && !ids.has(r.source_book_id) ? {
    ...r, example: '', source_paragraph_id: null, source_chapter_id: null, source_chapter_title: null,
    source_book_id: null, source_book_title: null, source_book_title_en: null, source_book_domain: null, source_book_specialty: null,
  } : r));
}
