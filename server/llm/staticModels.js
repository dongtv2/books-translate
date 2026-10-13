// Fallback lists shown when a live "list models" call isn't possible yet
// (no API key entered, provider unreachable, etc.) — keeps the dropdown
// usable instead of empty.
export const STATIC_MODELS = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  ],
  openai: [
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  ],
  nvidia: [
    { id: 'meta/llama-3.1-70b-instruct', label: 'Llama 3.1 70B Instruct' },
    { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B Instruct' },
    { id: 'qwen/qwen2.5-72b-instruct', label: 'Qwen 2.5 72B Instruct' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B Instruct' },
    { id: 'nvidia/riva-translate-4b-instruct-v2', label: 'Riva Translate 4B Instruct v2 (chỉ dịch)' },
    { id: 'nvidia/riva-translate-4b-instruct', label: 'Riva Translate 4B Instruct (chỉ dịch)' },
  ],
  ollama: [],
  lmstudio: [],
  // Self-hosted NIMs on the Metta-AI-Server. The live list comes from its
  // /models endpoint (and is remembered, see routes/settings.js); these are
  // shown when it cannot be reached and nothing was remembered yet.
  metta: [
    { id: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B Instruct (NIM)' },
    { id: 'nvidia/riva-translate-4b-instruct-v2', label: 'Riva Translate 4B Instruct v2 (NIM, chỉ dịch)' },
  ],
};
