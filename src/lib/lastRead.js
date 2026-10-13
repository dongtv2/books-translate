// Where the signed-in user stopped reading in each book — the chapter and,
// once they have scrolled, the paragraph. Stored per account on the server
// (/api/me/reading) so it follows the user across devices; kept here in
// memory so pages can read it synchronously while rendering.
import { api } from '../api.js';

const LEGACY_KEY = 'bt_last_read'; // browser-only storage used before accounts
let cache = new Map(); // bookId -> { chapterId, chapterTitle, paragraphId, at }

export async function loadReading() {
  const rows = await api.myReading().catch(() => []);
  cache = new Map(rows.map((r) => [r.bookId, {
    chapterId: r.chapterId, chapterTitle: r.chapterTitle, paragraphId: r.paragraphId || null,
    at: Date.parse(`${r.updatedAt.replace(' ', 'T')}Z`),
  }]));

  // One-time move of positions saved in this browser before accounts existed.
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
    for (const [bookId, entry] of Object.entries(legacy)) {
      if (!cache.has(Number(bookId)) && entry?.chapterId) {
        await api.saveReading(entry.chapterId).catch(() => {});
        cache.set(Number(bookId), { ...entry, paragraphId: null });
      }
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable: nothing to migrate.
  }
}

export function clearReading() {
  cache = new Map();
}

// Opening a chapter records the chapter; a paragraph is added as the reader
// scrolls. Re-opening the chapter they were already in keeps that paragraph.
export function recordLastRead({ bookId, chapterId, chapterTitle, paragraphId }) {
  const prev = cache.get(bookId);
  const keepParagraph = paragraphId === undefined && prev?.chapterId === chapterId ? prev.paragraphId : paragraphId ?? null;
  cache.set(bookId, { chapterId, chapterTitle, paragraphId: keepParagraph, at: Date.now() });
  api.saveReading(chapterId, keepParagraph).catch(() => {});
}

export function getLastRead(bookId) {
  return cache.get(Number(bookId)) || null;
}

// Link that reopens a reading position: the paragraph if known.
export function readingHref({ chapterId, paragraphId }) {
  return `/chapters/${chapterId}${paragraphId ? `#paragraph-${paragraphId}` : ''}`;
}
