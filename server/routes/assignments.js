// /api/assignments — who translates and who reviews which part of a book
// (book, chapter, section or paragraph), as users or groups. Reviewers may
// decide the term discussions in their part (server/discussions.js).
import { Router } from 'express';
import { bookFilterSql } from '../bookAccess.js';
import { db } from '../db.js';
import { ASSIGNMENT_ROLES, assignmentsCovering, placeOfParagraph } from '../discussions.js';

const router = Router();

const COLS = `a.*, u.name AS user_name, u.email AS user_email, g.name AS group_name,
  c.title AS chapter_title, s.heading AS section_heading, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title`;
const FROM = `work_assignments a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN groups g ON g.id = a.group_id
  JOIN books b ON b.id = a.book_id LEFT JOIN chapters c ON c.id = a.chapter_id LEFT JOIN sections s ON s.id = a.section_id`;

// GET /api/assignments?bookId= — every assignment in a book;
// ?paragraphId= — those covering one paragraph (inherited ones included).
router.get('/', (req, res) => {
  if (Number(req.query.paragraphId)) {
    const place = placeOfParagraph(Number(req.query.paragraphId));
    if (!place) return res.status(404).json({ error: 'Không tìm thấy đoạn văn.' });
    return res.json({ roles: ASSIGNMENT_ROLES, place, assignments: assignmentsCovering(place) });
  }
  const bookId = Number(req.query.bookId);
  if (!bookId) return res.status(400).json({ error: 'Thiếu bookId.' });
  return res.json({
    roles: ASSIGNMENT_ROLES,
    assignments: db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE a.book_id = ? ORDER BY a.chapter_id IS NOT NULL, a.section_id IS NOT NULL, a.paragraph_id IS NOT NULL, a.id`).all(bookId),
  });
});

// GET /api/assignments/mine — the signed-in user's assignments (direct or
// through a group), for "Việc của tôi".
router.get('/mine', (req, res) => {
  res.json(db.prepare(`
    SELECT ${COLS} FROM ${FROM}
    WHERE (a.user_id = ? OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)) AND ${bookFilterSql(req, 'a.book_id')}
    ORDER BY a.book_id, a.id
  `).all(req.user.id, req.user.id));
});

// GET /api/assignments/people — who can be assigned (active users, groups).
router.get('/people', (_req, res) => {
  res.json({
    users: db.prepare("SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name COLLATE NOCASE, email").all(),
    groups: db.prepare('SELECT id, name FROM groups ORDER BY name COLLATE NOCASE').all(),
  });
});

// POST /api/assignments — { bookId | chapterId | sectionId | paragraphId, userId | groupId, role }
// The most specific id given is the scope; the levels above it are filled in.
router.post('/', (req, res) => {
  const b = req.body || {};
  let place = null;
  if (Number(b.paragraphId)) place = placeOfParagraph(Number(b.paragraphId));
  else if (Number(b.sectionId)) {
    place = db.prepare('SELECT s.id AS section_id, s.chapter_id, c.book_id FROM sections s JOIN chapters c ON c.id = s.chapter_id WHERE s.id = ?').get(Number(b.sectionId));
  } else if (Number(b.chapterId)) {
    place = db.prepare('SELECT id AS chapter_id, book_id FROM chapters WHERE id = ?').get(Number(b.chapterId));
  } else if (Number(b.bookId)) {
    place = db.prepare('SELECT id AS book_id FROM books WHERE id = ?').get(Number(b.bookId));
  }
  if (!place) return res.status(404).json({ error: 'Không tìm thấy phần sách cần phân công.' });
  if (!ASSIGNMENT_ROLES[b.role]) return res.status(400).json({ error: 'Vai trò phải là Dịch hoặc Duyệt.' });
  const userId = Number(b.userId) || null;
  const groupId = userId ? null : Number(b.groupId) || null;
  if (!userId && !groupId) return res.status(400).json({ error: 'Hãy chọn người hoặc nhóm.' });
  if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (groupId && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) return res.status(404).json({ error: 'Không tìm thấy nhóm.' });

  const row = {
    book_id: place.book_id, chapter_id: place.chapter_id ?? null, section_id: place.section_id ?? null, paragraph_id: place.paragraph_id ?? null,
    user_id: userId, group_id: groupId, role: b.role,
  };
  const duplicate = db.prepare(`
    SELECT id FROM work_assignments WHERE book_id = @book_id AND chapter_id IS @chapter_id AND section_id IS @section_id AND paragraph_id IS @paragraph_id
      AND user_id IS @user_id AND group_id IS @group_id AND role = @role
  `).get(row);
  const id = duplicate?.id ?? db.prepare(`
    INSERT INTO work_assignments (book_id, chapter_id, section_id, paragraph_id, user_id, group_id, role, created_by)
    VALUES (@book_id, @chapter_id, @section_id, @paragraph_id, @user_id, @group_id, @role, @created_by)
  `).run({ ...row, created_by: req.user.id }).lastInsertRowid;
  return res.status(duplicate ? 200 : 201).json(db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE a.id = ?`).get(id));
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM work_assignments WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Không tìm thấy phân công.' });
  return res.json({ ok: true });
});

export default router;
