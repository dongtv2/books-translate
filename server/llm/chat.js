import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../settingsStore.js';
import { chatCompletion } from './openAICompatAdapter.js';
import { providerLabel } from './index.js';

const OPENAI_STYLE = ['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'];

// A plain multi-turn chat with the configured provider: a system prompt and
// [{ role: 'user' | 'assistant', content }], answered with text. Used by the
// translation assistant (assistant.js); translation itself goes through the
// structured adapters in llm/index.js.
export async function chatText({ system, messages, maxTokens = 1800, temperature = 0.3 }) {
  const settings = getSettings();
  const provider = settings.provider;
  const config = settings[provider];
  if (!config) throw new Error(`Chưa cấu hình nhà cung cấp AI: ${provider}`);

  if (OPENAI_STYLE.includes(provider)) {
    const data = await chatCompletion({
      config,
      providerKey: provider,
      body: { messages: [{ role: 'system', content: system }, ...messages], temperature, max_tokens: maxTokens },
    });
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  if (provider === 'anthropic') {
    if (!config.apiKey) throw new Error('Thiếu API key cho Anthropic (Claude) — vào Cài đặt để nhập.');
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await client.messages.create({ model: config.model, max_tokens: maxTokens, temperature, system, messages });
    return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  if (provider === 'gemini') {
    if (!config.apiKey) throw new Error('Thiếu API key cho Gemini — vào Cài đặt để nhập.');
    const model = config.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      });
    } catch (err) {
      throw new Error(`Không kết nối được tới Gemini (${err.message}).`);
    }
    if (!res.ok) throw new Error(`Gemini trả về lỗi ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }

  throw new Error(`${providerLabel(provider)} chỉ dịch máy, không trò chuyện được. Chọn nhà cung cấp khác trong Cài đặt để dùng trợ lý.`);
}
