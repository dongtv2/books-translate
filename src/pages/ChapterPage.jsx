import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, PenLine, ALargeSmall, Languages, Plus, Trash2, Check } from 'lucide-react';
import { api } from '../api.js';
import { notifyBookChanged, notifyActiveSection } from '../lib/bookEvents.js';
import { recordLastRead } from '../lib/lastRead.js';
import SectionBlock from '../components/SectionBlock.jsx';
import TranslationProgress from '../components/TranslationProgress.jsx';
import ChapterEnd from '../components/ChapterEnd.jsx';
import { VocabHintsProvider } from '../components/VocabHints.jsx';
import { AssistantProvider, AssistantPanel, useAssistant } from '../components/AssistantPanel.jsx';
import { ChapterVocabProvider } from '../components/ParagraphVocab.jsx';
import { DiscussionProvider, DiscussionPanel, ChapterThreadsProvider, useDiscussion } from '../components/TermDiscussion.jsx';
import TermSelectionButton from '../components/TermSelectionButton.jsx';
import InlineTitle from '../components/InlineTitle.jsx';
import { Button, Notice, Popover, Progress, Segmented, LoadingLine, inputClass } from '../components/ui.jsx';
import { useSequentialTranslate } from '../hooks/useSequentialTranslate.js';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { useLayoutSettings, contentWidthClass, CONTENT_WIDTH_OPTIONS, FONT_SIZE_OPTIONS } from '../context/LayoutSettingsContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const VIEW_MODES = [
  { key: 'read', label: 'Đọc', icon: <BookOpen size={15} /> },
  { key: 'edit', label: 'Chỉnh sửa', icon: <PenLine size={15} /> },
];

const READING_FONTS = [
  { key: 'serif', label: 'Literata' },
  { key: 'sans', label: 'Be Vietnam Pro' },
];

// How the chapter is displayed. Lives next to the text it changes instead
// of only in Settings, so a tweak can be judged against the page at once.
function DisplayPopover() {
  const { settings, updateSettings } = useLayoutSettings();
  return (
    <Popover
      label="Hiển thị"
      width="w-72"
      triggerClassName="h-8 gap-1.5 rounded-md border border-rule bg-page px-2.5 text-body font-medium text-soft hover:border-mute hover:text-ink"
      trigger={<><ALargeSmall size={17} /><span className="hidden sm:inline">Hiển thị</span></>}
    >
      <div className="space-y-4 p-2.5">
        <div>
          <p className="mb-1.5 text-meta font-medium text-soft">Cỡ chữ · áp dụng cho cả hai cột</p>
          <Segmented size="sm" label="Cỡ chữ" options={FONT_SIZE_OPTIONS} value={settings.fontSize} onChange={(fontSize) => updateSettings({ fontSize })} />
        </div>
        <div>
          <p className="mb-1.5 text-meta font-medium text-soft">Font · dùng chung Anh–Việt</p>
          <Segmented size="sm" label="Kiểu chữ" options={READING_FONTS} value={settings.readingFont} onChange={(readingFont) => updateSettings({ readingFont })} />
        </div>
        <div>
          <p className="mb-1.5 text-meta font-medium text-soft">Độ rộng trang</p>
          <Segmented size="sm" label="Độ rộng trang" options={CONTENT_WIDTH_OPTIONS} value={settings.contentWidth} onChange={(contentWidth) => updateSettings({ contentWidth })} />
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-meta font-medium text-soft">
          Hiện cột ghi chú
          <input
            type="checkbox"
            checked={settings.showNotes !== false}
            onChange={(e) => updateSettings({ showNotes: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-meta font-medium text-soft">
          Đánh dấu chỗ đang thảo luận
          <input
            type="checkbox"
            checked={settings.showThreadMarks !== false}
            onChange={(e) => updateSettings({ showThreadMarks: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-meta font-medium text-soft">
          Đánh dấu từ đã có trong kho
          <input
            type="checkbox"
            checked={settings.showVocabHints !== false}
            onChange={(e) => updateSettings({ showVocabHints: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>
      </div>
    </Popover>
  );
}

export default function ChapterPage() {
  return (
    <AssistantProvider>
      <DiscussionProvider>
        <ChapterView />
      </DiscussionProvider>
    </AssistantProvider>
  );
}

function ChapterView() {
  const { id } = useParams();
  const assistant = useAssistant();
  const discussion = useDiscussion();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirm();
  const { settings, updateSettings } = useLayoutSettings();
  const { can } = useAuth();
  const canEdit = can('books.edit');
  const canTranslate = can('translate.run');
  // Without books.edit the chapter is always in reading mode.
  const readMode = !canEdit || settings.chapterViewMode !== 'edit';
  const { progress, run, cancel, reset } = useSequentialTranslate();
  const [chapter, setChapter] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [reexplainAll, setReexplainAll] = useState(false);
  const [showAddSection, setShowAddSection] = useState(false);
  const [newHeading, setNewHeading] = useState('');
  const [newText, setNewText] = useState('');
  const [showAddParagraph, setShowAddParagraph] = useState(false);
  const [newParagraphText, setNewParagraphText] = useState('');
  const [addingParagraph, setAddingParagraph] = useState(false);

  const refresh = useCallback(() => {
    api.getChapter(id).then((c) => { setChapter(c); notifyBookChanged(); }).catch((e) => setLoadError(e.message));
  }, [id]);

  useEffect(() => { setChapter(null); setLoadError(''); setError(''); reset(); refresh(); }, [id, refresh, reset]);

  // Remember this chapter as the place to resume from.
  useEffect(() => {
    if (chapter) recordLastRead({ bookId: chapter.book.id, chapterId: chapter.id, chapterTitle: chapter.title });
  }, [chapter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ...and, as the reader scrolls, the paragraph they are at (the topmost one
  // in view), saved once they settle, so "Đọc tiếp" lands on it next time.
  useEffect(() => {
    if (!chapter) return undefined;
    const rows = Array.from(document.querySelectorAll('.para-row[id^="paragraph-"]'));
    if (!rows.length) return undefined;
    let timer = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const paragraphId = Number(visible[0].target.id.replace('paragraph-', ''));
      clearTimeout(timer);
      timer = setTimeout(() => recordLastRead({ bookId: chapter.book.id, chapterId: chapter.id, chapterTitle: chapter.title, paragraphId }), 1500);
    }, { rootMargin: '-120px 0px -55% 0px' });
    rows.forEach((el) => observer.observe(el));
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [chapter]);

  // How far through the chapter the reader is, for the thin bar under the
  // toolbar.
  const [readProgress, setReadProgress] = useState(0);
  useEffect(() => {
    if (!chapter) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      setReadProgress(max > 0 ? Math.min(100, Math.round((window.scrollY / max) * 100)) : 100);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame); };
  }, [chapter]);

  // ← / → move to the previous / next chapter, unless the reader is typing
  // in a field or editor (where the arrows move the caret).
  useEffect(() => {
    if (!chapter) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = e.target?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return;
      if (e.key === 'ArrowLeft' && chapter.prevChapter) navigate(`/chapters/${chapter.prevChapter.id}`);
      if (e.key === 'ArrowRight' && chapter.nextChapter) navigate(`/chapters/${chapter.nextChapter.id}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, navigate]);

  // Links from a book's marked-paragraph list arrive as #paragraph-<id>, but
  // the paragraphs only exist once the chapter has loaded, so the browser's
  // own hash scrolling has nothing to land on. Do it after the first render,
  // as a jump: the target can be thousands of pixels down a long chapter.
  useEffect(() => {
    if (!chapter || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [chapter?.id, location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll-spy: tells the persistent Sidebar which section heading is
  // currently in view so its ToC can highlight the matching entry.
  useEffect(() => {
    if (!chapter) return undefined;
    const elements = Array.from(document.querySelectorAll('section[id^="section-"]'));
    if (elements.length === 0) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        notifyActiveSection(Number(visible[0].target.id.replace('section-', '')));
      },
      { rootMargin: '-96px 0px -70% 0px', threshold: [0, 1] }
    );
    elements.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      notifyActiveSection(null);
    };
  }, [chapter?.id, chapter?.sections?.length]);

  // A link from the discussions list (?thread=<id>) opens that thread.
  const threadParam = Number(searchParams.get('thread'));
  useEffect(() => {
    if (!chapter || !threadParam) return;
    const t = chapter.threads?.find((x) => x.id === threadParam);
    if (t) discussion.open(t.paragraph_id, { threadId: t.id });
    setSearchParams((p) => { p.delete('thread'); return p; }, { replace: true });
  }, [chapter?.id, threadParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // A thread opened, decided, reopened or deleted in the panel.
  const updateThread = useCallback((t) => {
    setChapter((c) => c && {
      ...c,
      threads: t.removed
        ? c.threads.filter((x) => x.id !== t.id)
        : [...(c.threads || []).filter((x) => x.id !== t.id), t],
    });
  }, []);

  // Words added or edited from a paragraph editor (ParagraphVocab).
  const setKnownTerms = useCallback((update) => {
    setChapter((c) => c && { ...c, knownTerms: update(c.knownTerms || []) });
  }, []);

  function applyParagraphUpdate(updated) {
    setChapter((c) => c && {
      ...c,
      sections: c.sections.map((s) =>
        s.id === updated.section_id
          ? { ...s, paragraphs: s.paragraphs.map((p) => (p.id === updated.id ? updated : p)) }
          : s
      ),
    });
  }

  async function handleTranslatePending() {
    setError('');
    const pending = chapter.sections.flatMap((s) => s.paragraphs.filter((p) => p.status === 'pending'));
    if (pending.length === 0) return;
    try {
      await run(pending, { reexplainAll, onParagraphDone: applyParagraphUpdate });
      notifyBookChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  // One request at a time: a double click used to add the section twice.
  const [addingSection, setAddingSection] = useState(false);
  async function handleAddSection() {
    if (addingSection) return;
    setAddingSection(true);
    setError('');
    try {
      await api.addSection(id, { heading: newHeading, text: newText });
      setNewHeading('');
      setNewText('');
      setShowAddSection(false);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingSection(false);
    }
  }

  // Adds paragraphs directly to the chapter (reusing its first/headless
  // section behind the scenes) — no need to think about "mục nhỏ" at all
  // for the common case of just appending more content to this chapter.
  async function handleAddParagraphToChapter() {
    if (!newParagraphText.trim()) return;
    setAddingParagraph(true);
    setError('');
    try {
      await api.addParagraphsToChapter(id, newParagraphText);
      setNewParagraphText('');
      setShowAddParagraph(false);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingParagraph(false);
    }
  }

  async function handleRenameChapter(title) {
    if (!title) throw new Error('empty');
    await api.updateChapter(chapter.id, { title });
    setChapter((c) => c && { ...c, title });
    notifyBookChanged();
  }

  async function handleRenameChapterVi(titleVi) {
    await api.updateChapter(chapter.id, { title_vi: titleVi });
    setChapter((c) => c && { ...c, title_vi: titleVi });
    notifyBookChanged();
  }

  async function handleDeleteChapter() {
    if (!(await confirm('Xoá toàn bộ chương này (và mọi đoạn văn bên trong)?'))) return;
    await api.deleteChapter(id);
    navigate(`/books/${chapter.book.id}`);
  }

  if (loadError) return <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8"><Notice>{loadError}</Notice></div>;
  if (!chapter) return <LoadingLine />;

  const paragraphs = chapter.sections.flatMap((s) => s.paragraphs);
  const pendingCount = paragraphs.filter((p) => p.status === 'pending').length;
  const translatedCount = paragraphs.length - pendingCount;
  const pct = paragraphs.length > 0 ? Math.round((translatedCount / paragraphs.length) * 100) : 0;
  const translating = Boolean(progress && !progress.finished);
  const widthClass = contentWidthClass(settings.contentWidth);

  // The paragraph the assistant is open for, and its number in the chapter.
  const assistantIndex = assistant.openId ? paragraphs.findIndex((p) => p.id === assistant.openId) : -1;
  const discussionIndex = discussion.openId ? paragraphs.findIndex((p) => p.id === discussion.openId) : -1;

  return (
    <div className={`${settings.readingFont === 'sans' ? 'reading-sans' : ''} ${assistantIndex >= 0 || discussionIndex >= 0 ? 'xl:pr-[460px]' : ''}`}>
      <TermSelectionButton />
      {discussionIndex >= 0 && (
        <DiscussionPanel
          key={discussion.state.key}
          paragraph={paragraphs[discussionIndex]}
          index={discussionIndex}
          onThreadsChanged={updateThread}
        />
      )}
      {assistantIndex >= 0 && (
        <AssistantPanel
          key={assistant.openId}
          paragraph={paragraphs[assistantIndex]}
          index={assistantIndex}
          onParagraphUpdated={applyParagraphUpdate}
        />
      )}
      <div className="sticky top-12 z-20 border-b border-rule bg-page/95 backdrop-blur lg:top-0">
        <div
          role="progressbar"
          aria-label="Đã đọc trong chương"
          aria-valuenow={readProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-accent transition-transform duration-150"
          style={{ transform: `scaleX(${readProgress / 100})` }}
        />
        <div className={`mx-auto flex h-14 items-center gap-3 px-4 sm:px-8 ${widthClass}`}>
          <Link
            to={`/books/${chapter.book.id}`}
            title="Về trang sách"
            className="flex min-w-0 items-center gap-2 text-body font-medium text-soft hover:text-accent"
          >
            <ArrowLeft size={17} className="shrink-0" />
            <span className="truncate">{chapter.book.title_vi || chapter.book.title_en}</span>
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {paragraphs.length > 0 && (
              <div className="hidden items-center gap-2 pr-1 md:flex" title={`${translatedCount}/${paragraphs.length} đoạn đã dịch`}>
                <Progress value={pct} tone={pct === 100 ? 'ok' : 'accent'} className="w-20" />
                <span className="text-caption tabular-nums text-mute">{translatedCount}/{paragraphs.length}</span>
              </div>
            )}
            {canEdit && <Segmented
              label="Chế độ xem"
              options={VIEW_MODES.map((m) => ({ ...m, label: <span className="hidden sm:inline">{m.label}</span>, hint: m.label }))}
              value={readMode ? 'read' : 'edit'}
              onChange={(chapterViewMode) => updateSettings({ chapterViewMode })}
            />}
            <DisplayPopover />
          </div>
        </div>
      </div>

      <div className={`mx-auto space-y-8 px-4 pb-16 pt-8 sm:px-8 ${widthClass}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          {readMode ? (
            <div className="max-w-4xl">
              {chapter.label && <p className="mb-1 text-meta font-medium uppercase tracking-wide text-mute">{chapter.label}{chapter.label_vi ? ` · ${chapter.label_vi}` : ''}</p>}
              <h1 className="font-serif text-display font-semibold leading-tight text-ink">{chapter.title}</h1>
              {chapter.title_vi && <p className="mt-1.5 font-serif text-title leading-snug text-soft">{chapter.title_vi}</p>}
            </div>
          ) : (
            <div className="max-w-4xl flex-1">
              {chapter.label && <p className="mb-1 text-meta font-medium uppercase tracking-wide text-mute">{chapter.label}{chapter.label_vi ? ` · ${chapter.label_vi}` : ''}</p>}
              <h1>
                <InlineTitle
                  value={chapter.title}
                  label="Tên chương"
                  placeholder="Tên chương"
                  onSave={handleRenameChapter}
                  className="font-serif text-display font-semibold leading-tight text-ink"
                />
              </h1>
              <InlineTitle
                value={chapter.title_vi || ''}
                label="Tên chương tiếng Việt"
                placeholder="Tên chương tiếng Việt"
                onSave={handleRenameChapterVi}
                className="font-serif text-title leading-snug text-soft"
              />
            </div>
          )}
          {!readMode && (
            <Button variant="danger" size="sm" onClick={handleDeleteChapter}>
              <Trash2 size={15} /> Xoá chương
            </Button>
          )}
        </div>

        {pendingCount > 0 && !translating && canTranslate && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-accent/25 bg-accent-soft px-4 py-3">
            <div>
              <p className="text-body font-semibold text-ink">{pendingCount} đoạn chưa dịch</p>
              <label className="mt-1 flex cursor-pointer items-center gap-2 text-meta text-soft">
                <input
                  type="checkbox"
                  checked={reexplainAll}
                  onChange={(e) => setReexplainAll(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                Giải thích lại cả những từ đã có trong kho từ vựng
              </label>
            </div>
            <Button variant="primary" onClick={handleTranslatePending}>
              <Languages size={16} /> Dịch {pendingCount} đoạn còn lại
            </Button>
          </div>
        )}

        {pendingCount === 0 && paragraphs.length > 0 && !readMode && !progress && (
          <p className="flex items-center gap-1.5 text-body text-ok"><Check size={16} /> Cả chương đã được dịch.</p>
        )}

        {error && <Notice>{error}</Notice>}

        {!readMode && (
          showAddParagraph ? (
            <div className="space-y-2.5 rounded-lg border border-dashed border-rule p-4">
              <textarea
                autoFocus
                value={newParagraphText}
                onChange={(e) => setNewParagraphText(e.target.value)}
                placeholder="Dán đoạn văn tiếng Anh cần thêm vào chương này. Để một dòng trống giữa các đoạn."
                rows={5}
                className={inputClass}
              />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleAddParagraphToChapter} disabled={addingParagraph}>
                  {addingParagraph ? 'Đang thêm…' : 'Thêm đoạn văn'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setShowAddParagraph(false); setNewParagraphText(''); }}>Huỷ</Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setShowAddParagraph(true)}>
              <Plus size={16} /> Thêm đoạn văn vào chương
            </Button>
          )
        )}

        {paragraphs.length === 0 && readMode && (
          <div className="rounded-lg border border-dashed border-rule px-6 py-12 text-center">
            <p className="font-serif text-heading font-semibold text-ink">Chương này chưa có nội dung</p>
            {canEdit && <p className="mt-1.5 text-body text-soft">Chuyển sang chế độ chỉnh sửa để dán đoạn văn tiếng Anh vào.</p>}
            {canEdit && (
              <Button variant="primary" className="mt-4" onClick={() => updateSettings({ chapterViewMode: 'edit' })}>
                <PenLine size={16} /> Chỉnh sửa chương
              </Button>
            )}
          </div>
        )}

        <ChapterThreadsProvider value={chapter.threads}>
        <ChapterVocabProvider entries={chapter.knownTerms} setEntries={setKnownTerms} bookId={chapter.book?.id} chapterId={chapter.id}>
        <VocabHintsProvider entries={chapter.knownTerms} enabled={settings.showVocabHints !== false}>
          <div className="space-y-10">
            {chapter.sections.map((s, i) => (
              <SectionBlock key={s.id} section={s} index={i} onRefresh={refresh} onParagraphUpdated={applyParagraphUpdate} readMode={readMode} />
            ))}
          </div>
        </VocabHintsProvider>
        </ChapterVocabProvider>
        </ChapterThreadsProvider>

        {!readMode && (
          showAddSection ? (
            <div className="space-y-2.5 rounded-lg border border-dashed border-rule p-4">
              <input
                autoFocus
                value={newHeading}
                onChange={(e) => setNewHeading(e.target.value)}
                placeholder="Tiêu đề mục (có thể để trống)"
                className={inputClass}
              />
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Đoạn văn tiếng Anh đầu tiên của mục này (tuỳ chọn). Để một dòng trống giữa các đoạn."
                rows={4}
                className={inputClass}
              />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={handleAddSection} disabled={addingSection}>{addingSection ? 'Đang thêm…' : 'Thêm mục'}</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowAddSection(false)}>Huỷ</Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setShowAddSection(true)}>
              <Plus size={14} /> Thêm mục có tiêu đề riêng
            </Button>
          )
        )}

        <TranslationProgress progress={progress} onCancel={cancel} onDismiss={reset} />

        <ChapterEnd chapter={chapter} />
      </div>
    </div>
  );
}
