import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// BOOKS_DB_PATH lets a second instance (tests, staging) run on a copy.
const dbPath = process.env.BOOKS_DB_PATH || path.join(dataDir, 'books.db');
export const db = new Database(dbPath);
// Where files that belong with this database (e.g. the setup token) go.
export const dataDirectory = path.dirname(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// WAL + NORMAL is the recommended, crash-safe pairing (a power cut can lose
// the last moments of writes, never corrupt the file); fewer fsyncs make
// writes much faster. Wait for a busy lock instead of failing at once, and
// keep more pages and temp tables in memory.
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -16000');
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title_en TEXT NOT NULL,
    title_vi TEXT,
    author TEXT,
    publisher TEXT,
    publish_date TEXT,
    original_year TEXT,
    isbn10 TEXT,
    isbn13 TEXT,
    page_count TEXT,
    format TEXT,
    language TEXT,
    rating TEXT,
    amazon_url TEXT,
    extra_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    part_id INTEGER REFERENCES parts(id) ON DELETE SET NULL,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    heading TEXT
  );

  CREATE TABLE IF NOT EXISTS paragraphs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    english_md TEXT NOT NULL,
    vietnamese_md TEXT NOT NULL DEFAULT '',
    phrases_verbs_md TEXT NOT NULL DEFAULT '',
    vocabulary_md TEXT NOT NULL DEFAULT '',
    citations_md TEXT NOT NULL DEFAULT '',
    remarks_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'translated')),
    is_flagged INTEGER NOT NULL DEFAULT 0,
    is_bookmarked INTEGER NOT NULL DEFAULT 0,
    is_highlighted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_parts_book ON parts(book_id);
  CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
  CREATE INDEX IF NOT EXISTS idx_chapters_part ON chapters(part_id);
  CREATE INDEX IF NOT EXISTS idx_sections_chapter ON sections(chapter_id);
  CREATE INDEX IF NOT EXISTS idx_paragraphs_section ON paragraphs(section_id);
  CREATE INDEX IF NOT EXISTS idx_paragraphs_status ON paragraphs(status);

  CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    term_normalized TEXT NOT NULL,
    ipa TEXT,
    word_type TEXT NOT NULL,
    meaning_vi TEXT NOT NULL,
    example TEXT,
    topic TEXT,
    date_added TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Đang học'
      CHECK (status IN ('Thành thạo', 'Đang học', 'Cần ôn gấp')),
    source_paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE SET NULL,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_date TEXT NOT NULL DEFAULT (date('now')),
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_vocab_normalized ON vocabulary(term_normalized);
  CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocabulary(status);
  CREATE INDEX IF NOT EXISTS idx_vocab_source_paragraph ON vocabulary(source_paragraph_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- A library of named system prompts (e.g. "Tiểu thuyết", "Sách kỹ thuật")
  -- so different books can be translated with different instructions.
  -- Exactly one row has is_default = 1 — the fallback for books with no
  -- explicit prompt_template_id assigned.
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per SRS grading event — powers the "reviewed today" / streak /
  -- accuracy stats on the Ôn tập dashboard (vocabulary.due_date only ever
  -- holds the *next* due date, not review history).
  CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    grade TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_date TEXT NOT NULL DEFAULT (date('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_review_log_date ON review_log(reviewed_date);
  CREATE INDEX IF NOT EXISTS idx_review_log_vocab ON review_log(vocabulary_id);
`);

// --- Lightweight forward migrations -----------------------------------
// CREATE TABLE IF NOT EXISTS doesn't add columns to a table that already
// existed from an earlier version of the schema, so patch those in by hand.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('books', 'prompt_template_id', 'prompt_template_id INTEGER REFERENCES prompt_templates(id) ON DELETE SET NULL');

ensureColumn('paragraphs', 'citations_md', "citations_md TEXT NOT NULL DEFAULT ''");
// Citation / quotation text that belongs to a paragraph but is not part of
// its running prose (a quoted passage, a source line, a footnote): the
// original under the English column and its translation under the
// Vietnamese one, side by side with citations_md (the notes) in one row.
// The free-text topic words had before the fixed topic list (vocabTopics.js).
// What each book is about, for AI prompts and the vocabulary's context
// (see bookContext.js).
ensureColumn('books', 'domain', "domain TEXT NOT NULL DEFAULT ''");
ensureColumn('books', 'specialty', "specialty TEXT NOT NULL DEFAULT ''");
ensureColumn('books', 'context_note', "context_note TEXT NOT NULL DEFAULT ''");
ensureColumn('vocabulary', 'topic_original', "topic_original TEXT NOT NULL DEFAULT ''");
ensureColumn('paragraphs', 'citation_en_md', "citation_en_md TEXT NOT NULL DEFAULT ''");
ensureColumn('paragraphs', 'citation_vi_md', "citation_vi_md TEXT NOT NULL DEFAULT ''");
ensureColumn('paragraphs', 'is_flagged', 'is_flagged INTEGER NOT NULL DEFAULT 0');
ensureColumn('paragraphs', 'is_bookmarked', 'is_bookmarked INTEGER NOT NULL DEFAULT 0');
ensureColumn('paragraphs', 'is_highlighted', 'is_highlighted INTEGER NOT NULL DEFAULT 0');

ensureColumn('vocabulary', 'ease_factor', "ease_factor REAL NOT NULL DEFAULT 2.5");
ensureColumn('vocabulary', 'interval_days', "interval_days REAL NOT NULL DEFAULT 0");
ensureColumn('vocabulary', 'repetitions', "repetitions INTEGER NOT NULL DEFAULT 0");
ensureColumn('vocabulary', 'due_date', "due_date TEXT NOT NULL DEFAULT ''");
ensureColumn('vocabulary', 'last_reviewed_at', 'last_reviewed_at TEXT');

// SQLite forbids a non-constant ALTER TABLE ... DEFAULT, so backfill separately.
db.exec(`UPDATE vocabulary SET due_date = date('now') WHERE due_date = ''`);
db.exec('CREATE INDEX IF NOT EXISTS idx_vocab_due_date ON vocabulary(due_date)');

export default db;
