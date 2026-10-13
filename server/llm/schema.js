import { WORD_TYPES } from '../wordTypes.js';
import { VOCAB_TOPICS } from '../vocabTopics.js';

export const TOOL_NAME = 'emit_paragraph_translation';
export const TOOL_DESCRIPTION = 'Trả về bản dịch tiếng Việt của một đoạn văn cùng ghi chú từ vựng/cụm từ/nhận xét.';

// Plain JSON-Schema-ish object, deliberately restricted to keywords every
// provider's structured-output / function-calling mode understands
// (Anthropic tools, OpenAI-compatible tools, Gemini responseSchema).
export const PARAGRAPH_TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    english_md: { type: 'string' },
    vietnamese_md: { type: 'string' },
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          meaning_vi: { type: 'string' },
        },
        required: ['term', 'meaning_vi'],
      },
    },
    new_words: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          ipa: { type: 'string' },
          word_type: { type: 'string', enum: WORD_TYPES },
          meaning_vi: { type: 'string' },
          example: { type: 'string' },
          topic: { type: 'string', enum: VOCAB_TOPICS },
        },
        required: ['term', 'ipa', 'word_type', 'meaning_vi', 'example', 'topic'],
      },
    },
    already_known: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term_in_text: { type: 'string' },
          matched_existing_term: { type: 'string' },
        },
        required: ['term_in_text', 'matched_existing_term'],
      },
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['source', 'note'],
      },
    },
    remarks_note: { type: 'string' },
    // Only asked for when the paragraph has a <citation> block (see
    // buildUserMessage); optional so prompts without one are unaffected.
    citation_vi_md: { type: 'string' },
  },
  required: ['english_md', 'vietnamese_md', 'phrases', 'new_words', 'already_known', 'citations', 'remarks_note'],
};
