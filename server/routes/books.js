import { Router } from 'express';
import { db } from '../db.js';
import { chatText } from '../llm/chat.js';
import multer from 'multer';
import { accessOf, bookFilterSql, canManageAccess, setAccess, setOwner, VISIBILITIES } from '../bookAccess.js';
import { MAX_BYTES, coverFile, deleteCover, removeCoverFiles, saveCover } from '../bookCovers.js';
import { NUMBERING, numberToc, tocStandardEnabled } from '../toc.js';
import { autoAssignBooks, genreAiEnabled, genreSuggestionPrompt, listGenres, parseGenreSuggestion } from '../genres.js';
import { can } from '../auth/middleware.js';

const router = Router();

const BOOK_FIELDS = [
  'title_en', 'title_vi', 'author', 'publisher', 'publish_date', 'original_year',
  'isbn10', 'isbn13', 'page_count', 'format', 'language', 'rating', 'amazon_url',
  'domain', 'specialty', 'context_note',
];

function withParsedExtra(book) {
  let extra_json = {};
  try { extra_json = JSON.parse(book.extra_json || '{}'); } catch { /* ignore */ }
  return { ...book, extra_json };
}

// GET /api/books
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapterCount,
      (SELECT COUNT(*) FROM paragraphs p JOIN sections s ON p.section_id = s.id JOIN chapters c ON s.chapter_id = c.id WHERE c.book_id = b.id) AS paragraphCount,
      (SELECT COUNT(*) FROM paragraphs p JOIN sections s ON p.section_id = s.id JOIN chapters c ON s.chapter_id = c.id WHERE c.book_id = b.id AND p.status = 'translated') AS translatedCount
    FROM books b
    WHERE ${bookFilterSql(req, 'b.id')}
    ORDER BY b.id DESC
  `).all();
  res.json(rows.map(withParsedExtra));
});

// POST /api/books — create an empty book (metadata only), seeded with one chapter/section.
router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.title_en?.trim()) return res.status(400).json({ error: 'Thiếu tên sách (tiếng Anh).' });

  const fields = Object.fromEntries(BOOK_FIELDS.map((f) => [f, body[f] || '']));
  const run = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO books (title_en, title_vi, author, publisher, publish_date, original_year, isbn10, isbn13, page_count, format, language, rating, amazon_url, domain, specialty, context_note, extra_json)
      VALUES (@title_en, @title_vi, @author, @publisher, @publish_date, @original_year, @isbn10, @isbn13, @page_count, @format, @language, @rating, @amazon_url, @domain, @specialty, @context_note, '{}')
    `).run(fields);
    const bookId = info.lastInsertRowid;
    const chapterId = db.prepare('INSERT INTO chapters (book_id, part_id, order_index, title) VALUES (?, NULL, 0, ?)')
      .run(bookId, 'Chương 1').lastInsertRowid;
    db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, 0, NULL)').run(chapterId);
    return bookId;
  });

  const bookId = run();
  setOwner(bookId, req.user.id);
  autoAssignBooks(bookId);
  res.json(withParsedExtra(db.prepare('SELECT * FROM books WHERE id = ?').get(bookId)));
});

// GET /api/books/:id — metadata + table of contents
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!book) return res.status(404).json({ error: 'Không tìm thấy sách.' });

  const partRows = db.prepare('SELECT * FROM parts WHERE book_id = ? ORDER BY order_index').all(id);
  const chapterRows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM paragraphs p JOIN sections s ON p.section_id = s.id WHERE s.chapter_id = c.id) AS paragraphCount,
      (SELECT COUNT(*) FROM paragraphs p JOIN sections s ON p.section_id = s.id WHERE s.chapter_id = c.id AND p.status = 'translated') AS translatedCount
    FROM chapters c WHERE c.book_id = ? ORDER BY order_index
  `).all(id);
  // "Chương 3" / "Phần 2" labels and front/back matter (toc.js), numbered
  // over the whole outline. Chapters with no paragraphs yet (the rest of a
  // book's TOC, waiting for its text) are shown to editors only, and so is a
  // part left without chapters.
  const numbered = numberToc({ parts: partRows, chapters: chapterRows, numbering: book.toc_numbering });
  const readerView = tocStandardEnabled() && !can(req, 'books.edit');
  const chapters = readerView ? numbered.chapters.filter((c) => c.paragraphCount > 0) : numbered.chapters;
  const parts = readerView ? numbered.parts.filter((p) => chapters.some((c) => c.part_id === p.id)) : numbered.parts;

  const sectionsByChapter = new Map();
  if (chapters.length) {
    const placeholders = chapters.map(() => '?').join(',');
    const sectionRows = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM paragraphs p WHERE p.section_id = s.id) AS paragraphCount,
        (SELECT COUNT(*) FROM paragraphs p WHERE p.section_id = s.id AND p.status = 'translated') AS translatedCount
      FROM sections s WHERE s.chapter_id IN (${placeholders}) ORDER BY s.order_index
    `).all(...chapters.map((c) => c.id));
    for (const s of sectionRows) {
      if (!sectionsByChapter.has(s.chapter_id)) sectionsByChapter.set(s.chapter_id, []);
      sectionsByChapter.get(s.chapter_id).push(s);
    }
  }
  const chaptersWithSections = chapters.map((c) => ({ ...c, sections: sectionsByChapter.get(c.id) || [] }));

  const chaptersByPart = new Map();
  const chaptersWithoutPart = [];
  for (const ch of chaptersWithSections) {
    if (ch.part_id == null) chaptersWithoutPart.push(ch);
    else {
      if (!chaptersByPart.has(ch.part_id)) chaptersByPart.set(ch.part_id, []);
      chaptersByPart.get(ch.part_id).push(ch);
    }
  }

  res.json({
    ...withParsedExtra(book),
    genre_name: book.genre_id ? db.prepare('SELECT name FROM genres WHERE id = ?').get(book.genre_id)?.name ?? null : null,
    parts: parts.map((p) => ({ ...p, chapters: chaptersByPart.get(p.id) || [] })),
    chaptersWithoutPart,
  });
});

// POST /api/books/:id/suggest-context — the AI's guess at the book's field,
// specialty and a short context note, from its title, author and opening
// paragraphs; shown in the edit form for the user to accept or change.
router.post('/:id/suggest-context', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!book) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  const sample = db.prepare(`
    SELECT p.english_md FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id
    WHERE c.book_id = ? ORDER BY c.order_index, s.order_index, p.order_index LIMIT 3
  `).all(id).map((r) => r.english_md.slice(0, 600)).join('\n\n');
  try {
    const answer = await chatText({
      system: 'Bạn là thủ thư chuyên phân loại sách. Chỉ trả về một đối tượng JSON, không giải thích.',
      temperature: 0,
      maxTokens: 500,
      messages: [{
        role: 'user',
        content: `Sách: "${book.title_en}"${book.title_vi ? ` (bản Việt: "${book.title_vi}")` : ''}${book.author ? `, tác giả ${book.author}` : ''}.\n${sample ? `Trích đoạn đầu sách:\n${sample}\n` : ''}\nTrả về JSON bằng tiếng Việt với các khoá:\n- "domain": lĩnh vực chính (ngắn, ví dụ "Tâm lý học, Nuôi dạy con")\n- "specialty": chuyên môn hoặc lý thuyết cụ thể của sách (ví dụ "Tâm lý học phát triển; lý thuyết gắn bó (attachment theory)")\n- "context_note": 1–2 câu tóm tắt sách bàn về điều gì, viết cho người dịch`,
      }],
    });
    const json = JSON.parse((answer.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    res.json({
      domain: String(json.domain || '').trim(),
      specialty: String(json.specialty || '').trim(),
      context_note: String(json.context_note || '').trim(),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof SyntaxError ? 'AI trả về sai định dạng. Thử lại hoặc tự điền.' : err.message });
  }
});

// POST /api/books/:id/suggest-genre — the AI's pick among the library's
// genres for a book no keyword files (genres.js), with a one-line reason;
// shown to the editor, never applied here.
router.post('/:id/suggest-genre', async (req, res) => {
  if (!genreAiEnabled()) return res.status(503).json({ error: 'Gợi ý thể loại bằng AI đang tắt (GENRE_AI=0).' });
  const id = parseInt(req.params.id, 10);
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!book) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  const genres = listGenres();
  if (!genres.length) return res.status(400).json({ error: 'Thư viện chưa có thể loại nào.' });
  const sample = db.prepare(`
    SELECT p.english_md FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id
    WHERE c.book_id = ? ORDER BY c.order_index, s.order_index, p.order_index LIMIT 3
  `).all(id).map((r) => r.english_md.slice(0, 600)).join('\n\n');
  const { system, content } = genreSuggestionPrompt(book, sample, genres);
  try {
    const answer = await chatText({ system, temperature: 0, maxTokens: 300, messages: [{ role: 'user', content }] });
    res.json(parseGenreSuggestion(answer, genres));
  } catch (err) {
    res.status(502).json({ error: err instanceof SyntaxError ? 'AI trả về sai định dạng. Thử lại hoặc chọn tay.' : err.message });
  }
});

// PATCH /api/books/:id — edit metadata
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy sách.' });

  const updates = {};
  for (const f of BOOK_FIELDS) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  // genre_id: a genre picked by hand, or "auto" to file the book by its
  // field again (genres.js)
  if (req.body.genre_id !== undefined) {
    if (req.body.genre_id === 'auto' || req.body.genre_id === null) {
      updates.genre_manual = 0;
    } else {
      const gid = Number(req.body.genre_id);
      if (!db.prepare('SELECT 1 FROM genres WHERE id = ?').get(gid)) return res.status(400).json({ error: 'Không có thể loại này.' });
      updates.genre_id = gid;
      updates.genre_manual = 1;
    }
  }
  if (req.body.toc_numbering !== undefined) {
    if (!Object.hasOwn(NUMBERING, req.body.toc_numbering)) return res.status(400).json({ error: 'Kiểu đánh số mục lục không hợp lệ.' });
    updates.toc_numbering = req.body.toc_numbering;
  }
  if (req.body.prompt_template_id !== undefined) {
    updates.prompt_template_id = req.body.prompt_template_id || null;
  }
  const merged = { ...existing, ...updates };
  db.prepare(`
    UPDATE books SET
      title_en=@title_en, title_vi=@title_vi, author=@author, publisher=@publisher,
      publish_date=@publish_date, original_year=@original_year, isbn10=@isbn10, isbn13=@isbn13,
      page_count=@page_count, format=@format, language=@language, rating=@rating, amazon_url=@amazon_url,
      domain=@domain, specialty=@specialty, context_note=@context_note,
      prompt_template_id=@prompt_template_id, toc_numbering=@toc_numbering,
      genre_id=@genre_id, genre_manual=@genre_manual,
      updated_at = datetime('now')
    WHERE id=@id
  `).run({ ...merged, id });
  // field, specialty or title may point to another genre now
  autoAssignBooks(id);

  res.json(withParsedExtra(db.prepare('SELECT * FROM books WHERE id = ?').get(id)));
});

// DELETE /api/books/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const covers = db.prepare('SELECT cover_lg, cover_sm FROM books WHERE id = ?').get(id);
  const info = db.prepare('DELETE FROM books WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  removeCoverFiles(covers);
  res.json({ ok: true });
});

// ---- cover image (server/bookCovers.js) -------------------------------------------

// PUT /api/books/:id/cover — multipart: files "lg" and "sm" (the browser's
// WebP renditions), fields color, width, height.
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES.lg, files: 2, fields: 5 } });
router.put('/:id/cover', (req, res) => {
  coverUpload.fields([{ name: 'lg', maxCount: 1 }, { name: 'sm', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh bìa quá lớn.' : 'Dữ liệu ảnh không hợp lệ.' });
    try {
      const cover = saveCover(parseInt(req.params.id, 10), { lg: req.files?.lg?.[0]?.buffer, sm: req.files?.sm?.[0]?.buffer }, req.body || {});
      res.json(cover);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
});

// DELETE /api/books/:id/cover — back to the typographic cover.
router.delete('/:id/cover', (req, res) => {
  try {
    deleteCover(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/books/:id/cover/lg|sm — the image. Its URL carries the file
// name (?v=), which changes with the image, so it can be cached for good.
router.get('/:id/cover/:size', (req, res) => {
  const file = coverFile(parseInt(req.params.id, 10), req.params.size);
  if (!file) return res.status(404).json({ error: 'Sách chưa có ảnh bìa.' });
  res.set({ 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(file);
});

// GET /api/books/:id/marks — the signed-in user's flagged/bookmarked/highlighted
// paragraphs across the whole book, with enough chapter/section context to link back to them.
router.get('/:id/marks', (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  const rows = db.prepare(`
    SELECT p.id, p.english_md, m.is_flagged, m.is_bookmarked, m.is_highlighted,
           s.id AS section_id, c.id AS chapter_id, c.title AS chapter_title
    FROM paragraph_marks m
    JOIN paragraphs p ON p.id = m.paragraph_id
    JOIN sections s ON p.section_id = s.id
    JOIN chapters c ON s.chapter_id = c.id
    WHERE m.user_id = ? AND c.book_id = ? AND (m.is_flagged = 1 OR m.is_bookmarked = 1 OR m.is_highlighted = 1)
    ORDER BY c.order_index, s.order_index, p.order_index
  `).all(req.user.id, bookId);
  res.json(rows);
});

// POST /api/books/:id/parts — add a Part manually
router.post('/:id/parts', (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Thiếu tên phần.' });
  const nextIndex = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM parts WHERE book_id = ?').get(bookId).n;
  const info = db.prepare('INSERT INTO parts (book_id, order_index, title) VALUES (?, ?, ?)').run(bookId, nextIndex, title);
  res.json(db.prepare('SELECT * FROM parts WHERE id = ?').get(info.lastInsertRowid));
});

// POST /api/books/:id/chapters — add a Chapter manually (seeded with one empty section)
router.post('/:id/chapters', (req, res) => {
  const bookId = parseInt(req.params.id, 10);
  const title = (req.body?.title || '').trim();
  const partId = req.body?.partId ? Number(req.body.partId) : null;
  if (!title) return res.status(400).json({ error: 'Thiếu tên chương.' });
  if (partId != null && !db.prepare('SELECT 1 FROM parts WHERE id = ? AND book_id = ?').get(partId, bookId)) {
    return res.status(400).json({ error: 'Phần này không thuộc sách.' });
  }

  const nextIndex = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM chapters WHERE book_id = ?').get(bookId).n;
  const run = db.transaction(() => {
    const chapterId = db.prepare('INSERT INTO chapters (book_id, part_id, order_index, title) VALUES (?, ?, ?, ?)')
      .run(bookId, partId, nextIndex, title).lastInsertRowid;
    db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, 0, NULL)').run(chapterId);
    return chapterId;
  });
  const chapterId = run();
  res.json(db.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId));
});

// GET /api/books/:id/access — who may see the book; PUT { visibility,
// userIds, groupIds, ownerId? } replaces it. Admins and the book's owner.
router.get('/:id/access', (req, res) => {
  const book = db.prepare('SELECT id, owner_id FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  res.json({ ...accessOf(book.id), canManage: canManageAccess(req, book), visibilities: VISIBILITIES });
});
router.put('/:id/access', (req, res) => {
  const book = db.prepare('SELECT id, owner_id FROM books WHERE id = ?').get(Number(req.params.id));
  if (!book) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  if (!canManageAccess(req, book)) return res.status(403).json({ error: 'Chỉ quản trị viên hoặc chủ sách được đổi quyền xem.' });
  const b = req.body || {};
  try {
    const next = setAccess(book.id, {
      visibility: b.visibility,
      userIds: Array.isArray(b.userIds) ? b.userIds : [],
      groupIds: Array.isArray(b.groupIds) ? b.groupIds : [],
      // only admins hand a book to someone else
      ownerId: req.permissions.has('users.manage') ? b.ownerId : undefined,
    }, req.user.id);
    res.json({ ...next, canManage: true, visibilities: VISIBILITIES });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
