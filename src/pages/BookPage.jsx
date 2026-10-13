import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import PageContainer from '../components/PageContainer.jsx';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowUp, ArrowDown, BookOpen, Bookmark, Check, ChevronDown, ChevronRight,
  EllipsisVertical, ExternalLink, Flag, Highlighter, LoaderCircle, Pencil, Plus, Sparkles, Star, Trash2, X,
} from 'lucide-react';
import { api, BOOK_META_FIELDS, BOOK_CONTEXT_FIELDS } from '../api.js';
import { KIND_OPTIONS, NUMBERING_OPTIONS, tocGroups, withLabel } from '../lib/toc.js';
import BookCoverEditor from '../components/BookCoverEditor.jsx';
import { BookTeam } from '../components/Assignments.jsx';
import BookAccess from '../components/BookAccess.jsx';
import {
  Button, buttonClass, Field, IconButton, MenuItem, Notice, Popover, Progress, Segmented, Sheet, LoadingLine, Tabs, inputClass,
} from '../components/ui.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { notifyBookChanged } from '../lib/bookEvents.js';
import { getLastRead, readingHref } from '../lib/lastRead.js';
import { previewText } from '../lib/inlineMarkdown.js';
import { useAuth } from '../context/AuthContext.jsx';

function percent(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function RowProgress({ done, total }) {
  if (!total) return <span className="w-16 shrink-0 text-right text-caption text-mute">Trống</span>;
  const pct = percent(done, total);
  return (
    <div className="flex w-16 shrink-0 items-center justify-end gap-1.5" title={`${done}/${total} đoạn đã dịch`}>
      {pct === 100 ? (
        <Check size={14} className="text-ok" aria-label="Đã dịch xong" />
      ) : (
        <>
          <Progress value={pct} className="w-8" />
          <span className="w-7 text-right text-caption tabular-nums text-mute">{pct}%</span>
        </>
      )}
    </div>
  );
}

// Structure editing (rename, move, delete) — only for books.edit.
function RowMenu({ children }) {
  const { can } = useAuth();
  if (!can('books.edit')) return null;
  return (
    <Popover
      label="Thao tác khác"
      width="w-52"
      triggerClassName="h-7 w-7 justify-center rounded-md text-mute hover:bg-sunken hover:text-ink"
      trigger={<EllipsisVertical size={16} />}
    >
      {children}
    </Popover>
  );
}

// Enter that only ends a Vietnamese input method's composition (Telex/VNI
// on macOS sends a composing Enter, then a real one) must not submit.
const isSubmitEnter = (e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;

// Creates something (a part, a chapter, a section) from one line of text.
// Submits once: a second Enter or click while the first request is running
// used to create the same part twice.
function InlineAdd({ placeholder, submitLabel, onSubmit, onCancel }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  async function submit() {
    const title = value.trim();
    if (!title || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await onSubmit(title);
    } catch (e) {
      setError(e.message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
        onKeyDown={(e) => { if (isSubmitEnter(e)) { e.preventDefault(); submit(); } if (e.key === 'Escape') onCancel(); }}
        className={`${inputClass} min-w-0 flex-1 py-1.5`}
      />
      <Button size="sm" variant="primary" onClick={submit} disabled={busy || !value.trim()}>
        {busy && <LoaderCircle size={14} className="animate-spin" />} {submitLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Huỷ</Button>
      {error && <Notice className="w-full">{error}</Notice>}
    </div>
  );
}

// Click-to-rename text used for Part titles and Section headings (levels
// that have no separate navigation target, unlike a chapter).
function InlineEditableText({ value, onSave, placeholder, className = '' }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  useEffect(() => setDraft(value || ''), [value]);

  if (!can('books.edit')) {
    return <span className={`min-w-0 flex-1 truncate ${className}`}>{value || <span className="font-normal italic text-mute">{placeholder}</span>}</span>;
  }
  if (editing) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (isSubmitEnter(e)) { onSave(draft); setEditing(false); }
            if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
          }}
          className={`${inputClass} min-w-0 flex-1 py-1`}
        />
        <Button size="sm" variant="primary" onClick={() => { onSave(draft); setEditing(false); }}>Lưu</Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft(value || ''); setEditing(false); }}>Huỷ</Button>
      </div>
    );
  }
  return (
    <button onClick={() => setEditing(true)} title="Bấm để đổi tên" className={`min-w-0 flex-1 truncate rounded text-left hover:text-accent ${className}`}>
      {value || <span className="font-normal italic text-mute">{placeholder}</span>}
    </button>
  );
}

// Which parts show their chapters and which chapters their sections (keys:
// a chapter id, or "part-<id>"); shared so "Mở tất cả / Thu gọn" reaches
// every row.
const TocOpenContext = createContext({ isOpen: () => true, toggle: () => {} });

// A section without a heading is the chapter's opening text, not an entry of
// the table of contents: readers never see it there; editors see a quiet row
// where a heading can be given to it.
function SectionRow({ section, index, total, onRefresh }) {
  // the chapter's only section: the whole chapter, not divided into sections
  const whole = total === 1;
  const confirm = useConfirm();
  const canEdit = useAuth().can('books.edit');
  const opening = !section.heading;

  async function handleRename(heading) { await api.updateSection(section.id, { heading }); onRefresh(); }
  async function handleRenameVi(headingVi) { await api.updateSection(section.id, { heading_vi: headingVi }); onRefresh(); }
  async function handleMove(direction) { await api.moveSection(section.id, direction); onRefresh(); }
  async function handleDelete() {
    if (!(await confirm(`Xoá ${opening ? 'phần mở đầu chương' : `mục "${section.heading}"`} và toàn bộ đoạn văn bên trong?`))) return;
    await api.deleteSection(section.id);
    onRefresh();
  }

  return (
    <div className={`flex min-w-0 items-start gap-2 py-1 pr-1 text-meta ${opening ? 'text-mute' : 'text-soft'}`}>
      <span className="w-3 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        {opening ? (
          <>
            <span className="italic">{whole ? 'Cả chương (chưa chia mục)' : 'Đoạn mở đầu chương'}</span>
            <InlineEditableText value="" onSave={handleRename} placeholder="Đặt tiêu đề để thành một mục" className="text-caption" />
          </>
        ) : (
          <>
            <InlineEditableText value={section.heading} onSave={handleRename} placeholder="Tiêu đề mục" className="text-ink" />
            {(canEdit || section.heading_vi) && <InlineEditableText value={section.heading_vi} onSave={handleRenameVi} placeholder="tiêu đề tiếng Việt" className="text-mute" />}
          </>
        )}
      </div>
      <span className="hidden shrink-0 pt-px text-caption tabular-nums text-mute sm:inline">{section.paragraphCount} đoạn</span>
      <RowProgress done={section.translatedCount} total={section.paragraphCount} />
      <RowMenu>
        <MenuItem icon={<ArrowUp size={14} />} onClick={() => handleMove('up')} disabled={index === 0}>Chuyển lên</MenuItem>
        <MenuItem icon={<ArrowDown size={14} />} onClick={() => handleMove('down')} disabled={index === total - 1}>Chuyển xuống</MenuItem>
        <MenuItem icon={<Trash2 size={14} />} onClick={handleDelete} danger>{opening ? 'Xoá phần mở đầu' : 'Xoá mục'}</MenuItem>
      </RowMenu>
    </div>
  );
}

function ChapterRow({ chapter, index, total, parts, isLastRead, onRefresh }) {
  const confirm = useConfirm();
  const canEdit = useAuth().can('books.edit');
  const toc = useContext(TocOpenContext);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chapter.title);
  const [titleViDraft, setTitleViDraft] = useState(chapter.title_vi || '');
  const [showAddSection, setShowAddSection] = useState(false);

  useEffect(() => setTitleDraft(chapter.title), [chapter.title]);

  function cancelRename() {
    setTitleDraft(chapter.title);
    setTitleViDraft(chapter.title_vi || '');
    setRenaming(false);
  }
  async function handleRename() {
    if (titleDraft.trim()) await api.updateChapter(chapter.id, { title: titleDraft.trim(), title_vi: titleViDraft.trim() });
    setRenaming(false);
    onRefresh();
  }
  async function handleKind(e) {
    await api.updateChapter(chapter.id, { kind: e.target.value });
    onRefresh();
  }
  async function handleMove(direction) { await api.moveChapter(chapter.id, direction); onRefresh(); }
  async function handleDelete() {
    if (!(await confirm(`Xoá chương "${chapter.title}" và toàn bộ mục/đoạn văn bên trong?`))) return;
    await api.deleteChapter(chapter.id);
    onRefresh();
  }
  async function handleMoveToPart(e) {
    const val = e.target.value;
    await api.updateChapter(chapter.id, { partId: val === '' ? null : Number(val) });
    onRefresh();
  }
  async function handleAddSection(heading) {
    await api.addSection(chapter.id, { heading });
    setShowAddSection(false);
    if (!toc.isOpen(chapter.id, headed.length > 0)) toc.toggle(chapter.id, headed.length > 0);
    onRefresh();
  }

  // Only headed sections are entries of the TOC, numbered 3.1, 3.2… under
  // a numbered chapter.
  const headed = chapter.sections.filter((s) => s.heading);
  const visible = canEdit ? chapter.sections : headed;
  const canOpen = visible.length > 0 || canEdit;
  const showSections = canOpen && toc.isOpen(chapter.id, headed.length > 0);

  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-1 pr-1 hover:bg-sunken/60">
        {canOpen ? (
          <IconButton label={showSections ? 'Ẩn các mục' : 'Hiện các mục'} onClick={() => toc.toggle(chapter.id, headed.length > 0)} className="!h-7 !w-7">
            {showSections ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </IconButton>
        ) : <span className="w-7 shrink-0" aria-hidden />}

        {renaming ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <input
              autoFocus
              value={titleDraft}
              aria-label="Tên chương (tiếng Anh)"
              placeholder="Tên chương (tiếng Anh)"
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => { if (isSubmitEnter(e)) handleRename(); if (e.key === 'Escape') cancelRename(); }}
              className={`${inputClass} min-w-0 flex-1 basis-56 py-1`}
            />
            <input
              value={titleViDraft}
              aria-label="Tên chương tiếng Việt"
              placeholder="Tên chương tiếng Việt"
              onChange={(e) => setTitleViDraft(e.target.value)}
              onKeyDown={(e) => { if (isSubmitEnter(e)) handleRename(); if (e.key === 'Escape') cancelRename(); }}
              className={`${inputClass} min-w-0 flex-1 basis-56 py-1`}
            />
            <Button size="sm" variant="primary" onClick={handleRename}>Lưu</Button>
            <Button size="sm" variant="ghost" onClick={cancelRename}>Huỷ</Button>
          </div>
        ) : (
          <Link to={`/chapters/${chapter.id}`} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-lead text-ink hover:text-accent">
            <span className="min-w-0">
              <span className="block truncate">{withLabel(chapter.label, chapter.title)}</span>
              {chapter.title_vi && <span className="block truncate text-meta text-mute">{withLabel(chapter.label_vi, chapter.title_vi)}</span>}
            </span>
            {headed.length > 0 && !showSections && <span className="shrink-0 text-caption text-mute">{headed.length} mục</span>}
            {isLastRead && <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-caption font-medium text-accent">Đang đọc</span>}
          </Link>
        )}

        <RowProgress done={chapter.translatedCount} total={chapter.paragraphCount} />

        {!renaming && (
          <RowMenu>
            <MenuItem icon={<Pencil size={14} />} onClick={() => { setTitleViDraft(chapter.title_vi || ''); setRenaming(true); }}>Đổi tên chương</MenuItem>
            <label className="mt-1 block border-t border-rule px-2.5 pb-1.5 pt-2">
              <span className="mb-1 block text-caption text-mute">Loại</span>
              <select value={chapter.kind || 'chapter'} onChange={handleKind} className={`${inputClass} px-2 py-1 text-meta`}>
                {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
            <MenuItem icon={<ArrowUp size={14} />} onClick={() => handleMove('up')} disabled={index === 0}>Chuyển lên</MenuItem>
            <MenuItem icon={<ArrowDown size={14} />} onClick={() => handleMove('down')} disabled={index === total - 1}>Chuyển xuống</MenuItem>
            <label className="mt-1 block border-t border-rule px-2.5 pb-1.5 pt-2">
              <span className="mb-1 block text-caption text-mute">Thuộc phần</span>
              <select value={chapter.part_id ?? ''} onChange={handleMoveToPart} className={`${inputClass} px-2 py-1 text-meta`}>
                <option value="">Không thuộc phần nào</option>
                {parts.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </label>
            <MenuItem icon={<Trash2 size={14} />} onClick={handleDelete} danger>Xoá chương</MenuItem>
          </RowMenu>
        )}
      </div>

      {showSections && (
        <div className="mb-1 ml-9 border-l border-rule pl-1">
          {chapter.sections.map((s, i) => (
            (canEdit || s.heading) && <SectionRow key={s.id} section={s} index={i} total={chapter.sections.length} onRefresh={onRefresh} />
          ))}
          {chapter.sections.length === 0 && <p className="pl-2 text-meta italic text-mute">Chưa có đoạn văn nào.</p>}
          <div className={`pl-1 pr-1 pt-0.5 ${canEdit ? '' : 'hidden'}`}>
            {showAddSection ? (
              <InlineAdd placeholder="Tiêu đề mục mới" submitLabel="Thêm mục" onSubmit={handleAddSection} onCancel={() => setShowAddSection(false)} />
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setShowAddSection(true)} className="-ml-2.5">
                <Plus size={14} /> Thêm mục
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Editors' settings of the book's TOC and filing, above the TOC: its genre
// (thể loại — automatic from its field, genres.js, or picked by hand; the AI
// can suggest one, books.js suggest-genre, which the editor applies or not)
// and how its parts and chapters are numbered (as the printed book does).
function BookTocSettings({ book, onChanged }) {
  const [genres, setGenres] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.listGenres().then((d) => setGenres(d.genres)).catch((err) => { setGenres([]); setError(err.message); });
  }, []);

  async function save(patch) {
    setError('');
    try {
      await api.updateBook(book.id, patch);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  async function pickGenre(genreId) {
    setSuggestion(null);
    await save({ genre_id: genreId });
  }
  async function ask() {
    setAsking(true);
    setSuggestion(null);
    try {
      setSuggestion(await api.suggestBookGenre(book.id));
    } catch (err) {
      setSuggestion({ error: err.message });
    } finally {
      setAsking(false);
    }
  }

  const genreValue = book.genre_manual ? String(book.genre_id) : 'auto';
  const autoName = book.genre_manual ? '' : ` — ${book.genre_name || 'chưa xếp được'}`;
  return (
    <Sheet className="p-4 sm:p-5">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="book-genre" className="mb-1.5 block text-meta font-medium text-soft">Thể loại</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="book-genre"
              value={genreValue}
              disabled={!genres}
              onChange={(e) => pickGenre(e.target.value)}
              className={`${inputClass} min-w-0 flex-1 basis-48`}
            >
              <option value="auto">Tự động{autoName}</option>
              {(genres || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <Button
              variant={book.genre_id ? 'secondary' : 'primary'}
              onClick={ask}
              disabled={asking}
              title="AI đọc tên, lĩnh vực và vài đoạn đầu sách rồi gợi ý một thể loại"
            >
              {asking ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />} Gợi ý bằng AI
            </Button>
          </div>
          <p className="mt-1.5 text-caption text-mute">Tự động theo lĩnh vực của sách. Từ vựng trong sách được xếp vào thể loại này.</p>
        </div>

        <div className="min-w-0">
          <label htmlFor="book-numbering" className="mb-1.5 block text-meta font-medium text-soft">Đánh số phần và chương</label>
          <select
            id="book-numbering"
            value={book.toc_numbering || 'numeric'}
            onChange={(e) => save({ toc_numbering: e.target.value })}
            className={`${inputClass} w-full`}
          >
            {NUMBERING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="mt-1.5 text-caption text-mute">Chọn giống mục lục của sách in. Phần đầu và cuối sách không đánh số.</p>
        </div>
      </div>

      {suggestion && (
        <div role="status" className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-rule bg-sunken px-3 py-2.5 text-body">
          {suggestion.error ? (
            <span className="min-w-0 flex-1 text-flag">{suggestion.error}</span>
          ) : (
            <span className="min-w-0 flex-1 text-soft">
              <Sparkles size={14} className="mr-1.5 inline align-[-2px] text-accent" />
              AI gợi ý <strong className="font-semibold text-ink">{suggestion.name || (suggestion.newName ? `thể loại mới “${suggestion.newName}”` : 'không thể loại nào hợp')}</strong>
              {suggestion.reason && <span className="block text-meta text-mute">{suggestion.reason}</span>}
              {!suggestion.genreId && suggestion.newName && <span className="block text-meta text-mute">Tạo thể loại này ở Kho từ vựng → Quản lý thể loại, rồi chọn lại ở đây.</span>}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {suggestion.genreId && suggestion.genreId !== book.genre_id && (
              <Button size="sm" variant="primary" onClick={() => pickGenre(String(suggestion.genreId))}>Áp dụng</Button>
            )}
            {suggestion.genreId && suggestion.genreId === book.genre_id && <span className="text-meta text-mute">Đang là thể loại của sách</span>}
            <IconButton label="Bỏ gợi ý" onClick={() => setSuggestion(null)}><X size={15} /></IconButton>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-meta text-flag">{error}</p>}
    </Sheet>
  );
}

// A top-level group of the TOC (front matter, the chapters, back matter),
// set like a part heading so the tree reads group → chapter → section.
function TocGroupTitle({ children }) {
  return <p className="pb-1.5 pl-1 font-serif text-heading font-semibold text-ink">{children}</p>;
}

function ChapterGroup({ chapters, parts, lastReadId, onRefresh, nested = false }) {
  return (
    <div className={nested ? 'ml-3 border-l-2 border-rule pl-2' : ''}>
      {chapters.map((c, i) => (
        <ChapterRow key={c.id} chapter={c} index={i} total={chapters.length} parts={parts} isLastRead={c.id === lastReadId} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

function PartBlock({ part, index, total, bookId, allParts, lastReadId, onRefresh }) {
  const confirm = useConfirm();
  const canEdit = useAuth().can('books.edit');
  const toc = useContext(TocOpenContext);
  const partKey = `part-${part.id}`;
  const collapsed = !toc.isOpen(partKey, true);
  const [showAddChapter, setShowAddChapter] = useState(false);

  async function handleRename(title) { if (title.trim()) await api.updatePart(part.id, { title: title.trim() }); onRefresh(); }
  async function handleRenameVi(titleVi) { await api.updatePart(part.id, { title_vi: titleVi.trim() }); onRefresh(); }
  async function handleMove(direction) { await api.movePart(part.id, direction); onRefresh(); }
  async function handleDelete() {
    if (!(await confirm(`Xoá phần "${part.title}"? Các chương bên trong sẽ chuyển về nhóm "Khác", không bị xoá.`))) return;
    await api.deletePart(part.id);
    onRefresh();
  }
  async function handleAddChapter(title) {
    await api.addChapter(bookId, { title, partId: part.id });
    setShowAddChapter(false);
    onRefresh();
  }

  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5 pb-1.5 pl-1 pr-1">
        <IconButton label={collapsed ? 'Mở phần' : 'Thu gọn phần'} onClick={() => toc.toggle(partKey, true)} className="!h-7 !w-7">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col items-stretch">
          <div className="flex min-w-0 items-baseline gap-1.5 font-serif text-heading font-semibold text-ink">
            {part.label && <span className="shrink-0">{part.label}:</span>}
            <InlineEditableText value={part.title} onSave={handleRename} placeholder="Tên phần" className="font-serif text-heading font-semibold text-ink" />
          </div>
          {(canEdit || part.title_vi) && (
            <div className="flex min-w-0 items-baseline gap-1.5 text-meta text-mute">
              {part.label_vi && <span className="shrink-0">{part.label_vi}:</span>}
              <InlineEditableText value={part.title_vi} onSave={handleRenameVi} placeholder="tên phần tiếng Việt" className="text-meta text-mute" />
            </div>
          )}
        </div>
        <span className="shrink-0 text-caption text-mute">{part.chapters.length} chương</span>
        <RowMenu>
          <MenuItem icon={<ArrowUp size={14} />} onClick={() => handleMove('up')} disabled={index === 0}>Chuyển lên</MenuItem>
          <MenuItem icon={<ArrowDown size={14} />} onClick={() => handleMove('down')} disabled={index === total - 1}>Chuyển xuống</MenuItem>
          <MenuItem icon={<Trash2 size={14} />} onClick={handleDelete} danger>Xoá phần</MenuItem>
        </RowMenu>
      </div>

      {!collapsed && (
        <>
          <ChapterGroup nested chapters={part.chapters} parts={allParts} lastReadId={lastReadId} onRefresh={onRefresh} />
          <div className={`pl-12 pr-1 pt-1 ${canEdit ? '' : 'hidden'}`}>
            {showAddChapter ? (
              <InlineAdd placeholder="Tên chương mới" submitLabel="Thêm chương" onSubmit={handleAddChapter} onCancel={() => setShowAddChapter(false)} />
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setShowAddChapter(true)} className="-ml-2.5">
                <Plus size={14} /> Thêm chương vào phần này
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const MARK_TABS = [
  { key: 'review', label: 'Xem lại', Icon: Flag, match: (m) => m.is_flagged },
  { key: 'highlight', label: 'Highlight', Icon: Highlighter, match: (m) => m.is_highlighted },
  { key: 'bookmarks', label: 'Bookmark', Icon: Bookmark, match: (m) => m.is_bookmarked },
];

function MarksPanel({ marks }) {
  const [tab, setTab] = useState('review');
  const groups = Object.fromEntries(MARK_TABS.map((t) => [t.key, marks.filter(t.match)]));
  const active = groups[tab] || [];

  return (
    <div className="space-y-4">
      <Segmented
        label="Loại đánh dấu"
        size="sm"
        className="max-w-full"
        value={tab}
        onChange={setTab}
        options={MARK_TABS.map(({ key, label, Icon }) => ({
          key,
          icon: <Icon size={13} />,
          label: <>{label} <span className="tabular-nums text-mute">{groups[key].length}</span></>,
        }))}
      />
      {active.length === 0 ? (
        <p className="text-body text-mute">Chưa có đoạn nào. Khi đọc, rê chuột vào một đoạn để đánh dấu.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {active.map((m) => (
            <li key={m.id}>
              <Link
                to={`/chapters/${m.chapter_id}#paragraph-${m.id}`}
                className="block h-full rounded-lg border border-rule bg-page px-4 py-3 hover:border-mute"
              >
                <span className="block text-caption text-mute">{m.chapter_title}</span>
                <span className="mt-1 line-clamp-3 font-serif text-body leading-snug text-ink">{previewText(m.english_md)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The few facts a reader wants at a glance, shortened from the full
// publication fields ("2004 (Knopf Canada)" → 2004). The full values stay in
// the Thông tin sách tab.
function keyFacts(book) {
  const short = (s) => (s || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const year = `${book.original_year || ''} ${book.publish_date || ''}`.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[0];
  const pages = (book.page_count || '').match(/\d[\d.,]*/)?.[0];
  const rating = (book.rating || '').match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/)?.[1];
  return [
    book.genre_name && { label: 'Thể loại', value: book.genre_name },
    book.domain && { label: 'Lĩnh vực', value: book.domain },
    year && { label: 'Xuất bản', value: year },
    pages && { label: 'Số trang', value: pages },
    book.language && { label: 'Ngôn ngữ', value: short(book.language) },
    rating && { label: 'Đánh giá', value: <><Star size={15} className="-mt-0.5 inline fill-warn text-warn" /> {rating}/5</> },
    book.publisher && { label: 'Nhà xuất bản', value: short(book.publisher) },
  ].filter(Boolean);
}

function KeyFacts({ book }) {
  const facts = keyFacts(book);
  if (!facts.length) return null;
  return (
    <dl className="flex flex-wrap gap-y-3">
      {facts.map((f) => (
        <div key={f.label} className="min-w-0 pr-6 sm:border-l sm:border-rule sm:px-4 sm:first:border-l-0 sm:first:pl-0">
          <dt className="text-caption text-mute">{f.label}</dt>
          <dd className="mt-0.5 max-w-[16rem] truncate font-serif text-lead font-semibold text-ink">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// The book's field, specialty and context: what the AI is told when it
// translates, explains words or answers questions about this book.
function BookContext({ book, canEdit, onEdit }) {
  const filled = BOOK_CONTEXT_FIELDS.filter((f) => book[f.key]?.trim());
  return (
    <Sheet className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-serif text-heading font-semibold text-ink">Ngữ cảnh sách</h2>
        {canEdit && <Button size="sm" variant="ghost" onClick={() => onEdit()}><Pencil size={14} /> Sửa</Button>}
      </div>
      <p className="mt-1 text-meta text-mute">AI dùng phần này để chọn thuật ngữ đúng chuyên môn khi dịch, giải nghĩa từ và trả lời câu hỏi.</p>
      {filled.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-dashed border-rule px-4 py-3">
          <p className="text-body text-soft">Chưa có lĩnh vực và chuyên môn của sách.</p>
          {canEdit && <Button size="sm" onClick={() => onEdit({ suggest: true })}><Sparkles size={14} /> Gợi ý bằng AI</Button>}
        </div>
      ) : (
        <dl className="mt-4 space-y-3">
          {filled.map((f) => (
            <div key={f.key}>
              <dt className="text-meta text-mute">{f.label}</dt>
              <dd className="mt-0.5 text-body leading-relaxed text-ink">{book[f.key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </Sheet>
  );
}

function BookDetails({ book, canEdit, onEdit }) {
  const fields = BOOK_META_FIELDS.filter((f) => !['title_en', 'title_vi', 'author', 'amazon_url'].includes(f.key) && book[f.key]);
  return (
    <Sheet className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-serif text-heading font-semibold text-ink">Chi tiết xuất bản</h2>
        {canEdit && <Button size="sm" variant="ghost" onClick={() => onEdit()}><Pencil size={14} /> Sửa thông tin</Button>}
      </div>
      {fields.length === 0 ? (
        <p className="mt-3 text-body text-mute">Chưa có thông tin xuất bản.</p>
      ) : (
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-meta text-mute">{f.label}</dt>
              <dd className="mt-0.5 break-words text-body text-ink">{book[f.key]}</dd>
            </div>
          ))}
        </dl>
      )}
      {book.amazon_url && (
        <a href={book.amazon_url} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm', 'mt-5')}>
          <ExternalLink size={14} /> Xem trên Amazon
        </a>
      )}
    </Sheet>
  );
}

function BookMetaForm({ bookId, draft, setDraft, prompts, onSave, onCancel, suggestOnOpen = false }) {
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState('');

  async function suggest() {
    setSuggesting(true);
    setSuggestError('');
    try {
      const s = await api.suggestBookContext(bookId);
      // Fill only the fields the AI answered, keeping anything typed.
      setDraft((d) => ({ ...d, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v)) }));
    } catch (e) {
      setSuggestError(e.message);
    } finally {
      setSuggesting(false);
    }
  }

  useEffect(() => { if (suggestOnOpen) suggest(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet className="p-5 sm:p-6">
      <h2 className="font-serif text-heading font-semibold text-ink">Sửa thông tin sách</h2>

      <div className="mt-4 rounded-md border border-rule bg-sunken/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body font-semibold text-ink">Ngữ cảnh sách</p>
          <Button size="sm" onClick={suggest} disabled={suggesting}>
            {suggesting ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />} Gợi ý bằng AI
          </Button>
        </div>
        {suggestError && <p className="mt-2 text-caption text-flag">{suggestError}</p>}
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {BOOK_CONTEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} className={f.multiline ? 'sm:col-span-2' : ''}>
              {f.multiline ? (
                <textarea
                  rows={3}
                  value={draft[f.key] || ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className={inputClass}
                />
              ) : (
                <input
                  value={draft[f.key] || ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  className={inputClass}
                />
              )}
            </Field>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {BOOK_META_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              value={draft[f.key] || ''}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              className={inputClass}
            />
          </Field>
        ))}
        <Field label="Prompt dịch (loại sách)" hint="Sách chưa gán sẽ dùng prompt mặc định trong Cài đặt.">
          <select
            value={draft.prompt_template_id || ''}
            onChange={(e) => setDraft((d) => ({ ...d, prompt_template_id: e.target.value ? Number(e.target.value) : null }))}
            className={inputClass}
          >
            <option value="">Mặc định (theo Cài đặt)</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (mặc định)' : ''}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={onSave}>Lưu thông tin</Button>
        <Button variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </Sheet>
  );
}

// The translation side of the book: progress and, for editors, which prompt
// it is translated with.
function TranslationCard({ chapters, translated, total, pct, promptName, canEdit }) {
  return (
    <Sheet className="space-y-4 p-5">
      <h2 className="font-serif text-heading font-semibold text-ink">Bản dịch</h2>
      <div>
        <Progress value={pct} tone={pct === 100 ? 'ok' : 'accent'} />
        <p className="mt-1.5 text-meta tabular-nums text-soft">{translated}/{total} đoạn ({pct}%) trong {chapters} chương</p>
      </div>
      {canEdit && (
        <div>
          <p className="text-meta text-mute">Prompt dịch</p>
          <p className="mt-0.5 text-body text-ink">{promptName}</p>
        </div>
      )}
    </Sheet>
  );
}

const BOOK_TABS = ['contents', 'info', 'marks', 'team'];

export default function BookPage() {
  const { can } = useAuth();
  const canEdit = can('books.edit');
  const canMark = can('marks.own');
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  const [editingMeta, setEditingMeta] = useState(false);
  const [suggestOnOpen, setSuggestOnOpen] = useState(false);
  const [metaDraft, setMetaDraft] = useState({});
  const [adding, setAdding] = useState(null); // 'part' | 'chapter' | null
  // Which parts and chapters are open in the TOC. 'auto': every part, and
  // the chapters that have headed sections; 'all' / 'none' after "Mở tất
  // cả" / "Thu gọn"; a click on one row's arrow overrides it for that row.
  const [tocMode, setTocMode] = useState({ mode: 'auto', overrides: new Map() });
  const tocOpen = useMemo(() => ({
    isOpen: (chapterId, byDefault) => (tocMode.overrides.has(chapterId) ? tocMode.overrides.get(chapterId)
      : tocMode.mode === 'all' ? true : tocMode.mode === 'none' ? false : byDefault),
    toggle: (chapterId, byDefault) => setTocMode((prev) => {
      const overrides = new Map(prev.overrides);
      const open = overrides.has(chapterId) ? overrides.get(chapterId) : prev.mode === 'all' ? true : prev.mode === 'none' ? false : byDefault;
      overrides.set(chapterId, !open);
      return { ...prev, overrides };
    }),
  }), [tocMode]);
  const [marks, setMarks] = useState([]);
  const [prompts, setPrompts] = useState([]);

  // The open tab lives in the URL (?tab=info), so a link or the back button
  // returns to the same view.
  const requestedTab = searchParams.get('tab');
  const tab = BOOK_TABS.includes(requestedTab) && (requestedTab !== 'marks' || canMark) ? requestedTab : 'contents';
  const setTab = (key) => setSearchParams(key === 'contents' ? {} : { tab: key }, { replace: true });

  const refresh = useCallback(() => {
    api.getBook(id).then((b) => { setBook(b); setMetaDraft(b); notifyBookChanged(); }).catch((e) => setError(e.message));
    if (can('marks.own')) api.getBookMarks(id).then(setMarks).catch(() => {});
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setBook(null); refresh(); }, [id, refresh]);
  useEffect(() => { if (canEdit) api.listPrompts().then(setPrompts).catch(() => {}); }, [canEdit]);

  function startEditMeta(options) {
    setMetaDraft(book);
    setSuggestOnOpen(Boolean(options?.suggest));
    setEditingMeta(true);
    setTab('info');
  }

  async function handleSaveMeta() {
    // the genre and numbering have their own controls; sending them back
    // here would turn an automatic genre into a hand-picked one
    const { genre_id: _genre, genre_manual: _manual, toc_numbering: _numbering, ...draft } = metaDraft;
    const updated = await api.updateBook(id, draft);
    setBook((b) => ({ ...b, ...updated }));
    setEditingMeta(false);
    notifyBookChanged();
  }

  async function handleDeleteBook() {
    if (!(await confirm('Xoá toàn bộ sách này (mọi chương/đoạn văn sẽ mất, từ vựng đã lưu vẫn giữ lại)?'))) return;
    await api.deleteBook(id);
    navigate('/library');
  }

  async function handleAddPart(title) {
    await api.addPart(id, title);
    setAdding(null);
    refresh();
  }

  async function handleAddChapter(title) {
    const chapter = await api.addChapter(id, { title, partId: null });
    setAdding(null);
    navigate(`/chapters/${chapter.id}`);
  }

  if (error) return <PageContainer><Notice>{error}</Notice></PageContainer>;
  if (!book) return <LoadingLine />;

  const allChapters = [...book.chaptersWithoutPart, ...book.parts.flatMap((p) => p.chapters)];
  const toc = tocGroups(book);
  const totalParagraphs = allChapters.reduce((n, c) => n + c.paragraphCount, 0);
  const translatedParagraphs = allChapters.reduce((n, c) => n + c.translatedCount, 0);
  const pct = percent(translatedParagraphs, totalParagraphs);

  // Resume where reading stopped; otherwise the first chapter still waiting
  // for translation; otherwise simply the first chapter.
  const lastRead = getLastRead(book.id);
  const resumeChapter = allChapters.find((c) => c.id === lastRead?.chapterId)
    || [...book.parts.flatMap((p) => p.chapters), ...book.chaptersWithoutPart].find((c) => c.translatedCount < c.paragraphCount)
    || book.parts[0]?.chapters[0]
    || book.chaptersWithoutPart[0];
  const isResuming = resumeChapter && resumeChapter.id === lastRead?.chapterId;

  const promptName = book.prompt_template_id
    ? prompts.find((p) => p.id === book.prompt_template_id)?.name || 'Không rõ'
    : 'Mặc định (theo Cài đặt)';

  const tabs = [
    { key: 'contents', label: 'Mục lục', count: allChapters.length },
    { key: 'info', label: 'Thông tin sách' },
    ...(canMark ? [{ key: 'marks', label: 'Đánh dấu của tôi', count: marks.length }] : []),
    { key: 'team', label: 'Nhóm dịch' },
  ];

  return (
    <PageContainer className="space-y-8">
      <Link to="/library" className="inline-flex items-center gap-1.5 text-body font-medium text-soft hover:text-accent">
        <ArrowLeft size={16} /> Thư viện
      </Link>

      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
        <BookCoverEditor book={book} canEdit={canEdit} onChange={(fields) => { setBook((b) => ({ ...b, ...fields })); notifyBookChanged(); }} />
        <div className="min-w-0 flex-1 space-y-5">
          <div>
            <h1 className="font-serif text-display font-semibold leading-tight text-ink">{book.title_vi || book.title_en}</h1>
            {book.title_vi && <p className="mt-1.5 font-serif text-lead italic text-soft">{book.title_en}</p>}
            {book.author && <p className="mt-2 text-body text-soft">{book.author}</p>}
          </div>

          <KeyFacts book={book} />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            {resumeChapter && (
              <Link to={isResuming ? readingHref(lastRead) : `/chapters/${resumeChapter.id}`} className={buttonClass('primary', 'lg')}>
                <BookOpen size={17} className="shrink-0" /> {isResuming ? 'Đọc tiếp' : 'Bắt đầu đọc'}
              </Link>
            )}
            {totalParagraphs > 0 && (
              <div className="min-w-0 max-w-sm flex-1 basis-56">
                <Progress value={pct} tone={pct === 100 ? 'ok' : 'accent'} />
                <p className="mt-1.5 truncate text-meta text-mute" title={resumeChapter?.title}>
                  {isResuming
                    ? <>Đang đọc: <span className="text-soft">{resumeChapter.title}</span></>
                    : <span className="tabular-nums">Đã dịch {translatedParagraphs}/{totalParagraphs} đoạn ({pct}%)</span>}
                </p>
              </div>
            )}
            {canEdit && (
              <Popover
                label="Thao tác khác với sách"
                width="w-48"
                triggerClassName="h-11 w-11 justify-center rounded-md border border-rule bg-page text-soft hover:border-mute hover:text-ink"
                trigger={<EllipsisVertical size={18} />}
              >
                <MenuItem icon={<Pencil size={14} />} onClick={() => startEditMeta()}>Sửa thông tin</MenuItem>
                <MenuItem icon={<Trash2 size={14} />} onClick={handleDeleteBook} danger>Xoá sách</MenuItem>
              </Popover>
            )}
          </div>
        </div>
      </header>

      <div className="space-y-6">
        <Tabs label="Nội dung trang sách" tabs={tabs} value={tab} onChange={setTab} />

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'contents' && (
            <section className="min-w-0 space-y-4">
              {canEdit && <BookTocSettings book={book} onChanged={refresh} />}

              <div className="flex flex-wrap items-center gap-2">
                {(allChapters.length > 0 || book.parts.length > 0) && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setTocMode({ mode: 'all', overrides: new Map() })}><ChevronDown size={14} /> Mở tất cả</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTocMode({ mode: 'none', overrides: new Map() })}><ChevronRight size={14} /> Thu gọn</Button>
                  </>
                )}
                {canEdit && (
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" onClick={() => setAdding(adding === 'part' ? null : 'part')}><Plus size={14} /> Phần</Button>
                    <Button size="sm" onClick={() => setAdding(adding === 'chapter' ? null : 'chapter')}><Plus size={14} /> Chương</Button>
                  </div>
                )}
              </div>

              {adding === 'part' && (
                <InlineAdd placeholder="Tên phần mới (vd. Part 1: ...)" submitLabel="Tạo phần" onSubmit={handleAddPart} onCancel={() => setAdding(null)} />
              )}
              {adding === 'chapter' && (
                <InlineAdd placeholder="Tên chương mới (chưa thuộc phần nào)" submitLabel="Tạo chương" onSubmit={handleAddChapter} onCancel={() => setAdding(null)} />
              )}

              {allChapters.length === 0 && book.parts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-rule px-6 py-10 text-center">
                  <p className="font-serif text-heading font-semibold text-ink">Sách chưa có chương nào</p>
                  {canEdit && <p className="mt-1.5 text-body text-soft">Tạo chương đầu tiên rồi dán đoạn văn tiếng Anh vào để bắt đầu dịch.</p>}
                  {canEdit && <Button variant="primary" className="mt-4" onClick={() => setAdding('chapter')}><Plus size={16} /> Tạo chương</Button>}
                </div>
              ) : (
                <TocOpenContext.Provider value={tocOpen}>
                <Sheet className="space-y-5 p-4 sm:p-5">
                  {toc.front.length > 0 && (
                    <div>
                      <TocGroupTitle>Phần đầu sách</TocGroupTitle>
                      <ChapterGroup nested chapters={toc.front} parts={book.parts} lastReadId={lastRead?.chapterId} onRefresh={refresh} />
                    </div>
                  )}

                  {book.parts.map((part, i) => (
                    <PartBlock key={part.id} part={part} index={i} total={book.parts.length} bookId={id} allParts={book.parts} lastReadId={lastRead?.chapterId} onRefresh={refresh} />
                  ))}

                  {toc.body.length > 0 && (
                    <div>
                      {(book.parts.length > 0 || toc.front.length > 0 || toc.back.length > 0) && (
                        <TocGroupTitle>{book.parts.length > 0 ? 'Chương không thuộc phần nào' : 'Các chương'}</TocGroupTitle>
                      )}
                      <ChapterGroup nested={book.parts.length > 0 || toc.front.length > 0 || toc.back.length > 0} chapters={toc.body} parts={book.parts} lastReadId={lastRead?.chapterId} onRefresh={refresh} />
                    </div>
                  )}

                  {toc.back.length > 0 && (
                    <div>
                      <TocGroupTitle>Phần cuối sách</TocGroupTitle>
                      <ChapterGroup nested chapters={toc.back} parts={book.parts} lastReadId={lastRead?.chapterId} onRefresh={refresh} />
                    </div>
                  )}
                </Sheet>
                </TocOpenContext.Provider>
              )}
            </section>
          )}

          {tab === 'info' && (
            <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
              {editingMeta ? (
                <BookMetaForm
                  bookId={book.id}
                  suggestOnOpen={suggestOnOpen}
                  draft={metaDraft}
                  setDraft={setMetaDraft}
                  prompts={prompts}
                  onSave={handleSaveMeta}
                  onCancel={() => { setMetaDraft(book); setEditingMeta(false); }}
                />
              ) : (
                <div className="min-w-0 space-y-6">
                  <BookContext book={book} canEdit={canEdit} onEdit={startEditMeta} />
                  <BookDetails book={book} canEdit={canEdit} onEdit={startEditMeta} />
                </div>
              )}
              <div className="min-w-0 space-y-6">
                <TranslationCard
                  chapters={allChapters.length}
                  translated={translatedParagraphs}
                  total={totalParagraphs}
                  pct={pct}
                  promptName={promptName}
                  canEdit={canEdit}
                />
                <BookAccess bookId={book.id} />
              </div>
            </div>
          )}

          {tab === 'marks' && canMark && <MarksPanel marks={marks} />}
          {tab === 'team' && <BookTeam book={book} />}
        </div>
      </div>
    </PageContainer>
  );
}
