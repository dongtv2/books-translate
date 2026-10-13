// /api/discussions — threads about how to translate a word or phrase of a
// paragraph: comments, proposals with votes, and the decision that files the
// agreed translation in the glossary (see server/discussions.js).
import { Router } from 'express';
import { bookFilterSql } from '../bookAccess.js';
import { absorbPrivateCopies } from '../vocabStore.js';
import { db } from '../db.js';
import { can } from '../auth/middleware.js';
import { normalizeTerm } from '../normalize.js';
import { plainText } from '../../src/lib/inlineMarkdown.js';
import { containsTerm } from '../../src/lib/vocabMatch.js';
import { WORD_TYPES } from '../wordTypes.js';
import { isValidTopic } from '../vocabTopics.js';
import {
  placeOfParagraph, assignmentsCovering, isReviewerFor, assignedThreadsCondition, upsertGlossary,
} from '../discussions.js';

const router = Router();

const clean = (s, n = 4000) => String(s ?? '').trim().slice(0, n);

// The sentence of the paragraph's column that contains the picked words.
function sentenceWith(paragraph, side, term) {
  const text = plainText(side === 'vi' ? paragraph.vietnamese_md : paragraph.english_md);
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [text];
  const lower = term.toLowerCase();
  return (sentences.find((s) => (side === 'vi' ? s.toLowerCase().includes(lower) : containsTerm(s, term) || s.toLowerCase().includes(lower))) || '').trim();
}

// May this user decide (chốt / mở lại) this thread?
function canResolve(req, thread) {
  return can(req, 'glossary.manage') || isReviewerFor(req.user.id, thread);
}

function canCloseDiscussion(req, thread) {
  return thread.created_by === req.user.id || canResolve(req, thread);
}

const THREAD_COLS = `t.*,
  COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title, c.title AS chapter_title, s.heading AS section_heading,
  cu.name AS created_by_name, ru.name AS resolved_by_name,
  (SELECT COUNT(*) FROM term_posts x WHERE x.thread_id = t.id AND x.kind <> 'event') AS post_count,
  (SELECT COUNT(*) FROM term_posts x WHERE x.thread_id = t.id AND x.kind = 'proposal') AS proposal_count,
  (SELECT MAX(created_at) FROM term_posts x WHERE x.thread_id = t.id) AS last_post_at`;
const THREAD_FROM = `term_threads t
  JOIN books b ON b.id = t.book_id JOIN chapters c ON c.id = t.chapter_id JOIN sections s ON s.id = t.section_id
  LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users ru ON ru.id = t.resolved_by
  LEFT JOIN term_thread_reads r ON r.thread_id = t.id AND r.user_id = @uid`;
// Unread: something happened since the user last opened it, and not by them.
const UNREAD = `(r.read_at IS NULL OR r.read_at < t.updated_at)
  AND EXISTS (SELECT 1 FROM term_posts x WHERE x.thread_id = t.id AND x.created_at > COALESCE(r.read_at, '') AND COALESCE(x.user_id, 0) <> @uid
    UNION SELECT 1 WHERE r.read_at IS NULL AND COALESCE(t.created_by, 0) <> @uid)`;

const touch = (id) => db.prepare("UPDATE term_threads SET updated_at = datetime('now') WHERE id = ?").run(id);
const markRead = (uid, id) => db.prepare(`
  INSERT INTO term_thread_reads (user_id, thread_id, read_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(user_id, thread_id) DO UPDATE SET read_at = excluded.read_at
`).run(uid, id);

// GET /api/discussions?bookId=&chapterId=&paragraphId=&status=open|resolved&filter=mine|assigned|unread&q=
router.get('/', (req, res) => {
  const { bookId, chapterId, paragraphId, status, filter, q } = req.query;
  const params = { uid: req.user.id };
  const where = [bookFilterSql(req, 't.book_id')];
  if (Number(bookId)) { where.push('t.book_id = @bookId'); params.bookId = Number(bookId); }
  if (Number(chapterId)) { where.push('t.chapter_id = @chapterId'); params.chapterId = Number(chapterId); }
  if (Number(paragraphId)) { where.push('t.paragraph_id = @paragraphId'); params.paragraphId = Number(paragraphId); }
  if (['open', 'resolved'].includes(status)) { where.push('t.status = @status'); params.status = status; }
  if (filter === 'mine') where.push('(t.created_by = @uid OR EXISTS (SELECT 1 FROM term_posts x WHERE x.thread_id = t.id AND x.user_id = @uid))');
  if (filter === 'assigned') where.push(assignedThreadsCondition(req.user.id));
  if (filter === 'unread') where.push(UNREAD);
  if (q && String(q).trim()) {
    where.push("(t.term LIKE @q OR t.resolution_vi LIKE @q OR EXISTS (SELECT 1 FROM term_posts x WHERE x.thread_id = t.id AND (x.body LIKE @q OR x.meaning_vi LIKE @q)))");
    params.q = `%${String(q).trim()}%`;
  }
  const rows = db.prepare(`
    SELECT ${THREAD_COLS}, CASE WHEN ${UNREAD} THEN 1 ELSE 0 END AS unread
    FROM ${THREAD_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.status = 'resolved', t.updated_at DESC LIMIT 300
  `).all(params);
  res.json(rows);
});

// GET /api/discussions/summary — counts for the sidebar badge.
router.get('/summary', (req, res) => {
  const params = { uid: req.user.id };
  const visible = bookFilterSql(req, 't.book_id');
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM ${THREAD_FROM} WHERE ${UNREAD} AND ${visible}`).get(params).c;
  const assignedOpen = db.prepare(`SELECT COUNT(*) AS c FROM term_threads t WHERE t.status = 'open' AND ${assignedThreadsCondition(req.user.id)} AND ${visible}`).get().c;
  res.json({ unread, assignedOpen });
});

function threadDetail(req, id) {
  const uid = req.user.id;
  const thread = db.prepare(`SELECT ${THREAD_COLS} FROM ${THREAD_FROM} WHERE t.id = @id`).get({ uid, id });
  if (!thread) return null;
  const posts = db.prepare(`
    SELECT p.*, u.name AS user_name, u.email AS user_email,
      (SELECT COUNT(*) FROM term_votes v WHERE v.post_id = p.id) AS votes,
      EXISTS (SELECT 1 FROM term_votes v WHERE v.post_id = p.id AND v.user_id = ?) AS my_vote
    FROM term_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.thread_id = ? ORDER BY p.created_at, p.id
  `).all(uid, id);
  const voters = db.prepare(`
    SELECT v.post_id, u.name, u.email FROM term_votes v JOIN term_posts p ON p.id = v.post_id JOIN users u ON u.id = v.user_id WHERE p.thread_id = ?
  `).all(id);
  for (const p of posts) p.voters = voters.filter((v) => v.post_id === p.id).map((v) => v.name || v.email);

  // What is already decided or stored for this term, to start from.
  const glossary = db.prepare(`
    SELECT g.*, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title FROM glossary g LEFT JOIN books b ON b.id = g.book_id
    WHERE g.term_normalized = ? AND (g.book_id IS NULL OR g.book_id = ?) ORDER BY g.book_id IS NULL
  `).all(thread.term_normalized, thread.book_id);
  const vocabulary = db.prepare('SELECT id, term, ipa, word_type, meaning_vi, topic FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL').get(thread.term_normalized) || null;

  return {
    ...thread,
    posts,
    glossary,
    vocabulary,
    assignments: assignmentsCovering(thread),
    canResolve: canResolve(req, thread),
    canClose: canCloseDiscussion(req, thread),
  };
}

// POST /api/discussions — { paragraphId, term, side?, body?, meaning_vi? }
// Opens a thread on words of a paragraph (or returns the open one already on
// the same words there), with an optional first comment and/or proposal.
router.post('/', (req, res) => {
  const paragraphId = Number(req.body?.paragraphId);
  const place = placeOfParagraph(paragraphId);
  if (!place) return res.status(404).json({ error: 'Không tìm thấy đoạn văn.' });
  // A word, a phrase or whole sentences.
  const term = clean(req.body?.term, 1000).replace(/\s+/g, ' ');
  if (!term) return res.status(400).json({ error: 'Hãy chọn hoặc nhập từ / cụm từ cần thảo luận.' });
  const side = req.body?.side === 'vi' ? 'vi' : 'en';
  const term_normalized = side === 'en' ? normalizeTerm(term) : term.toLowerCase();
  const body = clean(req.body?.body);
  const meaning = clean(req.body?.meaning_vi, 1500);
  const anchorText = clean(req.body?.anchorText, 1200);
  const anchorStart = Number.isInteger(req.body?.anchorStart) && anchorText ? req.body.anchorStart : null;

  const existing = db.prepare("SELECT id FROM term_threads WHERE paragraph_id = ? AND term_normalized = ? AND side = ? AND status = 'open' AND discussion_status <> 'closed'")
    .get(paragraphId, term_normalized, side);
  const id = db.transaction(() => {
    let threadId = existing?.id;
    if (!threadId) {
      const paragraph = db.prepare('SELECT english_md, vietnamese_md FROM paragraphs WHERE id = ?').get(paragraphId);
      threadId = db.prepare(`
        INSERT INTO term_threads (book_id, chapter_id, section_id, paragraph_id, term, term_normalized, side, context, anchor_start, anchor_end, anchor_text, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        place.book_id, place.chapter_id, place.section_id, paragraphId, term, term_normalized, side, sentenceWith(paragraph, side, term),
        anchorStart, anchorStart == null ? null : anchorStart + anchorText.length, anchorStart == null ? '' : anchorText, req.user.id,
      ).lastInsertRowid;
    } else if (anchorStart != null) {
      // A thread may have been created manually before someone selected the
      // exact occurrence in the paragraph. Keep the existing conversation,
      // but attach it to the newly selected text so the mark can be rendered.
      db.prepare(`
        UPDATE term_threads
        SET anchor_start = ?, anchor_end = ?, anchor_text = ?
        WHERE id = ?
      `).run(anchorStart, anchorStart + anchorText.length, anchorText, threadId);
    }
    const insert = db.prepare('INSERT INTO term_posts (thread_id, user_id, kind, body, meaning_vi) VALUES (?, ?, ?, ?, ?)');
    if (meaning) {
      const postId = insert.run(threadId, req.user.id, 'proposal', body, meaning).lastInsertRowid;
      db.prepare('INSERT OR IGNORE INTO term_votes (post_id, user_id) VALUES (?, ?)').run(postId, req.user.id);
    } else if (body) {
      insert.run(threadId, req.user.id, 'comment', body, '');
    }
    touch(threadId);
    markRead(req.user.id, threadId);
    return threadId;
  })();
  res.status(existing ? 200 : 201).json(threadDetail(req, id));
});

// GET /api/discussions/:id — the thread with its posts; marks it read.
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const detail = threadDetail(req, id);
  if (!detail) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  markRead(req.user.id, id);
  res.json(detail);
});

// POST /api/discussions/:id/posts — { kind: 'comment'|'proposal', body, meaning_vi }
router.post('/:id/posts', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  if (thread.status === 'resolved' || thread.discussion_status === 'closed') {
    return res.status(409).json({ error: 'Thảo luận đã đóng. Hãy mở lại trước khi gửi bình luận.' });
  }
  const kind = req.body?.kind === 'proposal' ? 'proposal' : 'comment';
  const body = clean(req.body?.body);
  const meaning = clean(req.body?.meaning_vi, 1500);
  if (kind === 'proposal' && !meaning) return res.status(400).json({ error: 'Hãy nhập cách dịch đề xuất.' });
  if (kind === 'comment' && !body) return res.status(400).json({ error: 'Hãy nhập nội dung bình luận.' });
  db.transaction(() => {
    const postId = db.prepare('INSERT INTO term_posts (thread_id, user_id, kind, body, meaning_vi) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.user.id, kind, body, kind === 'proposal' ? meaning : '').lastInsertRowid;
    // Proposing counts as voting for one's own proposal.
    if (kind === 'proposal') db.prepare('INSERT OR IGNORE INTO term_votes (post_id, user_id) VALUES (?, ?)').run(postId, req.user.id);
    touch(id);
    markRead(req.user.id, id);
  })();
  res.status(201).json(threadDetail(req, id));
});

function ownPost(req, res) {
  const post = db.prepare('SELECT * FROM term_posts WHERE id = ?').get(Number(req.params.postId));
  if (!post || post.kind === 'event') { res.status(404).json({ error: 'Không tìm thấy bình luận.' }); return null; }
  return post;
}

// PATCH /api/discussions/posts/:postId — { body?, meaning_vi? }, own posts only.
router.patch('/posts/:postId', (req, res) => {
  const post = ownPost(req, res);
  if (!post) return undefined;
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Chỉ sửa được bình luận của chính bạn.' });
  const body = req.body?.body !== undefined ? clean(req.body.body) : post.body;
  const meaning = req.body?.meaning_vi !== undefined ? clean(req.body.meaning_vi, 1500) : post.meaning_vi;
  if (post.kind === 'proposal' ? !meaning : !body) return res.status(400).json({ error: 'Nội dung không được để trống.' });
  db.prepare("UPDATE term_posts SET body = ?, meaning_vi = ?, edited_at = datetime('now') WHERE id = ?").run(body, meaning, post.id);
  touch(post.thread_id);
  return res.json(threadDetail(req, post.thread_id));
});

// DELETE /api/discussions/posts/:postId — own posts, or any with glossary.manage.
router.delete('/posts/:postId', (req, res) => {
  const post = ownPost(req, res);
  if (!post) return undefined;
  if (post.user_id !== req.user.id && !can(req, 'glossary.manage')) {
    return res.status(403).json({ error: 'Chỉ xoá được bình luận của chính bạn.' });
  }
  db.prepare('DELETE FROM term_posts WHERE id = ?').run(post.id);
  return res.json(threadDetail(req, post.thread_id));
});

// POST /api/discussions/posts/:postId/vote — toggles the user's vote.
router.post('/posts/:postId/vote', (req, res) => {
  const post = db.prepare("SELECT * FROM term_posts WHERE id = ? AND kind = 'proposal'").get(Number(req.params.postId));
  if (!post) return res.status(404).json({ error: 'Không tìm thấy đề xuất.' });
  const removed = db.prepare('DELETE FROM term_votes WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id).changes;
  if (!removed) db.prepare('INSERT INTO term_votes (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
  return res.json(threadDetail(req, post.thread_id));
});

// POST /api/discussions/:id/resolve — decide the translation:
// { meaning_vi, word_type?, topic?, note?, scope: 'book'|'all', addToVocabulary?, updateVocabulary? }
// Files it in the glossary (this book, or every book) and, if asked, in the
// shared vocabulary for review.
router.post('/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  if (!canResolve(req, thread)) return res.status(403).json({ error: 'Chỉ biên tập viên hoặc người duyệt được phân công mới chốt được.' });

  const meaning = clean(req.body?.meaning_vi, 1500);
  if (!meaning) return res.status(400).json({ error: 'Hãy nhập cách dịch được chốt.' });
  const term = clean(req.body?.term, 1000) || thread.term;
  // A decided sentence is usually just this passage's translation, not
  // terminology for the whole book: the client leaves it out by default.
  const toGlossary = req.body?.saveToGlossary !== false;
  const wordType = WORD_TYPES.includes(req.body?.word_type) ? req.body.word_type : '';
  const topic = isValidTopic(req.body?.topic) ? req.body.topic : '';
  const note = clean(req.body?.note, 500);
  const bookId = req.body?.scope === 'all' ? null : thread.book_id;
  // Only source-language terms belong in the vocabulary learners review.
  const toVocabulary = thread.side === 'en' && req.body?.addToVocabulary;

  db.transaction(() => {
    let vocabularyId = null;
    if (toVocabulary) {
      const term_normalized = normalizeTerm(term);
      const existing = db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL').get(term_normalized);
      if (existing) {
        vocabularyId = existing.id;
        if (req.body?.updateVocabulary && can(req, 'vocab.edit')) {
          db.prepare(`
            UPDATE vocabulary SET meaning_vi = ?, word_type = COALESCE(NULLIF(?, ''), word_type), topic = COALESCE(NULLIF(?, ''), topic), updated_at = datetime('now')
            WHERE id = ?
          `).run(meaning, wordType, topic, existing.id);
        }
      } else {
        vocabularyId = db.prepare(`
          INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, status, source_paragraph_id)
          VALUES (?, ?, '', ?, ?, ?, ?, date('now'), 'Đang học', ?)
        `).run(term, term_normalized, wordType || WORD_TYPES[0], meaning, thread.context, topic || 'Khác', thread.paragraph_id).lastInsertRowid;
        absorbPrivateCopies(vocabularyId);
      }
    }
    const glossaryId = toGlossary
      ? upsertGlossary({ bookId, term, meaning_vi: meaning, word_type: wordType, topic, note, vocabularyId, threadId: id, userId: req.user.id })
      : null;
    db.prepare(`
      UPDATE term_threads SET status = 'resolved', resolution_vi = ?, glossary_id = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(meaning, glossaryId, req.user.id, id);
    db.prepare("INSERT INTO term_posts (thread_id, user_id, kind, body, meaning_vi) VALUES (?, ?, 'event', 'resolved', ?)").run(id, req.user.id, meaning);
    markRead(req.user.id, id);
  })();
  res.json(threadDetail(req, id));
});

// POST /api/discussions/:id/reopen — the glossary entry stays until the
// thread is decided again (or the entry is edited in the glossary).
router.post('/:id/reopen', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  if (!canResolve(req, thread)) return res.status(403).json({ error: 'Chỉ biên tập viên hoặc người duyệt được phân công mới mở lại được.' });
  db.transaction(() => {
    db.prepare("UPDATE term_threads SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("INSERT INTO term_posts (thread_id, user_id, kind, body) VALUES (?, ?, 'event', 'reopened')").run(id, req.user.id);
    markRead(req.user.id, id);
  })();
  res.json(threadDetail(req, id));
});

// Conversation state is separate from deciding a translation for the glossary.
router.post('/:id/close', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  if (!canCloseDiscussion(req, thread)) return res.status(403).json({ error: 'Chỉ người mở thảo luận, biên tập viên hoặc người duyệt được phân công mới đóng được.' });
  db.transaction(() => {
    db.prepare("UPDATE term_threads SET discussion_status = 'closed', discussion_closed_by = ?, discussion_closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.user.id, id);
    db.prepare("INSERT INTO term_posts (thread_id, user_id, kind, body) VALUES (?, ?, 'event', 'discussion_closed')").run(id, req.user.id);
    markRead(req.user.id, id);
  })();
  res.json(threadDetail(req, id));
});

router.post('/:id/reopen-discussion', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  if (!canCloseDiscussion(req, thread)) return res.status(403).json({ error: 'Chỉ người mở thảo luận, biên tập viên hoặc người duyệt được phân công mới mở lại được.' });
  db.transaction(() => {
    db.prepare("UPDATE term_threads SET discussion_status = 'open', discussion_closed_by = NULL, discussion_closed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    db.prepare("INSERT INTO term_posts (thread_id, user_id, kind, body) VALUES (?, ?, 'event', 'discussion_reopened')").run(id, req.user.id);
    markRead(req.user.id, id);
  })();
  res.json(threadDetail(req, id));
});

// DELETE /api/discussions/:id — its creator while nobody else has posted, or
// glossary.manage.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const thread = db.prepare('SELECT * FROM term_threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thảo luận.' });
  const others = db.prepare('SELECT COUNT(*) AS c FROM term_posts WHERE thread_id = ? AND COALESCE(user_id, 0) <> ?').get(id, req.user.id).c;
  if (!can(req, 'glossary.manage') && (thread.created_by !== req.user.id || others > 0)) {
    return res.status(403).json({ error: 'Chỉ xoá được thảo luận của bạn khi chưa ai tham gia.' });
  }
  db.prepare('DELETE FROM term_threads WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
