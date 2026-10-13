// What a book is about — its field, specialty and a short context note —
// as one line for AI prompts, so translations, word meanings and the
// assistant's answers use the terminology of that field (e.g. "attachment"
// is "sự gắn bó" in developmental psychology, not "tệp đính kèm").
import { db } from './db.js';

export const BOOK_CONTEXT_FIELDS = ['domain', 'specialty', 'context_note'];

const findBook = db.prepare('SELECT id, title_en, title_vi, author, domain, specialty, context_note FROM books WHERE id = ?');
const findBookOfParagraph = db.prepare(`
  SELECT c.book_id AS id FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id WHERE p.id = ?
`);

export const bookById = (id) => (id ? findBook.get(id) || null : null);
export const bookOfParagraph = (paragraphId) => bookById(findBookOfParagraph.get(paragraphId)?.id);

// "" when the book has no context filled in.
export function bookContextText(book, { language = 'vi' } = {}) {
  if (!book) return '';
  const parts = [];
  if (language === 'en') {
    if (book.domain?.trim()) parts.push(`Field: ${book.domain.trim()}`);
    if (book.specialty?.trim()) parts.push(`Specialty: ${book.specialty.trim()}`);
    if (book.context_note?.trim()) parts.push(`About the book: ${book.context_note.trim()}`);
    return parts.length ? `${parts.join('. ')}. Use the established Vietnamese terminology of this field.` : '';
  }
  if (book.domain?.trim()) parts.push(`Lĩnh vực: ${book.domain.trim()}`);
  if (book.specialty?.trim()) parts.push(`Chuyên môn: ${book.specialty.trim()}`);
  if (book.context_note?.trim()) parts.push(`Ngữ cảnh: ${book.context_note.trim()}`);
  return parts.length ? `${parts.join('. ')}. Dùng thuật ngữ tiếng Việt chuẩn của lĩnh vực này.` : '';
}
