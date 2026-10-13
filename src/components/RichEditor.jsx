import { useCallback, useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, Highlighter, List, Sparkles } from 'lucide-react';
import { parseInline } from '../lib/inlineMarkdown.js';
import InlineAI from './InlineAI.jsx';

// Visual editor for the app's markdown subset, in the spirit of Obsidian's
// live preview: you see bold, italic, underline, highlight and bullets, never
// the ** == <u> - characters. The stored value stays plain markdown
// (see inlineMarkdown.js), so everything that renders or translates it is
// unchanged:
//   **bold**  *italic*  <u>underline</u>  ==highlight==  "- " bullet lines
//
// Built on contentEditable. The DOM is rebuilt from markdown only when the
// value changes from outside (switching paragraphs, cancel); while typing,
// the DOM is the source of truth and is serialized back on every input, so
// the caret never jumps.

// ---- markdown → editor HTML -------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineHtml(text) {
  // Quotes stay literal while editing; only the formatting marks become tags.
  return parseInline(text, { quotes: false })
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.em) html = `<em>${html}</em>`;
      if (run.u) html = `<u>${html}</u>`;
      if (run.mark) html = `<mark>${html}</mark>`;
      if (run.strong) html = `<strong>${html}</strong>`;
      return html;
    })
    .join('');
}

function markdownToHtml(md) {
  const lines = (md || '').split('\n');
  const out = [];
  let list = null;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = []; out.push(list); }
      list.push(`<li>${inlineHtml(bullet[1]) || '<br>'}</li>`);
    } else {
      list = null;
      out.push(`<div>${inlineHtml(line) || '<br>'}</div>`);
    }
  }
  return out.map((b) => (Array.isArray(b) ? `<ul>${b.join('')}</ul>` : b)).join('');
}

// ---- editor DOM → markdown -------------------------------------------------

const BLOCKS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);

function markOf(el) {
  const tag = el.tagName;
  const style = el.style || {};
  if (tag === 'B' || tag === 'STRONG' || Number(style.fontWeight) >= 600 || style.fontWeight === 'bold') return 'strong';
  if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic') return 'em';
  if (tag === 'U' || (style.textDecoration || style.textDecorationLine || '').includes('underline')) return 'u';
  if (tag === 'MARK' || (style.backgroundColor && style.backgroundColor !== 'transparent')) return 'mark';
  return null;
}

const DELIM = { strong: ['**', '**'], em: ['*', '*'], u: ['<u>', '</u>'], mark: ['==', '=='] };

// Inline content of one block. `active` carries marks already open around
// this node, so a <b> nested inside a <b> doesn't emit "****".
function inlineMarkdown(node, active = new Set()) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent.replace(/ /g, ' ');
    } else if (child.nodeName === 'BR') {
      out += '\n';
    } else if (child.nodeType === Node.ELEMENT_NODE && !BLOCKS.has(child.nodeName)) {
      const mark = markOf(child);
      if (mark && !active.has(mark)) {
        const inner = inlineMarkdown(child, new Set([...active, mark]));
        // Keep surrounding spaces outside the delimiters: "**word** " not "**word **".
        const lead = inner.match(/^\s*/)[0];
        const trail = inner.slice(lead.length).match(/\s*$/)[0];
        const core = inner.slice(lead.length, inner.length - trail.length);
        out += core ? `${lead}${DELIM[mark][0]}${core}${DELIM[mark][1]}${trail}` : inner;
      } else {
        out += inlineMarkdown(child, active);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      out += inlineMarkdown(child, active);
    }
  }
  return out;
}

function htmlToMarkdown(root) {
  const lines = [];
  const walk = (node) => {
    let inline = null;
    const flushInline = () => {
      if (inline !== null) lines.push(...inline.replace(/\n$/, '').split('\n'));
      inline = null;
    };
    for (const child of node.childNodes) {
      if (child.nodeName === 'UL' || child.nodeName === 'OL') {
        flushInline();
        for (const li of child.children) lines.push(`- ${inlineMarkdown(li).replace(/\n/g, ' ').trim()}`);
      } else if (child.nodeType === Node.ELEMENT_NODE && BLOCKS.has(child.nodeName)) {
        flushInline();
        const hasBlocks = [...child.children].some((c) => BLOCKS.has(c.nodeName));
        if (hasBlocks) walk(child);
        else lines.push(...inlineMarkdown(child).replace(/\n$/, '').split('\n'));
      } else {
        const wrapper = document.createElement('span');
        wrapper.appendChild(child.cloneNode(true));
        inline = (inline || '') + inlineMarkdown(wrapper);
      }
    }
    flushInline();
  };
  walk(root);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

// ---- component -------------------------------------------------------------

const TOOLS = [
  { key: 'bold', label: 'Đậm', shortcut: '⌘B', Icon: Bold, run: () => document.execCommand('bold') },
  { key: 'italic', label: 'Nghiêng', shortcut: '⌘I', Icon: Italic, run: () => document.execCommand('italic') },
  { key: 'underline', label: 'Gạch chân', shortcut: '⌘U', Icon: Underline, run: () => document.execCommand('underline') },
  { key: 'highlight', label: 'Highlight', shortcut: '⌘⇧H', Icon: Highlighter, run: toggleHighlight },
  { key: 'list', label: 'Gạch đầu dòng', shortcut: '⌘⇧8', Icon: List, run: () => document.execCommand('insertUnorderedList') },
];

// Wraps the selection in <mark>, or unwraps it when the selection is
// already inside one.
function toggleHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const anchor = sel.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
  const existing = anchor?.closest?.('mark');
  if (existing) {
    existing.replaceWith(...existing.childNodes);
    return;
  }
  if (sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const mark = document.createElement('mark');
  mark.appendChild(range.extractContents());
  range.insertNode(mark);
  sel.removeAllRanges();
  const after = document.createRange();
  after.selectNodeContents(mark);
  sel.addRange(after);
}

function activeFormats() {
  const sel = window.getSelection();
  const node = sel?.anchorNode;
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return {
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    highlight: Boolean(el?.closest?.('mark')),
    list: Boolean(el?.closest?.('li')),
  };
}

// `textClassName` sets the typeface and size of the text being edited; callers
// pass the same classes the field uses in reading mode, so editing doesn't
// change how the text looks.
// `ai` ({ field, label, run }) adds an AI button to the toolbar that opens
// the field's inline assistant (InlineAI) under the text.
// `seamless` is the always-on editor of the chapter's edit mode: no box, the
// text looks as it does when reading, and the toolbar floats above the field
// only while it has focus.
export default function RichEditor({ value, onChange, placeholder, minRows = 3, list = false, className = '', textClassName = 'text-body leading-relaxed text-ink', ai = null, seamless = false }) {
  const ref = useRef(null);
  const lastValue = useRef(null);
  const [active, setActive] = useState({});
  const [focused, setFocused] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSelection, setAiSelection] = useState('');

  // Opening the AI remembers the text selected in this field, if any, so the
  // request can be limited to it.
  function toggleAi() {
    if (aiOpen) { setAiOpen(false); return; }
    const sel = window.getSelection();
    const inside = sel && !sel.isCollapsed && ref.current?.contains(sel.anchorNode) && ref.current.contains(sel.focusNode);
    setAiSelection(inside ? sel.toString().trim() : '');
    setAiOpen(true);
  }

  // Rebuild the DOM only when the value didn't come from this editor.
  useEffect(() => {
    if (!ref.current || value === lastValue.current) return;
    const md = value || '';
    ref.current.innerHTML = list && !md.trim() ? '<ul><li><br></li></ul>' : markdownToHtml(md);
    lastValue.current = md;
  }, [value, list]);

  const emit = useCallback(() => {
    const md = htmlToMarkdown(ref.current);
    lastValue.current = md;
    onChange(md);
  }, [onChange]);

  useEffect(() => {
    if (!focused) return undefined;
    const onSelection = () => setActive(activeFormats());
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [focused]);

  function runTool(tool) {
    ref.current.focus();
    document.execCommand('styleWithCSS', false, false);
    tool.run();
    emit();
    setActive(activeFormats());
  }

  function handleKeyDown(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey && key === 'h') { e.preventDefault(); runTool(TOOLS[3]); }
    else if (e.shiftKey && (key === '8' || key === '*')) { e.preventDefault(); runTool(TOOLS[4]); }
    else if (!e.shiftKey && ['b', 'i', 'u'].includes(key)) {
      // Native contentEditable handles these; just sync afterwards.
      requestAnimationFrame(() => { emit(); setActive(activeFormats()); });
    }
  }

  // Pasted text arrives without its source formatting (web pages, Word),
  // which would otherwise bring fonts, colors and links into the editor.
  function handlePaste(e) {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }

  return (
    <div
      className={seamless
        ? `group/editor relative -mx-2 rounded-md border border-transparent transition-colors hover:border-rule/70 focus-within:border-accent/60 focus-within:bg-page ${className}`
        : `rounded-md border border-rule bg-page focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 ${className}`}
    >
      {/* In seamless mode the toolbar rides on a zero-height sticky strip:
          above the field while its top is in view, pinned under the chapter
          header while the field is scrolled through. */}
      <div className={seamless ? 'sticky top-[6.5rem] z-20 h-0' : ''}>
      <div
        className={seamless
          ? `absolute bottom-0 left-0 mb-1 items-center gap-0.5 rounded-md border border-rule bg-page px-1 py-0.5 shadow-sm group-focus-within/editor:flex ${aiOpen ? 'flex' : 'hidden'}`
          : 'flex items-center gap-0.5 border-b border-rule bg-sunken px-1 py-0.5'}
      >
        {TOOLS.map((tool) => (
          <button
            key={tool.key}
            type="button"
            title={`${tool.label} (${tool.shortcut})`}
            aria-label={tool.label}
            aria-pressed={Boolean(active[tool.key])}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTool(tool)}
            className={`grid h-7 w-7 place-items-center rounded transition-colors ${
              active[tool.key] ? 'bg-accent-soft text-accent' : 'text-mute hover:bg-rule hover:text-ink'
            }`}
          >
            <tool.Icon size={15} />
          </button>
        ))}
        {ai && (
          <button
            type="button"
            title={`Hỏi AI về ô ${ai.label} (chọn chữ trước để chỉ sửa phần đó)`}
            aria-label={`AI cho ô ${ai.label}`}
            aria-pressed={aiOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleAi}
            className={`${seamless ? 'ml-1 border-l border-rule pl-2' : 'ml-auto'} flex h-7 items-center gap-1 rounded px-2 text-caption font-medium transition-colors ${
              aiOpen ? 'bg-accent-soft text-accent' : 'text-mute hover:bg-rule hover:text-accent'
            }`}
          >
            <Sparkles size={14} /> AI
          </button>
        )}
      </div>
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => { setFocused(true); setActive(activeFormats()); }}
        onBlur={() => { setFocused(false); setActive({}); }}
        style={{ minHeight: `${minRows * 1.65 + (seamless ? 0.5 : 1.5)}em` }}
        className={`rich-editor ${seamless ? 'px-2 py-0.5' : 'px-3 py-2.5'} focus:outline-none ${textClassName}`}
      />
      {ai && aiOpen && (
        <InlineAI
          field={ai.field}
          label={ai.label}
          value={value || ''}
          selection={aiSelection}
          onClearSelection={() => setAiSelection('')}
          run={ai.run}
          onApply={(next) => onChange(next)}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}
