export const WORD_TYPES = [
  'Noun', 'Verb', 'Adjective', 'Adverb', 'Phrasal verb',
  'Idiom', 'Noun phrase', 'Adjective phrase', 'Collocation',
];

export const WORD_TYPE_ABBR = {
  Noun: 'n',
  Verb: 'v',
  Adjective: 'adj',
  Adverb: 'adv',
  'Phrasal verb': 'phrasal v',
  Idiom: 'idiom',
  'Noun phrase': 'n phrase',
  'Adjective phrase': 'adj phrase',
  Collocation: 'collocation',
};

const ABBR_TO_WORD_TYPE = {
  n: 'Noun',
  noun: 'Noun',
  v: 'Verb',
  verb: 'Verb',
  adj: 'Adjective',
  adjective: 'Adjective',
  adv: 'Adverb',
  adverb: 'Adverb',
  'phrasal v': 'Phrasal verb',
  'phrasal verb': 'Phrasal verb',
  idiom: 'Idiom',
  'n phrase': 'Noun phrase',
  'noun phrase': 'Noun phrase',
  'adj phrase': 'Adjective phrase',
  'adjective phrase': 'Adjective phrase',
  collocation: 'Collocation',
};

// Returns a canonical WORD_TYPES value, or null if the raw label (from a
// human-typed docx cell like "(phrase)") doesn't map cleanly to one. Callers
// use null to mean "don't file this into the tracked vocabulary — display
// only", so we deliberately don't guess on ambiguous labels.
export function mapWordType(raw) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\.$/, '');
  return ABBR_TO_WORD_TYPE[key] || null;
}
