// Word-level difference between two texts, for comparing a translation
// before and after a proposed revision. Whitespace and punctuation are their
// own tokens, so a changed comma shows as just that comma.
// Returns [{ type: 'same' | 'del' | 'ins', text }] with neighbours merged.

const tokenize = (s) => String(s || '').match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu) || [];

export function diffWords(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);
  // Common prefix and suffix first: a revision usually touches a few
  // sentences, so this keeps the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // LCS lengths, row-major (n+1)×(m+1), filled from the end.
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = midA[i] === midB[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  a.slice(0, start).forEach((t) => push('same', t));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { push('same', midA[i]); i += 1; j += 1; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) { push('del', midA[i]); i += 1; }
    else { push('ins', midB[j]); j += 1; }
  }
  while (i < n) { push('del', midA[i]); i += 1; }
  while (j < m) { push('ins', midB[j]); j += 1; }
  a.slice(endA).forEach((t) => push('same', t));
  return absorbSpaces(out);
}

// "old words" → "new words" reads better as one deleted phrase followed by
// one inserted phrase than as fragments alternating around shared spaces:
// a run of changes (with the spaces inside it) becomes one del + one ins.
function absorbSpaces(parts) {
  const out = [];
  let k = 0;
  while (k < parts.length) {
    if (parts[k].type === 'same') { out.push({ ...parts[k] }); k += 1; continue; }
    let del = '';
    let ins = '';
    while (k < parts.length) {
      const q = parts[k];
      if (q.type === 'del') del += q.text;
      else if (q.type === 'ins') ins += q.text;
      else if (/^\s+$/.test(q.text) && parts[k + 1] && parts[k + 1].type !== 'same') { del += q.text; ins += q.text; }
      else break;
      k += 1;
    }
    if (del) out.push({ type: 'del', text: del });
    if (ins) out.push({ type: 'ins', text: ins });
  }
  return out;
}

// How many words were removed and added — the summary above a diff.
export function diffStats(parts) {
  const count = (type) => parts.filter((p) => p.type === type).reduce((n, p) => n + (p.text.match(/[\p{L}\p{N}]+/gu) || []).length, 0);
  return { removed: count('del'), added: count('ins') };
}
