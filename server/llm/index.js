import { getSettings } from '../settingsStore.js';
import * as anthropicAdapter from './anthropicAdapter.js';
import * as geminiAdapter from './geminiAdapter.js';
import * as openAICompatAdapter from './openAICompatAdapter.js';
import * as rivaAdapter from './rivaAdapter.js';

const PROVIDER_LABELS = {
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)',
  openai: 'OpenAI (ChatGPT)',
  nvidia: 'NVIDIA Build',
  riva: 'NVIDIA Riva NMT',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  metta: 'Metta-AI-Server',
};

export function providerLabel(key) {
  return PROVIDER_LABELS[key] || key;
}

// Short plain translation (no notes, no JSON) for the providers that speak
// the OpenAI chat format; returns null where it is not available.
export async function translatePlainText(text) {
  const settings = getSettings();
  const provider = settings.provider;
  if (!['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'].includes(provider)) return null;
  return openAICompatAdapter.translatePlain({ text, config: settings[provider], providerKey: provider });
}

export async function translateParagraph(args) {
  return translateParagraphWith(getSettings().provider, args);
}

// The same, with a named provider instead of the active one (the hybrid
// pipeline uses its annotator here, whatever provider is active).
export async function translateParagraphWith(provider, { text, existingTerms = [], reexplainAll = false, citation = '', systemPrompt }) {
  const settings = getSettings();
  const config = settings[provider];
  if (!config) throw new Error(`Chưa cấu hình nhà cung cấp AI: ${provider}`);

  if (provider === 'anthropic') {
    return anthropicAdapter.translateParagraph({ text, existingTerms, reexplainAll, citation, config, systemPrompt });
  }
  if (provider === 'gemini') {
    return geminiAdapter.translateParagraph({ text, existingTerms, reexplainAll, citation, config, systemPrompt });
  }
  if (['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'].includes(provider)) {
    return openAICompatAdapter.translateParagraph({ text, existingTerms, reexplainAll, citation, config, providerKey: provider, systemPrompt });
  }
  if (provider === 'riva') {
    return rivaAdapter.translateParagraph({ text, config });
  }
  throw new Error(`Nhà cung cấp AI không được hỗ trợ: ${provider}`);
}
