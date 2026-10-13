// Parser for the app's small inline markdown subset:
//   **bold**   *italic*   <u>underline</u>   ==highlight==   "quotation"
// Underline and highlight follow Obsidian's conventions (markdown itself has
// no underline). Shared by the renderers (markdownLite.jsx), the visual
// editor (RichEditor.jsx) and TTS text preparation (textTiming.js), so the
// text that is spoken, shown and edited is the same characters.
//
// It walks the text once and toggles each mark at its delimiter, so marks
// can nest: a quotation containing bolded terms ("**he** said") keeps its
// bold. A delimiter only opens a mark when a closing one exists later in the
// text; an unmatched one stays a literal character instead of swallowing
// the rest of the paragraph.

const U_OPEN = '<u>';
const U_CLOSE = '</u>';

// Returns [{ text, strong, em, u, mark, q }] runs, with delimiters removed.
// `quotes: false` keeps straight quotes as ordinary text (the editor shows
// and edits them literally instead of turning them into a <q>).
export function parseInline(text, { quotes = true } = {}) {
  const runs = [];
  if (!text) return runs;
  const state = { strong: false, em: false, u: false, mark: false, q: false };
  let buf = '';

  const flush = () => {
    if (buf) runs.push({ text: buf, ...state });
    buf = '';
  };
  const toggle = (key, width) => {
    flush();
    state[key] = !state[key];
    return width;
  };

  let i = 0;
  while (i < text.length) {
    if (text.startsWith('**', i) && (state.strong || text.indexOf('**', i + 2) !== -1)) {
      i += toggle('strong', 2);
    } else if (text.startsWith('==', i) && (state.mark || text.indexOf('==', i + 2) !== -1)) {
      i += toggle('mark', 2);
    } else if (!state.u && text.startsWith(U_OPEN, i) && text.indexOf(U_CLOSE, i + 3) !== -1) {
      i += toggle('u', U_OPEN.length);
    } else if (state.u && text.startsWith(U_CLOSE, i)) {
      i += toggle('u', U_CLOSE.length);
    } else if (text[i] === '*' && (state.em || hasSingleStarAfter(text, i + 1))) {
      i += toggle('em', 1);
    } else if (quotes && text[i] === '"' && (state.q || text.indexOf('"', i + 1) !== -1)) {
      i += toggle('q', 1);
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return runs;
}

// A lone "*" that could close an italic — not one half of a "**".
function hasSingleStarAfter(text, from) {
  for (let j = from; j < text.length; j += 1) {
    if (text[j] !== '*') continue;
    if (text[j + 1] === '*') { j += 1; continue; }
    return true;
  }
  return false;
}

// Plain text exactly as rendered (delimiters removed, quote marks dropped
// because <q> draws its own).
export function plainText(text) {
  return parseInline(text).map((r) => r.text).join('');
}

// Plain text for short previews (lists, menus): every delimiter removed,
// quote marks kept as written.
export function previewText(text) {
  return parseInline(text, { quotes: false }).map((r) => r.text).join('');
}
