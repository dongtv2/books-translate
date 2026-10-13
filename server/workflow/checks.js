// Checks on a translation that need no model call: what a reader would catch
// at a glance. The translate-paragraph graph runs them after every draft and
// repair (cheap first, the model only to fix what they find); the A/B
// comparison (compare.js) scores both pipelines with them.
//
// Each issue: { type, detail, severity }. Types the graph knows how to repair:
//   empty        no Vietnamese at all
//   short        far shorter than the English (sentences dropped)
//   sentences    fewer sentences than the English
//   extra        much longer / more sentences than the English (added text)
//   glossary     a decided term (glossary) not translated the decided way
//   untranslated English words left in the Vietnamese
//   citation     the citation was not translated
//   bold         the two columns bold a different number of terms
import { plainText } from '../../src/lib/inlineMarkdown.js';
import { containsTerm } from '../../src/lib/vocabMatch.js';

export const SEVERITY = { empty: 100, short: 12, extra: 10, sentences: 8, glossary: 6, citation: 5, untranslated: 3, bold: 1 };

const sentenceCount = (text) => (text.match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)/g) || []).filter((s) => /\p{L}{2,}/u.test(s)).length;
const fold = (s) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
const boldCount = (s) => ((s || '').match(/\*\*[^*]+\*\*/g) || []).length;

// English words the Vietnamese may keep: names, the term in brackets after
// its translation ("sự gắn bó (attachment)"), numbers, abbreviations.
function leftoverEnglish(english, vietnamese) {
  const withoutBrackets = vietnamese.replace(/\([^)]*\)/g, ' ');
  const enWords = new Set((english.match(/[A-Za-z][a-z'’-]{3,}/g) || []).filter((w) => w === w.toLowerCase()).map((w) => w.toLowerCase()));
  // Vietnamese words written with plain Latin letters only (no diacritics) that
  // are also words of the English text.
  return [...new Set((withoutBrackets.match(/(?<![\p{L}])[a-z][a-z'’-]{3,}(?![\p{L}])/gu) || []).filter((w) => enWords.has(w)))];
}

// `draft`: { english_md, vietnamese_md, citation_vi_md }; `paragraph`: the
// source row; `glossary`: decided entries that occur in the paragraph.
export function checkTranslation(draft, paragraph, glossary = []) {
  const issues = [];
  const en = plainText(paragraph.english_md || '');
  const vi = plainText(draft?.vietnamese_md || '');
  if (!vi.trim()) return [{ type: 'empty', detail: 'Chưa có bản dịch.', severity: SEVERITY.empty }];

  // Vietnamese runs about as long as the English or longer; far shorter
  // means something was dropped.
  const ratio = vi.length / Math.max(1, en.length);
  if (en.length > 120 && ratio < 0.7) {
    issues.push({ type: 'short', detail: `Bản dịch chỉ dài ${Math.round(ratio * 100)}% bản gốc — có thể sót câu.`, severity: SEVERITY.short });
  }
  const enS = sentenceCount(en);
  const viS = sentenceCount(vi);
  // A small model sometimes adds sentences (often the example it was shown).
  if (en.length > 120 && (ratio > 1.9 || (enS >= 3 && viS > enS + Math.max(2, Math.ceil(enS * 0.3))))) {
    issues.push({ type: 'extra', detail: `Bản dịch dài bất thường (${Math.round(ratio * 100)}% bản gốc, ${viS}/${enS} câu) — có thể thêm câu không có trong bản gốc.`, severity: SEVERITY.extra, en: enS, vi: viS });
  }
  // Translators may join two sentences; losing more than that is a gap.
  if (enS >= 3 && viS < enS - Math.max(1, Math.floor(enS * 0.25))) {
    issues.push({ type: 'sentences', detail: `Bản gốc ${enS} câu, bản dịch ${viS} câu.`, severity: SEVERITY.sentences, en: enS, vi: viS });
  }

  const viFold = fold(vi);
  for (const g of glossary) {
    if (!containsTerm(en, g.term)) continue;
    // Any of the alternatives the team wrote ("sự gắn bó / gắn bó") counts.
    // A leading "sự", "việc"… is grammar, not the term: "nuôi dạy con" counts
    // for "việc nuôi dạy con".
    const options = g.meaning_vi.split(/[;/,]| hoặc /)
      .map((s) => fold(s.replace(/\([^)]*\)/g, '').trim()).replace(/^(sự|việc|những|các|một|tính|có)\s+/, ''))
      .filter((s) => s.length > 1);
    if (options.length && !options.some((o) => viFold.includes(o))) {
      issues.push({ type: 'glossary', detail: `“${g.term}” phải dịch là “${g.meaning_vi}”.`, severity: SEVERITY.glossary, term: g.term, meaning: g.meaning_vi });
    }
  }

  const left = leftoverEnglish(en, vi);
  if (left.length >= 2 || (left.length === 1 && left[0].length > 6)) {
    issues.push({ type: 'untranslated', detail: `Còn từ tiếng Anh chưa dịch: ${left.slice(0, 6).join(', ')}.`, severity: SEVERITY.untranslated, words: left });
  }

  if (paragraph.citation_en_md?.trim() && plainText(draft.citation_vi_md || '').replace(/[\s"“”]/g, '').length < 3) {
    issues.push({ type: 'citation', detail: 'Phần trích dẫn chưa được dịch.', severity: SEVERITY.citation });
  }

  const be = boldCount(draft.english_md);
  const bv = boldCount(draft.vietnamese_md);
  if (be !== bv) issues.push({ type: 'bold', detail: `Bôi đậm lệch: ${be} cụm ở bản Anh, ${bv} ở bản Việt.`, severity: SEVERITY.bold });

  return issues;
}

export const issueScore = (issues) => issues.reduce((n, i) => n + i.severity, 0);
