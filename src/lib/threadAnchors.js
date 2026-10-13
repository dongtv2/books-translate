// Where a term discussion sits in a paragraph column, in plain-text offsets
// (the text RichText renders: inlineMarkdown's runs joined, which is also the
// column's DOM textContent in reading mode).
import { findTerms } from './vocabMatch.js';

// Threads on several words or more are about a passage, not a term.
export const isPassage = (term) => (term || '').trim().split(/\s+/).length > 6;

// { start, end } of the thread in `text`, or null. Tries, in order: the
// stored place if the text there is unchanged; the stored text nearest the
// stored place (the paragraph was edited around it); the term itself
// (inflections included for English); a case-insensitive search.
export function locateThread(text, t) {
  if (!text) return null;
  const anchor = t.anchor_text || '';
  if (anchor && t.anchor_start != null && text.slice(t.anchor_start, t.anchor_start + anchor.length) === anchor) {
    return { start: t.anchor_start, end: t.anchor_start + anchor.length };
  }
  if (anchor) {
    let best = -1;
    for (let i = text.indexOf(anchor); i >= 0; i = text.indexOf(anchor, i + 1)) {
      if (best < 0 || Math.abs(i - (t.anchor_start ?? 0)) < Math.abs(best - (t.anchor_start ?? 0))) best = i;
    }
    if (best >= 0) return { start: best, end: best + anchor.length };
  }
  if (t.side !== 'vi' && !isPassage(t.term)) {
    const m = findTerms(text, [{ id: t.id, term: t.term }])[0];
    if (m) return { start: m.start, end: m.end };
  }
  const i = text.toLowerCase().indexOf((t.term || '').toLowerCase());
  return i >= 0 && t.term ? { start: i, end: i + t.term.length } : null;
}

// The sentence(s) around [start, end): the context the words are read in.
export function sentenceAround(text, start, end) {
  let from = 0;
  const re = /[.!?…]+["”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(text)) && m.index + m[0].length <= start) from = m.index + m[0].length;
  // The first sentence end at or after the picked text (which may itself
  // end with the full stop).
  re.lastIndex = from;
  while ((m = re.exec(text)) && m.index + m[0].length < end);
  const to = m ? m.index + m[0].length : text.length;
  return { start: from, end: to };
}

// Plain-text offset of a DOM position inside `root`.
export function offsetIn(root, node, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

// A DOM Range over plain-text offsets [start, end) inside `root`.
export function rangeIn(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.data.length;
    if (!startSet && start <= pos + len) { range.setStart(n, start - pos); startSet = true; }
    if (startSet && end <= pos + len) { range.setEnd(n, end - pos); return range; }
    pos += len;
  }
  return startSet ? range : null;
}
