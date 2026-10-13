import { buildUserMessage } from './prompt.js';
import { PARAGRAPH_TRANSLATION_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION } from './schema.js';

export async function translateParagraph({ text, existingTerms, reexplainAll, citation, config, systemPrompt }) {
  if (!config.apiKey) {
    throw new Error('Thiếu API key cho Gemini — vào Cài đặt để nhập.');
  }
  const model = config.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: buildUserMessage({ text, existingTerms, reexplainAll, citation }) }] }],
    tools: [{ functionDeclarations: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: PARAGRAPH_TRANSLATION_SCHEMA }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL_NAME] } },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Không kết nối được tới Gemini (${err.message}).`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini trả về lỗi ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
  if (!part) {
    throw new Error('Gemini không trả về kết quả đúng định dạng mong đợi.');
  }
  return part.functionCall.args;
}

export async function listModels(config) {
  if (!config.apiKey) throw new Error('Thiếu API key.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.apiKey)}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gemini trả về lỗi ${res.status} khi lấy danh sách model.`);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
}
