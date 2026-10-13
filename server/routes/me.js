// /api/me — the signed-in user's personal workspace on the shared library.
import { Router } from 'express';
import { db } from '../db.js';
import { can } from '../auth/middleware.js';
import { bookFilterSql } from '../bookAccess.js';
import '../bookCovers.js'; // books.cover_* columns

const router = Router();

const plain = (s, n = 260) => {
  const t = (s || '').replace(/\*\*|==|<\/?u>|(?<!\*)\*(?!\*)/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
};

// ---- reading position ---------------------------------------------------------

router.get('/reading', (req, res) => {
  res.json(db.prepare(`
    SELECT r.book_id AS bookId, r.chapter_id AS chapterId, r.paragraph_id AS paragraphId, c.title AS chapterTitle, r.updated_at AS updatedAt
    FROM user_reading r JOIN chapters c ON c.id = r.chapter_id
    WHERE r.user_id = ? AND ${bookFilterSql(req, 'r.book_id')} ORDER BY r.updated_at DESC
  `).all(req.user.id));
});

// PUT { chapterId, paragraphId? } — the book is taken from the chapter; a
// paragraph is kept only if it belongs to that chapter.
router.put('/reading', (req, res) => {
  const chapter = db.prepare('SELECT id, book_id FROM chapters WHERE id = ?').get(Number(req.body?.chapterId));
  if (!chapter) return res.status(404).json({ error: 'Không tìm thấy chương.' });
  const paragraph = req.body?.paragraphId
    ? db.prepare('SELECT p.id FROM paragraphs p JOIN sections s ON s.id = p.section_id WHERE p.id = ? AND s.chapter_id = ?').get(Number(req.body.paragraphId), chapter.id)
    : null;
  db.prepare(`
    INSERT INTO user_reading (user_id, book_id, chapter_id, paragraph_id, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_id = excluded.chapter_id, paragraph_id = excluded.paragraph_id, updated_at = excluded.updated_at
  `).run(req.user.id, chapter.book_id, chapter.id, paragraph?.id ?? null);
  res.json({ ok: true });
});

// ---- preferences ----------------------------------------------------------------

const PREF_KEYS = ['contentWidth', 'fontSize', 'ttsVoice', 'ttsSpeed', 'chapterViewMode', 'theme', 'readingFont', 'showNotes', 'showVocabHints', 'showThreadMarks', 'uiScale'];

router.get('/preferences', (req, res) => {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ?').get(req.user.id);
  let value = null;
  try { value = row ? JSON.parse(row.value) : null; } catch { value = null; }
  res.json({ preferences: value });
});

router.put('/preferences', (req, res) => {
  const clean = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => PREF_KEYS.includes(k)));
  db.prepare(`
    INSERT INTO user_preferences (user_id, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify(clean));
  res.json({ ok: true });
});

// ---- home -------------------------------------------------------------------------

// GET /api/me/home — everything the personal home page shows, in one call,
// limited to what the user's role may see.
router.get('/home', (req, res) => {
  const uid = req.user.id;

  const chapterProgress = db.prepare(`
    SELECT COUNT(*) AS total, SUM(p.status = 'translated') AS translated
    FROM paragraphs p JOIN sections s ON s.id = p.section_id WHERE s.chapter_id = ?
  `);
  const bookProgress = db.prepare(`
    SELECT COUNT(*) AS total, SUM(p.status = 'translated') AS translated
    FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE c.book_id = ?
  `);
  // A bilingual taste of where the reader is: the first translated paragraph
  // of the chapter they are in.
  const excerpt = db.prepare(`
    SELECT p.id, p.english_md, p.vietnamese_md FROM paragraphs p JOIN sections s ON s.id = p.section_id
    WHERE s.chapter_id = ? AND p.vietnamese_md <> '' ORDER BY s.order_index, p.order_index LIMIT 1
  `);
  const reading = db.prepare(`
    SELECT r.updated_at, r.paragraph_id, b.id AS book_id, b.title_en, b.title_vi, b.author, b.cover_lg, b.cover_sm, b.cover_color, c.id AS chapter_id, c.title AS chapter_title,
      (SELECT COUNT(*) FROM chapters c2 WHERE c2.book_id = b.id) AS chapter_count,
      (SELECT COUNT(*) FROM chapters c3 WHERE c3.book_id = b.id AND c3.order_index <= c.order_index) AS chapter_number
    FROM user_reading r JOIN books b ON b.id = r.book_id JOIN chapters c ON c.id = r.chapter_id
    WHERE r.user_id = ? AND ${bookFilterSql(req, 'b.id')} ORDER BY r.updated_at DESC LIMIT 4
  `).all(uid).map((r) => {
    // Where they stopped, if known (and translated); else the chapter's first translated paragraph.
    const stopped = r.paragraph_id ? db.prepare("SELECT id, english_md, vietnamese_md FROM paragraphs WHERE id = ? AND vietnamese_md <> ''").get(r.paragraph_id) : null;
    const ex = stopped || excerpt.get(r.chapter_id);
    return {
      book: { id: r.book_id, title_en: r.title_en, title_vi: r.title_vi, author: r.author, cover_lg: r.cover_lg, cover_sm: r.cover_sm, cover_color: r.cover_color, progress: bookProgress.get(r.book_id) },
      chapter: { id: r.chapter_id, title: r.chapter_title, number: r.chapter_number, count: r.chapter_count, progress: chapterProgress.get(r.chapter_id) },
      excerpt: ex ? { paragraphId: ex.id, english: plain(ex.english_md), vietnamese: plain(ex.vietnamese_md), isWhereStopped: Boolean(stopped) } : null,
      paragraphId: r.paragraph_id,
      updatedAt: r.updated_at,
    };
  });

  let review = null;
  if (can(req, 'review.own')) {
    // the shared words and the user's own
    const FROM = '(SELECT * FROM vocabulary WHERE owner_id IS NULL OR owner_id = @uid) v LEFT JOIN vocab_progress vp ON vp.vocabulary_id = v.id AND vp.user_id = @uid';
    const dueToday = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} WHERE COALESCE(vp.due_date, '') <= date('now')`).get({ uid }).c;
    const reviewedToday = db.prepare("SELECT COUNT(*) AS c FROM review_log WHERE user_id = ? AND reviewed_date = date('now')").get(uid).c;
    const mastered = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} WHERE COALESCE(vp.status, 'Đang học') = 'Thành thạo'`).get({ uid }).c;
    const days = new Set(db.prepare('SELECT DISTINCT reviewed_date AS d FROM review_log WHERE user_id = ? ORDER BY d DESC LIMIT 400').all(uid).map((r) => r.d));
    let streakDays = 0;
    const cursor = new Date();
    if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(cursor.toISOString().slice(0, 10))) { streakDays += 1; cursor.setDate(cursor.getDate() - 1); }
    // The last 7 days of review activity, oldest first, for a small chart.
    const counts = new Map(db.prepare(`
      SELECT reviewed_date AS d, COUNT(*) AS c FROM review_log WHERE user_id = ? AND reviewed_date >= date('now', '-6 days') GROUP BY d
    `).all(uid).map((r) => [r.d, r.c]));
    const week = [...Array(7)].map((_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      const key = d.toISOString().slice(0, 10);
      return { date: key, count: counts.get(key) || 0 };
    });
    review = { dueToday, reviewedToday, mastered, streakDays, week };
  }

  const marks = can(req, 'marks.own')
    ? db.prepare(`
        SELECT m.paragraph_id AS paragraphId, m.is_flagged, m.is_bookmarked, m.is_highlighted, p.english_md,
               c.id AS chapterId, c.title AS chapterTitle, b.title_vi, b.title_en
        FROM paragraph_marks m JOIN paragraphs p ON p.id = m.paragraph_id JOIN sections s ON s.id = p.section_id
        JOIN chapters c ON c.id = s.chapter_id JOIN books b ON b.id = c.book_id
        WHERE m.user_id = ? AND ${bookFilterSql(req, 'b.id')} ORDER BY m.updated_at DESC, m.paragraph_id DESC LIMIT 4
      `).all(uid).map((m) => ({
        paragraphId: m.paragraphId,
        chapterId: m.chapterId,
        chapterTitle: m.chapterTitle,
        bookTitle: m.title_vi || m.title_en,
        kind: m.is_flagged ? 'flag' : m.is_bookmarked ? 'bookmark' : 'highlight',
        excerpt: plain(m.english_md, 140),
      }))
    : null;

  const newWords = db.prepare('SELECT id, term, ipa, word_type, meaning_vi FROM vocabulary WHERE owner_id IS NULL ORDER BY id DESC LIMIT 6').all();

  // For editors: chapters that still have untranslated paragraphs.
  const todo = can(req, 'books.edit')
    ? db.prepare(`
        SELECT c.id AS chapterId, c.title, b.title_vi, b.title_en,
          COUNT(p.id) AS total, SUM(p.status = 'pending') AS pending
        FROM chapters c JOIN books b ON b.id = c.book_id
        JOIN sections s ON s.chapter_id = c.id JOIN paragraphs p ON p.section_id = s.id
        WHERE ${bookFilterSql(req, 'b.id')}
        GROUP BY c.id HAVING pending > 0 ORDER BY b.id, c.order_index LIMIT 4
      `).all().map((r) => ({ chapterId: r.chapterId, title: r.title, bookTitle: r.title_vi || r.title_en, pending: r.pending, total: r.total }))
    : null;

  res.json({
    reading,
    review,
    marks,
    newWords,
    todo,
    counts: {
      books: db.prepare(`SELECT COUNT(*) AS c FROM books b WHERE ${bookFilterSql(req, 'b.id')}`).get().c,
      words: db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id IS NULL OR owner_id = ?').get(uid).c,
    },
  });
});

export default router;
