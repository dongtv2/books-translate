import { Router } from 'express';
import {
  listPromptTemplates,
  getPromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
  setDefaultPromptTemplate,
} from '../llm/promptTemplates.js';

const router = Router();

// GET /api/prompts — the whole prompt library, default first.
router.get('/', (_req, res) => {
  res.json(listPromptTemplates());
});

// POST /api/prompts — { name, content } — create a new named prompt.
router.post('/', (req, res) => {
  try {
    const created = createPromptTemplate(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/prompts/:id — { name?, content? }.
router.patch('/:id', (req, res) => {
  try {
    const updated = updatePromptTemplate(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/prompts/:id — refuses to delete the default or the last one.
router.delete('/:id', (req, res) => {
  try {
    deletePromptTemplate(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/prompts/:id/default — makes this prompt the library-wide fallback.
router.post('/:id/default', (req, res) => {
  try {
    const updated = setDefaultPromptTemplate(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
