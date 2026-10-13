// Paragraph marks (needs review / bookmark / highlight) belong to each user.
// The legacy columns on `paragraphs` are no longer read; their values were
// handed to the first administrator (store.adoptLegacyProgress).
import { db } from '../db.js';

export const MARK_FIELDS = ['is_flagged', 'is_bookmarked', 'is_highlighted'];

// Replaces the mark fields of paragraph rows with the user's own marks.
export function withUserMarks(paragraphs, userId) {
  if (!paragraphs.length) return paragraphs;
  const ids = paragraphs.map((p) => p.id);
  const rows = db.prepare(`SELECT * FROM paragraph_marks WHERE user_id = ? AND paragraph_id IN (${ids.map(() => '?').join(',')})`)
    .all(userId, ...ids);
  const byId = new Map(rows.map((r) => [r.paragraph_id, r]));
  return paragraphs.map((p) => {
    const m = byId.get(p.id);
    return { ...p, is_flagged: m?.is_flagged || 0, is_bookmarked: m?.is_bookmarked || 0, is_highlighted: m?.is_highlighted || 0 };
  });
}

export function setUserMarks(userId, paragraphId, patch) {
  const current = db.prepare('SELECT * FROM paragraph_marks WHERE user_id = ? AND paragraph_id = ?').get(userId, paragraphId)
    || { is_flagged: 0, is_bookmarked: 0, is_highlighted: 0 };
  const next = { ...current };
  for (const f of MARK_FIELDS) if (patch[f] !== undefined) next[f] = patch[f] ? 1 : 0;
  if (!next.is_flagged && !next.is_bookmarked && !next.is_highlighted) {
    db.prepare('DELETE FROM paragraph_marks WHERE user_id = ? AND paragraph_id = ?').run(userId, paragraphId);
  } else {
    db.prepare(`
      INSERT INTO paragraph_marks (user_id, paragraph_id, is_flagged, is_bookmarked, is_highlighted, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, paragraph_id) DO UPDATE SET is_flagged = excluded.is_flagged, is_bookmarked = excluded.is_bookmarked, is_highlighted = excluded.is_highlighted, updated_at = excluded.updated_at
    `).run(userId, paragraphId, next.is_flagged, next.is_bookmarked, next.is_highlighted);
  }
}
