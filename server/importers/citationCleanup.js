// Kindle's "Copy" feature always appends a citation as its own paragraph
// right after the excerpt, e.g.:
//   Neufeld, Gordon; Maté MD, Gabor. Hold On to Your Kids: Why Parents Need
//   to Matter More Than Peers (pp. 42-43). (Function). Kindle Edition.
// When someone pastes a Kindle clip into the app, that trailing paragraph is
// pure noise (not part of the book text) and would otherwise end up as its
// own bogus "pending" paragraph. Detect it and drop it during import/paste.
const KINDLE_CITATION_RE =
  /^[A-Za-zÀ-ỹ][^\n]{0,300}\((?:pp?\.\s*\d+(?:[-–]\d+)?|Location\s*\d+(?:[-–]\d+)?)\)\.[^\n]*Kindle Edition\.?\s*$/i;

export function isKindleCitation(text) {
  return KINDLE_CITATION_RE.test((text || '').trim());
}

// Filters a list of already-split paragraph strings, dropping any that are
// nothing but a Kindle citation.
export function stripKindleCitations(paragraphs) {
  return paragraphs.filter((p) => !isKindleCitation(p));
}
