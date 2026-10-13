// Cover images of books.
//
// The browser does the image work (src/lib/coverImage.js): it scales the
// picked image to two WebP renditions — "lg" (600 px wide, the book page)
// and "sm" (200 px, lists) — and measures its main color. The server only
// checks and stores: the bytes must really be an image (magic numbers, not
// the file name or the declared type), each file is size-capped, names are
// made here (book id + content hash), and replaced files are deleted.
// Files live next to the database in covers/; the book row keeps their
// names, the color and the size, so pages can lay the cover out before it
// loads. A missing file simply falls back to the typographic cover.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDirectory } from './db.js';

for (const [col, def] of [
  ['cover_lg', "cover_lg TEXT NOT NULL DEFAULT ''"],
  ['cover_sm', "cover_sm TEXT NOT NULL DEFAULT ''"],
  ['cover_color', "cover_color TEXT NOT NULL DEFAULT ''"],
  ['cover_w', 'cover_w INTEGER'],
  ['cover_h', 'cover_h INTEGER'],
  ['cover_updated_at', 'cover_updated_at TEXT'],
]) {
  if (!db.prepare('PRAGMA table_info(books)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE books ADD COLUMN ${def}`);
}

export const coverDir = () => process.env.COVER_DIR || path.join(dataDirectory, 'covers');
export const MAX_BYTES = { lg: 1.5 * 1024 * 1024, sm: 400 * 1024 };
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

// The real type of an image from its first bytes, or null.
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function removeFiles(row) {
  for (const name of [row?.cover_lg, row?.cover_sm]) {
    if (name && /^[\w.-]+$/.test(name)) fs.rmSync(path.join(coverDir(), name), { force: true });
  }
}

// Stores a book's cover: { lg, sm } are Buffers; meta { color, width, height }.
// Returns the book's cover fields.
export function saveCover(bookId, { lg, sm }, meta = {}) {
  const book = db.prepare('SELECT id, cover_lg, cover_sm FROM books WHERE id = ?').get(bookId);
  if (!book) throw httpError(404, 'Không tìm thấy sách.');
  const files = {};
  for (const [size, buf] of [['lg', lg], ['sm', sm]]) {
    if (!buf?.length) throw httpError(400, 'Thiếu ảnh bìa.');
    if (buf.length > MAX_BYTES[size]) throw httpError(413, 'Ảnh bìa quá lớn sau khi nén.');
    const type = sniffImage(buf);
    if (!type) throw httpError(415, 'File không phải ảnh WebP, JPEG hoặc PNG.');
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    files[size] = { name: `book-${book.id}-${hash}-${size}.${EXT[type]}`, buf };
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(meta.color || '')) ? meta.color.toLowerCase() : '';
  const dim = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 20000 ? Number(v) : null);

  fs.mkdirSync(coverDir(), { recursive: true });
  for (const f of Object.values(files)) fs.writeFileSync(path.join(coverDir(), f.name), f.buf);
  db.prepare(`UPDATE books SET cover_lg = ?, cover_sm = ?, cover_color = ?, cover_w = ?, cover_h = ?, cover_updated_at = datetime('now') WHERE id = ?`)
    .run(files.lg.name, files.sm.name, color, dim(meta.width), dim(meta.height), book.id);
  // the previous files, unless the same image was uploaded again
  if (book.cover_lg !== files.lg.name || book.cover_sm !== files.sm.name) {
    removeFiles({ cover_lg: book.cover_lg !== files.lg.name ? book.cover_lg : '', cover_sm: book.cover_sm !== files.sm.name ? book.cover_sm : '' });
  }
  return coverOf(book.id);
}

export function deleteCover(bookId) {
  const book = db.prepare('SELECT id, cover_lg, cover_sm FROM books WHERE id = ?').get(bookId);
  if (!book) throw httpError(404, 'Không tìm thấy sách.');
  db.prepare("UPDATE books SET cover_lg = '', cover_sm = '', cover_color = '', cover_w = NULL, cover_h = NULL, cover_updated_at = datetime('now') WHERE id = ?").run(book.id);
  removeFiles(book);
}

export function coverOf(bookId) {
  return db.prepare('SELECT cover_lg, cover_sm, cover_color, cover_w, cover_h, cover_updated_at FROM books WHERE id = ?').get(bookId);
}

// The file for /api/books/:id/cover/:size, or null.
export function coverFile(bookId, size) {
  const row = db.prepare('SELECT cover_lg, cover_sm FROM books WHERE id = ?').get(bookId);
  const name = size === 'sm' ? row?.cover_sm : size === 'lg' ? row?.cover_lg : '';
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  const file = path.join(coverDir(), name);
  return fs.existsSync(file) ? file : null;
}

// Removes a deleted book's files (books rows go by CASCADE elsewhere).
export function removeCoverFiles(row) {
  removeFiles(row);
}
