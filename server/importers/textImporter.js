// Heuristic importer for plain pasted text (no docx structure to lean on).
// Recognizes "PART ...", "CHAPTER ..." (or Vietnamese "PHẦN"/"CHƯƠNG") lines
// as Part/Chapter boundaries, and short ALL-CAPS lines as section headings —
// everything else is grouped into paragraphs at blank-line boundaries.
import { isKindleCitation } from './citationCleanup.js';

function detectHeading(line) {
  if (/^(part|ph[aầ]n)\s+/i.test(line)) return { type: 'part', title: line };
  if (/^(chapter|ch[uư][oơ]ng)\s+/i.test(line)) return { type: 'chapter', title: line };
  if (line.length >= 3 && line.length <= 100) {
    const letters = line.replace(/[^a-zA-ZÀ-ỹ]/g, '');
    const hasLower = /[a-zà-ỹ]/.test(letters);
    const wordCount = line.split(/\s+/).length;
    if (letters.length >= 3 && !hasLower && wordCount <= 14 && !/[.?!]$/.test(line)) {
      return { type: 'section', title: line };
    }
  }
  return null;
}

export function parseBookText(rawText, meta = {}) {
  const book = {
    title_en: meta.title_en || '',
    title_vi: meta.title_vi || '',
    author: meta.author || '',
    publisher: meta.publisher || '',
    publish_date: meta.publish_date || '',
    original_year: meta.original_year || '',
    isbn10: meta.isbn10 || '',
    isbn13: meta.isbn13 || '',
    page_count: meta.page_count || '',
    format: meta.format || '',
    language: meta.language || '',
    rating: meta.rating || '',
    amazon_url: meta.amazon_url || '',
    extra_json: {},
  };

  const parts = [];
  let currentPart = null;
  let currentChapter = null;
  let currentSection = null;
  const paragraphBuffer = [];

  function ensurePart() {
    if (!currentPart) {
      currentPart = { title: null, chapters: [] };
      parts.push(currentPart);
    }
    return currentPart;
  }
  function ensureChapter() {
    if (!currentChapter) {
      const part = ensurePart();
      currentChapter = { title: 'Chương 1', sections: [] };
      part.chapters.push(currentChapter);
    }
    return currentChapter;
  }
  function ensureSection() {
    if (!currentSection) {
      const chapter = ensureChapter();
      currentSection = { heading: null, paragraphs: [] };
      chapter.sections.push(currentSection);
    }
    return currentSection;
  }
  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join(' ').replace(/\s+/g, ' ').trim();
    paragraphBuffer.length = 0;
    if (!text || isKindleCitation(text)) return;
    ensureSection().paragraphs.push({
      english_md: text,
      vietnamese_md: '',
      phrases_verbs_md: '',
      vocabulary_md: '',
      remarks_note: '',
      status: 'pending',
      vocabWords: [],
    });
  }

  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = detectHeading(line);
    if (heading) {
      flushParagraph();
      if (heading.type === 'part') {
        currentPart = { title: heading.title, chapters: [] };
        parts.push(currentPart);
        currentChapter = null;
        currentSection = null;
      } else if (heading.type === 'chapter') {
        const part = ensurePart();
        currentChapter = { title: heading.title, sections: [] };
        part.chapters.push(currentChapter);
        currentSection = null;
      } else {
        const chapter = ensureChapter();
        currentSection = { heading: heading.title, paragraphs: [] };
        chapter.sections.push(currentSection);
      }
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraph();

  for (const part of parts) {
    part.chapters = part.chapters.filter((c) => c.sections.some((s) => s.paragraphs.length > 0));
    for (const chapter of part.chapters) {
      chapter.sections = chapter.sections.filter((s) => s.paragraphs.length > 0);
    }
  }
  const nonEmptyParts = parts.filter((p) => p.chapters.length > 0);

  return { book, parts: nonEmptyParts };
}
