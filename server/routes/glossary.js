// /api/glossary — the team's decided terminology (see server/discussions.js),
// per book or for every book, by topic.
import { Router } from 'express';
import { bookFilterSql } from '../bookAccess.js';
import { db } from '../db.js';
import { normalizeTerm } from '../normalize.js';
import { WORD_TYPES } from '../wordTypes.js';
import { isValidTopic } from '../vocabTopics.js';
import { upsertGlossary } from '../discussions.js';

const router = Router();

const COLS = `g.*, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title, u.name AS updated_by_name,
  t.paragraph_id AS thread_paragraph_id, t.chapter_id AS thread_chapter_id,
  (SELECT COUNT(*) FROM term_threads x WHERE x.term_normalized = g.term_normalized AND (g.book_id IS NULL OR x.book_id = g.book_id)) AS thread_count`;
const FROM = `glossary g LEFT JOIN books b ON b.id = g.book_id LEFT JOIN users u ON u.id = g.updated_by
  LEFT JOIN term_threads t ON t.id = g.thread_id`;
const getEntry = (id) => db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE g.id = ?`).get(id);

// GET /api/glossary?bookId=&scope=book|all&topic=&q=
// With bookId: that book's entries and the every-book ones (what the AI uses
// for it); scope=book narrows to the book's own, scope=all to every-book.
router.get('/', (req, res) => {
  const { bookId, scope, topic, q } = req.query;
  const where = [bookFilterSql(req, 'g.book_id')];
  const params = {};
  if (scope === 'all') where.push('g.book_id IS NULL');
  else if (Number(bookId)) {
    params.bookId = Number(bookId);
    where.push(scope === 'book' ? 'g.book_id = @bookId' : '(g.book_id = @bookId OR g.book_id IS NULL)');
  }
  if (topic) { where.push('g.topic = @topic'); params.topic = String(topic); }
  if (q && String(q).trim()) {
    where.push('(g.term LIKE @q OR g.meaning_vi LIKE @q OR g.note LIKE @q)');
    params.q = `%${String(q).trim()}%`;
  }
  res.json(db.prepare(`SELECT ${COLS} FROM ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.term COLLATE NOCASE LIMIT 2000`).all(params));
});

function readBody(body, existing = {}) {
  const pick = (k, n) => (body[k] !== undefined ? String(body[k] ?? '').trim().slice(0, n) : existing[k] ?? '');
  return {
    term: pick('term', 200),
    meaning_vi: pick('meaning_vi', 300),
    word_type: WORD_TYPES.includes(body.word_type) ? body.word_type : body.word_type === '' ? '' : existing.word_type ?? '',
    topic: isValidTopic(body.topic) ? body.topic : body.topic === '' ? '' : existing.topic ?? '',
    note: pick('note', 500),
  };
}

// POST /api/glossary — { term, meaning_vi, word_type?, topic?, note?, bookId? (omit for every book) }
router.post('/', (req, res) => {
  const entry = readBody(req.body || {});
  if (!entry.term || !entry.meaning_vi) return res.status(400).json({ error: 'Cần có thuật ngữ và cách dịch.' });
  const bookId = Number(req.body?.bookId) || null;
  if (bookId && !db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId)) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  const id = upsertGlossary({ ...entry, bookId, userId: req.user.id });
  return res.status(201).json(getEntry(id));
});

// PATCH /api/glossary/:id — same fields; bookId: null moves it to every book.
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM glossary WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy thuật ngữ.' });
  const next = readBody(req.body || {}, existing);
  if (!next.term || !next.meaning_vi) return res.status(400).json({ error: 'Cần có thuật ngữ và cách dịch.' });
  const bookId = req.body?.bookId !== undefined ? Number(req.body.bookId) || null : existing.book_id;
  const term_normalized = normalizeTerm(next.term);
  const clash = db.prepare('SELECT id FROM glossary WHERE COALESCE(book_id, 0) = ? AND term_normalized = ? AND id <> ?').get(bookId ?? 0, term_normalized, id);
  if (clash) return res.status(409).json({ error: `"${next.term}" đã có trong bảng thuật ngữ của phạm vi này.` });
  db.prepare(`
    UPDATE glossary SET book_id = ?, term = ?, term_normalized = ?, meaning_vi = ?, word_type = ?, topic = ?, note = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(bookId, next.term, term_normalized, next.meaning_vi, next.word_type, next.topic, next.note, req.user.id, id);
  return res.json(getEntry(id));
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM glossary WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Không tìm thấy thuật ngữ.' });
  return res.json({ ok: true });
});

export default router;
