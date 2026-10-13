// /api/admin/activity — the activity log for admins (users.manage, via the
// /api/admin/ rule): a filtered list, a per-user summary and the health of
// the log writer itself.
import { Router } from 'express';
import { db } from '../db.js';
import { flush, stats, enabled } from '../activityLog.js';
import { rolesOf } from '../auth/store.js';

const router = Router();

// The first segment of an action ("vocab.merge" → "vocab"), for filters.
const GROUPS = ['auth', 'admin', 'paragraph', 'assistant', 'book', 'vocab', 'discussion', 'glossary', 'assignment', 'prompt', 'settings', 'other'];

// GET /api/admin/activity?userId=&action=&group=&entityType=&entityId=&from=&to=&failed=1&page=&pageSize=
router.get('/', (req, res) => {
  flush(); // the latest requests, including the admin's own, show at once
  const q = req.query;
  const where = [];
  const params = {};
  if (q.userId === 'none') where.push('a.user_id IS NULL');
  else if (Number(q.userId)) { where.push('a.user_id = @userId'); params.userId = Number(q.userId); }
  if (q.action) { where.push('a.action = @action'); params.action = String(q.action); }
  if (GROUPS.includes(q.group)) { where.push("(a.action = @group OR a.action LIKE @groupLike)"); params.group = q.group; params.groupLike = `${q.group}.%`; }
  if (q.entityType) { where.push('a.entity_type = @entityType'); params.entityType = String(q.entityType); }
  if (Number(q.entityId)) { where.push('a.entity_id = @entityId'); params.entityId = Number(q.entityId); }
  if (/^\d{4}-\d{2}-\d{2}/.test(q.from || '')) { where.push('a.at >= @from'); params.from = q.from; }
  if (/^\d{4}-\d{2}-\d{2}/.test(q.to || '')) { where.push('a.at < @to'); params.to = q.to.length === 10 ? `${q.to}T23:59:59.999Z` : q.to; }
  if (q.failed === '1') where.push('a.status >= 400');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));

  const total = db.prepare(`SELECT COUNT(*) AS c FROM activity_log a ${clause}`).get(params).c;
  const rows = db.prepare(`
    SELECT a.*, u.email AS user_email, u.name AS user_name
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    ${clause} ORDER BY a.id DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize })
    .map((r) => ({ ...r, detail: safeParse(r.detail) }));
  res.json({ rows, total, page, pageSize, actions: db.prepare('SELECT DISTINCT action FROM activity_log ORDER BY action').all().map((r) => r.action) });
});

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// GET /api/admin/activity/summary?days=30 — one line per user: when they
// were last active and what they did in the period.
router.get('/summary', (req, res) => {
  flush();
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.status, u.last_login_at,
      (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
    FROM users u ORDER BY u.id
  `).all();
  const counts = db.prepare(`
    SELECT user_id, action, COUNT(*) AS c, SUM(status >= 400) AS failed
    FROM activity_log WHERE at >= ? AND user_id IS NOT NULL GROUP BY user_id, action
  `).all(since);
  const reviews = db.prepare(`
    SELECT user_id, COUNT(*) AS c, COUNT(DISTINCT reviewed_date) AS days FROM review_log
    WHERE reviewed_at >= datetime('now', ?) AND user_id IS NOT NULL GROUP BY user_id
  `).all(`-${days} days`);
  const lastAction = db.prepare('SELECT user_id, MAX(at) AS at FROM activity_log WHERE user_id IS NOT NULL GROUP BY user_id').all();

  const byUser = new Map(users.map((u) => [u.id, { ...u, actions: {}, total: 0, failed: 0, reviews: 0, reviewDays: 0, last_action_at: null }]));
  for (const c of counts) {
    const u = byUser.get(c.user_id);
    if (!u) continue;
    u.actions[c.action] = c.c;
    u.total += c.c;
    u.failed += c.failed || 0;
  }
  for (const r of reviews) { const u = byUser.get(r.user_id); if (u) { u.reviews = r.c; u.reviewDays = r.days; } }
  for (const l of lastAction) { const u = byUser.get(l.user_id); if (u) u.last_action_at = l.at; }

  const failedLogins = db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE action = 'auth.login' AND status >= 400 AND at >= ?").get(since).c;
  res.json({ days, users: [...byUser.values()], failedLogins });
});

// GET /api/admin/activity/health — is the log being written?
router.get('/health', (_req, res) => {
  flush();
  const size = db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest FROM activity_log').get();
  res.json({ enabled: enabled(), ...stats, ...size });
});

// GET /api/admin/activity/users/:id — one user's workspace as an admin sees
// it: which books they can see, where they are reading, their marks, their
// vocabulary review, AI use, assignments, sessions and recent actions.
router.get('/users/:id', (req, res) => {
  flush();
  const uid = Number(req.params.id);
  const user = db.prepare('SELECT id, email, name, status, created_at, last_login_at FROM users WHERE id = ?').get(uid);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const roles = rolesOf(uid);
  const isAdmin = roles.effective.includes('admin');

  const books = db.prepare(`
    SELECT b.id, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS title, b.visibility, b.owner_id = @uid AS owner,
      CASE WHEN b.visibility = 'public' THEN 'public' WHEN b.owner_id = @uid THEN 'owner'
        WHEN EXISTS (SELECT 1 FROM book_access a WHERE a.book_id = b.id AND a.user_id = @uid) THEN 'user'
        WHEN EXISTS (SELECT 1 FROM book_access a WHERE a.book_id = b.id AND a.group_id IN (SELECT group_id FROM group_members WHERE user_id = @uid)) THEN 'group'
        ELSE NULL END AS via
    FROM books b ORDER BY b.id
  `).all({ uid }).map((b) => ({ ...b, owner: Boolean(b.owner), via: isAdmin && !b.via ? 'admin' : b.via, visible: isAdmin || Boolean(b.via) }));

  const reading = db.prepare(`
    SELECT r.book_id, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title, r.chapter_id, c.title AS chapter_title, r.paragraph_id, r.updated_at
    FROM user_reading r JOIN books b ON b.id = r.book_id JOIN chapters c ON c.id = r.chapter_id WHERE r.user_id = ? ORDER BY r.updated_at DESC
  `).all(uid);
  const marks = db.prepare(`
    SELECT SUM(is_flagged) AS flagged, SUM(is_bookmarked) AS bookmarked, SUM(is_highlighted) AS highlighted FROM paragraph_marks WHERE user_id = ?
  `).get(uid);
  const vocabStatus = db.prepare(`
    SELECT COALESCE(vp.status, 'Đang học') AS status, COUNT(*) AS c FROM vocabulary v
    LEFT JOIN vocab_progress vp ON vp.vocabulary_id = v.id AND vp.user_id = @uid WHERE v.owner_id IS NULL OR v.owner_id = @uid GROUP BY 1
  `).all({ uid });
  const ownWords = db.prepare(`
    SELECT COUNT(*) AS own, SUM(proposal_status = 'pending') AS pending, SUM(proposal_status = 'rejected') AS rejected,
      (SELECT COUNT(*) FROM user_vocab WHERE user_id = @uid) AS listed
    FROM vocabulary WHERE owner_id = @uid
  `).get({ uid });
  const due = db.prepare(`
    SELECT COUNT(*) AS c FROM vocabulary v LEFT JOIN vocab_progress vp ON vp.vocabulary_id = v.id AND vp.user_id = @uid
    WHERE (v.owner_id IS NULL OR v.owner_id = @uid) AND COALESCE(vp.due_date, '') <= date('now')
  `).get({ uid }).c;
  const reviews = db.prepare(`
    SELECT COUNT(*) AS total, SUM(reviewed_at >= datetime('now', '-30 days')) AS last30, MAX(reviewed_at) AS last_at,
      COUNT(DISTINCT CASE WHEN reviewed_at >= datetime('now', '-30 days') THEN reviewed_date END) AS days30
    FROM review_log WHERE user_id = ?
  `).get(uid);
  const assistant = db.prepare(`
    SELECT COUNT(*) AS messages, SUM(created_at >= datetime('now', '-30 days')) AS last30,
      SUM(revision_status = 'approved') AS approved FROM assistant_messages WHERE user_id = ? AND role = 'user'
  `).get(uid);
  const assignments = db.prepare(`
    SELECT a.id, a.role, a.book_id, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title, c.title AS chapter_title, g.name AS via_group
    FROM work_assignments a JOIN books b ON b.id = a.book_id LEFT JOIN chapters c ON c.id = a.chapter_id LEFT JOIN groups g ON g.id = a.group_id
    WHERE a.user_id = ? OR a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) ORDER BY a.book_id, a.id
  `).all(uid, uid);
  const sessions = db.prepare(`
    SELECT auth_method, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC
  `).all(uid, new Date().toISOString());
  const recent = db.prepare('SELECT id, at, action, status, entity_type, entity_id FROM activity_log WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(uid);

  res.json({
    user, roles: roles.effective, isAdmin,
    groups: db.prepare('SELECT g.id, g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name').all(uid),
    books, reading, marks, vocabStatus, ownWords, due, reviews, assistant, assignments, sessions, recent,
  });
});

export default router;
