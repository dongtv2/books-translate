import { Router } from 'express';
import { db } from '../db.js';
import { stripKindleCitations } from '../importers/citationCleanup.js';
import { withUserMarks } from '../auth/marks.js';
import { plainText } from '../../src/lib/inlineMarkdown.js';
import { containsTerm } from '../../src/lib/vocabMatch.js';
import { redactSources } from '../bookAccess.js';
import { meaningForBook, sensesFor } from '../vocabSenses.js';
import { numberedChaptersOf, tocFieldError, tocStandardEnabled } from '../toc.js';
import { can } from '../auth/middleware.js';

const router = Router();

// GET /api/chapters/:id — full reading/editing view: book context + sections + paragraphs
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(id);
  if (!chapter) return res.status(404).json({ error: 'Không tìm thấy chương.' });

  const book = db.prepare('SELECT id, title_en, title_vi, domain FROM books WHERE id = ?').get(chapter.book_id);
  const sections = db.prepare('SELECT * FROM sections WHERE chapter_id = ? ORDER BY order_index').all(id);
  const paragraphsBySection = new Map();
  if (sections.length) {
    const placeholders = sections.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM paragraphs WHERE section_id IN (${placeholders}) ORDER BY order_index`)
      .all(...sections.map((s) => s.id));
    for (const row of rows) {
      if (!paragraphsBySection.has(row.section_id)) paragraphsBySection.set(row.section_id, []);
      paragraphsBySection.get(row.section_id).push(row);
    }
  }

  // Chapter navigation (prev/next within the same book) for the reader.
  // Labels ("Chương 3", "Phần đầu sách") follow the book's reading order (toc.js).
  const numbered = numberedChaptersOf(chapter.book_id);
  const toc = (c) => {
    const x = numbered.get(c.id);
    return { kind: x?.kind ?? 'chapter', number: x?.number ?? null, label: x?.label ?? null, label_vi: x?.label_vi ?? null };
  };
  // Readers step over chapters that have no text yet (see books.js).
  const readerView = tocStandardEnabled() && !can(req, 'books.edit');
  const siblings = db.prepare(`
    SELECT c.id, c.title, c.title_vi, EXISTS (SELECT 1 FROM sections s JOIN paragraphs p ON p.section_id = s.id WHERE s.chapter_id = c.id) AS has_text
    FROM chapters c WHERE c.book_id = ? ORDER BY c.order_index
  `).all(chapter.book_id)
    .filter((c) => !readerView || c.has_text || c.id === id)
    .map(({ has_text: _hasText, ...c }) => ({ ...c, ...toc(c) }));
  const idx = siblings.findIndex((c) => c.id === id);

  // Vocabulary harvested from this chapter's paragraphs (shared entries and
  // the reader's own words).
  const vocabulary = db.prepare(`
    SELECT v.id, v.term, v.ipa, v.word_type, v.meaning_vi, v.source_paragraph_id, v.owner_id
    FROM vocabulary v JOIN paragraphs p ON p.id = v.source_paragraph_id JOIN sections s ON s.id = p.section_id
    WHERE s.chapter_id = ? AND (v.owner_id IS NULL OR v.owner_id = ?) ORDER BY s.order_index, p.order_index, v.id
  `).all(id, req.user.id);

  // Every vocabulary entry (from any chapter or book) that occurs in this
  // chapter's English text, with the reader's own status — the reader marks
  // these in the English column with a quick look at IPA and meaning.
  const englishText = [...paragraphsBySection.values()].flat().map((p) => plainText(p.english_md || '')).join('\n');
  const knownTerms = englishText
    ? db.prepare(`
        SELECT v.id, v.term, v.ipa, v.word_type, v.meaning_vi, v.topic, v.example, v.source_paragraph_id, v.owner_id, COALESCE(vp.status, 'Đang học') AS status,
          sc.id AS source_chapter_id, sc.title AS source_chapter_title, sb.id AS source_book_id,
          COALESCE(NULLIF(sb.title_vi, ''), sb.title_en) AS source_book_title, sb.domain AS source_book_domain
        FROM vocabulary v LEFT JOIN vocab_progress vp ON vp.vocabulary_id = v.id AND vp.user_id = @uid
          LEFT JOIN paragraphs sp ON sp.id = v.source_paragraph_id LEFT JOIN sections ss ON ss.id = sp.section_id
          LEFT JOIN chapters sc ON sc.id = ss.chapter_id LEFT JOIN books sb ON sb.id = sc.book_id
        WHERE v.owner_id IS NULL OR v.owner_id = @uid
      `).all({ uid: req.user.id }).filter((v) => containsTerm(englishText, v.term))
    : [];
  // Each word's meaning in THIS book (its sense here, or the general one);
  // the general meaning rides along when it differs. Then words first met
  // in a book this reader may not see lose their source and example.
  const senses = sensesFor(knownTerms.map((v) => v.id));
  for (let i = 0; i < knownTerms.length; i += 1) {
    const v = knownTerms[i];
    const { meaning, sense } = meaningForBook({ meaning: v.meaning_vi, bookId: v.source_book_id, domain: v.source_book_domain, senses: senses.get(v.id) || [] }, book);
    knownTerms[i] = redactSources(req, [{ ...v, meaning_vi: meaning, meaning_general: sense ? v.meaning_vi : undefined, sense_id: sense?.id ?? null }])[0];
  }

  // Term discussions in this chapter, for each paragraph's badge.
  const threads = db.prepare('SELECT id, paragraph_id, term, side, status, discussion_status, resolution_vi, anchor_start, anchor_end, anchor_text FROM term_threads WHERE chapter_id = ? ORDER BY id').all(id);

  res.json({
    ...chapter,
    ...toc(chapter),
    book,
    vocabulary,
    knownTerms,
    threads,
    sections: sections.map((s) => ({ ...s, paragraphs: withUserMarks(paragraphsBySection.get(s.id) || [], req.user.id) })),
    prevChapter: idx > 0 ? siblings[idx - 1] : null,
    nextChapter: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
  });
});

// PATCH /api/chapters/:id — rename and/or move to a different Part
// (partId: a number to assign, null to unassign, omitted to leave as-is).
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM chapters WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy chương.' });

  const body = req.body || {};
  if (body.title !== undefined && typeof body.title !== 'string') return res.status(400).json({ error: 'Tên chương không hợp lệ.' });
  const title = body.title !== undefined ? body.title.trim() : existing.title;
  if (!title) return res.status(400).json({ error: 'Thiếu tên chương.' });
  const tocError = tocFieldError(body);
  if (tocError) return res.status(400).json({ error: tocError });
  const partId = body.partId !== undefined ? (body.partId === null ? null : Number(body.partId)) : existing.part_id;
  // A chapter only joins a part of its own book.
  if (partId != null && !db.prepare('SELECT 1 FROM parts WHERE id = ? AND book_id = ?').get(partId, existing.book_id)) {
    return res.status(400).json({ error: 'Phần này không thuộc sách của chương.' });
  }
  const kind = body.kind ?? existing.kind;
  const titleVi = body.title_vi !== undefined ? body.title_vi.trim() : existing.title_vi;

  db.prepare('UPDATE chapters SET title = ?, title_vi = ?, kind = ?, part_id = ? WHERE id = ?').run(title, titleVi, kind, partId, id);
  res.json(db.prepare('SELECT * FROM chapters WHERE id = ?').get(id));
});

// DELETE /api/chapters/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM chapters WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy chương.' });
  res.json({ ok: true });
});

// POST /api/chapters/:id/move — { direction: 'up' | 'down' }, swaps
// order_index with the adjacent chapter that shares the same Part (or the
// same "no part" group) so moving within one part's list never disturbs
// another part's ordering.
router.post('/:id/move', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(id);
  if (!chapter) return res.status(404).json({ error: 'Không tìm thấy chương.' });

  const direction = req.body?.direction;
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'direction phải là "up" hoặc "down".' });
  }

  const siblings = chapter.part_id == null
    ? db.prepare('SELECT id, order_index FROM chapters WHERE book_id = ? AND part_id IS NULL ORDER BY order_index').all(chapter.book_id)
    : db.prepare('SELECT id, order_index FROM chapters WHERE book_id = ? AND part_id = ? ORDER BY order_index').all(chapter.book_id, chapter.part_id);

  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return res.json({ ok: true, moved: false });

  const other = siblings[swapIdx];
  db.transaction(() => {
    db.prepare('UPDATE chapters SET order_index = ? WHERE id = ?').run(other.order_index, id);
    db.prepare('UPDATE chapters SET order_index = ? WHERE id = ?').run(chapter.order_index, other.id);
  })();
  res.json({ ok: true, moved: true });
});

// POST /api/chapters/:id/paragraphs — append raw English text directly to
// the chapter, without the caller having to think about "sections" at all:
// reuses the chapter's first (usually headless) section if one exists,
// otherwise creates one. This is what lets a user just keep pasting more
// text into an existing chapter instead of accidentally creating a
// duplicate chapter when they really meant "more content for this one".
router.post('/:id/paragraphs', (req, res) => {
  const chapterId = parseInt(req.params.id, 10);
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Thiếu nội dung đoạn văn.' });

  const paragraphs = stripKindleCitations(
    text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  );
  if (paragraphs.length === 0) return res.status(400).json({ error: 'Không tách được đoạn văn nào (có thể toàn bộ chỉ là dòng trích dẫn Kindle).' });

  const run = db.transaction(() => {
    let section = db.prepare('SELECT id FROM sections WHERE chapter_id = ? ORDER BY order_index LIMIT 1').get(chapterId);
    if (!section) {
      const sectionId = db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, 0, NULL)').run(chapterId).lastInsertRowid;
      section = { id: sectionId };
    }
    const nextIndex = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM paragraphs WHERE section_id = ?').get(section.id).n;
    const insertParagraph = db.prepare(`
      INSERT INTO paragraphs (section_id, order_index, english_md, status) VALUES (?, ?, ?, 'pending')
    `);
    return paragraphs.map((p, i) => insertParagraph.run(section.id, nextIndex + i, p).lastInsertRowid);
  });
  const ids = run();

  const placeholders = ids.map(() => '?').join(',');
  res.json(db.prepare(`SELECT * FROM paragraphs WHERE id IN (${placeholders}) ORDER BY order_index`).all(...ids));
});

// POST /api/chapters/:id/sections — add a section (heading) with an initial paragraph block
router.post('/:id/sections', (req, res) => {
  const chapterId = parseInt(req.params.id, 10);
  const heading = (req.body?.heading || '').trim() || null;
  const text = (req.body?.text || '').trim();

  const nextIndex = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM sections WHERE chapter_id = ?').get(chapterId).n;
  const run = db.transaction(() => {
    const sectionId = db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, ?, ?)')
      .run(chapterId, nextIndex, heading).lastInsertRowid;
    if (text) {
      const paragraphs = stripKindleCitations(
        text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
      );
      const insertParagraph = db.prepare(`
        INSERT INTO paragraphs (section_id, order_index, english_md, status) VALUES (?, ?, ?, 'pending')
      `);
      paragraphs.forEach((p, i) => insertParagraph.run(sectionId, i, p));
    }
    return sectionId;
  });
  const sectionId = run();
  res.json(db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId));
});

export default router;
