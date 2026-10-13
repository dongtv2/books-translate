import http from 'node:http';
import https from 'node:https';
import { buildUserMessage } from './prompt.js';
import { PARAGRAPH_TRANSLATION_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION } from './schema.js';

const LABELS = { openai: 'OpenAI (ChatGPT)', nvidia: 'NVIDIA Build', ollama: 'Ollama', lmstudio: 'LM Studio', metta: 'Metta-AI-Server' };
// Cloud providers need a real key before a call makes sense; local servers
// (Ollama/LM Studio) just need to be reachable.
const CLOUD_PROVIDERS = ['openai', 'nvidia'];

// A concrete example matching PARAGRAPH_TRANSLATION_SCHEMA, used to steer
// models that can't do real tool/function calling (many local Ollama models,
// especially ones fine-tuned for a single task) into emitting the right JSON
// shape from a plain instruction instead.
const JSON_SHAPE_EXAMPLE = JSON.stringify(
  {
    english_md: '...',
    vietnamese_md: '...',
    phrases: [{ term: '...', meaning_vi: '...' }],
    new_words: [{ term: '...', ipa: '...', word_type: 'Noun', meaning_vi: '...', example: '...', topic: '...' }],
    already_known: [{ term_in_text: '...', matched_existing_term: '...' }],
    citations: [{ source: '...', note: '...' }],
    remarks_note: '...',
    citation_vi_md: '... (chỉ khi có <citation>)',
  },
  null,
  2
);

// How to force the single tool call. OpenAI accepts naming the function;
// LM Studio rejects that object form with a 400 ("Supported string values:
// none, auto, required"), which used to push every LM Studio request onto
// the plain-JSON fallback even for models with working tool calling. With
// one tool defined, "required" means the same thing.
function toolChoiceFor(providerKey) {
  if (providerKey === 'lmstudio') return 'required';
  return { type: 'function', function: { name: TOOL_NAME } };
}

// Upper bound on the reply. A full paragraph result is ~400–2,000 tokens;
// small local models occasionally fall into a repetition loop and would
// otherwise generate until the context is full (minutes, then unparseable).
const MAX_OUTPUT_TOKENS = 4096;

function buildRequestBody({ model, systemPrompt, text, existingTerms, reexplainAll, citation, useTools, providerKey }) {
  if (useTools) {
    return {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserMessage({ text, existingTerms, reexplainAll, citation }) },
      ],
      tools: [{ type: 'function', function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: PARAGRAPH_TRANSLATION_SCHEMA } }],
      tool_choice: toolChoiceFor(providerKey),
    };
  }
  // Fallback for models without tool-calling support: ask for raw JSON
  // matching the same shape instead, no tools/tool_choice involved.
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: 'system',
        content: `${systemPrompt}\n\nQUAN TRỌNG: Model này không hỗ trợ tool calling. Thay vì gọi tool, hãy trả lời DUY NHẤT bằng một JSON object hợp lệ đúng theo cấu trúc mẫu dưới đây — không markdown, không code fence, không giải thích gì thêm ngoài JSON:\n${JSON_SHAPE_EXAMPLE}`,
      },
      { role: 'user', content: buildUserMessage({ text, existingTerms, reexplainAll, citation }) },
    ],
  };
}

// Pulls a JSON object out of a plain-text model reply — strips a ```json
// fence if present, then takes the substring between the first "{" and the
// last "}" so stray commentary before/after the object doesn't break parsing.
function extractJsonObject(content) {
  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// POSTs JSON with no response deadline. The global fetch() gives up when the
// response headers take more than 5 minutes, and a non-streaming completion
// from a local model sends nothing at all until generation has finished —
// a long paragraph on a laptop easily runs past that and surfaced as a
// misleading "fetch failed / is the server running?". node:http has no such
// limit; the request ends when the model does (or the user cancels).
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      target,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function callChatCompletions(url, config, body) {
  try {
    return await postJson(url, { Authorization: `Bearer ${config.apiKey || 'not-needed'}` }, body);
  } catch (err) {
    return { networkError: err };
  }
}

// Shared by OpenAI, Ollama, and LM Studio — all three speak the same
// OpenAI-compatible /chat/completions + tools contract. Falls back to a
// plain-JSON prompt when the model/server rejects tool calling outright
// (common for smaller or task-specific local models served via Ollama).
// Guided decoding on vLLM-based servers (Metta-AI-Server's NIM) now and then
// degenerates into emitting whitespace until max_tokens: a 200 response with
// no usable tool call. The same request usually succeeds on a second try, so
// an unparseable answer is retried once before giving up.
export async function translateParagraph(options) {
  try {
    return await translateOnce(options);
  } catch (err) {
    if (!err.retryable) throw err;
    return translateOnce(options);
  }
}

function formatError(message) {
  const err = new Error(message);
  err.retryable = true;
  return err;
}

async function translateOnce({ text, existingTerms, reexplainAll, citation, config, providerKey, systemPrompt }) {
  const label = LABELS[providerKey] || providerKey;
  if (CLOUD_PROVIDERS.includes(providerKey) && !config.apiKey) {
    throw new Error(`Thiếu API key cho ${label} — vào Cài đặt để nhập.`);
  }
  if (!config.baseUrl) throw new Error(`Thiếu Base URL cho ${label} — vào Cài đặt để cấu hình.`);
  if (!config.model) throw new Error(`Thiếu tên model cho ${label} — vào Cài đặt để cấu hình.`);

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const args = { model: config.model, systemPrompt, text, existingTerms, reexplainAll, citation, providerKey };

  let res = await callChatCompletions(url, config, buildRequestBody({ ...args, useTools: true }));
  if (res.networkError) {
    throw new Error(`Không kết nối được tới ${label} tại ${config.baseUrl} (${res.networkError.message}). Kiểm tra server có đang chạy không.`);
  }

  let usedFallback = false;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const toolsUnsupported = res.status === 400 && /tool/i.test(errText);
    if (!toolsUnsupported) {
      throw new Error(`${label} trả về lỗi ${res.status}: ${errText.slice(0, 300)}`);
    }
    // Model/server rejected tool calling entirely — retry once without tools.
    usedFallback = true;
    res = await callChatCompletions(url, config, buildRequestBody({ ...args, useTools: false }));
    if (res.networkError) {
      throw new Error(`Không kết nối được tới ${label} tại ${config.baseUrl} (${res.networkError.message}). Kiểm tra server có đang chạy không.`);
    }
    if (!res.ok) {
      const retryErrText = await res.text().catch(() => '');
      throw new Error(`${label} trả về lỗi ${res.status} (đã thử không dùng tools): ${retryErrText.slice(0, 300)}`);
    }
  }

  const data = await res.json();

  if (!usedFallback) {
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall) {
      try {
        return JSON.parse(toolCall.function.arguments);
      } catch {
        throw formatError(`${label} trả về JSON không hợp lệ cho tool call.`);
      }
    }
    // No tool_calls even on a 200 — some servers silently ignore tools
    // instead of rejecting them; fall through and try to read plain content.
  }

  const content = data.choices?.[0]?.message?.content;
  const parsed = content ? extractJsonObject(content) : null;
  if (!parsed) {
    throw formatError(`${label} không trả về kết quả đúng định dạng (model "${config.model}" có thể không hỗ trợ tool calling lẫn JSON output).`);
  }
  return parsed;
}

export async function listModels(config, providerKey) {
  const label = LABELS[providerKey] || providerKey;
  if (CLOUD_PROVIDERS.includes(providerKey) && !config.apiKey) throw new Error('Thiếu API key.');
  if (!config.baseUrl) throw new Error('Thiếu Base URL.');

  const url = `${config.baseUrl.replace(/\/$/, '')}/models`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey || 'not-needed'}` },
    });
  } catch (err) {
    throw new Error(`Không kết nối được tới ${label} tại ${config.baseUrl} (${err.message}).`);
  }
  if (!res.ok) throw new Error(`${label} trả về lỗi ${res.status} khi lấy danh sách model.`);
  const data = await res.json();
  return (data.data || []).map((m) => ({ id: m.id, label: m.id }));
}

// Plain English → Vietnamese translation of a short text, no tools and no
// JSON. Used to fill in a paragraph's citation translation when the model
// skipped it inside the structured result (smaller models often do, while
// they translate the same text fine when asked on its own).
export async function translatePlain({ text, config, providerKey }) {
  const label = LABELS[providerKey] || providerKey;
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await callChatCompletions(url, config, {
    model: config.model,
    max_tokens: 1024,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Bạn là biên dịch viên Anh-Việt. Dịch đoạn trích dẫn người dùng gửi sang tiếng Việt tự nhiên, sát nghĩa. Giữ nguyên tên riêng, tên sách/tạp chí, năm và số trang; giữ dấu ngoặc kép quanh lời trích dẫn trực tiếp; giữ **...** và *...* nếu có. Chỉ trả về bản dịch, không giải thích, không thêm gì khác.',
      },
      { role: 'user', content: text },
    ],
  });
  if (res.networkError) throw new Error(`Không kết nối được tới ${label} tại ${config.baseUrl} (${res.networkError.message}).`);
  if (!res.ok) throw new Error(`${label} trả về lỗi ${res.status} khi dịch trích dẫn.`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// One chat/completions call returning the parsed response body. Shared by
// the compact pipeline (llm/compactPipeline.js).
export async function chatCompletion({ config, providerKey, body }) {
  const label = LABELS[providerKey] || providerKey;
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await callChatCompletions(url, config, { model: config.model, ...body });
  if (res.networkError) throw new Error(`Không kết nối được tới ${label} tại ${config.baseUrl} (${res.networkError.message}). Kiểm tra server có đang chạy không.`);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${label} trả về lỗi ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}
