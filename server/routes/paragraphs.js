import { Router } from 'express';
import { db } from '../db.js';
import { loadVocabState, translateAndSaveParagraph } from '../paragraphTranslation.js';
import { can } from '../auth/middleware.js';
import { MARK_FIELDS, withUserMarks, setUserMarks } from '../auth/marks.js';
import { getSettings } from '../settingsStore.js';
import { runGraph } from '../workflow/engine.js';
import translateParagraphGraph from '../workflow/graphs/translateParagraph.js';
import { getRun, runsFor } from '../workflow/store.js';

const router = Router();
const TEXT_FIELDS = ['english_md', 'vietnamese_md', 'phrases_verbs_md', 'vocabulary_md', 'citations_md', 'citation_en_md', 'citation_vi_md', 'remarks_note', 'status'];

// PATCH /api/paragraphs/:id — manual edit of the shared text fields
// (books.edit) and/or the signed-in user's own marks (marks.own); any subset
// of fields may be sent.
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy đoạn văn.' });

  const updates = {};
  for (const f of TEXT_FIELDS) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const markPatch = Object.fromEntries(MARK_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]]));

  if (Object.keys(updates).length && !can(req, 'books.edit')) {
    return res.status(403).json({ error: 'Tài khoản của bạn không được sửa nội dung đoạn văn.' });
  }
  if (Object.keys(markPatch).length && !can(req, 'marks.own')) {
    return res.status(403).json({ error: 'Tài khoản của bạn không được đánh dấu đoạn văn.' });
  }
  if (updates.status && !['pending', 'translated'].includes(updates.status)) {
    return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
  }

  db.transaction(() => {
    if (Object.keys(updates).length) {
      const merged = { ...existing, ...updates, id };
      db.prepare(`
        UPDATE paragraphs SET
          english_md=@english_md, vietnamese_md=@vietnamese_md, phrases_verbs_md=@phrases_verbs_md,
          vocabulary_md=@vocabulary_md, citations_md=@citations_md, citation_en_md=@citation_en_md, citation_vi_md=@citation_vi_md,
          remarks_note=@remarks_note, status=@status, updated_at=datetime('now')
        WHERE id=@id
      `).run(merged);
    }
    if (Object.keys(markPatch).length) setUserMarks(req.user.id, id, markPatch);
  })();

  res.json(withUserMarks([db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(id)], req.user.id)[0]);
});

// DELETE /api/paragraphs/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM paragraphs WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy đoạn văn.' });
  res.json({ ok: true });
});

// POST /api/paragraphs/:id/translate — translate (or re-translate) just this
// paragraph via Claude and save immediately.
router.post('/:id/translate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const paragraph = db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(id);
  if (!paragraph) return res.status(404).json({ error: 'Không tìm thấy đoạn văn.' });

  try {
    const reexplainAll = Boolean(req.body?.reexplainAll);
    // Settings → AI: the graph workflow checks the draft and repairs what it
    // finds before saving; the linear pipeline saves the first draft.
    if (getSettings().workflow?.mode === 'graph') {
      const run = await runGraph(translateParagraphGraph, { paragraphId: id, reexplainAll }, { subject: `paragraph:${id}`, userId: req.user.id });
      const { saved, remaining = [] } = run.state;
      return res.json({
        ...saved,
        paragraph: withUserMarks([saved.paragraph], req.user.id)[0],
        workflow: {
          runId: run.runId, ms: run.ms, llmCalls: run.llmCalls, repairs: run.state.repairs, strategy: run.state.plan?.strategy,
          path: run.trace.map((t) => t.node), remaining: remaining.map(({ type, detail }) => ({ type, detail })),
        },
      });
    }
    const vocabState = loadVocabState();
    const result = await translateAndSaveParagraph(paragraph, vocabState, { reexplainAll });
    res.json({ ...result, paragraph: withUserMarks([result.paragraph], req.user.id)[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Dịch thất bại.' });
  }
});

// GET /api/paragraphs/:id/workflows — recent workflow runs for a paragraph;
// GET /api/paragraphs/:id/workflows/:runId — one run with its steps.
router.get('/:id/workflows', (req, res) => {
  res.json(runsFor(`paragraph:${parseInt(req.params.id, 10)}`));
});
router.get('/:id/workflows/:runId', (req, res) => {
  const run = getRun(Number(req.params.runId));
  if (!run || run.subject !== `paragraph:${parseInt(req.params.id, 10)}`) return res.status(404).json({ error: 'Không tìm thấy lượt chạy.' });
  return res.json(run);
});

export default router;
