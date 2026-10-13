import { Router } from 'express';
import { db } from '../db.js';
import { tocFieldError } from '../toc.js';

const router = Router();

// PATCH /api/parts/:id — rename
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy phần.' });
  const body = req.body || {};
  const title = body.title !== undefined ? String(body.title).trim() : existing.title;
  if (!title) return res.status(400).json({ error: 'Thiếu tên phần.' });
  const tocError = tocFieldError(body);
  if (tocError) return res.status(400).json({ error: tocError });
  const titleVi = body.title_vi !== undefined ? body.title_vi.trim() : existing.title_vi;
  db.prepare('UPDATE parts SET title = ?, title_vi = ? WHERE id = ?').run(title, titleVi, id);
  res.json(db.prepare('SELECT * FROM parts WHERE id = ?').get(id));
});

// DELETE /api/parts/:id — chapters under it fall back to "no part" (schema:
// chapters.part_id ON DELETE SET NULL), nothing else is destroyed.
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM parts WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy phần.' });
  res.json({ ok: true });
});

// POST /api/parts/:id/move — { direction: 'up' | 'down' }, swaps order_index
// with the adjacent part in the same book. No-op silently at either end.
router.post('/:id/move', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
  if (!part) return res.status(404).json({ error: 'Không tìm thấy phần.' });

  const direction = req.body?.direction;
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'direction phải là "up" hoặc "down".' });
  }

  const siblings = db.prepare('SELECT id, order_index FROM parts WHERE book_id = ? ORDER BY order_index').all(part.book_id);
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return res.json({ ok: true, moved: false });

  const other = siblings[swapIdx];
  db.transaction(() => {
    db.prepare('UPDATE parts SET order_index = ? WHERE id = ?').run(other.order_index, id);
    db.prepare('UPDATE parts SET order_index = ? WHERE id = ?').run(part.order_index, other.id);
  })();
  res.json({ ok: true, moved: true });
});

export default router;
