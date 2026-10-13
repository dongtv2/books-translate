// Translation pipeline tuned for small models (Llama 3.1 8B on
// Metta-AI-Server). The single-call prompt asks one response to copy the
// English with bold marks, translate, extract IPA vocabulary and keep two
// bold sets in sync — a 70B+ model manages, an 8B model gets most of it
// wrong. Here the work is split so each call does one thing:
//
//   1. translate  — plain text out, no JSON. Context: a glossary built from
//                   the vocabulary already learned in this book (so key terms
//                   keep the same Vietnamese every time), and the previous
//                   paragraph with its translation as a worked example.
//   2. notes      — JSON via tool call, given the English AND the finished
//                   Vietnamese: phrases, new words, citations, remark, plus
//                   for every item the exact Vietnamese words used for it.
//   3. bolding    — done here in code, not by the model: an item is bolded
//                   only where it is found in both columns, so the English
//                   and Vietnamese bold sets always match.
import { WORD_TYPES } from '../wordTypes.js';
import { bookContextText } from '../bookContext.js';
import { VOCAB_TOPICS, TOPIC_GUIDE } from '../vocabTopics.js';
import { chatCompletion, translatePlain } from './openAICompatAdapter.js';
import { relevantTerms } from '../normalize.js';
import { isMtOnly, mtMessages, mtReply } from './mtModels.js';

const TRANSLATE_SYSTEM = `You are an expert literary translator from English into Vietnamese.
Translate the paragraph the user sends into natural, fluent, faithful Vietnamese for an educated Vietnamese reader.
Rules:
- Translate the meaning, not word by word. Keep every idea; add nothing.
- Use the glossary translations for those terms, so terminology stays consistent across the book.
- Keep personal names, book and journal titles, numbers and years unchanged.
- Keep quotation marks around direct quotations; translate the quoted words.
- No English words may remain in the translation except names and titles.
- Output ONLY the Vietnamese translation: no notes, no markdown, no quotation of the original.`;

const NOTES_TOOL = 'emit_paragraph_notes';

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, meaning_vi: { type: 'string' }, vi: { type: 'string' } },
        required: ['term', 'meaning_vi', 'vi'],
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
          topic: { type: 'string', enum: VOCAB_TOPICS },
          vi: { type: 'string' },
        },
        required: ['term', 'ipa', 'word_type', 'meaning_vi', 'topic', 'vi'],
      },
    },
    citations: {
      type: 'array',
      items: { type: 'object', properties: { source: { type: 'string' }, note: { type: 'string' } }, required: ['source', 'note'] },
    },
    remarks_note: { type: 'string' },
  },
  required: ['phrases', 'new_words', 'citations', 'remarks_note'],
};

const NOTES_SYSTEM = `You help a Vietnamese reader learn English from a book. You get an English paragraph and its Vietnamese translation. Call ${NOTES_TOOL} once with:
- new_words: 2 to 5 words or expressions from the English paragraph that an upper-intermediate learner would NOT already know (B2-C2): uncommon words, idioms, phrasal verbs, collocations. NEVER basic everyday words such as society, everywhere, replace, natural, healthy, important, children. term = dictionary form exactly as an English learner would look it up. ipa = British IPA with stress mark, between slashes. word_type = one of: ${WORD_TYPES.join(', ')}. meaning_vi = short Vietnamese meaning that fits this context. topic = one value from the topic list below, chosen by what the word means.
- phrases: 0 to 4 short expressions (2 to 5 words, never a whole clause or sentence) from the paragraph that help understanding but are not worth memorising, with meaning_vi.
- citations: only people, studies or works the paragraph cites as a source; note = one short Vietnamese sentence on who/what it is. Usually empty.
- remarks_note: one short Vietnamese sentence on what is notable in the paragraph, or "".
- For EVERY phrase and new word, vi = the exact words of the Vietnamese translation that translate it (copied character for character from the translation).
Topic list:
${TOPIC_GUIDE}
Never list a word from the known-words list. Every term must be copied from the English paragraph (only changed to dictionary form for new_words). word_type must describe the term itself (e.g. "industrially advanced" is an Adjective phrase, not an Adverb). Write all explanations in Vietnamese.`;

function glossaryBlock(glossary) {
  if (!glossary.length) return '';
  const lines = glossary.map((g) => `- ${g.term}: ${g.meaning_vi.split(/[;.]/)[0].trim().slice(0, 70)}`);
  return `Glossary (use these Vietnamese renderings):\n${lines.join('\n')}\n\n`;
}

export async function translateParagraphCompact({ text, citation = '', glossary = [], previous = null, book = null, existingTerms = [], guide = '', config, providerKey }) {
  // A translation-only model (Riva Translate on the server): it translates
  // with its own prompt and can do nothing else — no glossary, no notes.
  // The hybrid pipeline (Settings → AI → Kết hợp) adds the notes.
  if (isMtOnly(config.model)) {
    const mt = async (t) => mtReply(await chatCompletion({ config, providerKey, body: { messages: mtMessages(t.replace(/\*\*|__/g, '')), temperature: 0, max_tokens: 2048 } }));
    const vietnamese = await mt(text);
    if (!vietnamese) throw new Error('Mô hình không trả về bản dịch.');
    return {
      english_md: text.replace(/\*\*/g, ''), vietnamese_md: vietnamese, citation_vi_md: citation.trim() ? await mt(citation.trim()) : '',
      phrases: [], new_words: [], already_known: [], citations: [], remarks_note: '',
      _pipeline: { warnings: [`${config.model} là model chỉ dịch: đoạn này chưa có ghi chú từ vựng. Muốn có ghi chú, bật Cài đặt → AI dịch → Cách dịch: Kết hợp.`] },
    };
  }
  const warnings = [];
  // --- 1. translate -------------------------------------------------------
  // The book's translation guide from Settings (Vietnamese) goes after the
  // built-in rules: it carries voice, forms of address and fidelity choices.
  const system = guide.trim() ? `${TRANSLATE_SYSTEM}\n\nTranslator's guide for this book (in Vietnamese; follow it):\n${guide.trim()}` : TRANSLATE_SYSTEM;
  const messages = [{ role: 'system', content: system }];
  // The book's own title stays in English inside the text (8B models tend
  // to invent a Vietnamese title on the spot).
  const context = bookContextText(book, { language: 'en' });
  const intro = book ? `Book: "${book.title_en}". When this book's title appears in the text, keep it exactly as written in English.${context ? `\n${context}` : ''}\n\n` : '';
  if (previous?.english && previous?.vietnamese) {
    // The previous paragraph as a solved example: shows the expected style
    // and carries the narrative context into this one.
    messages.push({ role: 'user', content: `${intro}${previous.english}` });
    messages.push({ role: 'assistant', content: previous.vietnamese });
    messages.push({ role: 'user', content: `${glossaryBlock(glossary)}${text}` });
  } else {
    messages.push({ role: 'user', content: `${intro}${glossaryBlock(glossary)}${text}` });
  }
  const tr = await chatCompletion({ config, providerKey, body: { messages, temperature: 0.2, max_tokens: 2048 } });
  let vietnamese = (tr.choices?.[0]?.message?.content || '').trim();
  // Some models wrap the whole answer in quotes; drop them unless the
  // original paragraph is itself a quotation.
  if (!/^["“]/.test(text.trim()) && /^["“][\s\S]*["”]$/.test(vietnamese)) vietnamese = vietnamese.slice(1, -1).trim();
  if (!vietnamese) throw new Error('Mô hình không trả về bản dịch.');

  // --- 2. notes -----------------------------------------------------------
  const known = existingTerms.length ? existingTerms.join(', ') : '(none)';
  let notes = { phrases: [], new_words: [], citations: [], remarks_note: '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await chatCompletion({
      config,
      providerKey,
      body: {
        temperature: 0.2,
        max_tokens: 1500,
        messages: [
          { role: 'system', content: NOTES_SYSTEM },
          { role: 'user', content: `${context ? `${context} Give meanings as used in this field.\n\n` : ''}Known words (do not list): ${known}\n\nEnglish paragraph:\n${text}\n\nVietnamese translation:\n${vietnamese}` },
        ],
        tools: [{ type: 'function', function: { name: NOTES_TOOL, description: 'Vocabulary notes for one paragraph.', parameters: NOTES_SCHEMA } }],
        tool_choice: providerKey === 'lmstudio' ? 'required' : { type: 'function', function: { name: NOTES_TOOL } },
      },
      });
    } catch (err) {
      // A server without tool calling (vLLM started without
      // --tool-call-parser) cannot give notes: keep the translation.
      if (!/\b400\b[\s\S]*tool/i.test(err.message)) throw err;
      warnings.push('Máy chủ không hỗ trợ tool calling (vLLM cần --tool-call-parser): đã lưu bản dịch, chưa có ghi chú từ vựng.');
      break;
    }
    try {
      notes = JSON.parse(res.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments);
      break;
    } catch {
      // Guided decoding occasionally degenerates (see openAICompatAdapter);
      // retry once, then keep the translation without notes.
    }
  }

  // --- 3. citation --------------------------------------------------------
  const citationVi = citation.trim() ? await translatePlain({ text: citation.trim(), config, providerKey }) : '';

  // --- 4. bold both columns from the same item list -----------------------
  // Clause-length items are a small-model habit; as notes they explain
  // nothing and as bold spans they swallow whole sentences.
  const shortEnough = (i) => i?.term && i.term.trim().split(/\s+/).length <= 5 && i.term.length <= 40;
  // Then: nothing already in the learner's vocabulary, no two items for the
  // same word (conform / conforming), and a cap — on long paragraphs a small
  // model lists everything it can find.
  const knownTerms = new Set(existingTerms.map((k) => k.toLowerCase()));
  const seen = [];
  const keep = (i) => {
    const key = i.term.toLowerCase().trim();
    if (knownTerms.has(key) || relevantTerms(i.term, existingTerms).length > 0) return false;
    if (seen.some((s) => relevantTerms(s, [key]).length > 0 || relevantTerms(key, [s]).length > 0)) return false;
    seen.push(key);
    return true;
  };
  notes.new_words = (notes.new_words || []).filter(shortEnough).filter(keep).slice(0, 5);
  notes.phrases = (notes.phrases || []).filter(shortEnough).filter(keep).slice(0, 4);
  const items = [...notes.new_words, ...notes.phrases].filter((i) => i?.vi && i.vi.length <= 60);
  const { english, vietnamese: vietnameseMd } = boldPairs(text, vietnamese, items);

  return {
    english_md: english,
    vietnamese_md: vietnameseMd,
    phrases: (notes.phrases || []).map(({ vi: _vi, ...p }) => p),
    new_words: (notes.new_words || []).map(({ vi: _vi, ...w }) => ({ ...w, example: sentenceContaining(text, w.term) })),
    already_known: [],
    citations: notes.citations || [],
    remarks_note: notes.remarks_note || '',
    citation_vi_md: citationVi,
    ...(warnings.length ? { _pipeline: { warnings } } : {}),
  };
}

// --- bolding helpers -------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Regex for an English term in any inflection: each word's stem followed by
// optional letters ("subvert" finds "subverts", "primed for" finds "primed
// for", "pull at the heartstrings" finds "pulls at the heartstrings").
function englishTermRe(term) {
  const words = term.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || [];
  if (!words.length) return null;
  const parts = words.map((w) => {
    const stem = w.length > 4 ? w.replace(/(e|y|ies|es|s|ed|ing)$/, '') : w;
    return `${escapeRe(stem)}[a-z’'-]*`;
  });
  return new RegExp(`\\b${parts.join('\\s+')}\\b`, 'i');
}

function findSpan(text, re, taken) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  let m;
  while ((m = g.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!taken.some(([a, b]) => start < b && end > a)) return [start, end];
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return null;
}

function applyBold(text, spans) {
  let out = text;
  for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) {
    out = `${out.slice(0, a)}**${out.slice(a, b)}**${out.slice(b)}`;
  }
  return out;
}

// A Vietnamese rendering is usually a little longer than the English term,
// never a whole clause; a much longer span means the model pointed at the
// wrong part of the sentence (seen: a 5-word idiom matched to a 13-word clause).
function plausibleRendering(term, vi) {
  const enWords = term.trim().split(/\s+/).length;
  const viWords = vi.trim().split(/\s+/).length;
  return viWords <= Math.max(4, enWords * 2 + 1);
}

export function boldPairs(english, vietnamese, items) {
  const enTaken = [];
  const viTaken = [];
  // Longest first, so "attachment behavior" wins over "attachment".
  for (const item of [...items].sort((a, b) => b.term.length - a.term.length)) {
    const re = englishTermRe(item.term);
    const vi = item.vi.trim().replace(/^\*+|\*+$/g, '');
    if (!re || vi.length < 2 || !plausibleRendering(item.term, vi)) continue;
    const enSpan = findSpan(english, re, enTaken);
    const viSpan = findSpan(vietnamese, new RegExp(escapeRe(vi), 'i'), viTaken);
    if (enSpan && viSpan) {
      enTaken.push(enSpan);
      viTaken.push(viSpan);
    }
  }
  return { english: applyBold(english, enTaken), vietnamese: applyBold(vietnamese, viTaken) };
}

function sentenceContaining(text, term) {
  const re = englishTermRe(term);
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g) || [text];
  const hit = re && sentences.find((s) => re.test(s));
  return (hit || sentences[0]).trim().slice(0, 240);
}

// ---- bold alignment for an existing translation ----------------------------
// Rebuilds the bold marks of a paragraph from the terms in its notes, without
// touching the wording: the model only says which Vietnamese words translate
// each term, and boldPairs() marks a term where it is found in BOTH columns.
// Used to repair paragraphs whose English and Vietnamese bold disagree.

const ALIGN_TOOL = 'emit_term_alignment';
const ALIGN_SCHEMA = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: { type: 'object', properties: { term: { type: 'string' }, vi: { type: 'string' } }, required: ['term', 'vi'] },
    },
  },
  required: ['pairs'],
};

export async function alignBold({ english, vietnamese, terms, hints = [], config, providerKey }) {
  const plainEn = english.replace(/\*\*/g, '');
  const plainVi = vietnamese.replace(/\*\*/g, '');
  if (!terms.length) return { english: plainEn, vietnamese: plainVi, matched: 0 };

  const hintLine = hints.length ? `\nVietnamese phrases that were marked before (may help): ${hints.join(' | ')}` : '';
  let pairs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await chatCompletion({
      config,
      providerKey,
      body: {
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: `You align English terms with their Vietnamese translation. For each English term, find the words in the Vietnamese text that translate it, and copy them EXACTLY as they appear (same letters, accents and case), as short as possible (usually 1 to 6 words). If a term has no counterpart in the Vietnamese text, use an empty string. Call ${ALIGN_TOOL} once.`,
          },
          { role: 'user', content: `English:\n${plainEn}\n\nVietnamese:\n${plainVi}\n\nTerms:\n${terms.map((t) => `- ${t}`).join('\n')}${hintLine}` },
        ],
        tools: [{ type: 'function', function: { name: ALIGN_TOOL, description: 'Vietnamese counterpart of each term.', parameters: ALIGN_SCHEMA } }],
        tool_choice: providerKey === 'lmstudio' ? 'required' : { type: 'function', function: { name: ALIGN_TOOL } },
      },
    });
    try {
      pairs = JSON.parse(res.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments).pairs || [];
      break;
    } catch {
      // Degenerate guided decoding — retry once.
    }
  }

  // Only the requested terms: the model sometimes adds terms of its own,
  // which would bold words the notes never explain.
  const wanted = new Map(terms.map((t) => [t.toLowerCase().trim(), t]));
  const items = pairs
    .filter((p) => p?.term && p?.vi && p.vi.length <= 60 && wanted.has(p.term.toLowerCase().trim()))
    .map((p) => ({ term: wanted.get(p.term.toLowerCase().trim()), vi: p.vi }));
  const result = boldPairs(plainEn, plainVi, items);
  return { ...result, matched: (result.english.match(/\*\*/g) || []).length / 2 };
}

// Terms listed in a paragraph's notes ("- **term** …" lines).
export function termsFromNotes(...notes) {
  const terms = [];
  for (const md of notes) {
    for (const m of (md || '').matchAll(/^\s*-\s*\*\*([^*]+)\*\*/gm)) terms.push(m[1].trim());
  }
  return [...new Set(terms)];
}
