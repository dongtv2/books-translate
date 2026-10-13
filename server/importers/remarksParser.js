import { inlineNodeToMd } from './htmlUtils.js';
import { mapWordType } from '../wordTypes.js';

const HEADER_PATTERNS = [
  [/^phrases?\s*(&|and)\s*verbs?:?$/i, 'phrases'],
  [/^vocabulary:?$/i, 'vocabulary'],
  [/^remarks?:?$/i, 'remarks'],
];

// Matches lines like "- **Hunch over** /hʌntʃ ˈoʊvər/ (phrasal verb): Khom lưng..."
// or "**ubiquitous** (adj): phổ biến khắp nơi" (IPA optional).
const TERM_LINE_RE = /^-?\s*\*\*(.+?)\*\*\s*(\/[^/]+\/)?\s*\(([^)]+)\):\s*(.+)$/;

function classifyTermLine(line) {
  const m = line.match(TERM_LINE_RE);
  if (!m) return null;
  const [, term, ipaRaw, typeRaw, meaning] = m;
  return {
    term: term.trim(),
    ipa: ipaRaw ? ipaRaw.trim() : '',
    wordType: mapWordType(typeRaw),
    meaning: meaning.trim(),
  };
}

// Parses the third ("Phrase & Remark") table cell of an imported book,
// which shows up in the source docx in two different human-written shapes:
//   1. legacy flat list: "- **Term** /ipa/ (type): nghĩa" per line
//   2. grouped format: "Phrases & Verbs:" / "Vocabulary:" / "Remarks:" blocks
// Returns structured data ready to render into phrases_verbs_md /
// vocabulary_md / remarks_note, plus a vocabWords[] array of entries with a
// recognized word type — those are the ones worth inserting into the
// tracked vocabulary table directly (no LLM call needed, already human-authored).
export function parseRemarksCell($, cell) {
  let bucket = null;
  const phrasesLines = [];
  const vocabLines = [];
  const remarksLines = [];
  const vocabWords = [];

  function addTermLine(rawLine, targetBucket) {
    const cleaned = rawLine.replace(/^-\s*/, '').trim();
    const parsed = classifyTermLine(cleaned);
    if (!parsed) {
      (targetBucket === 'vocabulary' ? vocabLines : phrasesLines).push(`- ${cleaned}`);
      return;
    }
    if (targetBucket === 'vocabulary' || (targetBucket === null && parsed.wordType)) {
      vocabLines.push(`- **${parsed.term}**${parsed.ipa ? ` ${parsed.ipa}` : ''} (${parsed.wordType || 'Noun'}): ${parsed.meaning}`);
      if (parsed.wordType) {
        vocabWords.push({ term: parsed.term, ipa: parsed.ipa, wordType: parsed.wordType, meaning: parsed.meaning });
      }
    } else {
      phrasesLines.push(`- **${parsed.term}**: ${parsed.meaning}`);
    }
  }

  $(cell)
    .children()
    .each((_, el) => {
      const tag = el.tagName?.toLowerCase();
      if (tag === 'p') {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text) return; // spacer paragraph
        const header = HEADER_PATTERNS.find(([re]) => re.test(text));
        if (header) {
          bucket = header[1];
          return;
        }
        const md = inlineNodeToMd($, el).trim().replace(/\s+/g, ' ');
        if (/^-?\s*\*\*/.test(md)) {
          addTermLine(md, null); // legacy dash-bullet line, classify by parsed type
          return;
        }
        if (bucket === 'remarks') remarksLines.push(md);
        else if (bucket === 'phrases') phrasesLines.push(`- ${md}`);
        else if (bucket === 'vocabulary') addTermLine(md, 'vocabulary');
        else remarksLines.push(md);
      } else if (tag === 'ul' || tag === 'ol') {
        $(el)
          .children('li')
          .each((_, li) => {
            const md = inlineNodeToMd($, li).trim();
            if (!md) return;
            if (bucket === 'vocabulary') addTermLine(md, 'vocabulary');
            else addTermLine(md, 'phrases');
          });
      }
    });

  return {
    phrasesVerbsMd: phrasesLines.join('\n'),
    vocabularyMd: vocabLines.join('\n'),
    remarksNote: remarksLines.join('\n\n'),
    vocabWords,
  };
}
