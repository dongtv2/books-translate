// Lightweight normalization used as a safety-net dedupe check on the server.
// The smart "same root word" judgement (alienate/alienated/alienating) is
// primarily done by Claude (it has full context), but we still run every
// candidate through this before INSERT so a missed case never creates a
// duplicate row in the vocabulary table.

// "stopped" / "running" → "stop" / "run"; doubled l, s, z belong to the
// word itself ("falling", "passing").
function undouble(stem) {
  return stem.length > 2 && stem.at(-1) === stem.at(-2) && /[bdgmnprt]/.test(stem.at(-1)) ? stem.slice(0, -1) : stem;
}

function stripInflections(word) {
  const w = word;
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ied')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) {
    return undouble(w.slice(0, -3));
  }
  if (w.length > 4 && w.endsWith('ed')) {
    return undouble(w.slice(0, -2));
  }
  // "boxes", "watches" lose -es; "makes", "techniques" only the -s.
  if (w.length > 4 && /(?:[sxz]|[cs]h)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// Bump when normalizeTerm() changes: db.js re-keys every stored term (and
// merges entries that now share a key) once per version.
export const NORMALIZE_VERSION = 4;

// One word's key: inflection stripped, then a final silent "e" dropped so
// the dictionary form meets its inflections (impose / imposed / imposing →
// "impos"). Short words keep their "e": fad and fade, car and care are
// different words, which matters more than catching "faded".
function wordKey(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  const stem = stripInflections(word);
  return stem.length >= 6 && stem.endsWith('e') ? stem.slice(0, -1) : stem;
}

// Stand-ins a phrase is stored with ("lose one's temper", "turn against
// someone", "bring … back") are left out of the key: "take something for
// granted" and "take for granted" are one entry.
const SLOTS = new Set(['someone', 'somebody', 'something', 'sb', 'sth', "someone's", "somebody's", "one's", 'oneself', '…', '...']);

// The dedupe key of a vocabulary term: case, curly quotes, hyphens versus
// spaces, a "(to)" prefix, placeholders and every word's inflection are all
// ignored, so "Peer-oriented", "peer oriented", "adults"/"adult" and
// "lose one's temper"/"lose someone's temper"/"lose temper" share a key. The table has a
// unique index on it (db.js), so one key is one entry.
export function normalizeTerm(raw) {
  const cleaned = String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[-–—/]/g, ' ')
    .replace(/\.{3}|…/g, ' … ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-z0-9…]+|[^a-z0-9…]+$/g, '');

  return cleaned
    .split(' ')
    .map((w) => (SLOTS.has(w) ? '' : wordKey(w.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '').replace(/'s$/, ''))))
    .filter(Boolean)
    .join(' ');
}

// Words too common to say anything about whether a multi-word term occurs
// in a paragraph ("put up with the noise" should match on put/noise, not
// on up/with/the).
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'up', 'out', 'off', 'into',
  'and', 'or', 'as', 'is', 'be', 'it', 'its', 'his', 'her', 'their', 'your', 'my', 'our', 'one', "one's",
  'someone', 'something', 'sb', 'sth', 'that', 'this',
]);

function wordsOf(text) {
  return text.toLowerCase().normalize('NFKC').match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) || [];
}

// True when two lower-case words are the same word in different inflections
// (subvert / subverts / subverted / subverting, carry / carried, make /
// making). Deliberately not built on stripInflections() above: that one
// only has to be self-consistent for dedupe keys, whereas here a dictionary
// form has to meet whatever form the paragraph happens to use.
function sameRoot(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || long.length - short.length > 3) return false;
  const base = /[ey]$/.test(short) ? short.slice(0, -1) : short;
  return long.startsWith(base);
}

// Picks the vocabulary terms that could actually occur in `text`, so the
// model is told about those few instead of the whole vocabulary on every
// call (hundreds of terms cost thousands of prompt tokens per paragraph).
// A single-word term matches when some word of the paragraph shares its
// root; a multi-word term matches when every content word of it does.
// Over-inclusion is harmless — the model decides what is really "already
// known", and the server's own dedupe on INSERT still checks against the
// full vocabulary.
export function relevantTerms(text, terms) {
  const paragraphWords = new Set();
  for (const word of wordsOf(text.replace(/\*/g, ''))) {
    paragraphWords.add(word);
    for (const part of word.split(/['’-]/)) if (part) paragraphWords.add(part);
  }
  const inParagraph = (w) => {
    if (paragraphWords.has(w)) return true;
    for (const pw of paragraphWords) if (sameRoot(w, pw)) return true;
    return false;
  };

  return terms.filter((term) => {
    const words = wordsOf(term);
    if (words.length === 0) return false;
    const content = words.filter((w) => !STOPWORDS.has(w));
    const toCheck = content.length > 0 ? content : words;
    return toCheck.every((w) => inParagraph(w) || w.split(/['’-]/).every((part) => inParagraph(part)));
  });
}
