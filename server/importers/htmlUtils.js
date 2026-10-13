// Converts a cheerio node's inline content (text + <strong>/<b>/<em>/<i>/<br>)
// into the app's markdown-lite subset (**bold**, *italic*), used both for
// English/Vietnamese paragraph cells and for remark bullet lines.
export function inlineNodeToMd($, node) {
  let out = '';
  $(node)
    .contents()
    .each((_, child) => {
      if (child.type === 'text') {
        out += child.data;
        return;
      }
      if (child.type !== 'tag') return;
      const tag = child.tagName?.toLowerCase();
      if (tag === 'br') {
        out += '\n';
      } else if (tag === 'strong' || tag === 'b') {
        const inner = inlineNodeToMd($, child).trim();
        if (inner) out += `**${inner}**`;
      } else if (tag === 'em' || tag === 'i') {
        const inner = inlineNodeToMd($, child).trim();
        if (inner) out += `*${inner}*`;
      } else {
        out += inlineNodeToMd($, child);
      }
    });
  return out;
}

export function cellPlainText($, cell) {
  return $(cell).text().replace(/\s+/g, ' ').trim();
}

// A table cell may hold several <p> paragraphs; join them the way the app
// stores multi-paragraph cell content (rare for English/Vietnamese cells,
// but harmless when it happens).
export function cellToMd($, cell) {
  const parts = [];
  $(cell)
    .children('p')
    .each((_, p) => {
      const md = inlineNodeToMd($, p).trim();
      if (md) parts.push(md);
    });
  if (parts.length === 0) {
    const md = inlineNodeToMd($, cell).trim();
    return md;
  }
  return parts.join('\n\n');
}
