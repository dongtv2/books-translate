// Tiny pub/sub so the persistent Sidebar's book ToC (fetched independently
// of BookPage/ChapterPage) can refresh itself the moment a part/chapter/
// section is added, renamed, moved or deleted elsewhere — no page reload.
const EVENT_NAME = 'booktranslate:book-changed';

export function notifyBookChanged() {
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function onBookChanged(handler) {
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

// Lets ChapterPage report which section heading is currently scrolled into
// view, so the persistent Sidebar's ToC can highlight the matching entry —
// otherwise the sidebar (a route sibling, not a parent/child of ChapterPage)
// has no way to know.
const ACTIVE_SECTION_EVENT = 'booktranslate:active-section-changed';

export function notifyActiveSection(sectionId) {
  window.dispatchEvent(new CustomEvent(ACTIVE_SECTION_EVENT, { detail: { sectionId } }));
}

export function onActiveSectionChanged(handler) {
  const listener = (e) => handler(e.detail.sectionId);
  window.addEventListener(ACTIVE_SECTION_EVENT, listener);
  return () => window.removeEventListener(ACTIVE_SECTION_EVENT, listener);
}

// Fired after a vocabulary word is graded so the Sidebar's "due today" count
// beside "Ôn tập" drops immediately instead of waiting for the next navigation.
const REVIEW_EVENT = 'booktranslate:review-changed';

export function notifyReviewChanged() {
  window.dispatchEvent(new Event(REVIEW_EVENT));
}

export function onReviewChanged(handler) {
  window.addEventListener(REVIEW_EVENT, handler);
  return () => window.removeEventListener(REVIEW_EVENT, handler);
}

// Fired when term discussions were read or changed, so the Sidebar's badge
// beside "Thảo luận" follows.
const DISCUSSIONS_EVENT = 'booktranslate:discussions-changed';

export function notifyDiscussionsChanged() {
  window.dispatchEvent(new Event(DISCUSSIONS_EVENT));
}

export function onDiscussionsChanged(handler) {
  window.addEventListener(DISCUSSIONS_EVENT, handler);
  return () => window.removeEventListener(DISCUSSIONS_EVENT, handler);
}
