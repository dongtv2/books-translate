import { db } from './db.js';
import { decryptSecret, encryptSecret, isEncrypted } from './secrets.js';

const SETTINGS_KEY = 'llm_config';

export const PROVIDERS = ['metta', 'anthropic', 'gemini', 'openai', 'nvidia', 'riva', 'ollama', 'lmstudio'];

export const PROVIDER_DEFAULTS = {
  anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' },
  gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
  openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  // NVIDIA Build (build.nvidia.com) — OpenAI-compatible chat/completions
  // endpoint in front of various hosted NIMs (Llama, Qwen, Nemotron...).
  nvidia: { apiKey: '', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.1-70b-instruct' },
  // NVIDIA Riva NMT — pure machine translation over gRPC (NVCF), not a chat
  // LLM: no model field, just the function-id (from build.nvidia.com) that
  // identifies which hosted NMT function to call; none is shipped. See server/llm/rivaAdapter.js for the limitation.
  riva: { apiKey: '', functionId: '', server: 'grpc.nvcf.nvidia.com:443' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  // Metta-AI-Server — a self-hosted NVIDIA NIM (vLLM) on a GPU machine,
  // OpenAI-compatible, no API key. Its address is set in Settings (or
  // METTA_BASE_URL); none is shipped.
  metta: { baseUrl: process.env.METTA_BASE_URL || '', model: 'meta/llama-3.1-8b-instruct' },
};

function defaultConfig() {
  return {
    provider: 'anthropic',
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || PROVIDER_DEFAULTS.anthropic.model,
    },
    gemini: { ...PROVIDER_DEFAULTS.gemini },
    openai: { ...PROVIDER_DEFAULTS.openai },
    nvidia: { ...PROVIDER_DEFAULTS.nvidia },
    riva: { ...PROVIDER_DEFAULTS.riva },
    ollama: { ...PROVIDER_DEFAULTS.ollama },
    lmstudio: { ...PROVIDER_DEFAULTS.lmstudio },
    metta: { ...PROVIDER_DEFAULTS.metta },
    // How a paragraph is translated: 'linear' (one fixed chain) or 'graph'
    // (workflow/graphs/translateParagraph.js: checks and targeted repairs).
    workflow: { mode: 'linear', maxRepairs: 2 },
    // How a paragraph is drafted: 'single' — the chosen provider does it all;
    // 'hybrid' — a dedicated machine-translation model translates and a chat
    // model writes the notes and checks the terms (llm/hybridPipeline.js).
    pipeline: { ...PIPELINE_DEFAULTS },
  };
}

export const PIPELINE_DEFAULTS = {
  mode: 'single',
  translator: 'nvidia', // 'nvidia' (NVIDIA Build), 'metta' (self-hosted NIM) or 'riva' (Riva NMT over gRPC)
  translatorModel: 'nvidia/riva-translate-4b-instruct-v2', // used with translator 'nvidia'
  annotator: 'anthropic', // any chat provider below
};
export const MT_PROVIDERS = ['nvidia', 'metta', 'riva'];
export const ANNOTATOR_PROVIDERS = ['anthropic', 'gemini', 'openai', 'nvidia', 'ollama', 'lmstudio', 'metta'];

// Providers whose apiKey is stored encrypted (secrets.js).
const KEYED = ['anthropic', 'gemini', 'openai', 'nvidia', 'riva'];

export function getSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
  if (!row) return defaultConfig();
  try {
    const parsed = JSON.parse(row.value);
    for (const k of KEYED) if (parsed[k]?.apiKey) parsed[k] = { ...parsed[k], apiKey: decryptSecret(parsed[k].apiKey) };
    const base = defaultConfig();
    // Merge so newly-added providers/fields get sane defaults even if the
    // stored blob predates them.
    return {
      ...base,
      ...parsed,
      anthropic: { ...base.anthropic, ...parsed.anthropic },
      gemini: { ...base.gemini, ...parsed.gemini },
      openai: { ...base.openai, ...parsed.openai },
      nvidia: { ...base.nvidia, ...parsed.nvidia },
      riva: { ...base.riva, ...parsed.riva },
      ollama: { ...base.ollama, ...parsed.ollama },
      lmstudio: { ...base.lmstudio, ...parsed.lmstudio },
      metta: { ...base.metta, ...parsed.metta },
      workflow: { ...base.workflow, ...parsed.workflow },
      pipeline: { ...base.pipeline, ...parsed.pipeline },
    };
  } catch {
    return defaultConfig();
  }
}

export function saveSettings(next) {
  const current = getSettings();
  const merged = {
    ...current,
    ...next,
    anthropic: { ...current.anthropic, ...next.anthropic },
    gemini: { ...current.gemini, ...next.gemini },
    openai: { ...current.openai, ...next.openai },
    nvidia: { ...current.nvidia, ...next.nvidia },
    riva: { ...current.riva, ...next.riva },
    ollama: { ...current.ollama, ...next.ollama },
    lmstudio: { ...current.lmstudio, ...next.lmstudio },
    metta: { ...current.metta, ...next.metta },
    workflow: { ...current.workflow, ...next.workflow },
    pipeline: { ...current.pipeline, ...next.pipeline },
  };
  if (!['linear', 'graph'].includes(merged.workflow.mode)) merged.workflow.mode = 'linear';
  if (!['single', 'hybrid'].includes(merged.pipeline.mode)) merged.pipeline.mode = 'single';
  if (!MT_PROVIDERS.includes(merged.pipeline.translator)) merged.pipeline.translator = PIPELINE_DEFAULTS.translator;
  if (!ANNOTATOR_PROVIDERS.includes(merged.pipeline.annotator)) merged.pipeline.annotator = PIPELINE_DEFAULTS.annotator;
  merged.pipeline.translatorModel = String(merged.pipeline.translatorModel || PIPELINE_DEFAULTS.translatorModel).trim().slice(0, 200);
  if (!PROVIDERS.includes(merged.provider)) {
    throw new Error(`Nhà cung cấp không hợp lệ: ${merged.provider}`);
  }
  const stored = { ...merged };
  for (const k of KEYED) if (stored[k]?.apiKey) stored[k] = { ...stored[k], apiKey: encryptSecret(stored[k].apiKey) };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTINGS_KEY, JSON.stringify(stored));
  return merged;
}

// Masks API keys for responses that go to the client — full keys are only
// ever needed server-side to call the provider.
export function maskSettings(config) {
  const mask = (key) => (key ? `${'•'.repeat(Math.max(0, key.length - 4))}${key.slice(-4)}` : '');
  return {
    ...config,
    anthropic: { ...config.anthropic, apiKey: mask(config.anthropic.apiKey), hasApiKey: Boolean(config.anthropic.apiKey) },
    gemini: { ...config.gemini, apiKey: mask(config.gemini.apiKey), hasApiKey: Boolean(config.gemini.apiKey) },
    openai: { ...config.openai, apiKey: mask(config.openai.apiKey), hasApiKey: Boolean(config.openai.apiKey) },
    nvidia: { ...config.nvidia, apiKey: mask(config.nvidia.apiKey), hasApiKey: Boolean(config.nvidia.apiKey) },
    riva: { ...config.riva, apiKey: mask(config.riva.apiKey), hasApiKey: Boolean(config.riva.apiKey) },
  };
}

// Once: keys saved before encryption existed are re-saved encrypted.
{
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
  try {
    const raw = row ? JSON.parse(row.value) : {};
    if (KEYED.some((k) => raw[k]?.apiKey && !isEncrypted(raw[k].apiKey))) saveSettings({});
  } catch { /* unreadable settings fall back to defaults */ }
}
