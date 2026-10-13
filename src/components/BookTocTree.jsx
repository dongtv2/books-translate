import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { tocGroups, withLabel } from '../lib/toc.js';

// Translation progress for one chapter: a tick when complete, otherwise the
// percentage. Empty chapters show nothing rather than a misleading 0%.
function ChapterProgress({ chapter }) {
  if (!chapter.paragraphCount) return null;
  const pct = Math.round((chapter.translatedCount / chapter.paragraphCount) * 100);
  if (pct === 100) return <Check size={13} className="mt-0.5 shrink-0 text-ok" aria-label="Đã dịch xong" />;
  return <span className="shrink-0 text-caption tabular-nums text-mute">{pct}%</span>;
}

// An arrow that folds or unfolds a row of the tree.
function Fold({ open, label, onClick }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={onClick}
      className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-mute hover:bg-sunken hover:text-ink"
    >
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}

function ChapterEntry({ chapter, currentChapterId, currentSections, activeSectionId, onNavigate, open, onToggle }) {
  const isCurrent = chapter.id === currentChapterId;
  // Only headed sections are TOC entries; the untitled one is the chapter's
  // opening. The current chapter's sections come from the chapter page (they
  // are fresher); the others from the book.
  const headed = ((isCurrent && currentSections) || chapter.sections || []).filter((s) => s.heading);
  const showSections = headed.length > 0 && open;

  return (
    <div>
      <div className="flex items-start">
        {headed.length > 0 ? (
          <Fold open={showSections} label={showSections ? 'Ẩn các mục' : 'Hiện các mục'} onClick={onToggle} />
        ) : <span className="w-6 shrink-0" aria-hidden />}
        <Link
          to={`/chapters/${chapter.id}`}
          onClick={onNavigate}
          aria-current={isCurrent ? 'page' : undefined}
          className={`flex min-w-0 flex-1 items-start justify-between gap-2 rounded-md px-1.5 py-1.5 text-meta leading-snug transition-colors ${
            isCurrent ? 'bg-accent-soft font-medium text-accent' : 'text-soft hover:bg-sunken hover:text-ink'
          }`}
        >
          <span className="min-w-0">
            {withLabel(chapter.label, chapter.title)}
            {chapter.title_vi && <span className="block text-caption font-normal text-mute">{withLabel(chapter.label_vi, chapter.title_vi)}</span>}
          </span>
          <ChapterProgress chapter={chapter} />
        </Link>
      </div>
      {showSections && (
        <ul className="ml-6 mt-0.5 border-l border-rule">
          {headed.map((s) => {
            const isActive = isCurrent && s.id === activeSectionId;
            return (
              <li key={s.id}>
                <Link
                  to={`/chapters/${chapter.id}#section-${s.id}`}
                  onClick={onNavigate}
                  title={s.heading}
                  className={`-ml-px block border-l py-1 pl-3 pr-2 text-caption leading-snug transition-colors ${
                    isActive ? 'border-accent font-medium text-accent' : 'border-transparent text-mute hover:text-ink'
                  }`}
                >
                  {s.heading}
                  {s.heading_vi && <span className="block text-mute">{s.heading_vi}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Presentational only — the caller (global Sidebar) is responsible for
// fetching `book` and figuring out which chapter/sections/section-in-view
// are "current". `onNavigate` fires whenever a link inside the tree is
// clicked — the Sidebar uses it to auto-close the mobile overlay drawer.
export default function BookTocTree({ book, currentChapterId, currentSections, activeSectionId, onNavigate }) {
  // Rows the reader folded or unfolded (key: chapter id or "part-<id>"); by
  // default every part is open and only the current chapter shows its sections.
  const [toggled, setToggled] = useState(() => new Map());
  if (!book) return null;
  const isOpen = (key, byDefault) => (toggled.has(key) ? toggled.get(key) : byDefault);
  const toggle = (key, byDefault) => setToggled((m) => new Map(m).set(key, !isOpen(key, byDefault)));
  const entry = (c) => (
    <ChapterEntry
      key={c.id}
      chapter={c}
      currentChapterId={currentChapterId}
      currentSections={currentSections}
      activeSectionId={activeSectionId}
      onNavigate={onNavigate}
      open={isOpen(c.id, c.id === currentChapterId)}
      onToggle={() => toggle(c.id, c.id === currentChapterId)}
    />
  );
  const { front, parts, body, back } = tocGroups(book);
  const group = (key, title, chapters) => chapters.length > 0 && (
    <div key={key} className="space-y-0.5">
      {title && <p className="px-2 pb-1 pt-1 text-caption font-medium uppercase tracking-wide text-mute">{title}</p>}
      {chapters.map(entry)}
    </div>
  );

  return (
    <div className="space-y-4">
      <Link
        to={`/books/${book.id}`}
        onClick={onNavigate}
        title={book.title_vi || book.title_en}
        className="line-clamp-2 px-2 font-serif text-lead font-semibold leading-snug text-ink hover:text-accent"
      >
        {book.title_vi || book.title_en}
      </Link>

      {group('front', 'Phần đầu sách', front)}
      {parts.map((part) => {
        const key = `part-${part.id}`;
        const open = isOpen(key, true);
        return (
          <div key={part.id} className="space-y-0.5">
            <div className="flex items-start">
              <Fold open={open} label={open ? 'Thu gọn phần' : 'Mở phần'} onClick={() => toggle(key, true)} />
              <p className="min-w-0 px-1.5 pb-1 pt-1 font-serif text-body font-semibold leading-snug text-ink" title={withLabel(part.label, part.title)}>
                {withLabel(part.label, part.title)}
                {part.title_vi && <span className="block font-sans text-caption font-normal text-mute">{withLabel(part.label_vi, part.title_vi)}</span>}
              </p>
            </div>
            {open && (
              <div className="ml-3 space-y-0.5 border-l border-rule pl-1">
                {part.chapters.map(entry)}
              </div>
            )}
          </div>
        );
      })}
      {group('body', null, body)}
      {group('back', 'Phần cuối sách', back)}
    </div>
  );
}
