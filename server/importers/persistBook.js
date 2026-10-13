import { db } from '../db.js';
import { normalizeTerm } from '../normalize.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const insertBook = db.prepare(`
  INSERT INTO books
    (title_en, title_vi, author, publisher, publish_date, original_year, isbn10, isbn13, page_count, format, language, rating, amazon_url, extra_json)
  VALUES (@title_en, @title_vi, @author, @publisher, @publish_date, @original_year, @isbn10, @isbn13, @page_count, @format, @language, @rating, @amazon_url, @extra_json)
`);
const insertPart = db.prepare('INSERT INTO parts (book_id, order_index, title) VALUES (?, ?, ?)');
const insertChapter = db.prepare('INSERT INTO chapters (book_id, part_id, order_index, title) VALUES (?, ?, ?, ?)');
const insertSection = db.prepare('INSERT INTO sections (chapter_id, order_index, heading) VALUES (?, ?, ?)');
const insertParagraph = db.prepare(`
  INSERT INTO paragraphs (section_id, order_index, english_md, vietnamese_md, phrases_verbs_md, vocabulary_md, remarks_note, status)
  VALUES (@section_id, @order_index, @english_md, @vietnamese_md, @phrases_verbs_md, @vocabulary_md, @remarks_note, @status)
`);
const insertVocab = db.prepare(`
  INSERT INTO vocabulary
    (term, term_normalized, ipa, word_type, meaning_vi, example, topic, topic_original, date_added, status, source_paragraph_id)
  VALUES (@term, @term_normalized, @ipa, @word_type, @meaning_vi, @example, @topic, @topic_original, @date_added, 'Đang học', @source_paragraph_id)
  ON CONFLICT(term_normalized) WHERE owner_id IS NULL DO NOTHING
`);

// Persists a { book, parts } tree (see docxImporter.js / textImporter.js) in
// one transaction: books -> parts -> chapters -> sections -> paragraphs,
// plus any already-typed vocabWords the source already carried (docx import
// only — these are human-authored, so they go straight into the tracked
// vocabulary table without needing a Claude call).
export function persistParsedBook({ book, parts }) {
  const run = db.transaction(() => {
    const bookInfo = insertBook.run({
      title_en: book.title_en || 'Sách chưa đặt tên',
      title_vi: book.title_vi || '',
      author: book.author || '',
      publisher: book.publisher || '',
      publish_date: book.publish_date || '',
      original_year: book.original_year || '',
      isbn10: book.isbn10 || '',
      isbn13: book.isbn13 || '',
      page_count: book.page_count || '',
      format: book.format || '',
      language: book.language || '',
      rating: book.rating || '',
      amazon_url: book.amazon_url || '',
      extra_json: JSON.stringify(book.extra_json || {}),
    });
    const bookId = bookInfo.lastInsertRowid;

    const dateAdded = todayISO();
    const seenNormalized = new Set(
      db.prepare('SELECT term_normalized FROM vocabulary WHERE owner_id IS NULL').all().map((r) => r.term_normalized)
    );

    let paragraphCount = 0;
    let vocabInsertedCount = 0;

    parts.forEach((part, partIndex) => {
      const partId = part.title ? insertPart.run(bookId, partIndex, part.title).lastInsertRowid : null;

      part.chapters.forEach((chapter, chapterIndex) => {
        const chapterId = insertChapter.run(bookId, partId, chapterIndex, chapter.title).lastInsertRowid;

        chapter.sections.forEach((section, sectionIndex) => {
          const sectionId = insertSection.run(chapterId, sectionIndex, section.heading || null).lastInsertRowid;

          section.paragraphs.forEach((paragraph, paragraphIndex) => {
            const paragraphId = insertParagraph.run({
              section_id: sectionId,
              order_index: paragraphIndex,
              english_md: paragraph.english_md,
              vietnamese_md: paragraph.vietnamese_md || '',
              phrases_verbs_md: paragraph.phrases_verbs_md || '',
              vocabulary_md: paragraph.vocabulary_md || '',
              remarks_note: paragraph.remarks_note || '',
              status: paragraph.status || 'pending',
            }).lastInsertRowid;
            paragraphCount += 1;

            for (const w of paragraph.vocabWords || []) {
              const term = (w.term || '').trim();
              if (!term) continue;
              const term_normalized = normalizeTerm(term);
              if (seenNormalized.has(term_normalized)) continue;
              seenNormalized.add(term_normalized);
              insertVocab.run({
                term,
                term_normalized,
                ipa: w.ipa || '',
                word_type: w.wordType,
                meaning_vi: w.meaning || '',
                example: paragraph.english_md.slice(0, 300),
                // Filed under a real topic by classifyTopics() after the import.
                topic: '',
                topic_original: section.heading || chapter.title || '',
                date_added: dateAdded,
                source_paragraph_id: paragraphId,
              });
              vocabInsertedCount += 1;
            }
          });
        });
      });
    });

    return { bookId, paragraphCount, vocabInsertedCount };
  });

  return run();
}
