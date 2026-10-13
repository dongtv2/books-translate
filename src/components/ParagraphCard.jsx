import { useState, useEffect, useMemo, useRef } from 'react';
import { Volume2, Square, Flag, Bookmark, Highlighter, Languages, Trash2, LoaderCircle, Sparkles, Check, Plus, MessagesSquare } from 'lucide-react';
import { api } from '../api.js';
import { RichText, ReadAlongText, RemarksList } from '../lib/markdownLite.jsx';
import { useVocabHints } from './VocabHints.jsx';
import { useAssistant } from './AssistantPanel.jsx';
import { useDiscussion, useParagraphThreads, useThreadHints } from './TermDiscussion.jsx';
import ParagraphVocab from './ParagraphVocab.jsx';
import RichEditor from './RichEditor.jsx';
import ParagraphRemarks from './ParagraphRemarks.jsx';
import { Button, IconButton, Notice } from './ui.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { useLayoutSettings, fontSizeClass } from '../context/LayoutSettingsContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { playBlob, stopPlayback, subscribePlayingId, subscribeProgress, getPlayingId } from '../lib/ttsPlayer.js';
import { stripMarkdown, segmentText, findActiveIndices } from '../lib/textTiming.js';
import { paragraphGridCols } from '../lib/paragraphLayout.js';

// The text fields a paragraph editor changes, and those an AI translation
// writes.
const EDIT_FIELDS = ['english_md', 'vietnamese_md', 'phrases_verbs_md', 'vocabulary_md', 'citations_md', 'citation_en_md', 'citation_vi_md', 'remarks_note'];
const TRANSLATED_FIELDS = ['vietnamese_md', 'phrases_verbs_md', 'vocabulary_md', 'citations_md', 'citation_vi_md', 'status'];
const MARK_KEYS = ['is_flagged', 'is_bookmarked', 'is_highlighted'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const dirtyFields = (draft, saved) => EDIT_FIELDS.filter((f) => (draft[f] ?? '') !== (saved[f] ?? ''));

// Where the paragraph's autosave stands, at the start of its toolbar.
function SaveStatus({ state, onRetry }) {
  if (state === 'idle') return null;
  if (state === 'error') {
    return (
      <button type="button" onClick={onRetry} className="mr-1 rounded px-1.5 text-caption font-medium text-flag hover:bg-flag-soft">
        Chưa lưu được, thử lại
      </button>
    );
  }
  const label = { dirty: 'Chưa lưu', saving: 'Đang lưu…', saved: 'Đã lưu' }[state];
  return (
    <span className={`mr-1 inline-flex items-center gap-1 px-1 text-caption ${state === 'saved' ? 'text-ok' : 'text-mute'}`} role="status">
      {state === 'saving' ? <LoaderCircle size={12} className="animate-spin" /> : state === 'saved' ? <Check size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
      {label}
    </span>
  );
}

function EditLabel({ children }) {
  return <span className="mb-1 block text-caption font-medium text-mute">{children}</span>;
}

const CITATION_LABEL = 'Trích dẫn & chú thích';

// Heading of a cell in the citation row. The dashed rule above it lines up
// across all three columns because the cells share one grid row.
function CitationLabel() {
  return <p className="mb-1.5 text-caption font-semibold text-soft">{CITATION_LABEL}</p>;
}

// In the chapter's edit mode every paragraph is an editor at once (no
// per-paragraph Edit button): changes are saved on their own a moment after
// typing stops, and ⌘S saves right away.
export default function ParagraphCard({ paragraph, onRefresh, onUpdated, index = 0, readMode = false }) {
  const confirm = useConfirm();
  const { settings } = useLayoutSettings();
  const { can } = useAuth();
  const canMark = can('marks.own');
  const canTranslate = can('translate.run');
  const assistant = useAssistant();
  const canAsk = Boolean(assistant) && can('assistant.use');
  const asking = assistant?.openId === paragraph.id;
  const discussion = useDiscussion();
  const threads = useParagraphThreads(paragraph.id);
  const openThreads = threads.filter((t) => t.status === 'open' && t.discussion_status !== 'closed').length;
  const closedThreads = threads.filter((t) => t.discussion_status === 'closed').length;
  const resolvedThreads = threads.filter((t) => t.status === 'resolved').length;
  const discussing = discussion?.openId === paragraph.id;
  // Readers without discuss.join still follow existing discussions.
  const canDiscuss = Boolean(discussion) && (can('discuss.join') || threads.length > 0);
  const editing = !readMode;
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [showCitation, setShowCitation] = useState(false);
  const [draft, setDraft] = useState(paragraph);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null); // the last translation's workflow summary
  const [pipelineWarnings, setPipelineWarnings] = useState(null); // the hybrid pipeline's fallbacks
  const [ttsLoading, setTtsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(() => getPlayingId() === paragraph.id);
  const [readAlong, setReadAlong] = useState({ sentenceIndex: -1, wordIndexInSentence: -1 });

  const textSize = fontSizeClass('paragraph', settings.fontSize);
  const showNotes = settings.showNotes !== false;

  // The exact text sent to TTS (markdown stripped) and its sentence/word
  // offsets — computed once per paragraph text, reused on every progress tick.
  const vocabHints = useVocabHints();
  const enHints = useThreadHints(paragraph.id, 'en', vocabHints);
  const viHints = useThreadHints(paragraph.id, 'vi');
  const plainEnglish = useMemo(() => stripMarkdown(paragraph.english_md), [paragraph.english_md]);
  const sentences = useMemo(() => segmentText(plainEnglish), [plainEnglish]);

  // Outside editing the draft mirrors the paragraph. While editing, a field
  // follows a change from the server (a translation approved in the
  // assistant, an AI re-translation) only if the user has not touched it, so
  // unsaved edits are never overwritten — a mark toggled mid-edit used to
  // reset the whole draft.
  const prevParagraph = useRef(paragraph);
  useEffect(() => {
    const prev = prevParagraph.current;
    prevParagraph.current = paragraph;
    setDraft((d) => {
      if (!editing) return paragraph;
      const next = { ...d, ...pick(paragraph, MARK_KEYS) };
      for (const f of EDIT_FIELDS) if (d[f] === prev[f]) next[f] = paragraph[f];
      return next;
    });
  }, [paragraph, editing]);

  // Autosave. Refs give the timer and the unmount flush the latest values.
  const draftRef = useRef(draft);
  const paragraphRef = useRef(paragraph);
  const savingRef = useRef(false);
  useEffect(() => { draftRef.current = draft; paragraphRef.current = paragraph; }, [draft, paragraph]);

  const applyUpdate = (updated) => (onUpdated ? onUpdated(updated) : onRefresh());

  async function saveNow() {
    const d = draftRef.current;
    const p = paragraphRef.current;
    const fields = dirtyFields(d, p);
    if (!fields.length || savingRef.current) return;
    savingRef.current = true;
    setSaveState('saving');
    const patch = pick(d, fields);
    if (fields.includes('vietnamese_md')) patch.status = d.vietnamese_md?.trim() ? 'translated' : 'pending';
    try {
      applyUpdate(await api.updateParagraph(p.id, patch));
      setSaveState('saved');
      setError('');
    } catch (e) {
      setSaveState('error');
      setError(`Chưa lưu được: ${e.message}`);
    } finally {
      savingRef.current = false;
    }
  }

  const dirty = editing && dirtyFields(draft, paragraph).length > 0;
  useEffect(() => {
    if (!dirty) return undefined;
    const timer = setTimeout(saveNow, 1000);
    return () => clearTimeout(timer);
  }, [draft, paragraph, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the chapter (or switching to reading) saves what is pending; the
  // browser asks before closing the tab with unsaved changes.
  useEffect(() => () => {
    const d = draftRef.current;
    const p = paragraphRef.current;
    const fields = dirtyFields(d, p);
    if (fields.length) api.updateParagraph(p.id, pick(d, fields)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => subscribePlayingId((id) => {
    setIsPlaying(id === paragraph.id);
    if (id !== paragraph.id) setReadAlong({ sentenceIndex: -1, wordIndexInSentence: -1 });
  }), [paragraph.id]);

  // Follows the actual audio's playback position to estimate which
  // sentence/word is being spoken right now — see textTiming.js for why
  // this is a proportional estimate rather than a true alignment.
  useEffect(() => subscribeProgress((progress) => {
    if (!progress || progress.id !== paragraph.id || !plainEnglish) return;
    const charOffset = Math.floor((progress.currentTime / progress.duration) * plainEnglish.length);
    setReadAlong(findActiveIndices(sentences, charOffset));
  }), [paragraph.id, plainEnglish, sentences]);

  async function handleReadAloud() {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    const text = editing ? stripMarkdown(draft.english_md || '') : plainEnglish;
    if (!text.trim()) return;
    setTtsLoading(true);
    setError('');
    try {
      const blob = await api.speak({ text, voice: settings.ttsVoice, speed: settings.ttsSpeed });
      playBlob(paragraph.id, blob);
    } catch (e) {
      setError(e.message);
    } finally {
      setTtsLoading(false);
    }
  }

  async function handleTranslate() {
    // While editing, the English being edited is what gets translated: it is
    // saved first, and the result fills the draft's translated fields.
    if (editing && draft.vietnamese_md !== paragraph.vietnamese_md
      && !(await confirm('Dịch lại sẽ thay bản tiếng Việt bạn đang sửa. Tiếp tục?'))) return;
    setTranslating(true);
    setError('');
    try {
      if (editing && (draft.english_md !== paragraph.english_md || draft.citation_en_md !== paragraph.citation_en_md)) {
        await api.updateParagraph(paragraph.id, { english_md: draft.english_md, citation_en_md: draft.citation_en_md });
      }
      const result = await api.translateParagraph(paragraph.id);
      // The graph workflow reports what its checks could not fix.
      setReport(result?.workflow || null);
      // The hybrid pipeline (Settings → AI) reports a stage it had to skip.
      setPipelineWarnings(result?.pipeline?.warnings?.length ? result.pipeline.warnings : null);
      if (editing && result?.paragraph) setDraft((d) => ({ ...d, ...pick(result.paragraph, TRANSLATED_FIELDS) }));
      if (result?.paragraph) applyUpdate(result.paragraph);
      else onRefresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setTranslating(false);
    }
  }

  // Inline AI for each editor field: works on the unsaved draft, and its
  // proposals change only the draft (see InlineAI).
  const aiFor = (field, label) => (canAsk ? {
    field,
    label,
    run: (req) => api.askField(paragraph.id, { field, ...req, draft: pick(draft, EDIT_FIELDS) }),
  } : null);

  // ⌘S / Ctrl+S saves now instead of waiting for the pause.
  function handleEditKeys(e) {
    if (editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
    }
  }

  async function handleDelete() {
    if (!(await confirm('Xoá đoạn văn này?'))) return;
    await api.deleteParagraph(paragraph.id);
    onRefresh();
  }

  async function toggleMark(field) {
    applyUpdate(await api.updateParagraph(paragraph.id, { [field]: !paragraph[field] }));
  }

  // A colored strip down the binding edge makes flagged/bookmarked
  // paragraphs scannable while paging through a chapter. Flagged (needs
  // review) takes priority when both are set.
  const edge = paragraph.is_flagged ? 'bg-flag' : paragraph.is_bookmarked ? 'bg-accent' : '';
  const isPending = paragraph.status !== 'translated' && !paragraph.vietnamese_md?.trim();
  const pinned = saveState === 'saving' || saveState === 'error' || isPlaying || ttsLoading || translating || asking || discussing || threads.length > 0;
  const citationSize = fontSizeClass('citation', settings.fontSize);
  const hasNotes = Boolean(paragraph.phrases_verbs_md?.trim() || paragraph.vocabulary_md?.trim() || paragraph.remarks_note?.trim());
  // Editors use the same type as the reading view of each field.
  const bookEditorText = `book-text text-ink ${textSize}`;
  const citationEditorText = `book-text text-soft ${citationSize}`;
  const notesEditorText = `leading-relaxed text-soft [&_strong]:text-ink ${fontSizeClass('remarksBody', settings.fontSize)}`;
  const hasCitationRow = (editing && showCitation)
    || Boolean((editing ? draft : paragraph).citation_en_md?.trim() || (editing ? draft : paragraph).citation_vi_md?.trim() || (editing ? draft : paragraph).citations_md?.trim());
  const notesVisible = showNotes || editing;

  return (
    <div
      id={`paragraph-${paragraph.id}`}
      className={`para-row relative scroll-mt-28 border-t border-rule first:rounded-t-lg first:border-t-0 last:rounded-b-lg ${
        paragraph.is_highlighted ? 'bg-marker-soft' : ''
      } ${asking || discussing ? 'ring-2 ring-inset ring-accent/45' : ''}`}
      onKeyDown={handleEditKeys}
    >
      {edge && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${edge}`} />}

      <div
        data-pinned={pinned}
        className="row-actions flex items-center justify-between gap-2 px-4 pt-3 lg:absolute lg:-top-4 lg:right-3 lg:z-10 lg:rounded-md lg:border lg:border-rule lg:bg-page lg:p-0.5 lg:shadow-sm"
      >
        <span className="text-caption text-mute lg:hidden">Đoạn {index + 1}</span>
        <div className="flex flex-wrap items-center justify-end gap-0.5">
          {editing && <SaveStatus state={dirty && saveState !== 'saving' ? 'dirty' : saveState} onRetry={saveNow} />}
          {/* The same actions while editing as while reading: listening,
              marks, the assistant and AI translation all work on a paragraph
              being edited; Lưu/Huỷ are added at the end. */}
          <IconButton
            label={isPlaying ? 'Dừng đọc' : 'Nghe đoạn tiếng Anh'}
            onClick={handleReadAloud}
            disabled={ttsLoading || !(editing ? draft.english_md : paragraph.english_md)?.trim()}
            active={isPlaying}
          >
            {ttsLoading ? <LoaderCircle size={16} className="animate-spin" /> : isPlaying ? <Square size={14} /> : <Volume2 size={16} />}
          </IconButton>
          {canMark && (<>
          <IconButton label={paragraph.is_flagged ? 'Bỏ đánh dấu cần xem lại' : 'Đánh dấu cần xem lại'} tone="flag" active={Boolean(paragraph.is_flagged)} onClick={() => toggleMark('is_flagged')}>
            <Flag size={16} />
          </IconButton>
          <IconButton label={paragraph.is_bookmarked ? 'Bỏ bookmark' : 'Bookmark'} active={Boolean(paragraph.is_bookmarked)} onClick={() => toggleMark('is_bookmarked')}>
            <Bookmark size={16} />
          </IconButton>
          <IconButton label={paragraph.is_highlighted ? 'Bỏ highlight' : 'Highlight'} tone="marker" active={Boolean(paragraph.is_highlighted)} onClick={() => toggleMark('is_highlighted')}>
            <Highlighter size={16} />
          </IconButton>
          </>)}
          {canAsk && (
            <IconButton label="Hỏi trợ lý AI về đoạn này" active={asking} onClick={() => { discussion?.close(); if (asking) assistant.close(); else assistant.open(paragraph.id); }}>
              <Sparkles size={16} />
            </IconButton>
          )}
          {canDiscuss && (
            <IconButton
              label={threads.length ? `Bình luận theo đoạn (${openThreads} đang mở, ${resolvedThreads} đã chốt cách dịch, ${closedThreads} đã đóng)` : 'Bình luận về từ / cụm từ trong đoạn này'}
              active={discussing}
              className="relative"
              onClick={() => (discussing ? discussion.close() : discussion.open(paragraph.id))}
            >
              <MessagesSquare size={16} />
              {threads.length > 0 && (
                <span className={`absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums ${openThreads ? 'bg-warn text-page' : 'bg-ok text-page'}`}>
                  {openThreads || threads.length}
                </span>
              )}
            </IconButton>
          )}
          {!readMode && (
            <>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-rule" />
              {canTranslate && (
                <IconButton
                  label={editing ? 'Dịch lại bằng AI từ bản tiếng Anh đang sửa' : paragraph.status === 'translated' ? 'Dịch lại bằng AI' : 'Dịch bằng AI'}
                  onClick={handleTranslate}
                  disabled={translating}
                >
                  {translating ? <LoaderCircle size={16} className="animate-spin" /> : <Languages size={16} />}
                </IconButton>
              )}
              <IconButton label="Xoá đoạn" onClick={handleDelete} className="hover:!bg-flag-soft hover:!text-flag">
                <Trash2 size={16} />
              </IconButton>
            </>
          )}
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 px-4 pb-5 pt-3 lg:gap-0 lg:p-0 ${paragraphGridCols(notesVisible)}`}>
        <div className="hidden select-none py-6 text-center font-serif text-meta leading-[29px] tabular-nums text-mute lg:block">
          {index + 1}
          {/* Discussions on this paragraph stay visible without hovering. */}
          {threads.length > 0 && discussion && (
            <button
              type="button"
              onClick={() => discussion.open(paragraph.id)}
              title={`${openThreads} đang mở · ${resolvedThreads} đã chốt cách dịch · ${closedThreads} đã đóng`}
              aria-label="Mở thảo luận thuật ngữ của đoạn"
              className={`mx-auto mt-1 flex items-center gap-0.5 rounded px-1 font-sans text-caption font-semibold leading-5 ${openThreads ? 'text-warn hover:bg-warn-soft' : 'text-ok hover:bg-ok-soft'}`}
            >
              <MessagesSquare size={12} /> {openThreads || threads.length}
            </button>
          )}
        </div>

        <div data-term-side="en" className="min-w-0 lg:py-6 lg:pr-7">
          <p className="mb-1 text-caption font-semibold text-mute lg:hidden">Bản gốc · English</p>
          {editing ? (
            <RichEditor
              value={draft.english_md} ai={aiFor('english_md', 'English')}
              textClassName={bookEditorText}
              seamless
              onChange={(v) => setDraft((d) => ({ ...d, english_md: v }))}
              minRows={3}
              placeholder="Đoạn gốc tiếng Anh"
            />
          ) : null}
          {editing && !hasCitationRow && (
            <button type="button" onClick={() => setShowCitation(true)} className="mt-2 inline-flex items-center gap-1 text-caption text-mute hover:text-accent">
              <Plus size={13} /> Trích dẫn &amp; chú thích
            </button>
          )}
          {editing ? null : isPlaying ? (
            <ReadAlongText
              text={paragraph.english_md}
              sentences={sentences}
              activeSentenceIndex={readAlong.sentenceIndex}
              activeWordIndexInSentence={readAlong.wordIndexInSentence}
              className={`book-text text-ink ${textSize}`}
            />
          ) : (
            <RichText text={paragraph.english_md} hints={enHints} className={`book-text text-ink ${textSize}`} />
          )}
        </div>

        <div data-term-side="vi" className="min-w-0 border-rule max-lg:border-l-2 max-lg:border-accent/40 max-lg:pl-3 lg:border-l lg:px-7 lg:py-6">
          <p className="mb-1 text-caption font-semibold text-mute lg:hidden">Bản dịch · Tiếng Việt</p>
          {editing ? (
            <RichEditor
              value={draft.vietnamese_md} ai={aiFor('vietnamese_md', 'Tiếng Việt')}
              textClassName={bookEditorText}
              seamless
              onChange={(v) => setDraft((d) => ({ ...d, vietnamese_md: v }))}
              minRows={3}
              placeholder="Bản dịch tiếng Việt"
            />
          ) : null}
          {editing && !draft.vietnamese_md?.trim() && canTranslate && (
            <Button size="sm" className="mt-2" onClick={handleTranslate} disabled={translating}>
              {translating ? <LoaderCircle size={14} className="animate-spin" /> : <Languages size={14} />}
              {translating ? 'Đang dịch…' : 'Dịch đoạn này'}
            </Button>
          )}
          {editing ? null : paragraph.vietnamese_md ? (
            <RichText text={paragraph.vietnamese_md} hints={viHints} className={`book-text text-ink ${textSize}`} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-body italic text-mute">Chưa dịch</span>
              {isPending && canTranslate && (
                <Button size="sm" onClick={handleTranslate} disabled={translating}>
                  {translating ? <LoaderCircle size={14} className="animate-spin" /> : <Languages size={14} />}
                  {translating ? 'Đang dịch…' : 'Dịch đoạn này'}
                </Button>
              )}
            </div>
          )}
        </div>

        {notesVisible && (editing || hasNotes) && (
          <div className="min-w-0 border-rule max-lg:border-t max-lg:pt-4 lg:border-l lg:px-6 lg:py-6">
            {editing ? (
              <div className="space-y-3">
                <div>
                  <EditLabel>Phrases &amp; Verbs</EditLabel>
                  <RichEditor seamless list textClassName={notesEditorText} value={draft.phrases_verbs_md} ai={aiFor('phrases_verbs_md', 'Phrases & Verbs')} onChange={(v) => setDraft((d) => ({ ...d, phrases_verbs_md: v }))} minRows={2} placeholder="cụm từ: nghĩa" />
                </div>
                <div>
                  <EditLabel>Vocabulary</EditLabel>
                  <RichEditor seamless list textClassName={notesEditorText} value={draft.vocabulary_md} ai={aiFor('vocabulary_md', 'Vocabulary')} onChange={(v) => setDraft((d) => ({ ...d, vocabulary_md: v }))} minRows={2} placeholder="từ /IPA/ (loại từ): nghĩa" />
                </div>
                <div>
                  <EditLabel>Ghi chú</EditLabel>
                  <RichEditor seamless textClassName={notesEditorText} value={draft.remarks_note} ai={aiFor('remarks_note', 'Nhận xét')} onChange={(v) => setDraft((d) => ({ ...d, remarks_note: v }))} minRows={2} placeholder="Nhận xét ngắn về đoạn văn" />
                </div>
                <ParagraphVocab paragraphId={paragraph.id} englishMd={draft.english_md} />
              </div>
            ) : (
              <details className="group rounded-md">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-meta font-medium text-soft marker:hidden hover:text-accent focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                  <span className="grid h-5 w-5 place-items-center rounded bg-sunken text-mute transition-transform group-open:rotate-90" aria-hidden="true">›</span>
                  Ghi chú &amp; từ vựng
                </summary>
                <div className="border-l border-rule pb-1 pl-3 pt-2">
                  <ParagraphRemarks
                    phrasesVerbsMd={paragraph.phrases_verbs_md}
                    vocabularyMd={paragraph.vocabulary_md}
                    remarksNote={paragraph.remarks_note}
                    fontSize={settings.fontSize}
                  />
                </div>
              </details>
            )}
          </div>
        )}

        {/* Citation row: the original citation/quotation under English, its
            translation under Vietnamese, the source notes beside them — the
            same row of the same grid, so the three always stay aligned. */}
        {hasCitationRow && (
          <>
            <div className="hidden lg:block" />
            <div className="min-w-0 lg:pb-6 lg:pr-7">
              <div className="border-t border-dashed border-rule pt-3">
                <CitationLabel />
                {editing ? (
                  <RichEditor
                    value={draft.citation_en_md} ai={aiFor('citation_en_md', 'Trích dẫn (EN)')}
                    seamless
                    textClassName={citationEditorText}
                    onChange={(v) => setDraft((d) => ({ ...d, citation_en_md: v }))}
                    minRows={3}
                    placeholder="Trích dẫn, nguồn, chú thích gốc bằng tiếng Anh"
                  />
                ) : paragraph.citation_en_md?.trim() ? (
                  <RichText text={paragraph.citation_en_md} className={`book-text text-soft ${citationSize}`} />
                ) : (
                  <span className="text-meta italic text-mute">Không có</span>
                )}
              </div>
            </div>
            <div className="min-w-0 border-rule max-lg:border-l-2 max-lg:border-accent/40 max-lg:pl-3 lg:border-l lg:px-7 lg:pb-6">
              <div className="border-t border-dashed border-rule pt-3">
                <CitationLabel />
                {editing ? (
                  <RichEditor
                    value={draft.citation_vi_md} ai={aiFor('citation_vi_md', 'Trích dẫn (VI)')}
                    seamless
                    textClassName={citationEditorText}
                    onChange={(v) => setDraft((d) => ({ ...d, citation_vi_md: v }))}
                    minRows={3}
                    placeholder="Bản dịch tiếng Việt của phần trích dẫn"
                  />
                ) : paragraph.citation_vi_md?.trim() ? (
                  <RichText text={paragraph.citation_vi_md} className={`book-text text-soft ${citationSize}`} />
                ) : (
                  <span className="text-meta italic text-mute">
                    {paragraph.citation_en_md?.trim() ? 'Chưa dịch. Bấm Dịch lại để dịch cả phần trích dẫn.' : 'Không có'}
                  </span>
                )}
              </div>
            </div>
            {notesVisible && (
              <div className="min-w-0 border-rule lg:border-l lg:px-6 lg:pb-6">
                <div className="border-t border-dashed border-rule pt-3">
                  <CitationLabel />
                  {editing ? (
                    <RichEditor
                      seamless
                      list
                      value={draft.citations_md} ai={aiFor('citations_md', 'Ghi chú trích dẫn')}
                      textClassName={notesEditorText}
                      onChange={(v) => setDraft((d) => ({ ...d, citations_md: v }))}
                      minRows={3}
                      placeholder="- **Tên tác giả / công trình**: giải thích ngắn"
                    />
                  ) : paragraph.citations_md?.trim() ? (
                    <RemarksList text={paragraph.citations_md} itemClassName={`text-soft ${fontSizeClass('remarksBody', settings.fontSize)}`} />
                  ) : (
                    <span className="text-meta italic text-mute">Không có</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="px-4 pb-4 lg:pl-11 lg:pr-6">
          <Notice>{error}</Notice>
        </div>
      )}
      {pipelineWarnings && (
        <div className="px-4 pb-4 lg:pl-11 lg:pr-6">
          <Notice
            tone="warn"
            action={<button type="button" onClick={() => setPipelineWarnings(null)} className="text-meta font-medium underline-offset-2 hover:underline">Đóng</button>}
          >
            {pipelineWarnings.join(' ')}
          </Notice>
        </div>
      )}
      {report && (
        <div className="px-4 pb-4 lg:pl-11 lg:pr-6">
          <Notice
            tone={report.remaining.length ? 'warn' : 'ok'}
            action={<button type="button" onClick={() => setReport(null)} className="text-meta font-medium underline-offset-2 hover:underline">Đóng</button>}
          >
            {report.remaining.length
              ? <>Đã tự sửa {report.repairs} lần, còn cần xem lại: {report.remaining.map((i) => i.detail).join(' ')}</>
              : <>Bản dịch qua kiểm tra{report.repairs ? `, sau ${report.repairs} lần tự sửa` : ''}{report.strategy === 'chunked' ? ' (dịch theo từng phần)' : ''}.</>}
          </Notice>
        </div>
      )}
    </div>
  );
}
