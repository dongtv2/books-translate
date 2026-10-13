import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, Quote } from 'lucide-react';
import { useDiscussion } from './TermDiscussion.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { offsetIn } from '../lib/threadAnchors.js';

// Select a word, a phrase or whole sentences in a paragraph's English or
// Vietnamese column and a small toolbar appears above it: "Thảo luận" opens a
// discussion of exactly that text, remembering where it is (so it is marked
// in the text and the thread can jump back to it); while a thread is open,
// "Trích vào thảo luận" quotes it into the comment being written. The columns
// carry data-term-side="en" | "vi" (ParagraphCard).
const MAX_LENGTH = 600;

function pickedText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const el = (n) => (n.nodeType === 1 ? n : n.parentElement);
  const column = el(range.startContainer)?.closest('[data-term-side]');
  const endColumn = el(range.endContainer)?.closest('[data-term-side]');
  // Only within one column, and not inside an editor (it has its own tools).
  if (!column || column !== endColumn || el(range.commonAncestorContainer).closest('[contenteditable="true"], textarea, input')) return null;
  const row = column.closest('.para-row[id^="paragraph-"]');
  if (!row) return null;

  // Trim spaces and stray quote marks/punctuation at the edges, keeping the
  // offsets in step so the stored place points at exactly the kept text.
  const raw = range.toString();
  const lead = raw.match(/^[\s“"‘'(]*/)[0].length;
  const tail = raw.slice(lead).match(/[\s”"’'),;:]*$/)[0].length;
  const text = raw.slice(lead, raw.length - tail);
  if (!text.trim() || text.length > MAX_LENGTH) return null;
  // A single word or phrase also loses a trailing full stop.
  const exact = text.split(/\s+/).length <= 6 ? text.replace(/[.!?]+$/, '') : text;
  return {
    term: exact.replace(/\s+/g, ' '),
    side: column.dataset.termSide,
    paragraphId: Number(row.id.replace('paragraph-', '')),
    anchor: { start: offsetIn(column, range.startContainer, range.startOffset) + lead, text: exact },
    rect: range.getBoundingClientRect(),
  };
}

export default function TermSelectionButton() {
  const discussion = useDiscussion();
  const { can } = useAuth();
  const enabled = can('discuss.join');
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPicked(pickedText()));
    };
    const hide = () => setPicked(null);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', hide, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', hide);
    };
  }, [enabled]);

  if (!picked || !discussion) return null;
  const done = () => { window.getSelection()?.removeAllRanges(); setPicked(null); };
  const width = discussion.canQuote ? 260 : 120;
  const top = picked.rect.top > 56 ? picked.rect.top - 42 : picked.rect.bottom + 8;
  const left = Math.min(Math.max(8, picked.rect.left + picked.rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const button = 'inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-meta font-medium text-page hover:bg-accent';
  return createPortal(
    <div
      role="toolbar"
      aria-label="Với phần đã chọn"
      // Keep the selection while clicking.
      onPointerDown={(e) => e.preventDefault()}
      style={{ top, left }}
      className="fixed z-50 inline-flex items-center gap-0.5 rounded-md bg-ink p-0.5 shadow-lg"
    >
      <button
        type="button"
        className={button}
        title={picked.term.split(/\s+/).length > 6 ? 'Mở thảo luận về câu này' : 'Mở thảo luận về từ / cụm từ này'}
        onClick={() => { discussion.open(picked.paragraphId, { term: picked.term, side: picked.side, anchor: picked.anchor }); done(); }}
      >
        <MessageSquarePlus size={15} /> Bình luận
      </button>
      {discussion.canQuote && (
        <button type="button" className={button} title="Trích phần đã chọn vào bình luận đang viết" onClick={() => { discussion.quote(picked.term); done(); }}>
          <Quote size={14} /> Trích vào thảo luận
        </button>
      )}
    </div>,
    document.body,
  );
}
