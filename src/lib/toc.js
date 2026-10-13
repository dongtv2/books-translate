// The standard table of contents (server/toc.js) on the client: a book's
// chapters grouped into front matter, the body (parts, then chapters outside
// any part) and back matter, in reading order.
export const KIND_OPTIONS = [
  { value: 'front', label: 'Phần đầu sách (lời tựa, giới thiệu…)' },
  { value: 'chapter', label: 'Chương (đánh số)' },
  { value: 'back', label: 'Phần cuối sách (phụ lục, thuật ngữ…)' },
];

export function tocGroups(book) {
  const loose = book?.chaptersWithoutPart || [];
  return {
    front: loose.filter((c) => c.kind === 'front'),
    parts: book?.parts || [],
    body: loose.filter((c) => !c.kind || c.kind === 'chapter'),
    back: loose.filter((c) => c.kind === 'back'),
  };
}

// A title as the book prints it in its TOC: "Chapter 3: Why We’ve Come
// Undone", or the bare title when the book does not number (label null).
export const withLabel = (label, title) => (label && title ? `${label}: ${title}` : title || '');

// The book's numbering styles (server/toc.js NUMBERING).
export const NUMBERING_OPTIONS = [
  { value: 'words', label: 'Part One · Chapter 1' },
  { value: 'numeric', label: 'Part 1 · Chapter 1' },
  { value: 'none', label: 'Không đánh số' },
];
