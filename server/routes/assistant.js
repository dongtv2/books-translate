import { Router } from 'express';
import { db } from '../db.js';
import { withUserMarks } from '../auth/marks.js';
import { SKILLS, listMessages, ask, askField, approve, reject, revert, clearThread } from '../assistant.js';

// /api/paragraphs/:id/assistant — the signed-in user's chat with the
// translation assistant about one paragraph (see assistant.js).
const router = Router();

const pid = (req) => parseInt(req.params.id, 10);
const paragraphFor = (req) => withUserMarks([db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(pid(req))], req.user.id)[0];
const skillList = SKILLS.map(({ key, label, description, revises }) => ({ key, label, description, revises }));

function fail(res, err) {
  res.status(err.status || 500).json({ error: err.message, code: err.code, current: err.current });
}

router.get('/:id/assistant', (req, res) => {
  res.json({ skills: skillList, messages: listMessages(req.user.id, pid(req)) });
});

router.post('/:id/assistant', async (req, res) => {
  try {
    const messages = await ask({ userId: req.user.id, paragraphId: pid(req), message: req.body?.message, skill: req.body?.skill });
    res.json({ messages });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/paragraphs/:id/assistant/field — inline AI for one editor field
// { field, instruction, selection?, revise?, draft, history } → { reply, revision }
router.post('/:id/assistant/field', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await askField({
      paragraphId: pid(req), field: b.field, instruction: b.instruction, selection: b.selection,
      revise: typeof b.revise === 'boolean' ? b.revise : undefined, draft: b.draft || {}, history: b.history || [],
    }));
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/:id/assistant', (req, res) => {
  clearThread(req.user.id, pid(req));
  res.json({ ok: true });
});

router.post('/:id/assistant/:mid/approve', (req, res) => {
  try {
    const message = approve({ userId: req.user.id, paragraphId: pid(req), messageId: parseInt(req.params.mid, 10), text: req.body?.text, force: Boolean(req.body?.force) });
    res.json({ message, paragraph: paragraphFor(req) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/:id/assistant/:mid/reject', (req, res) => {
  try {
    res.json({ message: reject({ userId: req.user.id, paragraphId: pid(req), messageId: parseInt(req.params.mid, 10) }) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/:id/assistant/:mid/revert', (req, res) => {
  try {
    const message = revert({ userId: req.user.id, paragraphId: pid(req), messageId: parseInt(req.params.mid, 10) });
    res.json({ message, paragraph: paragraphFor(req) });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
