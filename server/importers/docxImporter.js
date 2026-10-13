import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import { cellPlainText, cellToMd } from './htmlUtils.js';
import { parseRemarksCell } from './remarksParser.js';

const METADATA_LABELS = {
  'tiêu đề đầy đủ': 'title',
  'tác giả': 'author',
  'nhà xuất bản': 'publisher',
  'ngày xuất bản': 'publish_date',
  'năm xuất bản gốc': 'original_year',
  'isbn-10 / asin': 'isbn10',
  'isbn-10': 'isbn10',
  'asin': 'isbn10',
  'isbn-13': 'isbn13',
  'số trang': 'page_count',
  'định dạng': 'format',
  'ngôn ngữ': 'language',
  'đánh giá trên amazon': 'rating',
  'link amazon': 'amazon_url',
};

function directCells($, row) {
  return $(row).find('> th, > td').toArray();
}

function parseMetadataTable($, table) {
  const book = { title_en: '', title_vi: '', extra_json: {} };
  $(table)
    .find('> thead > tr, > tbody > tr, > tr')
    .each((_, row) => {
      const cells = directCells($, row);
      if (cells.length < 2) return;
      const label = cellPlainText($, cells[0]).replace(/:$/, '').trim().toLowerCase();
      const field = METADATA_LABELS[label];
      const valueCell = cells[1];

      if (field === 'title') {
        const ps = $(valueCell).children('p');
        if (ps.length >= 2) {
          book.title_en = cellPlainText($, ps[0]);
          book.title_vi = cellPlainText($, ps[1]);
        } else {
          book.title_en = cellPlainText($, valueCell);
        }
        return;
      }
      if (field === 'amazon_url') {
        const href = $(valueCell).find('a').attr('href');
        book.amazon_url = href || cellPlainText($, valueCell);
        return;
      }
      if (field) {
        book[field] = cellPlainText($, valueCell);
      } else if (label) {
        book.extra_json[cellPlainText($, cells[0])] = cellPlainText($, valueCell);
      }
    });
  return book;
}

function looksLikeMetadataTable($, table) {
  const rows = $(table).find('> thead > tr, > tbody > tr, > tr');
  if (rows.length === 0) return false;
  let twoColRows = 0;
  rows.each((_, row) => {
    if (directCells($, row).length === 2) twoColRows += 1;
  });
  return twoColRows === rows.length && rows.length >= 3;
}

function looksLikeParagraphTable($, table) {
  const rows = $(table).find('> thead > tr, > tbody > tr, > tr');
  return rows.length > 0 && directCells($, rows[0]).length === 3;
}

function parseParagraphTable($, table) {
  const rows = $(table).find('> thead > tr, > tbody > tr, > tr').toArray();
  const paragraphs = [];
  rows.forEach((row, i) => {
    const cells = directCells($, row);
    if (cells.length < 3) return;
    const englishMd = cellToMd($, cells[0]);
    if (i === 0 && /^english$/i.test(cellPlainText($, cells[0]))) return; // header row
    if (!englishMd) return;

    const vietnameseMd = cellToMd($, cells[1]);
    const remarks = parseRemarksCell($, cells[2]);

    paragraphs.push({
      english_md: englishMd,
      vietnamese_md: vietnameseMd,
      phrases_verbs_md: remarks.phrasesVerbsMd,
      vocabulary_md: remarks.vocabularyMd,
      remarks_note: remarks.remarksNote,
      status: vietnameseMd ? 'translated' : 'pending',
      vocabWords: remarks.vocabWords,
    });
  });
  return paragraphs;
}

// Converts a mammoth-produced HTML document into { book, parts } where
// parts is [{ title, chapters: [{ title, sections: [{ heading, paragraphs }] }] }].
// Chapters with no preceding <h1> land in a synthetic part (title: null) so
// callers can decide whether to render a part heading at all.
export function parseBookHtml(html) {
  const $ = cheerio.load(html);
  const nodes = $('body').children().toArray();

  let book = { title_en: '', title_vi: '', extra_json: {} };
  const parts = [];
  let currentPart = null;
  let currentChapter = null;
  let currentSection = null;
  let metadataConsumed = false;

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

  for (const node of nodes) {
    const tag = node.tagName?.toLowerCase();

    if (tag === 'table') {
      if (!metadataConsumed && looksLikeMetadataTable($, node)) {
        book = parseMetadataTable($, node);
        metadataConsumed = true;
        continue;
      }
      metadataConsumed = true;
      if (looksLikeParagraphTable($, node)) {
        const section = ensureSection();
        section.paragraphs.push(...parseParagraphTable($, node));
      }
      continue;
    }

    metadataConsumed = true;

    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const headingText = $(node).text().trim();
      // Word docs sometimes carry empty Heading-styled paragraphs as visual
      // spacers/bookmarks — skip them rather than starting a nameless
      // part/chapter/section.
      if (!headingText) continue;

      if (tag === 'h1') {
        currentPart = { title: headingText, chapters: [] };
        parts.push(currentPart);
        currentChapter = null;
        currentSection = null;
      } else if (tag === 'h2') {
        const part = ensurePart();
        currentChapter = { title: headingText, sections: [] };
        part.chapters.push(currentChapter);
        currentSection = null;
      } else {
        const chapter = ensureChapter();
        currentSection = { heading: headingText, paragraphs: [] };
        chapter.sections.push(currentSection);
      }
    } else if (tag === 'p') {
      const text = $(node).text().trim();
      if (!text) continue;
      const section = ensureSection();
      section.paragraphs.push({
        english_md: text,
        vietnamese_md: '',
        phrases_verbs_md: '',
        vocabulary_md: '',
        remarks_note: '',
        status: 'pending',
        vocabWords: [],
      });
    }
  }

  // Drop sections/chapters/parts that ended up empty (e.g. a lone heading
  // with no table content following it before the next heading).
  for (const part of parts) {
    part.chapters = part.chapters.filter((c) => c.sections.some((s) => s.paragraphs.length > 0));
    for (const chapter of part.chapters) {
      chapter.sections = chapter.sections.filter((s) => s.paragraphs.length > 0);
    }
  }
  const nonEmptyParts = parts.filter((p) => p.chapters.length > 0);

  return { book, parts: nonEmptyParts };
}

export async function parseDocxBuffer(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return parseBookHtml(html);
}
