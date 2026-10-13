import { Router } from 'express';
import { db } from '../db.js';
import { normalizeTerm } from '../normalize.js';
import { containsTerm } from '../../src/lib/vocabMatch.js';
import { plainText } from '../../src/lib/inlineMarkdown.js';
import { chatText } from '../llm/chat.js';
import { bookOfParagraph, bookContextText } from '../bookContext.js';
import { WORD_TYPES } from '../wordTypes.js';
import { schedule, GRADES } from '../srs.js';
import { can } from '../auth/middleware.js';
import { VOCAB_TOPICS, isValidTopic, classifyTopics } from '../vocabTopics.js';
import { bookFilterSql, canSeeBook, redactSources, visibleBookIds } from '../bookAccess.js';
import {
  absorbPrivateCopies, approveProposal, listProposals, proposeVocab, rejectProposal, visibleVocabSql, withdrawProposal,
} from '../vocabStore.js';
import { deleteSense, listSenses, updateSense, upsertSense } from '../vocabSenses.js';
import { genresByVocab, setVocabGenre, vocabIdsInGenre } from '../genres.js';
import { mergeVocab, duplicateCandidates, dismissDuplicates, entryLinks, exportEntries, importEntries, EXCHANGE_FORMAT } from '../vocabStore.js';

const router = Router();

// Every answer of this router goes out with the source of words from books
// the user may not see blanked (bookAccess.redactSources): lists, single
// cards and the "already exists" entry alike, so no route can forget it.
router.use((req, res, next) => {
  if (!visibleBookIds(req)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (Array.isArray(body)) return json(redactSources(req, body));
    if (body && typeof body === 'object') {
      const out = { ...body };
      if (Array.isArray(out.rows)) out.rows = redactSources(req, out.rows);
      if (out.entry) [out.entry] = redactSources(req, [out.entry]);
      if ('source_book_id' in out) return json(redactSources(req, [out])[0]);
      return json(out);
    }
    return json(body);
  };
  next();
});
const STATUSES = ['Thành thạo', 'Đang học', 'Cần ôn gấp'];

// Vocabulary entries are shared; each user's review state lives in
// vocab_progress. A word the user has never reviewed has no progress row and
// reads as new: status "Đang học", due now — the same as a freshly added word
// before accounts existed.
// The book (and chapter) a word was collected from, through its source
// paragraph: each word shows where it came from, and the list can be
// narrowed to one book.
const SOURCE = `LEFT JOIN paragraphs sp ON sp.id = v.source_paragraph_id
  LEFT JOIN sections ss ON ss.id = sp.section_id
  LEFT JOIN chapters sc ON sc.id = ss.chapter_id
  LEFT JOIN books sb ON sb.id = sc.book_id`;
// The user sees the shared entries and their own words (owner_id), never
// another user's: every query here reads vocabulary through this subquery.
const FROM = `(SELECT * FROM vocabulary WHERE owner_id IS NULL OR owner_id = @uid) v
  LEFT JOIN vocab_progress vp ON vp.vocabulary_id = v.id AND vp.user_id = @uid
  LEFT JOIN user_vocab uv ON uv.vocabulary_id = v.id AND uv.user_id = @uid ${SOURCE}`;
const STATUS = "COALESCE(vp.status, 'Đang học')";
const DUE = "COALESCE(vp.due_date, '')";
const COLS = `v.id, v.term, v.term_normalized, v.ipa, v.word_type, v.meaning_vi, v.example, v.topic, v.date_added,
  v.source_paragraph_id, v.created_at, v.updated_at,
  v.owner_id, v.proposal_status, v.proposal_note, COALESCE(uv.note, '') AS my_note, (uv.user_id IS NOT NULL) AS in_my_list,
  ${STATUS} AS status, COALESCE(vp.ease_factor, 2.5) AS ease_factor, COALESCE(vp.interval_days, 0) AS interval_days,
  COALESCE(vp.repetitions, 0) AS repetitions, ${DUE} AS due_date, vp.last_reviewed_at,
  sc.id AS source_chapter_id, sc.title AS source_chapter_title,
  sb.id AS source_book_id, COALESCE(NULLIF(sb.title_vi, ''), sb.title_en) AS source_book_title, sb.title_en AS source_book_title_en,
  sb.domain AS source_book_domain, sb.specialty AS source_book_specialty`;

const getCard = (id, uid) => db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE v.id = @id`).get({ id, uid });

const upsertProgress = db.prepare(`
  INSERT INTO vocab_progress (user_id, vocabulary_id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at)
  VALUES (@uid, @id, @status, @ease_factor, @interval_days, @repetitions, @due_date, @last_reviewed_at)
  ON CONFLICT(user_id, vocabulary_id) DO UPDATE SET
    status = excluded.status, ease_factor = excluded.ease_factor, interval_days = excluded.interval_days,
    repetitions = excluded.repetitions, due_date = excluded.due_date, last_reviewed_at = excluded.last_reviewed_at
`);

function countByStatus(uid) {
  const rows = db.prepare(`SELECT ${STATUS} AS status, COUNT(*) AS c FROM ${FROM} GROUP BY 1`).all({ uid });
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) byStatus[r.status] = r.c;
  return byStatus;
}

// Search ignores case and Vietnamese diacritics ("nuoi day" finds "nuôi
// dạy") and ranks by relevance instead of date: the term itself first (exact,
// then an inflected form like "attaching" for "attach", then starts-with,
// then contains), then the Vietnamese meaning, and the example sentence last
// — a word like "attachment" occurs in hundreds of examples.
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();

function searchRank(row, q, qWords) {
  const term = fold(row.term);
  if (term === q) return 0;
  if (normalizeTerm(row.term) === normalizeTerm(q) || containsTerm(q, row.term) && term.split(' ').length >= qWords) return 1;
  if (term.startsWith(q)) return 2;
  if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(term)) return 3;
  if (term.includes(q)) return 4;
  const meaning = fold(row.meaning_vi);
  if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(meaning)) return 5;
  if (meaning.includes(q)) return 6;
  if (fold(row.example).includes(q)) return 7;
  return -1;
}

// Each row with the ids of its genres (thể loại).
function withGenres(req, rows) {
  const map = genresByVocab(req);
  return rows.map((r) => ({ ...r, genres: [...(map.get(r.id) || [])] }));
}

// GET /api/vocabulary?search=&status=&topic=&wordType=&genre=&page=&pageSize=
router.get('/', (req, res) => {
  const { search = '', status = '', topic = '', wordType = '', bookId = '', scope = '', page = '1', pageSize = '50' } = req.query;
  const params = { uid: req.user.id };
  const where = buildCategoryFilter({ status, topic, wordType, bookId, scope }, params, req);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
  const q = fold(search);

  if (!q) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} ${whereClause}`).get(params).c;
    const rows = db
      .prepare(`SELECT ${COLS} FROM ${FROM} ${whereClause} ORDER BY v.id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: ps, offset: (p - 1) * ps });
    return res.json({ rows: withGenres(req, rows), total, page: p, pageSize: ps });
  }

  // Ranked in JS over the filtered set (a few thousand rows at most).
  const qWords = q.split(' ').length;
  const ranked = db.prepare(`SELECT v.id, v.term, v.meaning_vi, v.example FROM ${FROM} ${whereClause}`).all(params)
    .map((r) => ({ id: r.id, rank: searchRank(r, q, qWords), len: r.term.length }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.len - b.len || b.id - a.id);
  const pageIds = ranked.slice((p - 1) * ps, p * ps).map((r) => r.id);
  const byId = new Map(pageIds.length
    ? db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE v.id IN (${pageIds.map(() => '?').join(',')})`)
      .all(...pageIds, { uid: params.uid }).map((r) => [r.id, r])
    : []);
  res.json({ rows: withGenres(req, pageIds.map((id) => byId.get(id)).filter(Boolean)), total: ranked.length, page: p, pageSize: ps });
});

// GET /api/vocabulary/export?format=json|tsv&withProgress=1 (+ the list's
// filters) — the whole filtered vocabulary as a file another install (or
// the import below) can read back. JSON keeps the user's review progress
// when asked; TSV is for spreadsheets and Anki.
const TSV_HEADER = ['Từ / Cụm từ', 'IPA', 'Loại từ', 'Nghĩa tiếng Việt', 'Câu ví dụ & Ngữ cảnh', 'Chủ đề', 'Sách', 'Chương', 'Lĩnh vực', 'Ngày thêm', 'Trạng thái'];
router.get('/export', (req, res) => {
  const { status = '', topic = '', wordType = '', bookId = '', scope = '', format = 'json', withProgress = '' } = req.query;
  const params = { uid: req.user.id };
  const where = buildCategoryFilter({ status, topic, wordType, bookId, scope }, params, req);
  const rows = db.prepare(`SELECT ${COLS} FROM ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.term COLLATE NOCASE`).all(params)
    .map((r) => redactSources(req, [r])[0])
    // book-specific meanings travel with the word (books this user may see)
    .map((r) => ({ ...r, senses: r.owner_id == null ? listSenses(r.id).filter((s) => canSeeBook(req, s.book_id)) : [] }));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'tsv') {
    const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    const lines = [TSV_HEADER.join('\t'), ...rows.map((r) => [r.term, r.ipa, r.word_type, r.meaning_vi, r.example, r.topic, r.source_book_title, r.source_chapter_title, r.source_book_domain, r.date_added, r.status].map(cell).join('\t'))];
    res.attachment(`vocabulary-${stamp}.tsv`).type('text/tab-separated-values; charset=utf-8').send(`﻿${lines.join('\n')}`);
    return;
  }
  res.attachment(`vocabulary-${stamp}.json`).json(exportEntries(rows, { withProgress: Boolean(withProgress) }));
});

// POST /api/vocabulary/import — { entries: [...], mode: 'skip'|'fill'|'overwrite',
// dryRun, withProgress }. `entries` is the export's list (or rows parsed from
// a TSV with the export's header). Terms already in the vocabulary — in any
// inflection or spelling the dedupe key folds — are never added twice.
router.post('/import', (req, res) => {
  const b = req.body || {};
  if (b.format && b.format !== EXCHANGE_FORMAT) return res.status(400).json({ error: 'File không phải kho từ vựng của ứng dụng này.' });
  if (!Array.isArray(b.entries)) return res.status(400).json({ error: 'Thiếu danh sách từ (entries).' });
  if (b.entries.length > 20000) return res.status(400).json({ error: 'File quá lớn (tối đa 20 000 từ mỗi lần).' });
  const mode = ['skip', 'fill', 'overwrite'].includes(b.mode) ? b.mode : 'fill';
  const report = importEntries(b.entries, {
    mode, dryRun: Boolean(b.dryRun), userId: req.user.id, withProgress: Boolean(b.withProgress) && can(req, 'review.own'),
  });
  res.json({ ...report, items: report.items.slice(0, 500) });
});

// GET /api/vocabulary/duplicates — groups of entries that are probably the
// same item twice (see vocabStore.duplicateCandidates).
router.get('/duplicates', (_req, res) => {
  res.json(duplicateCandidates());
});

// POST /api/vocabulary/duplicates/dismiss — { ids }: "these are different".
router.post('/duplicates/dismiss', (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: 'Cần ít nhất hai từ.' });
  dismissDuplicates(ids);
  res.json({ ok: true });
});

// POST /api/vocabulary/merge — { keepId, mergeIds }: folds the others into
// the kept entry, keeping everyone's review progress and history.
router.post('/merge', (req, res) => {
  const keepId = Number(req.body?.keepId);
  const mergeIds = (req.body?.mergeIds || []).map(Number).filter((id) => id && id !== keepId);
  if (!keepId || !mergeIds.length) return res.status(400).json({ error: 'Chọn từ giữ lại và ít nhất một từ để gộp.' });
  // Only shared entries are merged here; users' own words reach the shared
  // vocabulary through proposals.
  const ids = [keepId, ...mergeIds];
  if (db.prepare(`SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids).c !== ids.length) {
    return res.status(404).json({ error: 'Chỉ gộp được các từ trong kho chung.' });
  }
  try {
    mergeVocab(keepId, mergeIds, { reason: 'manual', userId: req.user.id });
    res.json(getCard(keepId, req.user.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /api/vocabulary/:id/links — where the entry occurs in every book, its
// word family and phrases, glossary decisions and discussions.
router.get('/:id/links', (req, res) => {
  const links = entryLinks(parseInt(req.params.id, 10), { limit: 1000, uid: req.user.id });
  if (!links) return res.status(404).json({ error: 'Không tìm thấy từ.' });
  // Only the books this user may see.
  const occurrences = links.occurrences.filter((o) => canSeeBook(req, o.book_id));
  res.json({
    ...links,
    occurrences: occurrences.slice(0, 40),
    occurrenceCount: occurrences.length,
    glossary: links.glossary.filter((g) => canSeeBook(req, g.book_id)),
    senses: listSenses(links.id).filter((s) => canSeeBook(req, s.book_id)),
    threads: links.threads.filter((t) => canSeeBook(req, t.book_id)),
  });
});

// GET /api/vocabulary/proposals — words users asked to add to the shared
// vocabulary (vocab.edit); POST /proposals/:id/approve { edits… } and
// /reject { note }.
router.get('/proposals', (_req, res) => {
  res.json(listProposals());
});
router.post('/proposals/:id/approve', (req, res) => {
  try {
    const sharedId = approveProposal(parseInt(req.params.id, 10), req.user.id, req.body || {});
    res.json(getCard(sharedId, req.user.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});
router.post('/proposals/:id/reject', (req, res) => {
  try {
    rejectProposal(parseInt(req.params.id, 10), req.user.id, req.body?.note);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST /api/vocabulary/:id/senses — { bookId, meaning_vi, example?, note? }:
// the word's meaning in one book (vocabSenses.js); PATCH/DELETE
// /senses/:sid change or remove it.
router.post('/:id/senses', (req, res) => {
  try {
    const sense = upsertSense({ vocabularyId: parseInt(req.params.id, 10), bookId: Number(req.body?.bookId), ...req.body, userId: req.user.id });
    if (!sense) return res.status(400).json({ error: 'Nghĩa này trùng với nghĩa chung, không cần thêm.' });
    res.status(201).json(sense);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});
router.patch('/senses/:sid', (req, res) => {
  try {
    res.json(updateSense(parseInt(req.params.sid, 10), req.body || {}));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});
router.delete('/senses/:sid', (req, res) => {
  try {
    deleteSense(parseInt(req.params.sid, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// GET /api/vocabulary/stats
router.get('/stats', (req, res) => {
  const uid = req.user.id;
  const mine = visibleVocabSql('v', uid);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM vocabulary v WHERE ${mine}`).get().c;
  // Every fixed topic with its count (zero included, in list order), so the
  // filter shows the whole set; unclassified words are counted separately.
  const counts = Object.fromEntries(
    db.prepare(`SELECT topic, COUNT(*) AS c FROM vocabulary v WHERE ${mine} GROUP BY topic`).all().map((r) => [r.topic, r.c]),
  );
  const scopes = {
    shared: db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id IS NULL').get().c,
    own: db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id = ?').get(uid).c,
    mine: db.prepare('SELECT COUNT(*) AS c FROM vocabulary v WHERE v.owner_id = ? OR (v.owner_id IS NULL AND EXISTS (SELECT 1 FROM user_vocab u WHERE u.vocabulary_id = v.id AND u.user_id = ?))').get(uid, uid).c,
    pending: db.prepare("SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id = ? AND proposal_status = 'pending'").get(uid).c,
    proposals: can(req, 'vocab.edit') ? db.prepare("SELECT COUNT(*) AS c FROM vocabulary WHERE owner_id IS NOT NULL AND proposal_status = 'pending'").get().c : 0,
  };
  const topics = VOCAB_TOPICS.map((topic) => ({ topic, c: counts[topic] || 0 }));
  const unclassified = total - topics.reduce((n, t) => n + t.c, 0);
  const books = db.prepare(`
    SELECT sb.id, COALESCE(NULLIF(sb.title_vi, ''), sb.title_en) AS title, sb.domain, COUNT(*) AS c
    FROM vocabulary v ${SOURCE} WHERE ${mine} AND ${bookFilterSql(req, 'sb.id')} GROUP BY sb.id ORDER BY c DESC
  `).all();
  res.json({ total, byStatus: countByStatus(uid), topics, unclassified, books, scopes });
});

// GET /api/vocabulary/topics — distinct topic list for filter dropdowns.
router.get('/topics', (_req, res) => {
  res.json(VOCAB_TOPICS);
});

// POST /api/vocabulary/classify-topics — files every word whose topic is not
// one of the fixed topics (new imports, older free-text labels) using the
// configured AI provider.
router.post('/classify-topics', async (_req, res) => {
  try {
    res.json(await classifyTopics());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Shared helper: build a nhóm(topic)/loại(word_type)/trạng thái WHERE clause
// used by both the SRS queue and the plain-browse endpoint below.
const SCOPES = ['shared', 'mine', 'own', 'pending'];

function buildCategoryFilter({ status, topic, wordType, chapterId, bookId, scope }, params, req) {
  const where = [];
  // Genre (thể loại) of the books a word comes from, with editors'
  // corrections (genres.js); "none" = words in no genre, "multi" = in two
  // or more.
  const genre = String(req?.query?.genre ?? '');
  if (genre === 'none' || genre === 'multi' || /^\d+$/.test(genre)) {
    const { none, ids } = vocabIdsInGenre(req, genre);
    params.genreIds = JSON.stringify(ids);
    where.push(`v.id ${none ? 'NOT ' : ''}IN (SELECT value FROM json_each(@genreIds))`);
  }
  // shared: the shared vocabulary; own: words only this user has; mine:
  // their own words plus the shared ones on their list; pending: their
  // words waiting for review.
  if (scope === 'shared') where.push('v.owner_id IS NULL');
  else if (scope === 'own') where.push('v.owner_id IS NOT NULL');
  else if (scope === 'mine') where.push('(v.owner_id IS NOT NULL OR uv.user_id IS NOT NULL)');
  else if (scope === 'pending') where.push("v.proposal_status = 'pending'");
  if (bookId === 'none') where.push('sb.id IS NULL');
  else if (bookId && Number(bookId)) {
    where.push('sb.id = @bookId');
    params.bookId = Number(bookId);
  }
  // Words that came from one chapter: "ôn các từ của chương này".
  if (chapterId && Number(chapterId)) {
    where.push('v.source_paragraph_id IN (SELECT p.id FROM paragraphs p JOIN sections s ON s.id = p.section_id WHERE s.chapter_id = @chapterId)');
    params.chapterId = Number(chapterId);
  }
  if (status && STATUSES.includes(status)) {
    where.push(`${STATUS} = @status`);
    params.status = status;
  }
  if (topic && topic.trim()) {
    where.push('v.topic = @topic');
    params.topic = topic.trim();
  }
  if (wordType && WORD_TYPES.includes(wordType)) {
    where.push('v.word_type = @wordType');
    params.wordType = wordType;
  }
  return where;
}

// GET /api/vocabulary/review?status=&topic=&wordType=&limit=20 — random
// browse/practice sample, filterable by nhóm (chủ đề) và loại (loại từ).
router.get('/review', (req, res) => {
  const { status = '', topic = '', wordType = '', chapterId = '', scope = '', limit = '20' } = req.query;
  const params = { uid: req.user.id };
  const where = buildCategoryFilter({ status, topic, wordType, chapterId, scope }, params, req);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${COLS} FROM ${FROM} ${whereClause} ORDER BY RANDOM() LIMIT @limit`)
    .all({ ...params, limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 20)) });
  res.json(rows);
});

// GET /api/vocabulary/due?limit=20&topic=&wordType=&status= — the user's
// spaced-repetition queue: everything due today or overdue, most-overdue
// first, optionally narrowed down to a nhóm / loại / trạng thái.
router.get('/due', (req, res) => {
  const { limit = '20', topic = '', wordType = '', status = '', chapterId = '', scope = '' } = req.query;
  const params = { uid: req.user.id };
  const where = [`${DUE} <= date('now')`, ...buildCategoryFilter({ status, topic, wordType, chapterId, scope }, params, req)];
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const rows = db
    .prepare(`SELECT ${COLS} FROM ${FROM} ${whereClause} ORDER BY ${DUE} ASC, v.id ASC LIMIT @limit`)
    .all({ ...params, limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 20)) });
  const dueCountTotal = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} ${whereClause}`).get(params).c;
  res.json({ rows, dueCountTotal });
});

// GET /api/vocabulary/review-stats — the signed-in user's Ôn tập dashboard:
// how much is due, how much was reviewed today, and their daily streak.
router.get('/review-stats', (req, res) => {
  const uid = req.user.id;
  const dueToday = db.prepare(`SELECT COUNT(*) AS c FROM ${FROM} WHERE ${DUE} <= date('now')`).get({ uid }).c;
  const reviewedToday = db.prepare(`SELECT COUNT(*) AS c FROM review_log WHERE user_id = ? AND reviewed_date = date('now')`).get(uid).c;
  const totalReviews = db.prepare('SELECT COUNT(*) AS c FROM review_log WHERE user_id = ?').get(uid).c;
  const gradeCounts = db.prepare(`
    SELECT grade, COUNT(*) AS c FROM review_log WHERE user_id = ? AND reviewed_date = date('now') GROUP BY grade
  `).all(uid);
  const todayByGrade = Object.fromEntries(GRADES.map((g) => [g, 0]));
  for (const r of gradeCounts) todayByGrade[r.grade] = r.c;

  const activeDays = db.prepare(`
    SELECT DISTINCT reviewed_date FROM review_log WHERE user_id = ? ORDER BY reviewed_date DESC LIMIT 400
  `).all(uid).map((r) => r.reviewed_date);
  const activeSet = new Set(activeDays);
  let streakDays = 0;
  const cursor = new Date();
  // A streak still counts if today has no review yet but yesterday does
  // (the user just hasn't opened the app yet today).
  if (!activeSet.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (activeSet.has(cursor.toISOString().slice(0, 10))) {
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  res.json({ dueToday, reviewedToday, totalReviews, todayByGrade, streakDays, byStatus: countByStatus(uid) });
});

// POST /api/vocabulary/:id/review — { grade: 'again'|'hard'|'good'|'easy' }
// Applies one SM-2 step to the signed-in user's schedule for this word.
router.post('/:id/review', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = req.user.id;
  const card = getCard(id, uid);
  if (!card) return res.status(404).json({ error: 'Không tìm thấy từ.' });

  const grade = req.body?.grade;
  if (!GRADES.includes(grade)) {
    return res.status(400).json({ error: `Đánh giá không hợp lệ (chọn 1 trong: ${GRADES.join(', ')}).` });
  }

  const next = schedule(card, grade);
  db.transaction(() => {
    upsertProgress.run({ uid, id, ...next });
    db.prepare('INSERT INTO review_log (vocabulary_id, grade, user_id) VALUES (?, ?, ?)').run(id, grade, uid);
  })();

  res.json(getCard(id, uid));
});

// The sentence of a paragraph that contains `term` — the example a word is
// stored with when added from the paragraph editor.
function exampleSentence(paragraphId, term) {
  const row = paragraphId ? db.prepare('SELECT english_md FROM paragraphs WHERE id = ?').get(paragraphId) : null;
  if (!row) return '';
  const text = plainText(row.english_md);
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [text];
  return (sentences.find((s) => containsTerm(s, term)) || '').trim();
}

// POST /api/vocabulary — add a word from the paragraph editor.
// { term, ipa, word_type, meaning_vi, example?, topic, source_paragraph_id }
// An existing entry with the same normalized term is returned as is (409).
router.post('/', (req, res) => {
  const b = req.body || {};
  const term = String(b.term || '').trim();
  if (!term) return res.status(400).json({ error: 'Hãy nhập từ hoặc cụm từ.' });
  const term_normalized = normalizeTerm(term);
  const uid = req.user.id;
  // Editors add to the shared vocabulary unless they ask for their own list;
  // everyone else adds a word of their own.
  const priv = !can(req, 'vocab.edit') || b.scope === 'private';
  if (priv && !can(req, 'vocab.own')) return res.status(403).json({ error: 'Tài khoản của bạn không được thêm từ.' });
  if (priv && process.env.VOCAB_PRIVATE === '0') return res.status(403).json({ error: 'Chức năng từ riêng đang tạm tắt.' });
  const shared = db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL').get(term_normalized);
  if (shared) {
    return res.status(409).json({
      error: priv ? `"${term}" đã có trong kho chung — thêm vào "Từ của tôi" để ôn và ghi chú riêng.` : `"${term}" đã có trong kho.`,
      code: 'exists', scope: 'shared', entry: getCard(shared.id, uid),
    });
  }
  const own = priv && db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND owner_id = ?').get(term_normalized, uid);
  if (own) return res.status(409).json({ error: `"${term}" đã có trong từ riêng của bạn.`, code: 'exists', scope: 'own', entry: getCard(own.id, uid) });
  const word_type = WORD_TYPES.includes(b.word_type) ? b.word_type : WORD_TYPES[0];
  const sourceId = Number(b.source_paragraph_id) || null;
  const info = db.prepare(`
    INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, status, source_paragraph_id, owner_id)
    VALUES (@term, @term_normalized, @ipa, @word_type, @meaning_vi, @example, @topic, date('now'), 'Đang học', @source_paragraph_id, @owner_id)
  `).run({
    owner_id: priv ? uid : null,
    term, term_normalized, word_type,
    ipa: String(b.ipa || '').trim(),
    meaning_vi: String(b.meaning_vi || '').trim(),
    example: String(b.example || '').trim() || exampleSentence(sourceId, term),
    topic: isValidTopic(b.topic) ? b.topic : 'Khác',
    source_paragraph_id: sourceId,
  });
  if (!priv) absorbPrivateCopies(info.lastInsertRowid);
  res.status(201).json(getCard(info.lastInsertRowid, uid));
});

// POST /api/vocabulary/suggest — { term, paragraphId } → the AI's IPA, word
// type, meaning in this paragraph's context and topic, for the add-word form.
router.post('/suggest', async (req, res) => {
  const term = String(req.body?.term || '').trim();
  if (!term) return res.status(400).json({ error: 'Hãy nhập từ hoặc cụm từ.' });
  const paragraphId = Number(req.body?.paragraphId) || null;
  const example = exampleSentence(paragraphId, term);
  const book = paragraphId ? bookOfParagraph(paragraphId) : null;
  const context = bookContextText(book);
  try {
    const answer = await chatText({
      system: 'Bạn là từ điển Anh – Việt cho người học. Chỉ trả về một đối tượng JSON, không giải thích.',
      temperature: 0,
      maxTokens: 300,
      messages: [{
        role: 'user',
        content: `Từ/cụm từ: "${term}"\n${book ? `Sách: "${book.title_en}". ${context}\n` : ''}${example ? `Câu trong sách: "${example}"\n` : ''}Trả về JSON với các khoá:\n- "ipa": phiên âm IPA kiểu /…/\n- "word_type": một trong ${JSON.stringify(WORD_TYPES)}\n- "meaning_vi": nghĩa tiếng Việt ngắn gọn, đúng ngữ cảnh và lĩnh vực của sách\n- "topic": một trong ${JSON.stringify(VOCAB_TOPICS.filter((x) => x !== 'Khác'))}`,
      }],
    });
    const json = JSON.parse((answer.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const lower = (s) => String(s || '').toLowerCase();
    res.json({
      ipa: String(json.ipa || '').trim(),
      word_type: WORD_TYPES.find((w) => lower(w) === lower(json.word_type)) || '',
      meaning_vi: String(json.meaning_vi || '').trim(),
      topic: isValidTopic(json.topic) ? json.topic : '',
      example,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof SyntaxError ? 'AI trả về sai định dạng. Thử lại hoặc tự điền.' : err.message, example });
  }
});

// PATCH /api/vocabulary/:id — the entry's content (vocab.edit) and/or the
// signed-in user's own status for it (review.own).
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = req.user.id;
  const existing = db.prepare('SELECT * FROM vocabulary WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)').get(id, uid);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy từ.' });
  const own = existing.owner_id != null;

  const fields = ['term', 'ipa', 'word_type', 'meaning_vi', 'example', 'topic', 'date_added'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined && req.body[f] !== existing[f]) updates[f] = req.body[f];
  }
  const status = req.body.status;

  if (Object.keys(updates).length && !can(req, own ? 'vocab.own' : 'vocab.edit')) {
    return res.status(403).json({ error: own ? 'Tài khoản của bạn không được sửa từ riêng.' : 'Tài khoản của bạn không được sửa nội dung kho từ vựng.' });
  }
  if (status !== undefined && !can(req, 'review.own')) {
    return res.status(403).json({ error: 'Tài khoản của bạn không có lịch ôn tập.' });
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
  }
  if (updates.word_type && !WORD_TYPES.includes(updates.word_type)) {
    return res.status(400).json({ error: 'Loại từ không hợp lệ.' });
  }
  if (updates.topic !== undefined && !isValidTopic(updates.topic)) {
    return res.status(400).json({ error: 'Chủ đề không hợp lệ.' });
  }

  if (updates.term !== undefined) {
    updates.term = String(updates.term).trim();
    if (!updates.term) return res.status(400).json({ error: 'Hãy nhập từ hoặc cụm từ.' });
    const key = normalizeTerm(updates.term);
    // A key is unique within the shared vocabulary and within each user's
    // own words; an own word may not take a key the shared one has either.
    const clash = db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND id != ? AND (owner_id IS NULL OR owner_id IS ?)')
      .get(key, id, existing.owner_id ?? null);
    if (clash) {
      return res.status(409).json({ error: `"${updates.term}" trùng với một từ đã có trong kho — gộp hai mục thay vì đổi tên.`, code: 'exists', entry: getCard(clash.id, uid) });
    }
  }

  db.transaction(() => {
    if (Object.keys(updates).length) {
      const merged = { ...existing, ...updates };
      const term_normalized = updates.term ? normalizeTerm(updates.term) : existing.term_normalized;
      db.prepare(`
        UPDATE vocabulary SET
          term = @term, term_normalized = @term_normalized, ipa = @ipa, word_type = @word_type,
          meaning_vi = @meaning_vi, example = @example, topic = @topic,
          date_added = @date_added, updated_at = datetime('now')
        WHERE id = @id
      `).run({ ...merged, term_normalized, id });
    }
    if (status !== undefined) {
      const card = getCard(id, uid);
      upsertProgress.run({
        uid, id, status,
        ease_factor: card.ease_factor, interval_days: card.interval_days, repetitions: card.repetitions,
        due_date: card.due_date, last_reviewed_at: card.last_reviewed_at,
      });
    }
  })();

  res.json(getCard(id, uid));
});

// DELETE /api/vocabulary/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT owner_id FROM vocabulary WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy từ.' });
  if (!can(req, row.owner_id != null ? 'vocab.own' : 'vocab.edit')) return res.status(403).json({ error: 'Tài khoản của bạn không được xoá từ này.' });
  db.prepare('DELETE FROM vocabulary WHERE id = ?').run(id);
  res.json({ ok: true });
});

// PUT /api/vocabulary/:id/mine — { note } puts a shared word on the user's
// own list (or updates their note on it); DELETE takes it off. On a word of
// their own, the note is simply theirs.
router.put('/:id/mine', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!getCard(id, req.user.id)) return res.status(404).json({ error: 'Không tìm thấy từ.' });
  db.prepare(`INSERT INTO user_vocab (user_id, vocabulary_id, note) VALUES (?, ?, ?)
    ON CONFLICT(user_id, vocabulary_id) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`)
    .run(req.user.id, id, String(req.body?.note ?? '').slice(0, 2000));
  res.json(getCard(id, req.user.id));
});
router.delete('/:id/mine', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM user_vocab WHERE user_id = ? AND vocabulary_id = ?').run(req.user.id, id);
  const card = getCard(id, req.user.id);
  if (!card) return res.status(404).json({ error: 'Không tìm thấy từ.' });
  res.json(card);
});

// POST /api/vocabulary/:id/propose — { note } asks for one's own word to
// join the shared vocabulary; DELETE withdraws the request.
router.post('/:id/propose', (req, res) => {
  if (process.env.VOCAB_PRIVATE === '0') return res.status(403).json({ error: 'Chức năng đề xuất từ đang tạm tắt.' });
  try {
    proposeVocab(parseInt(req.params.id, 10), req.user.id, req.body?.note);
    res.json(getCard(parseInt(req.params.id, 10), req.user.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});
router.delete('/:id/propose', (req, res) => {
  try {
    withdrawProposal(parseInt(req.params.id, 10), req.user.id);
    res.json(getCard(parseInt(req.params.id, 10), req.user.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// PUT /api/vocabulary/:id/genres — { genreId, in: true|false }: an editor
// puts a shared word in a genre or takes it out (genres.js); answers the
// word's genre ids.
router.put('/:id/genres', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const genreId = Number(req.body?.genreId);
  if (!db.prepare('SELECT 1 FROM vocabulary WHERE id = ? AND owner_id IS NULL').get(id)) return res.status(404).json({ error: 'Không tìm thấy từ trong kho chung.' });
  if (!db.prepare('SELECT 1 FROM genres WHERE id = ?').get(genreId)) return res.status(404).json({ error: 'Không tìm thấy thể loại.' });
  if (typeof req.body?.in !== 'boolean') return res.status(400).json({ error: 'Thiếu "in" (true/false).' });
  res.json({ id, genres: setVocabGenre(id, genreId, req.body.in, req.user.id, req) });
});

export default router;
