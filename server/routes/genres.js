// /api/genres — the library's genres (thể loại): read by anyone who sees the
// vocabulary, managed by vocabulary editors (vocab.edit). See server/genres.js.
import { Router } from 'express';
import { db } from '../db.js';
import { autoAssignBooks, genreError, genresWithCounts } from '../genres.js';

const router = Router();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cleanKeywords = (s) => String(s ?? '').split(',').map((k) => clean(k)).filter(Boolean).join(', ');

// GET /api/genres — { genres: [{ id, name, description, keywords, sort_order, wordCount, bookCount }], ungrouped }
router.get('/', (req, res) => {
  res.json(genresWithCounts(req));
});

// POST /api/genres — { name, description?, keywords? }; books not filed by
// hand are filed again, since the new keywords may fit them.
router.post('/', (req, res) => {
  const b = req.body || {};
  const error = genreError(b);
  if (error) return res.status(400).json({ error });
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM genres').get().n;
  try {
    const id = db.prepare('INSERT INTO genres (name, description, keywords, sort_order, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(clean(b.name), clean(b.description), cleanKeywords(b.keywords), next, req.user.id).lastInsertRowid;
    autoAssignBooks();
    res.status(201).json({ ...genresWithCounts(req), created: id });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'Đã có thể loại trùng tên.' });
    throw err;
  }
});

// PATCH /api/genres/:id — { name?, description?, keywords?, sort_order? }
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM genres WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ error: 'Không tìm thấy thể loại.' });
  const b = req.body || {};
  const error = genreError(b, { partial: true });
  if (error) return res.status(400).json({ error });
  try {
    db.transaction(() => {
      if (b.sort_order !== undefined && b.sort_order !== g.sort_order) {
        // move to a new place: the others shift around it
        const order = db.prepare('SELECT id FROM genres WHERE id <> ? ORDER BY sort_order, name').all(id).map((r) => r.id);
        order.splice(Math.max(0, Math.min(order.length, b.sort_order)), 0, id);
        const set = db.prepare('UPDATE genres SET sort_order = ? WHERE id = ?');
        order.forEach((gid, i) => set.run(i, gid));
      }
      db.prepare('UPDATE genres SET name = ?, description = ?, keywords = ? WHERE id = ?').run(
        b.name !== undefined ? clean(b.name) : g.name,
        b.description !== undefined ? clean(b.description) : g.description,
        b.keywords !== undefined ? cleanKeywords(b.keywords) : g.keywords,
        id,
      );
    })();
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'Đã có thể loại trùng tên.' });
    throw err;
  }
  // keywords and order decide automatic filing
  if (b.keywords !== undefined || b.sort_order !== undefined) autoAssignBooks();
  res.json(genresWithCounts(req));
});

// DELETE /api/genres/:id — books in it go back to automatic filing; words'
// corrections for it go with it; no word is deleted.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.transaction(() => {
    db.prepare('UPDATE books SET genre_manual = 0 WHERE genre_id = ?').run(id);
    return db.prepare('DELETE FROM genres WHERE id = ?').run(id);
  })();
  if (!info.changes) return res.status(404).json({ error: 'Không tìm thấy thể loại.' });
  autoAssignBooks();
  res.json(genresWithCounts(req));
});

export default router;
