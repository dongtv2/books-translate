import { Router } from 'express';
import { getSettings, saveSettings, maskSettings, PROVIDERS } from '../settingsStore.js';
import * as anthropicAdapter from '../llm/anthropicAdapter.js';
import * as geminiAdapter from '../llm/geminiAdapter.js';
import * as openAICompatAdapter from '../llm/openAICompatAdapter.js';
import * as rivaAdapter from '../llm/rivaAdapter.js';
import { STATIC_MODELS } from '../llm/staticModels.js';
import { getEffectivePromptForBook } from '../llm/promptTemplates.js';
import { buildSystemPrompt, isLegacyPrompt } from '../llm/prompt.js';
import { translateParagraphCompact } from '../llm/compactPipeline.js';
import { cleanTranslationResult } from '../modelOutput.js';
import { translateParagraphHybrid } from '../llm/hybridPipeline.js';

const router = Router();

// Where a provider's key is sent: its base URL (or, for Riva, its server).
const destination = (cfg = {}) => String(cfg.baseUrl ?? cfg.server ?? '').trim().replace(/\/+$/, '');
const isMasked = (key) => typeof key === 'string' && key.startsWith('•');

// A masked apiKey (starts with •, as returned by GET /api/settings) means
// "use the already-saved one" — but only toward the saved destination.
// Pointing a draft at another URL with the masked key would otherwise send
// the real, never-shown key to whatever server the draft names.
function resolveConfig(provider, draft = {}) {
  const saved = getSettings();
  const effective = { ...saved[provider], ...draft };
  if (isMasked(effective.apiKey)) {
    if (destination(effective) !== destination(saved[provider])) {
      throw Object.assign(new Error('Đã đổi địa chỉ máy chủ: hãy nhập lại API key cho địa chỉ mới.'), { status: 400 });
    }
    effective.apiKey = saved[provider].apiKey;
  }
  return effective;
}

// GET /api/settings — API keys come back masked (only last 4 chars visible).
router.get('/', (_req, res) => {
  res.json(maskSettings(getSettings()));
});

// PUT /api/settings — partial update, merged onto the stored config.
// A masked value (starts with •) for an apiKey field means "unchanged".
router.put('/', (req, res) => {
  try {
    const body = { ...req.body };
    const before = getSettings();
    for (const key of ['anthropic', 'gemini', 'openai', 'nvidia', 'riva']) {
      if (!body[key] || typeof body[key] !== 'object') continue;
      body[key] = { ...body[key] };
      const moved = (body[key].baseUrl !== undefined || body[key].server !== undefined)
        && destination({ ...before[key], ...body[key] }) !== destination(before[key]);
      // A new destination never inherits the saved key: it needs its own.
      if (moved && (body[key].apiKey === undefined || isMasked(body[key].apiKey))) body[key].apiKey = '';
      else if (isMasked(body[key].apiKey)) delete body[key].apiKey;
    }
    const saved = saveSettings(body);
    res.json(maskSettings(saved));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const TEST_PARAGRAPH = 'The quick brown fox jumps over the lazy dog.';

// POST /api/settings/test — { provider, config } — fires one real, minimal
// translate call against the draft config the user is editing (not
// necessarily saved yet), so mistakes surface before hitting Save.
router.post('/test', async (req, res) => {
  const { provider, config } = req.body || {};
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ ok: false, error: `Nhà cung cấp không hợp lệ: ${provider}` });
  }
  let effectiveConfig;
  try {
    effectiveConfig = resolveConfig(provider, config);
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, error: err.message });
  }
  const guide = getEffectivePromptForBook(null);
  const systemPrompt = buildSystemPrompt(guide);

  try {
    let result;
    if (provider === 'anthropic') {
      result = await anthropicAdapter.translateParagraph({ text: TEST_PARAGRAPH, existingTerms: [], reexplainAll: false, config: effectiveConfig, systemPrompt });
    } else if (provider === 'gemini') {
      result = await geminiAdapter.translateParagraph({ text: TEST_PARAGRAPH, existingTerms: [], reexplainAll: false, config: effectiveConfig, systemPrompt });
    } else if (provider === 'riva') {
      result = await rivaAdapter.translateParagraph({ text: TEST_PARAGRAPH, config: effectiveConfig });
    } else if (provider === 'metta') {
      // Same pipeline as real translations for this provider (see paragraphTranslation.js).
      result = await translateParagraphCompact({ text: TEST_PARAGRAPH, guide: isLegacyPrompt(guide) ? '' : guide, config: effectiveConfig, providerKey: provider });
    } else {
      result = await openAICompatAdapter.translateParagraph({ text: TEST_PARAGRAPH, existingTerms: [], reexplainAll: false, config: effectiveConfig, providerKey: provider, systemPrompt });
    }
    // Shown exactly as it would be saved.
    const warnings = result._pipeline?.warnings || [];
    result = cleanTranslationResult(result, TEST_PARAGRAPH);
    res.json({ ok: true, sample: result.vietnamese_md.replace(/\*\*/g, ''), warnings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/settings/test-pipeline — runs the saved hybrid pipeline (MT
// model + annotator) on the sample paragraph: the machine translation, the
// final text, the number of notes, timings and any fallback warnings.
router.post('/test-pipeline', async (req, res) => {
  const systemPrompt = buildSystemPrompt(getEffectivePromptForBook(null));
  try {
    const raw = await translateParagraphHybrid({ text: TEST_PARAGRAPH, systemPrompt });
    const { _pipeline: p } = raw;
    const result = cleanTranslationResult(raw, TEST_PARAGRAPH);
    res.json({
      ok: true,
      base: p.base,
      sample: result.vietnamese_md.replace(/\*\*/g, ''),
      notes: (result.new_words?.length || 0) + (result.phrases?.length || 0),
      translator: p.translator,
      annotator: p.annotator,
      mtMs: p.mtMs,
      ms: p.ms,
      warnings: p.warnings,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/settings/models — { provider, config } — live model list when
// possible (Anthropic/Gemini/OpenAI APIs, or an Ollama/LM Studio server's
// own /models endpoint), falling back to a small curated list otherwise.
router.post('/models', async (req, res) => {
  const { provider, config } = req.body || {};
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Nhà cung cấp không hợp lệ: ${provider}` });
  }
  // Riva NMT has no "model" concept to list — it's one fixed function per
  // config (see server/llm/rivaAdapter.js).
  if (provider === 'riva') {
    return res.json({ models: [], source: 'not-applicable' });
  }

  let effectiveConfig;
  try {
    effectiveConfig = resolveConfig(provider, config);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const isLocal = ['ollama', 'lmstudio', 'metta'].includes(provider);

  // Cloud providers need a key before a live call makes sense; local
  // providers just need a reachable baseUrl (already defaulted).
  if (!isLocal && !effectiveConfig.apiKey) {
    return res.json({ models: STATIC_MODELS[provider] || [], source: 'fallback' });
  }

  try {
    let models;
    if (provider === 'anthropic') models = await anthropicAdapter.listModels(effectiveConfig);
    else if (provider === 'gemini') models = await geminiAdapter.listModels(effectiveConfig);
    else models = await openAICompatAdapter.listModels(effectiveConfig, provider);
    // Remember what this endpoint serves, for when it is offline (a
    // self-hosted GPU server is not always up). Only for the saved address.
    if (isLocal && models.length && destination(effectiveConfig) === destination(getSettings()[provider])) {
      saveSettings({ [provider]: { knownModels: models.map((m) => m.id).slice(0, 100), knownModelsAt: new Date().toISOString() } });
    }
    res.json({ models, source: 'live' });
  } catch (err) {
    const saved = getSettings()[provider] || {};
    const remembered = destination(effectiveConfig) === destination(saved) ? (saved.knownModels || []) : [];
    const ids = new Set(remembered);
    const models = [
      ...remembered.map((id) => ({ id, label: id })),
      ...(STATIC_MODELS[provider] || []).filter((m) => !ids.has(m.id)),
    ];
    res.json({ models, source: remembered.length ? 'cached' : 'fallback', cachedAt: remembered.length ? saved.knownModelsAt : undefined, error: err.message });
  }
});

export default router;
