// Books have no cover image, so each gets a cloth-binding color picked
// deterministically from its title: the same book always wears the same
// cover, and a shelf of books reads as a varied row of spines.
const CLOTHS = [
  { bg: '#2f3e6b', fg: '#f3efe2' }, // navy
  { bg: '#7a2e2e', fg: '#f6ead8' }, // oxblood
  { bg: '#2f5d4e', fg: '#f1eedd' }, // bottle green
  { bg: '#5a3d7a', fg: '#f3ecf7' }, // plum
  { bg: '#8a5a1f', fg: '#fbf3df' }, // ochre
  { bg: '#3d4a52', fg: '#eef1f2' }, // slate
  { bg: '#1f5f73', fg: '#eaf4f6' }, // petrol
];

export function coverFor(book) {
  const key = (book.title_en || book.title_vi || '').trim() || String(book.id);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return CLOTHS[hash % CLOTHS.length];
}

// Drops the subtitle ("Title: Subtitle") so a cover carries a short title.
export function shortTitle(title = '') {
  return title.split(/[:—]/)[0].trim();
}
