import { useMemo } from 'react';
import { RichText } from '../lib/markdownLite.jsx';
import { previewText } from '../lib/inlineMarkdown.js';
import { diffWords } from '../lib/textDiff.js';

// Shared by the assistant panel and the inline AI of each editor field.

// Chat text: paragraphs, "- " / "1. " lists and **bold**/*italic* inline.
export function AnswerText({ text }) {
  const blocks = [];
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^\s*#{1,4}\s+(.*)$/);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) blocks.push({ type: 'gap' });
    else if (item) {
      const indent = /^\s{2,}/.test(line);
      if (last?.type === 'list') last.items.push({ text: item[1], indent });
      else blocks.push({ type: 'list', items: [{ text: item[1], indent }] });
    } else if (heading) blocks.push({ type: 'heading', text: heading[1] });
    else if (last?.type === 'p') last.text += `\n${line}`;
    else blocks.push({ type: 'p', text: line });
  }
  return (
    <div className="space-y-2 text-body leading-relaxed text-ink [&_strong]:font-semibold">
      {blocks.filter((b) => b.type !== 'gap').map((b, i) => {
        if (b.type === 'list') {
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className={`relative pl-4 ${it.indent ? 'ml-4 text-soft' : ''}`}>
                  <span aria-hidden="true" className="absolute left-0.5 top-[0.6em] h-1 w-1 rounded-full bg-mute" />
                  <RichText text={it.text} />
                </li>
              ))}
            </ul>
          );
        }
        if (b.type === 'heading') return <p key={i} className="font-semibold"><RichText text={b.text} /></p>;
        return <p key={i} className="whitespace-pre-line"><RichText text={b.text} /></p>;
      })}
    </div>
  );
}

export function DiffView({ before, after, className = '' }) {
  const parts = useMemo(() => diffWords(previewText(before), previewText(after)), [before, after]);
  return (
    <p className={`whitespace-pre-line font-serif text-body leading-relaxed text-ink ${className}`}>
      {parts.map((p, i) => (
        p.type === 'same' ? <span key={i}>{p.text}</span>
          : p.type === 'del'
            ? <del key={i} className="rounded-sm bg-flag-soft text-flag decoration-flag/70">{p.text}</del>
            : <ins key={i} className="rounded-sm bg-ok-soft text-ok no-underline">{p.text}</ins>
      ))}
    </p>
  );
}

