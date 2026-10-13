import Anthropic from '@anthropic-ai/sdk';
import { buildUserMessage } from './prompt.js';
import { PARAGRAPH_TRANSLATION_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION } from './schema.js';

export async function translateParagraph({ text, existingTerms, reexplainAll, citation, config, systemPrompt }) {
  if (!config.apiKey) {
    throw new Error('Thiếu API key cho Anthropic (Claude) — vào Cài đặt để nhập.');
  }
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 3000,
    system: systemPrompt,
    tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: PARAGRAPH_TRANSLATION_SCHEMA }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: buildUserMessage({ text, existingTerms, reexplainAll, citation }) }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Claude không trả về kết quả đúng định dạng mong đợi.');
  return toolUse.input;
}

export async function listModels(config) {
  if (!config.apiKey) throw new Error('Thiếu API key.');
  const client = new Anthropic({ apiKey: config.apiKey });
  const page = await client.models.list({ limit: 50 });
  return page.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
}
