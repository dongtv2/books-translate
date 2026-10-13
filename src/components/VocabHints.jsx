import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { BookMarked } from 'lucide-react';
import SpeakButton from './SpeakButton.jsx';
import { findTerms } from '../lib/vocabMatch.js';

// Words already in the vocabulary, marked where they appear in the English
// column: a dotted underline in the reader's status color, and on hover or
// tap a small card with IPA, word type and meaning, so a known word can be
// checked without leaving the paragraph.

const HINT_STATUS = {
  'Thành thạo': { line: 'decoration-ok/70', dot: 'bg-ok', text: 'text-ok' },
  'Đang học': { line: 'decoration-warn', dot: 'bg-warn', text: 'text-warn' },
  'Cần ôn gấp': { line: 'decoration-flag', dot: 'bg-flag', text: 'text-flag' },
};

const HintsContext = createContext(null);
const PopoverContext = createContext(null);

const OPEN_DELAY = 250;
const CLOSE_DELAY = 200;

function Hint({ entry, children }) {
  const pop = useContext(PopoverContext);
  const ref = useRef(null);
  const style = HINT_STATUS[entry.status] || HINT_STATUS['Đang học'];
  return (
    <span
      ref={ref}
      data-vocab-hint={entry.id}
      aria-label={`${entry.term}: ${entry.meaning_vi}`}
      onPointerEnter={(e) => e.pointerType === 'mouse' && pop.hoverOpen(entry, ref.current)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && pop.hoverClose()}
      onClick={(e) => { e.stopPropagation(); pop.toggle(entry, ref.current); }}
      className={`cursor-help rounded-[2px] underline decoration-dotted decoration-2 underline-offset-[5px] transition-colors hover:bg-accent-soft ${style.line}`}
    >
      {children}
    </span>
  );
}

function VocabCard({ entry, anchor, onEnter, onLeave, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  // Measured before paint, so the card never flashes at its old position.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const card = ref.current.getBoundingClientRect();
    const width = card.width;
    const left = Math.min(Math.max(12, r.left + r.width / 2 - width / 2), window.innerWidth - width - 12);
    const below = r.bottom + 8;
    const top = below + card.height > window.innerHeight - 12 ? r.top - card.height - 8 : below;
    setPos({ top: Math.max(12, top), left });
  }, [anchor, entry]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !anchor.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onClose, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onClose);
    };
  }, [anchor, onClose]);

  const style = HINT_STATUS[entry.status] || HINT_STATUS['Đang học'];
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={entry.term}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="fixed z-50 w-72 max-w-[calc(100vw-24px)] rounded-lg border border-rule bg-page p-4 shadow-lg"
    >
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 break-words font-serif text-heading font-semibold leading-snug text-ink">{entry.term}</p>
        <SpeakButton id={`hint-${entry.id}`} text={entry.term} size={15} className="-mr-1 -mt-0.5 !h-7 !w-7" />
      </div>
      {(entry.ipa || entry.word_type) && (
        <p className="mt-0.5 flex flex-wrap gap-x-2.5 text-meta text-mute">
          {entry.ipa && <span className="font-sans">{entry.ipa}</span>}
          {entry.word_type && <span className="italic">{entry.word_type}</span>}
        </p>
      )}
      <p className="mt-2.5 text-lead leading-relaxed text-ink">{entry.meaning_vi}</p>
      {entry.meaning_general && <p className="mt-1 text-meta text-mute">Nghĩa trong sách này · nghĩa chung: {entry.meaning_general}</p>}
      {entry.source_book_title && (
        <p className="mt-2 text-caption leading-snug text-mute">
          Từ sách <span className="text-soft">{entry.source_book_title}</span>
          {entry.source_chapter_title && <>, {entry.source_chapter_title}</>}
          {entry.source_book_domain && <span className="block">{entry.source_book_domain}</span>}
        </p>
      )}
      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-rule pt-2.5 text-meta">
        <span className={`flex items-center gap-1.5 font-medium ${style.text}`}>
          <span className={`h-2 w-2 rounded-full ${style.dot}`} /> {entry.status}
        </span>
        <Link to={`/vocabulary?search=${encodeURIComponent(entry.term)}`} className="flex items-center gap-1 text-soft hover:text-accent">
          <BookMarked size={14} /> Kho từ vựng
        </Link>
      </div>
    </div>,
    document.body,
  );
}

// `entries`: the chapter's knownTerms ({ id, term, ipa, word_type,
// meaning_vi, status }). With `enabled` false or no entries, nothing is
// marked and useVocabHints() returns null.
export function VocabHintsProvider({ entries, enabled = true, children }) {
  const [open, setOpen] = useState(null); // { entry, anchor }
  const timer = useRef(null);

  const clear = () => clearTimeout(timer.current);
  const close = useCallback(() => { clear(); setOpen(null); }, []);

  const pop = useMemo(() => ({
    hoverOpen(entry, anchor) {
      clear();
      timer.current = setTimeout(() => setOpen({ entry, anchor }), OPEN_DELAY);
    },
    hoverClose() {
      clear();
      timer.current = setTimeout(() => setOpen(null), CLOSE_DELAY);
    },
    toggle(entry, anchor) {
      clear();
      setOpen((o) => (o?.anchor === anchor ? null : { entry, anchor }));
    },
  }), []);

  useEffect(() => clear, []);

  const hints = useMemo(() => {
    if (!enabled || !entries?.length) return null;
    const byId = new Map(entries.map((e) => [e.id, e]));
    return {
      // Only a word's first appearance in each paragraph is marked: a key
      // term like "attachment" recurs in nearly every paragraph, and marking
      // each one would bury the text in underlines.
      find: (text) => {
        const seen = new Set();
        return findTerms(text, entries).filter((m) => !seen.has(m.id) && seen.add(m.id));
      },
      render: (match, content, key) => <Hint key={key} entry={byId.get(match.id)}>{content}</Hint>,
    };
  }, [entries, enabled]);

  return (
    <HintsContext.Provider value={hints}>
      <PopoverContext.Provider value={pop}>
        {children}
        {open && hints && (
          <VocabCard
            entry={open.entry}
            anchor={open.anchor}
            onEnter={clear}
            onLeave={pop.hoverClose}
            onClose={close}
          />
        )}
      </PopoverContext.Provider>
    </HintsContext.Provider>
  );
}

export function useVocabHints() {
  return useContext(HintsContext);
}
