// Minimal, safe renderer for the tiny markdown subset the app produces:
// **bold**, *italic*, <u>underline</u>, ==highlight==, "..." direct quotations,
// and "- " bullet lines. No
// HTML injection — everything is built as React elements, never
// dangerouslySetInnerHTML. Parsing lives in inlineMarkdown.js.
import { parseInline } from './inlineMarkdown.js';

function wrapMarks(run, content, key) {
  let node = content;
  if (run.em) node = <em>{node}</em>;
  if (run.u) node = <u className="underline-offset-[3px]">{node}</u>;
  if (run.mark) node = <mark className="rounded-[2px] bg-marker-soft px-0.5 text-inherit">{node}</mark>;
  if (run.strong) node = <strong>{node}</strong>;
  return <span key={key}>{node}</span>;
}

// Consecutive runs inside one quotation share a single <q>, so the quote
// marks the browser draws sit around the whole quotation, not each run.
// A direct quotation (e.g. citing another author) stays in the running text
// of both columns, just set apart so it reads as someone else's words.
function groupQuotes(runs, renderRun) {
  const out = [];
  let quote = null;
  runs.forEach((run, i) => {
    const node = renderRun(run, i);
    if (run.q) {
      if (!quote) { quote = []; out.push(quote); }
      quote.push(node);
    } else {
      quote = null;
      out.push(node);
    }
  });
  return out.map((item, i) =>
    Array.isArray(item) ? <q key={`q${i}`} className="italic text-soft">{item}</q> : item
  );
}

function inlineToNodes(text, keyPrefix) {
  return groupQuotes(parseInline(text), (run, i) => wrapMarks(run, run.text, `${keyPrefix}-${i}`));
}

// `hints` (from VocabHints' useVocabHints) marks vocabulary words: find()
// locates them in the plain text, render() wraps each matched piece. A match
// that crosses a bold/italic boundary is wrapped piece by piece.
export function RichText({ text, className = '', hints = null }) {
  if (!text) return null;
  if (!hints) return <span className={className}>{inlineToNodes(text, 'r')}</span>;

  const runs = parseInline(text);
  const matches = hints.find(runs.map((r) => r.text).join(''));
  if (!matches.length) return <span className={className}>{inlineToNodes(text, 'r')}</span>;

  let cursor = 0;
  const nodes = groupQuotes(runs, (run, ri) => {
    const start = cursor;
    const end = start + run.text.length;
    cursor = end;
    const pieces = [];
    let pos = start;
    for (const m of matches) {
      if (m.end <= start || m.start >= end) continue;
      const from = Math.max(m.start, start);
      const to = Math.min(m.end, end);
      if (from > pos) pieces.push(run.text.slice(pos - start, from - start));
      pieces.push(hints.render(m, run.text.slice(from - start, to - start), `h${ri}-${m.start}`));
      pos = to;
    }
    if (pos < end) pieces.push(run.text.slice(pos - start));
    return wrapMarks(run, pieces, `r-${ri}`);
  });
  return <span className={className}>{nodes}</span>;
}

// Same rendering as RichText, but also marks the sentence and the word being
// spoken while TTS reads this paragraph aloud. `sentences` comes from
// textTiming.js's segmentText() over the same parser's plain text, so
// character offsets line up exactly.
//
// The sentence mark is applied per word (and to the spaces inside the
// sentence), not per markdown run: a run of plain text often crosses a
// sentence boundary, and marking whole runs bled the band into the next
// sentence. The band's look (continuous across wrapped lines) is in
// index.css under .read-sentence.
export function ReadAlongText({ text, sentences, activeSentenceIndex, activeWordIndexInSentence, className = '' }) {
  if (!text) return null;
  const sentenceAt = (offset) => sentences.findIndex((s) => offset >= s.start && offset < s.end);
  const active = sentences[activeSentenceIndex];

  let cursor = 0; // offset into the plain text
  const nodes = groupQuotes(parseInline(text), (run, ri) => {
    const pieces = run.text.split(/(\s+)/).filter((p) => p !== '');
    const inner = pieces.map((piece, pi) => {
      const start = cursor;
      cursor += piece.length;
      const isSpace = /^\s+$/.test(piece);
      // A space belongs to the band only when the words on both sides are
      // in the active sentence, so the band ends at the full stop.
      const inActive = isSpace
        ? sentenceAt(start - 1) === activeSentenceIndex && sentenceAt(start + piece.length) === activeSentenceIndex
        : sentenceAt(start) === activeSentenceIndex;
      const isActiveWord = !isSpace && inActive && active?.words[activeWordIndexInSentence]?.start === start;
      const cls = isActiveWord ? 'read-sentence read-word' : inActive ? 'read-sentence' : undefined;
      return <span key={`${ri}-${pi}`} className={cls}>{piece}</span>;
    });
    return wrapMarks(run, inner, `w${ri}`);
  });

  return <span className={className}>{nodes}</span>;
}

// Bullet lines from the notes fields. Each line is usually "**term** /ipa/
// (type): meaning", so the bold term leads and the rest hangs under it.
export function RemarksList({ text, className = '', itemClassName = 'text-body' }) {
  if (!text || !text.trim()) {
    return <span className={`italic text-mute ${itemClassName}`}>(không có ghi chú)</span>;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {lines.map((line, i) => {
        const cleaned = line.replace(/^-\s*/, '');
        return (
          <li key={i} className={`leading-relaxed [&_strong]:font-semibold [&_strong]:text-ink ${itemClassName}`}>
            {inlineToNodes(cleaned, `m${i}`)}
          </li>
        );
      })}
    </ul>
  );
}
