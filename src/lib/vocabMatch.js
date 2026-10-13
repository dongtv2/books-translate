// Finds vocabulary entries in running English text, tolerant of the ways a
// word appears in a sentence: inflections ("attach" matches "attached",
// "attaching"), capitalisation, and the placeholders phrase entries are
// stored with ("turn against someone", "lose one's temper").
//
// Shared by the server (which picks the entries that occur in a chapter, see
// routes/chapters.js) and the reader (which marks them in the English
// column), so both agree on what counts as a match. Plain JS, no JSX.

// A placeholder stands for one to three words ("bring … back into" matches
// "bring our children back into").
const SLOT = "[\\w'’-]+(?:\\s+[\\w'’-]+){0,2}";
const PLACEHOLDERS = {
  someone: SLOT, somebody: SLOT, something: SLOT, sb: SLOT, sth: SLOT, '…': SLOT, '...': SLOT,
  "someone's": SLOT, "one's": "(?:my|your|his|her|its|our|their|one's|one’s)", oneself: '\\w+sel(?:f|ves)',
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every common inflection of one word, as a regex alternation.
function wordForms(word) {
  const w = word.toLowerCase();
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return escape(w);
  const forms = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}d`, `${w}ing`, `${w}'s`, `${w}’s`]);
  if (w.endsWith('e')) forms.add(`${w.slice(0, -1)}ing`);
  if (/[^aeiou]y$/.test(w)) { forms.add(`${w.slice(0, -1)}ies`); forms.add(`${w.slice(0, -1)}ied`); }
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(w)) { forms.add(`${w}${w.at(-1)}ed`); forms.add(`${w}${w.at(-1)}ing`); }
  // Entries stored inflected ("embittered", "startling") also match the base
  // spelling's other forms only via their own list; that is enough here.
  return [...forms].sort((a, b) => b.length - a.length).map(escape).join('|');
}

const cache = new Map();

// The regex for one entry, or null when the term is too short or too generic
// to mark without noise.
export function termRegex(term) {
  if (cache.has(term)) return cache.get(term);
  const words = String(term || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(to) attach" → "attach"
    .replace(/\s*(\.{3}|…)\s*/g, ' … ')
    .split(/[\s/]+/)
    .map((x) => (PLACEHOLDERS[x] ? x : x.replace(/^[^\w']+|[^\w']+$/g, '')))
    .filter(Boolean);
  let re = null;
  const letters = words.filter((x) => !PLACEHOLDERS[x]).join('').length;
  if (words.length && letters >= 3 && words.length <= 8) {
    const parts = words.map((x) => (PLACEHOLDERS[x] ? PLACEHOLDERS[x] : `(?:${wordForms(x)})`));
    re = new RegExp(`(?<![\\w'’])${parts.join("[\\s,'’-]+")}(?![\\w])`, 'gi');
  }
  cache.set(term, re);
  return re;
}

// Non-overlapping matches of `entries` ({ id, term }) in `text`, longest
// first where two overlap, in reading order: [{ start, end, id }].
export function findTerms(text, entries) {
  if (!text || !entries?.length) return [];
  const found = [];
  for (const e of entries) {
    const re = termRegex(e.term);
    if (!re) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      found.push({ start: m.index, end: m.index + m[0].length, id: e.id });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  found.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const f of found) {
    if (!taken.some((t) => f.start < t.end && t.start < f.end)) taken.push(f);
  }
  return taken.sort((a, b) => a.start - b.start);
}

// Whether `term` occurs anywhere in `text` (server-side pre-filter).
export function containsTerm(text, term) {
  const re = termRegex(term);
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
}
