// The standard table of contents every book follows (docs/db-postgres-toc-design.md §2):
//
//   front matter   Dedication, Preface, About the author…   (kind 'front', not numbered)
//   body           Part (optional) → Chapter → Section        (kind 'chapter', numbered 1…n)
//   back matter    Appendix, Glossary, Acknowledgments…      (kind 'back', not numbered)
//
// Headings are TOC entries (chapter title, section heading), never paragraph
// text; every title has an English and a Vietnamese form; "Chương 3" /
// "Phần 2" labels are computed from the order, never typed into a title.
// TOC_STANDARD=0 turns the labels and front/back grouping off (every chapter
// reads as a plain chapter, as before); the stored data stays.
import { db } from './db.js';

function ensureColumn(table, column, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}
ensureColumn('chapters', 'kind', "kind TEXT NOT NULL DEFAULT 'chapter'");
ensureColumn('chapters', 'title_vi', "title_vi TEXT NOT NULL DEFAULT ''");
// The title as it was before normalization (scripts/normalizeToc.mjs), kept
// for comparison and rollback; NULL when never changed.
ensureColumn('chapters', 'title_original', 'title_original TEXT');
ensureColumn('parts', 'title_vi', "title_vi TEXT NOT NULL DEFAULT ''");
ensureColumn('parts', 'title_original', 'title_original TEXT');
ensureColumn('sections', 'heading_vi', "heading_vi TEXT NOT NULL DEFAULT ''");
ensureColumn('sections', 'heading_original', 'heading_original TEXT');
// What a paragraph is (verse keeps its line breaks, an epigraph is set
// apart…) and its segment number in the source worksheet, if any.
// How the printed book labels its parts and chapters (NUMBERING below).
ensureColumn('books', 'toc_numbering', "toc_numbering TEXT NOT NULL DEFAULT 'numeric'");
ensureColumn('paragraphs', 'block_type', "block_type TEXT NOT NULL DEFAULT 'paragraph'");
ensureColumn('paragraphs', 'seg_no', "seg_no TEXT NOT NULL DEFAULT ''");

// Every row a TOC normalization changed, with the row as it was, so a run
// can be undone (scripts/normalizeToc.mjs --undo <run>).
db.exec(`
  CREATE TABLE IF NOT EXISTS toc_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    book_id INTEGER NOT NULL,
    tbl TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    before_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    undone_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_toc_changes_run ON toc_changes(run_id);
`);

export const tocStandardEnabled = () => process.env.TOC_STANDARD !== '0';

export const CHAPTER_KINDS = ['front', 'chapter', 'back'];
export const BLOCK_TYPES = ['paragraph', 'verse', 'quote', 'epigraph', 'list', 'note', 'glossary_entry'];

// Titles that are front or back matter, in English and Vietnamese.
const FRONT = /^(epigraph|đề từ|dedication|kính dâng|lời đề tặng|preface|lời tựa|lời dẫn|foreword|lời nói đầu|lời giới thiệu|introduction|giới thiệu|prologue|mở đầu|about (the|this)\b|about [a-z.\s]+$|về tác giả|đôi (nét|dòng) về|note to (the )?reader|author'?s note|copyright|contents|mục lục)/i;
const BACK = /^(appendix|appendices|phụ lục|glossary|bảng (chú giải )?thuật ngữ|acknowledg(e)?ments?|lời (cảm ơn|cảm tạ|tri ân)|notes|chú thích|ghi chú|bibliography|references|tài liệu tham khảo|index|chỉ mục|epilogue|lời kết|afterword|lời bạt)/i;

// 'front' / 'back' when the title is front/back matter, else null.
export function classifyTitle(title) {
  const t = plainTitle(title);
  if (BACK.test(t)) return 'back';
  if (FRONT.test(t)) return 'front';
  return null;
}

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function toNumber(token) {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (WORDS.includes(t)) return WORDS.indexOf(t);
  if (/^[ivxlc]+$/.test(t)) {
    let n = 0;
    for (let i = 0; i < t.length; i += 1) n += ROMAN[t[i]] < (ROMAN[t[i + 1]] || 0) ? -ROMAN[t[i]] : ROMAN[t[i]];
    return n;
  }
  return null;
}

const PREFIX = {
  part: /^\s*(?:part|phần|book|quyển)\s+([0-9]+|[ivxlc]+|[a-z]+)\b\s*[:.\-–—]?\s*/i,
  chapter: /^\s*(?:chapter|chương|ch\.)\s+([0-9]+|[ivxlc]+|[a-z]+)\b\s*[:.\-–—]?\s*/i,
};

// "CHAPTER 3: Why We've Come Undone" → { title: "Why We've Come Undone", number: 3 }.
// A title that is only the prefix ("Chapter 3") keeps it as its title.
export function stripNumberPrefix(title, level = 'chapter') {
  const raw = String(title || '').trim();
  const m = raw.match(PREFIX[level]);
  if (!m) return { title: raw, number: null };
  const number = toNumber(m[1]);
  if (number == null) return { title: raw, number: null };
  const rest = raw.slice(m[0].length).trim();
  return { title: rest || raw, number };
}

// Markdown marks and stray whitespace off a heading.
export function plainTitle(md) {
  return String(md || '').replace(/\*+|==|<\/?u>/g, '').replace(/[\t ]+/g, ' ').trim();
}

// Invisible characters (zero-width spaces/joiners, BOM) and doubled spaces
// off a title.
export function cleanTitle(s) {
  return String(s ?? '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

// English titles in the house style: Title Case. Only titles typed in ALL
// CAPS are changed (a mixed-case title is someone's deliberate choice);
// short function words stay lower case unless first or after a colon.
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'the', 'to', 'up', 'vs', 'with']);
export function titleCase(s) {
  const t = cleanTitle(s);
  if (/\p{Ll}/u.test(t)) return t;
  let startOfPhrase = true;
  let afterHyphen = false;
  return t.toLowerCase().split(/(\s+|-)/).map((w) => {
    if (w === '-') { afterHyphen = true; return w; }
    if (/^\s+$/.test(w) || !w) return w;
    const bare = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const keepLower = !startOfPhrase && !afterHyphen && SMALL.has(bare);
    startOfPhrase = /[:.!?—–]$/.test(w);
    afterHyphen = false;
    return keepLower ? w : w.replace(/\p{L}/u, (c) => c.toUpperCase());
  }).join('');
}

// A comparison key: case, diacritics, punctuation and markup folded away.
export function titleKey(s) {
  return plainTitle(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// How a book's own TOC labels its parts and chapters, so the app shows them
// as printed: "Part One: …" / "Chapter 1: …", "Part 1" / "Chapter 1", or no
// numbers at all (many anthologies). The Vietnamese line always reads
// "Phần 1" / "Chương 1" when the book numbers them.
export const NUMBERING = {
  words: { label: 'Part One · Chapter 1', part: (n) => `Part ${NUMBER_WORDS[n] ?? n}`, chapter: (n) => `Chapter ${n}` },
  numeric: { label: 'Part 1 · Chapter 1', part: (n) => `Part ${n}`, chapter: (n) => `Chapter ${n}` },
  none: { label: 'Không đánh số', part: null, chapter: null },
};
const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

// Adds number and labels to the chapters and parts of one book, in reading
// order: body chapters are numbered 1…n across the whole book, parts 1…n;
// front and back matter get no number. `label` is the book's own (English)
// label, `label_vi` its Vietnamese form; both null when the book prints none.
export function numberToc({ parts = [], chapters = [], numbering = 'numeric' }) {
  const on = tocStandardEnabled();
  const style = on ? NUMBERING[numbering] || NUMBERING.numeric : NUMBERING.none;
  const partNumber = new Map([...parts].sort((a, b) => a.order_index - b.order_index).map((p, i) => [p.id, i + 1]));
  let n = 0;
  const numbered = [...chapters].sort((a, b) => a.order_index - b.order_index).map((c) => {
    const kind = on && CHAPTER_KINDS.includes(c.kind) ? c.kind : 'chapter';
    const number = on && kind === 'chapter' ? (n += 1) : null;
    return { ...c, kind, number, label: number && style.chapter ? style.chapter(number) : null, label_vi: number && style.chapter ? `Chương ${number}` : null };
  });
  const byId = new Map(numbered.map((c) => [c.id, c]));
  return {
    parts: parts.map((p) => {
      const number = on ? partNumber.get(p.id) : null;
      return { ...p, number, label: number && style.part ? style.part(number) : null, label_vi: number && style.part ? `Phần ${number}` : null };
    }),
    chapters: chapters.map((c) => byId.get(c.id)),
  };
}

// The numbered form of one chapter of a book (chapter page, prev/next).
export function numberedChaptersOf(bookId) {
  const chapters = db.prepare('SELECT id, order_index, kind FROM chapters WHERE book_id = ? ORDER BY order_index').all(bookId);
  const numbering = db.prepare('SELECT toc_numbering FROM books WHERE id = ?').get(bookId)?.toc_numbering;
  return new Map(numberToc({ chapters, numbering }).chapters.map((c) => [c.id, c]));
}

// Checks a PATCH body's TOC fields; returns an error message or null.
export function tocFieldError({ kind, title_vi: titleVi, heading_vi: headingVi }) {
  if (kind !== undefined && !CHAPTER_KINDS.includes(kind)) return 'Loại chương không hợp lệ.';
  for (const v of [titleVi, headingVi]) {
    if (v !== undefined && (typeof v !== 'string' || v.length > 300)) return 'Tiêu đề tiếng Việt không hợp lệ (tối đa 300 ký tự).';
  }
  return null;
}
