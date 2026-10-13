import { Router } from 'express';
import { db } from '../db.js';
import { stripKindleCitations } from '../importers/citationCleanup.js';
import { tocFieldError } from '../toc.js';

const router = Router();

// PATCH /api/sections/:id — rename heading (pass heading: null/'' to clear it)
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy mục.' });
  const body = req.body || {};
  if (body.heading != null && typeof body.heading !== 'string') return res.status(400).json({ error: 'Tiêu đề mục không hợp lệ.' });
  const tocError = tocFieldError(body);
  if (tocError) return res.status(400).json({ error: tocError });
  // Either field may be sent alone; heading null/'' clears it.
  const heading = body.heading !== undefined ? (body.heading ?? '').trim() || null : existing.heading;
  const headingVi = body.heading_vi !== undefined ? body.heading_vi.trim() : existing.heading_vi;
  db.prepare('UPDATE sections SET heading = ?, heading_vi = ? WHERE id = ?').run(heading, headingVi, id);
  res.json(db.prepare('SELECT * FROM sections WHERE id = ?').get(id));
});

// DELETE /api/sections/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM sections WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy mục.' });
  res.json({ ok: true });
});

// POST /api/sections/:id/move — { direction: 'up' | 'down' }, swaps
// order_index with the adjacent section in the same chapter.
router.post('/:id/move', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
  if (!section) return res.status(404).json({ error: 'Không tìm thấy mục.' });

  const direction = req.body?.direction;
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: 'direction phải là "up" hoặc "down".' });
  }

  const siblings = db.prepare('SELECT id, order_index FROM sections WHERE chapter_id = ? ORDER BY order_index').all(section.chapter_id);
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return res.json({ ok: true, moved: false });

  const other = siblings[swapIdx];
  db.transaction(() => {
    db.prepare('UPDATE sections SET order_index = ? WHERE id = ?').run(other.order_index, id);
    db.prepare('UPDATE sections SET order_index = ? WHERE id = ?').run(section.order_index, other.id);
  })();
  res.json({ ok: true, moved: true });
});

// POST /api/sections/:id/paragraphs — append raw English text, split into
// one or more pending paragraphs at blank-line boundaries.
router.post('/:id/paragraphs', (req, res) => {
  const sectionId = parseInt(req.params.id, 10);
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Thiếu nội dung đoạn văn.' });

  const paragraphs = stripKindleCitations(
    text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  );
  if (paragraphs.length === 0) return res.status(400).json({ error: 'Không tách được đoạn văn nào (có thể toàn bộ chỉ là dòng trích dẫn Kindle).' });

  const nextIndex = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM paragraphs WHERE section_id = ?').get(sectionId).n;
  const insertParagraph = db.prepare(`
    INSERT INTO paragraphs (section_id, order_index, english_md, status) VALUES (?, ?, ?, 'pending')
  `);
  const ids = db.transaction(() => paragraphs.map((p, i) => insertParagraph.run(sectionId, nextIndex + i, p).lastInsertRowid))();

  const placeholders = ids.map(() => '?').join(',');
  res.json(db.prepare(`SELECT * FROM paragraphs WHERE id IN (${placeholders}) ORDER BY order_index`).all(...ids));
});

export default router;
