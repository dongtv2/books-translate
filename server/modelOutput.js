// Cleans a model's translation result before it is saved. The app stores
// and renders a tiny markdown subset (**bold**, *italic*), but smaller
// models — Llama 3.1 8B on Metta-AI-Server in particular — sometimes answer
// in HTML (<p>, <b>…</b>), rewrite the English they were told to copy, or
// pad the notes with items that are not in the paragraph at all (often
// lifted from the examples in the prompt). Each of those reached the page
// as-is before; this is the single place that catches them.
import { relevantTerms } from './normalize.js';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

// HTML emphasis → the app's markdown; every other tag is dropped.
export function htmlToMarkdown(text) {
  if (!text || !/[<&]/.test(text)) return text || '';
  return text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>\s*<\s*p[^>]*>/gi, '\n\n')
    .replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, '**$2**')
    .replace(/<\s*(i|em)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, '*$2*')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m])
    .trim();
}

// Neighbouring bold words become one bold phrase:
// "**attachment** **behavior**" → "**attachment behavior**".
export function mergeAdjacentBold(text) {
  return (text || '').replace(/\*\*([^*]+)\*\*(\s+)\*\*([^*]+)\*\*/g, (_m, a, sp, b) => `**${a}${sp}${b}**`)
    .replace(/\*\*([^*]+)\*\*(\s+)\*\*([^*]+)\*\*/g, (_m, a, sp, b) => `**${a}${sp}${b}**`);
}

function letters(text) {
  return (text || '').replace(/[*"“”]/g, '').replace(/\s+/g, ' ').trim();
}

function occursIn(paragraph, term) {
  if (!term) return false;
  if (paragraph.toLowerCase().includes(term.toLowerCase().trim())) return true;
  return relevantTerms(paragraph, [term]).length > 0;
}

export function cleanTranslationResult(result, originalEnglish, citationEnglish = '') {
  const clean = (s) => mergeAdjacentBold(htmlToMarkdown(s));
  const english = clean(result.english_md);

  // english_md must be the original text with only ** added. If the model
  // changed the words, keep the original (unbolded) rather than a rewrite.
  const englishOk = english && letters(english) === letters(originalEnglish);

  const cleanItem = (item, keys) => {
    const out = { ...item };
    for (const k of keys) if (typeof out[k] === 'string') out[k] = htmlToMarkdown(out[k]).replace(/\*\*/g, '');
    return out;
  };

  // When the English has to fall back to the unbolded original, the
  // Vietnamese bold can no longer be matched against it — drop it too, so the
  // two columns never disagree (the caller can re-align them; see alignBold).
  const vietnamese = clean(result.vietnamese_md);
  return {
    ...result,
    english_md: englishOk ? english : originalEnglish,
    vietnamese_md: englishOk ? vietnamese : vietnamese.replace(/\*\*/g, ''),
    remarks_note: htmlToMarkdown(result.remarks_note || '').replace(/\*\*/g, ''),
    citation_vi_md: citationEnglish.trim() ? clean(result.citation_vi_md || '') : '',
    phrases: (result.phrases || [])
      .map((p) => cleanItem(p, ['term', 'meaning_vi']))
      .filter((p) => p.term && p.meaning_vi && occursIn(originalEnglish, p.term)),
    new_words: (result.new_words || [])
      .map((w) => cleanItem(w, ['term', 'ipa', 'meaning_vi', 'example', 'topic']))
      .filter((w) => w.term && occursIn(originalEnglish, w.term)),
    citations: (result.citations || [])
      .map((c) => cleanItem(c, ['source', 'note']))
      .filter((c) => c.source && c.note && occursIn(`${originalEnglish}\n${citationEnglish}`, c.source)),
  };
}
