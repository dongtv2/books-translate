import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUp, BookCheck, Check, ChevronUp, LoaderCircle, LocateFixed, MessageSquare, MessagesSquare, Pencil, Plus, RotateCcw,
  Trash2, Users, X,
} from 'lucide-react';
import { api, WORD_TYPES } from '../api.js';
import { previewText } from '../lib/inlineMarkdown.js';
import { notifyDiscussionsChanged } from '../lib/bookEvents.js';
import { isPassage, locateThread, rangeIn, sentenceAround } from '../lib/threadAnchors.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { useLayoutSettings } from '../context/LayoutSettingsContext.jsx';
import { useAssistant } from './AssistantPanel.jsx';
import { Button, Notice, Segmented, Tag } from './ui.jsx';
import { AssignmentChips, AssignForm } from './Assignments.jsx';

// Team discussion of the words and phrases of a paragraph, beside the
// chapter: a thread per term, with comments and proposed translations people
// vote on; an editor or an assigned reviewer then decides ("chốt") one, which
// goes into the book's glossary — the terminology the AI must use for every
// later paragraph (server/discussions.js).

const DiscussionContext = createContext(null);

export function useDiscussion() {
  return useContext(DiscussionContext);
}

// Scrolls to where a thread's words are in its paragraph and paints them and
// their sentence with the CSS Custom Highlight API (no re-render, survives
// the hint spans around them). Returns false if the words are not on the page.
const HIGHLIGHTS = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
function clearFocus() {
  if (HIGHLIGHTS) { CSS.highlights.delete('thread-term'); CSS.highlights.delete('thread-context'); }
}
function focusThreadInText(t, { scroll = true } = {}) {
  const root = document.querySelector(`#paragraph-${t.paragraph_id} [data-term-side="${t.side || 'en'}"]`);
  if (!root) return false;
  const text = root.textContent;
  const at = locateThread(text, t);
  if (!at) {
    if (scroll) document.getElementById(`paragraph-${t.paragraph_id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return false;
  }
  const term = rangeIn(root, at.start, at.end);
  const ctx = sentenceAround(text, at.start, at.end);
  const sentence = rangeIn(root, ctx.start, ctx.end);
  if (HIGHLIGHTS && term) {
    CSS.highlights.set('thread-context', new Highlight(sentence || term));
    CSS.highlights.set('thread-term', new Highlight(term));
  }
  if (scroll && term) {
    const r = term.getBoundingClientRect();
    window.scrollBy({ top: r.top - window.innerHeight * 0.4, behavior: 'smooth' });
  }
  return true;
}

// Wraps the chapter (inside AssistantProvider: the two panels take the same
// place, so opening one closes the other).
// open(paragraphId, { term, side, anchor } | { threadId }) — a new thread on
// the picked words, or straight into an existing thread.
// focus(thread) — scroll to the thread's words and mark their sentence.
// The open thread can take quotes picked from the text (TermSelectionButton).
export function DiscussionProvider({ children }) {
  const assistant = useAssistant();
  const [state, setState] = useState(null); // { paragraphId, term?, side?, anchor?, threadId?, key }
  const [activeThread, setActiveThread] = useState(null); // the thread shown in the panel
  const quoteSink = useRef(null);
  const [canQuote, setCanQuote] = useState(false);
  const isOpen = state != null;

  useEffect(() => {
    if (!isOpen) return undefined;
    window.dispatchEvent(new CustomEvent('bt:make-room', { detail: true }));
    return () => window.dispatchEvent(new CustomEvent('bt:make-room', { detail: false }));
  }, [isOpen]);
  useEffect(() => { if (!activeThread) clearFocus(); }, [activeThread]);
  useEffect(() => clearFocus, []);

  const closeAssistant = assistant?.close;
  const value = useMemo(() => ({
    state,
    openId: state?.paragraphId ?? null,
    activeThreadId: activeThread?.id ?? null,
    open: (paragraphId, extra = {}) => {
      closeAssistant?.();
      setState({ paragraphId, ...extra, key: Date.now() });
    },
    close: () => { setState(null); setActiveThread(null); },
    focus: (t, opts) => focusThreadInText(t, opts),
    setActiveThread,
    canQuote,
    quote: (text) => quoteSink.current?.(text),
    registerQuote: (fn) => {
      quoteSink.current = fn;
      setCanQuote(true);
      return () => { if (quoteSink.current === fn) { quoteSink.current = null; setCanQuote(false); } };
    },
  }), [state, closeAssistant, activeThread, canQuote]);
  return <DiscussionContext.Provider value={value}>{children}</DiscussionContext.Provider>;
}

// The chapter's threads ({ id, paragraph_id, term, side, status }), for the
// badge on each paragraph.
const ChapterThreadsContext = createContext([]);
export const ChapterThreadsProvider = ChapterThreadsContext.Provider;
export function useParagraphThreads(paragraphId) {
  const threads = useContext(ChapterThreadsContext);
  return useMemo(() => (threads || []).filter((t) => t.paragraph_id === paragraphId), [threads, paragraphId]);
}

// Marks on the discussed words in a paragraph column, for RichText's `hints`.
// Merged with the vocabulary hints (`base`): a discussed passage wins where
// they overlap. Clicking a mark opens its thread.
function ThreadMark({ t, active, children }) {
  const discussion = useDiscussion();
  const resolved = t.status === 'resolved';
  return (
    <span
      data-thread-mark={t.id}
      title={resolved ? `Đã chốt: ${t.resolution_vi || ''}` : 'Đang thảo luận, bấm để xem'}
      onClick={(e) => { e.stopPropagation(); discussion?.open(t.paragraph_id, { threadId: t.id }); }}
      className={`cursor-pointer rounded-[2px] box-decoration-clone transition-colors ${
        active ? 'bg-accent-soft ring-1 ring-accent/60'
          : resolved ? 'underline decoration-ok/70 decoration-dotted decoration-2 underline-offset-[5px] hover:bg-ok-soft'
            : 'bg-warn-soft/70 underline decoration-warn decoration-dashed decoration-[1.5px] underline-offset-[5px] hover:bg-warn-soft'
      }`}
    >
      {children}
    </span>
  );
}

export function useThreadHints(paragraphId, side, base = null) {
  const threads = useParagraphThreads(paragraphId);
  const discussion = useDiscussion();
  const { settings } = useLayoutSettings();
  const enabled = settings.showThreadMarks !== false && Boolean(discussion);
  const activeId = discussion?.activeThreadId;
  return useMemo(() => {
    const mine = enabled ? threads.filter((t) => (t.side || 'en') === side) : [];
    if (!mine.length) return base;
    return {
      find: (text) => {
        // Shortest first, so a term discussed inside a discussed sentence
        // keeps its own mark.
        const marks = [];
        mine.map((t) => { const at = locateThread(text, t); return at && { ...at, id: `t${t.id}`, thread: t }; })
          .filter(Boolean)
          .sort((a, b) => (a.end - a.start) - (b.end - b.start))
          .forEach((m) => { if (!marks.some((k) => m.start < k.end && k.start < m.end)) marks.push(m); });
        const rest = base ? base.find(text).filter((m) => !marks.some((k) => m.start < k.end && k.start < m.end)) : [];
        return [...marks, ...rest].sort((a, b) => a.start - b.start);
      },
      render: (m, content, key) => (m.thread
        ? <ThreadMark key={key} t={m.thread} active={m.thread.id === activeId}>{content}</ThreadMark>
        : base.render(m, content, key)),
    };
  }, [threads, side, base, enabled, activeId]);
}

// ---- small helpers -------------------------------------------------------------

export const displayName = (name, email) => name || email || 'Ai đó';

// SQLite datetime('now') is UTC without a zone.
export function timeAgo(sqlTime) {
  if (!sqlTime) return '';
  const t = new Date(`${sqlTime.replace(' ', 'T')}Z`).getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày trước`;
  return new Date(t).toLocaleDateString('vi-VN');
}

let topicsPromise = null;
export const loadTopics = () => (topicsPromise ??= api.vocabTopics().catch(() => { topicsPromise = null; return []; }));

export function ThreadStatus({ status }) {
  if (status === 'closed') return <Tag>Đã đóng</Tag>;
  return status === 'resolved'
    ? <Tag tone="ok"><Check size={11} /> Đã chốt cách dịch</Tag>
    : <Tag tone="warn">Đang mở</Tag>;
}

// The context sentence with the discussed words in bold.
function ContextLine({ text, term }) {
  if (!text) return null;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  return (
    <p className="font-serif text-meta leading-snug text-soft">
      {i < 0 ? text : <>{text.slice(0, i)}<strong className="font-semibold text-ink">{text.slice(i, i + term.length)}</strong>{text.slice(i + term.length)}</>}
    </p>
  );
}

function Avatar({ name }) {
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-caption font-semibold text-accent">
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

const small = 'w-full rounded border border-rule bg-page px-2 py-1.5 text-meta text-ink placeholder:text-mute focus:border-accent focus:outline-none';

// ---- new thread ------------------------------------------------------------------

function NewThreadForm({ paragraph, initialTerm = '', initialSide = 'en', anchor = null, onCreated, onCancel }) {
  const [term, setTerm] = useState(initialTerm);
  const [side, setSide] = useState(initialSide);
  const [meaning, setMeaning] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const passage = isPassage(term);

  async function submit(e) {
    e.preventDefault();
    if (!term.trim()) return;
    setBusy(true);
    setError('');
    try {
      // The place in the text is kept while the words are the ones picked.
      const placed = anchor && side === initialSide && term.trim() === initialTerm.trim();
      onCreated(await api.createThread({
        paragraphId: paragraph.id, term: term.trim(), side, meaning_vi: meaning, body,
        ...(placed ? { anchorStart: anchor.start, anchorText: anchor.text } : {}),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-lg border border-accent/30 bg-page p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta font-semibold text-ink">{passage ? 'Bình luận về câu / đoạn trích' : 'Bình luận về từ / cụm từ'}</p>
        <Segmented
          size="sm"
          label="Từ cột"
          value={side}
          onChange={setSide}
          options={[{ key: 'en', label: 'Tiếng Anh', hint: 'Thuật ngữ gốc cần thống nhất cách dịch' }, { key: 'vi', label: 'Bản dịch', hint: 'Cách diễn đạt trong bản tiếng Việt' }]}
        />
      </div>
      {passage ? (
        <textarea value={term} onChange={(e) => setTerm(e.target.value)} rows={3} className={`${small} resize-y font-serif`} aria-label="Câu / đoạn trích" />
      ) : (
        <input autoFocus={!initialTerm} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={side === 'en' ? 'vd. attachment, turn against someone' : 'cụm từ trong bản dịch'} className={`${small} font-semibold`} aria-label="Từ / cụm từ" />
      )}
      {anchor && side === initialSide && term.trim() === initialTerm.trim() && (
        <div className="rounded-md border-l-2 border-accent bg-accent-soft/40 px-3 py-2">
          <p className="mb-1 flex items-center gap-1 text-caption font-medium text-accent"><LocateFixed size={12} /> Bình luận về phần đã chọn</p>
          <blockquote className="line-clamp-3 font-serif text-meta leading-relaxed text-ink">{anchor.text}</blockquote>
        </div>
      )}
      {passage ? (
        <textarea autoFocus={Boolean(initialTerm)} value={meaning} onChange={(e) => setMeaning(e.target.value)} rows={3} placeholder={side === 'en' ? 'Đề xuất bản dịch câu này (tuỳ chọn)' : 'Đề xuất cách diễn đạt khác (tuỳ chọn)'} className={`${small} resize-y`} aria-label="Đề xuất cách dịch" />
      ) : (
        <input autoFocus={Boolean(initialTerm)} value={meaning} onChange={(e) => setMeaning(e.target.value)} placeholder={side === 'en' ? 'Đề xuất cách dịch (tuỳ chọn)' : 'Đề xuất cách diễn đạt khác (tuỳ chọn)'} className={small} aria-label="Đề xuất cách dịch" />
      )}
      <textarea autoFocus={Boolean(anchor)} value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder={anchor ? 'Viết bình luận về phần đã chọn…' : 'Vì sao? Ngữ cảnh, nguồn tham khảo… (tuỳ chọn)'} className={`${small} resize-y`} aria-label="Bình luận" />
      {error && <Notice>{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy || !term.trim()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <MessageSquare size={14} />}
          {anchor && body.trim() ? 'Gửi bình luận' : 'Mở thảo luận'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}

// ---- deciding --------------------------------------------------------------------

function ResolveForm({ thread, initialMeaning, onDone, onCancel }) {
  const { can } = useAuth();
  const current = thread.glossary?.[0];
  const vocab = thread.vocabulary;
  const [topics, setTopics] = useState([]);
  const [form, setForm] = useState({
    term: thread.side === 'en' ? (vocab?.term || current?.term || thread.term) : thread.term,
    meaning_vi: initialMeaning || current?.meaning_vi || '',
    word_type: current?.word_type || vocab?.word_type || '',
    topic: current?.topic || vocab?.topic || '',
    note: current?.note || '',
    scope: current && current.book_id == null ? 'all' : 'book',
    // A passage is decided for this place only; a term becomes terminology.
    saveToGlossary: !isPassage(thread.term),
    addToVocabulary: thread.side === 'en' && !isPassage(thread.term),
    updateVocabulary: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { loadTopics().then(setTopics); }, []);
  useEffect(() => { if (initialMeaning) setForm((f) => ({ ...f, meaning_vi: initialMeaning })); }, [initialMeaning]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await api.resolveThread(thread.id, form));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-lg border border-ok/40 bg-ok-soft/40 p-3">
      <p className="flex items-center gap-1.5 text-meta font-semibold text-ink"><BookCheck size={15} className="text-ok" /> Chốt cách dịch</p>
      {isPassage(thread.term) ? (
        <textarea autoFocus value={form.meaning_vi} onChange={set('meaning_vi')} rows={4} placeholder="Bản dịch được chốt" className={`${small} resize-y font-serif`} aria-label="Bản dịch được chốt" />
      ) : (
        <div className="grid grid-cols-[1fr_1.4fr] gap-2">
          <input value={form.term} onChange={set('term')} className={`${small} font-semibold`} aria-label="Thuật ngữ" />
          <input autoFocus value={form.meaning_vi} onChange={set('meaning_vi')} placeholder="Cách dịch được chốt" className={small} aria-label="Cách dịch được chốt" />
        </div>
      )}
      <label className="flex items-center gap-2 text-meta text-soft">
        <input type="checkbox" checked={form.saveToGlossary} onChange={set('saveToGlossary')} className="h-4 w-4 accent-accent" />
        Lưu vào bảng thuật ngữ (AI dùng cho các lần dịch sau)
      </label>
      {form.saveToGlossary && (<>
      <div className="grid grid-cols-2 gap-2">
        <select value={form.word_type} onChange={set('word_type')} className={small} aria-label="Loại từ">
          <option value="">Loại từ…</option>
          {WORD_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <select value={form.topic} onChange={set('topic')} className={small} aria-label="Chủ đề">
          <option value="">Chủ đề…</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <input value={form.note} onChange={set('note')} placeholder="Ghi chú cho người dịch sau (tuỳ chọn), vd. chỉ dùng khi nói về trẻ nhỏ" className={small} aria-label="Ghi chú" />
      <div className="space-y-1.5 text-meta text-soft">
        <p className="font-medium">Áp dụng cho</p>
        <label className="flex items-center gap-2"><input type="radio" name="scope" value="book" checked={form.scope === 'book'} onChange={set('scope')} className="accent-accent" /> Sách này ({thread.book_title})</label>
        <label className="flex items-center gap-2"><input type="radio" name="scope" value="all" checked={form.scope === 'all'} onChange={set('scope')} className="accent-accent" /> Mọi sách</label>
        {thread.side === 'en' && (
          <label className="flex items-center gap-2 pt-1">
            <input type="checkbox" checked={form.addToVocabulary} onChange={set('addToVocabulary')} className="h-4 w-4 accent-accent" />
            {vocab ? 'Liên kết với từ đã có trong kho từ vựng' : 'Thêm vào kho từ vựng để ôn tập'}
          </label>
        )}
        {thread.side === 'en' && form.addToVocabulary && vocab && can('vocab.edit') && vocab.meaning_vi !== form.meaning_vi && (
          <label className="flex items-start gap-2 pl-6">
            <input type="checkbox" checked={form.updateVocabulary} onChange={set('updateVocabulary')} className="mt-0.5 h-4 w-4 accent-accent" />
            <span>Thay nghĩa trong kho (“{vocab.meaning_vi}”) bằng cách dịch này</span>
          </label>
        )}
      </div>
      </>)}
      {error && <Notice>{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy || !form.meaning_vi.trim()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} {form.saveToGlossary ? 'Chốt và lưu vào thuật ngữ' : 'Chốt'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}

// ---- one post --------------------------------------------------------------------

function Post({ post, me, canJoin, canModerate, canResolve, open, onThread, onPick }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(post.body);
  const [meaning, setMeaning] = useState(post.meaning_vi);
  const [busy, setBusy] = useState(false);
  const mine = post.user_id === me;
  const who = displayName(post.user_name, post.user_email);

  async function run(fn) {
    setBusy(true);
    try { onThread(await fn()); } finally { setBusy(false); }
  }

  if (post.kind === 'event') {
    return (
      <p className="flex items-center gap-2 py-1 text-caption text-mute">
        <span className="h-px flex-1 bg-rule" />
        {post.body === 'resolved' ? <><Check size={12} className="text-ok" /> {who} đã chốt cách dịch “{post.meaning_vi}”</>
          : post.body === 'discussion_closed' ? <><Check size={12} className="text-ok" /> {who} đã đóng thảo luận</>
            : post.body === 'discussion_reopened' ? <><RotateCcw size={12} /> {who} đã mở lại thảo luận</>
              : <><RotateCcw size={12} /> {who} đã mở lại quyết định dịch</>}
        <span>· {timeAgo(post.created_at)}</span>
        <span className="h-px flex-1 bg-rule" />
      </p>
    );
  }

  const isProposal = post.kind === 'proposal';
  return (
    <div className={`flex gap-2.5 ${isProposal ? 'rounded-lg border border-rule bg-page p-2.5' : ''}`}>
      <Avatar name={who} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-caption text-mute">
          <span className="font-semibold text-soft">{who}</span>
          {isProposal && <span className="text-accent">đề xuất</span>}
          <span>{timeAgo(post.created_at)}{post.edited_at ? ' · đã sửa' : ''}</span>
        </p>
        {editing ? (
          <div className="mt-1.5 space-y-1.5">
            {isProposal && <input value={meaning} onChange={(e) => setMeaning(e.target.value)} className={`${small} font-semibold`} aria-label="Cách dịch đề xuất" />}
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} className={`${small} resize-y`} aria-label="Nội dung" />
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api.updateThreadPost(post.id, { body, meaning_vi: meaning })).then(() => setEditing(false))}>Lưu</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Huỷ</Button>
            </div>
          </div>
        ) : (
          <>
            {isProposal && <p className="mt-0.5 font-serif text-lead font-semibold text-ink">{post.meaning_vi}</p>}
            {post.body && <p className="mt-0.5 whitespace-pre-line text-body text-ink">{post.body}</p>}
          </>
        )}
        {!editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {isProposal && (
              <button
                type="button"
                disabled={!canJoin || busy}
                onClick={() => run(() => api.voteProposal(post.id))}
                title={post.voters?.length ? `Đồng ý: ${post.voters.join(', ')}` : 'Chưa ai bình chọn'}
                aria-pressed={Boolean(post.my_vote)}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-caption font-semibold tabular-nums transition-colors disabled:cursor-default ${
                  post.my_vote ? 'border-accent bg-accent-soft text-accent' : 'border-rule text-soft hover:border-accent hover:text-accent'
                }`}
              >
                <ChevronUp size={14} /> {post.votes}
              </button>
            )}
            {isProposal && canResolve && open && (
              <Button size="sm" variant="ghost" className="!h-7" onClick={() => onPick(post.meaning_vi)}>
                <Check size={13} /> Chốt bản này
              </Button>
            )}
            {mine && canJoin && (
              <button type="button" onClick={() => setEditing(true)} className="ml-auto grid h-7 w-7 place-items-center rounded text-mute hover:bg-sunken hover:text-ink" aria-label="Sửa" title="Sửa">
                <Pencil size={13} />
              </button>
            )}
            {(mine && canJoin) || canModerate ? (
              <button
                type="button"
                onClick={async () => { if (await confirm('Xoá bình luận này?')) run(() => api.deleteThreadPost(post.id)); }}
                className={`${mine && canJoin ? '' : 'ml-auto'} grid h-7 w-7 place-items-center rounded text-mute hover:bg-flag-soft hover:text-flag`}
                aria-label="Xoá"
                title="Xoá"
              >
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- one thread ------------------------------------------------------------------

export function ThreadView({ threadId, onBack, onChanged, onDeleted }) {
  const { user, can } = useAuth();
  const confirm = useConfirm();
  const canJoin = can('discuss.join');
  const canModerate = can('glossary.manage');
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('comment');
  const [text, setText] = useState('');
  const [meaning, setMeaning] = useState('');
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(null); // null | { meaning }
  const scroller = useRef(null);
  const input = useRef(null);
  const discussion = useDiscussion();
  const { setActiveThread, focus, registerQuote } = discussion || {};

  const apply = useCallback((t) => { setThread(t); onChanged?.(t); }, [onChanged]);

  // Opening a thread moves the chapter to its words and marks their
  // sentence; the marks stay while the thread is open.
  const focused = useRef(false);
  useEffect(() => {
    if (!thread) return;
    setActiveThread?.(thread);
    if (!focused.current) { focused.current = true; requestAnimationFrame(() => focus?.(thread)); }
  }, [thread]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setActiveThread?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Words or sentences picked in the text while this thread is open can be
  // quoted into the comment being written.
  useEffect(() => registerQuote?.((quoted) => {
    setKind('comment');
    setText((t) => `${t.trim() ? `${t.trimEnd()} ` : ''}“${quoted}” `);
    requestAnimationFrame(() => input.current?.focus());
  }), [registerQuote]);

  useEffect(() => {
    let live = true;
    const load = () => api.getThread(threadId)
      .then((t) => { if (live) { setThread(t); notifyDiscussionsChanged(); } })
      .catch((e) => live && setError(e.message));
    load();
    // Others may be discussing at the same time.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
    return () => { live = false; clearInterval(timer); };
  }, [threadId]);

  useEffect(() => {
    const el = scroller.current?.closest('[data-scroll]');
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [thread?.posts?.length]);

  async function send(e) {
    e?.preventDefault();
    if (sending) return;
    if (kind === 'proposal' ? !meaning.trim() : !text.trim()) return;
    setSending(true);
    setError('');
    try {
      apply(await api.addThreadPost(threadId, { kind, body: text, meaning_vi: meaning }));
      setText('');
      setMeaning('');
      setKind('comment');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!(await confirm(`Xoá thảo luận về “${thread.term}”?`))) return;
    try {
      await api.deleteThread(threadId);
      onDeleted?.(thread);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!thread) return error ? <Notice>{error}</Notice> : <p className="text-body text-mute">Đang tải…</p>;

  const decisionOpen = thread.status === 'open';
  const conversationOpen = decisionOpen && thread.discussion_status !== 'closed';
  const passage = isPassage(thread.term);
  const proposals = thread.posts.filter((p) => p.kind === 'proposal');
  const topProposal = [...proposals].sort((a, b) => b.votes - a.votes)[0];
  const decided = thread.glossary?.[0];
  const canDelete = canModerate || (thread.created_by === user.id && thread.posts.every((p) => p.user_id === user.id || p.kind === 'event'));

  return (
    <div ref={scroller} className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          {onBack && (
            <button type="button" onClick={onBack} aria-label="Về danh sách" title="Về danh sách" className="-ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-mute hover:bg-sunken hover:text-ink">
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {passage ? (
              <blockquote className="border-l-2 border-accent pl-2.5 font-serif text-body leading-relaxed text-ink">{thread.term}</blockquote>
            ) : (
              <p className="break-words font-serif text-heading font-semibold leading-snug text-ink">{thread.term}</p>
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-caption text-mute">
              <ThreadStatus status={thread.status} />
              {thread.discussion_status === 'closed' && <Tag>Đã đóng bình luận</Tag>}
              {thread.side === 'vi' && <Tag>Bản dịch</Tag>}
              <span>{displayName(thread.created_by_name)} mở · {timeAgo(thread.created_at)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!focus?.(thread)) setError('Không tìm thấy chỗ này trong đoạn đang hiển thị (đoạn có thể đã sửa, hoặc đang ở chế độ chỉnh sửa).'); }}
            aria-label="Đến vị trí trong đoạn"
            title="Đến vị trí trong đoạn"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-mute hover:bg-sunken hover:text-accent"
          >
            <LocateFixed size={16} />
          </button>
          {canDelete && (
            <button type="button" onClick={remove} aria-label="Xoá thảo luận" title="Xoá thảo luận" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-mute hover:bg-flag-soft hover:text-flag">
              <Trash2 size={15} />
            </button>
          )}
        </div>
        {!passage && <ContextLine text={thread.context} term={thread.term} />}
      </div>

      {thread.status === 'resolved' && (
        <div className="rounded-lg border border-ok/40 bg-ok-soft/50 px-3 py-2.5">
          <p className="text-caption font-medium text-ok">Đã chốt{thread.resolved_by_name ? ` bởi ${thread.resolved_by_name}` : ''} · {timeAgo(thread.resolved_at)}</p>
          <p className="mt-0.5 font-serif text-lead font-semibold text-ink">{thread.resolution_vi}</p>
          {decided && <p className="mt-1 text-caption text-soft">Trong bảng thuật ngữ {decided.book_id == null ? 'dùng chung mọi sách' : 'của sách'}{decided.topic ? ` · ${decided.topic}` : ''}{decided.note ? ` · ${decided.note}` : ''}</p>}
        </div>
      )}

      {decisionOpen && (decided || thread.vocabulary) && (
        <div className="space-y-1 rounded-md bg-sunken px-3 py-2 text-caption text-soft">
          {decided && <p><span className="font-medium text-ink">Thuật ngữ đã chốt trước đây:</span> {decided.meaning_vi} ({decided.book_id == null ? 'mọi sách' : 'sách này'})</p>}
          {thread.vocabulary && <p><span className="font-medium text-ink">Trong kho từ vựng:</span> {thread.vocabulary.meaning_vi}{thread.vocabulary.ipa ? ` · ${thread.vocabulary.ipa}` : ''}</p>}
        </div>
      )}

      {thread.assignments?.length > 0 && <AssignmentChips assignments={thread.assignments} />}

      <div className="space-y-3">
        {thread.posts.length === 0 && <p className="text-body text-mute">Chưa có bình luận hay đề xuất nào.</p>}
        {thread.posts.map((p) => (
          <Post
            key={p.id}
            post={p}
            me={user.id}
            canJoin={canJoin}
            canModerate={canModerate}
            canResolve={thread.canResolve}
            open={conversationOpen}
            onThread={apply}
            onPick={(m) => setResolving({ meaning: m })}
          />
        ))}
      </div>

      {error && <Notice>{error}</Notice>}

      {resolving ? (
        <ResolveForm thread={thread} initialMeaning={resolving.meaning} onCancel={() => setResolving(null)} onDone={(t) => { setResolving(null); apply(t); }} />
      ) : thread.canResolve && (
        <div className="flex flex-wrap gap-2">
          {decisionOpen ? (
            <Button size="sm" onClick={() => setResolving({ meaning: topProposal?.meaning_vi || '' })}>
              <BookCheck size={14} /> Chốt cách dịch{topProposal ? ` (${topProposal.votes} phiếu cao nhất)` : ''}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setResolving({ meaning: thread.resolution_vi })}><Pencil size={14} /> Sửa quyết định</Button>
              <Button size="sm" variant="ghost" onClick={async () => apply(await api.reopenThread(thread.id))}><RotateCcw size={14} /> Mở lại</Button>
            </>
          )}
        </div>
      )}

      {thread.canClose && !resolving && (
        <div className="flex flex-wrap gap-2 border-t border-rule pt-3">
          {thread.discussion_status === 'closed' ? (
            <Button size="sm" variant="ghost" onClick={async () => apply(await api.reopenDiscussion(thread.id))}>
              <RotateCcw size={14} /> Mở lại thảo luận
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={async () => apply(await api.closeDiscussion(thread.id))}>
              <Check size={14} /> Đóng thảo luận
            </Button>
          )}
        </div>
      )}

      {canJoin && !resolving && conversationOpen && (
        <form onSubmit={send} className="space-y-2 rounded-lg border border-rule bg-page p-2.5 focus-within:border-accent">
          <Segmented
            size="sm"
            label="Loại"
            value={kind}
            onChange={setKind}
            options={[{ key: 'comment', label: 'Bình luận' }, { key: 'proposal', label: 'Đề xuất cách dịch' }]}
          />
          {kind === 'proposal' && (passage ? (
            <textarea value={meaning} onChange={(e) => setMeaning(e.target.value)} rows={3} placeholder="Bản dịch bạn đề xuất cho câu này" className={`${small} resize-y font-serif`} aria-label="Cách dịch đề xuất" />
          ) : (
            <input value={meaning} onChange={(e) => setMeaning(e.target.value)} placeholder="Cách dịch bạn đề xuất" className={`${small} font-semibold`} aria-label="Cách dịch đề xuất" />
          ))}
          <div className="flex items-end gap-2">
            <textarea
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }}
              rows={Math.min(5, Math.max(1, text.split('\n').length))}
              placeholder={kind === 'proposal' ? 'Lý do (tuỳ chọn)' : 'Viết bình luận… Bôi chọn chữ trong đoạn để trích vào. (Enter để gửi)'}
              aria-label="Nội dung"
              className="min-w-0 flex-1 resize-none bg-transparent text-body text-ink placeholder:text-mute focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Gửi"
              disabled={sending || (kind === 'proposal' ? !meaning.trim() : !text.trim())}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-strong disabled:opacity-40"
            >
              {sending ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </form>
      )}
      {!conversationOpen && canJoin && <p className="rounded-md bg-sunken px-3 py-2 text-meta text-mute">{thread.status === 'resolved' ? 'Cách dịch đã được chốt. Mở lại quyết định dịch nếu cần tiếp tục trao đổi.' : 'Thảo luận đã đóng. Mở lại thảo luận để tiếp tục bình luận.'}</p>}
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------

function ThreadRow({ t, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(t.id)} className="flex w-full items-start gap-2.5 rounded-lg border border-rule bg-page px-3 py-2.5 text-left hover:border-accent">
      <MessagesSquare size={15} className={`mt-1 shrink-0 ${t.status === 'resolved' ? 'text-ok' : 'text-warn'}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`font-serif text-ink ${isPassage(t.term) ? 'line-clamp-2 text-body' : 'truncate text-lead font-semibold'}`}>{t.term}</span>
          {t.unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" title="Có hoạt động mới" /> : null}
        </span>
        <span className="block text-caption text-mute">
          {t.status === 'resolved' ? <>Đã chốt cách dịch: <span className="text-ok">{t.resolution_vi}</span></> : `${t.proposal_count} đề xuất · ${t.post_count} bình luận`}
          {t.discussion_status === 'closed' && ' · Đã đóng bình luận'}
          {' · '}{timeAgo(t.updated_at)}
        </span>
      </span>
    </button>
  );
}

export function DiscussionPanel({ paragraph, index, onThreadsChanged }) {
  const discussion = useDiscussion();
  const { can } = useAuth();
  const canJoin = can('discuss.join');
  const canAssign = can('team.manage');
  const { state } = discussion;
  const [threads, setThreads] = useState(null);
  const [threadId, setThreadId] = useState(state.threadId || null);
  const [composing, setComposing] = useState(Boolean(state.term) && canJoin);
  const [assign, setAssign] = useState(null); // { assignments, place } when shown
  const [error, setError] = useState('');
  const pid = paragraph.id;

  const loadList = useCallback(() => api.listThreads({ paragraphId: pid }).then(setThreads).catch((e) => setError(e.message)), [pid]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(`paragraph-${pid}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input,textarea,select')) discussion.close(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey); };
  }, [pid, discussion]);

  const loadAssignments = () => api.listAssignments({ paragraphId: pid }).then(setAssign).catch((e) => setError(e.message));

  const changed = useCallback((t) => {
    onThreadsChanged?.({
      id: t.id, paragraph_id: t.paragraph_id, term: t.term, side: t.side, status: t.status,
      resolution_vi: t.resolution_vi, anchor_start: t.anchor_start, anchor_end: t.anchor_end, anchor_text: t.anchor_text,
      discussion_status: t.discussion_status,
    });
    loadList();
  }, [onThreadsChanged, loadList]);

  return (
    <aside
      aria-label="Bình luận và cách dịch"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-rule bg-desk font-sans shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.25)] sm:w-[460px]"
    >
      <header className="border-b border-rule bg-page px-4 pb-3 pt-3.5">
        <div className="flex items-start gap-2">
          <MessagesSquare size={18} className="mt-1 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-sans text-heading font-semibold text-ink">Bình luận &amp; cách dịch</h2>
            <p className="text-meta text-mute">Đoạn {index + 1}. Trao đổi về phần được chọn; chốt cách dịch là bước riêng.</p>
          </div>
          <button
            type="button"
            title="Người phụ trách đoạn này"
            aria-label="Người phụ trách đoạn này"
            aria-pressed={Boolean(assign)}
            onClick={() => (assign ? setAssign(null) : loadAssignments())}
            className={`grid h-8 w-8 place-items-center rounded-md ${assign ? 'bg-accent-soft text-accent' : 'text-mute hover:bg-sunken hover:text-ink'}`}
          >
            <Users size={16} />
          </button>
          <button type="button" aria-label="Đóng" onClick={discussion.close} className="grid h-8 w-8 place-items-center rounded-md text-mute hover:bg-sunken hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <p className="mt-2.5 line-clamp-2 rounded-md bg-sunken px-3 py-2 font-serif text-meta leading-snug text-soft">{previewText(paragraph.english_md)}</p>
        {assign && (
          <div className="mt-2.5 space-y-2 rounded-md border border-rule p-2.5">
            <p className="text-caption font-medium text-soft">Phụ trách (gồm cả phân công theo sách, chương, mục)</p>
            {assign.assignments.length ? <AssignmentChips assignments={assign.assignments} showScope /> : <p className="text-caption text-mute">Chưa có ai được phân công.</p>}
            {canAssign && (
              <AssignForm
                scopes={[
                  { key: 'paragraph', label: 'Đoạn này', payload: { paragraphId: pid } },
                  { key: 'section', label: 'Cả mục', payload: { sectionId: assign.place.section_id } },
                  { key: 'chapter', label: 'Cả chương', payload: { chapterId: assign.place.chapter_id } },
                ]}
                onAdded={loadAssignments}
              />
            )}
          </div>
        )}
      </header>

      <div data-scroll className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {error && <Notice>{error}</Notice>}
        {threadId ? (
          <ThreadView
            key={threadId}
            threadId={threadId}
            onBack={() => setThreadId(null)}
            onChanged={changed}
            onDeleted={(t) => { onThreadsChanged?.({ id: t.id, removed: true }); setThreadId(null); loadList(); }}
          />
        ) : (
          <>
            {composing ? (
              <NewThreadForm
                key={state.key}
                paragraph={paragraph}
                initialTerm={state.term || ''}
                initialSide={state.side || 'en'}
                anchor={state.anchor || null}
                onCancel={() => setComposing(false)}
                onCreated={(t) => { setComposing(false); changed(t); setThreadId(t.id); }}
              />
            ) : canJoin && (
              <Button size="sm" onClick={() => setComposing(true)}><Plus size={14} /> Bình luận về từ / cụm từ</Button>
            )}
            {!threads && <p className="text-body text-mute">Đang tải…</p>}
            {threads?.length === 0 && !composing && (
              <p className="text-body leading-relaxed text-soft">
                Chưa có bình luận nào cho đoạn này. Bôi chọn từ hoặc câu trong bản gốc hay bản dịch, rồi bấm <span className="font-medium text-ink">Bình luận</span> để gắn góp ý vào đúng vị trí.
              </p>
            )}
            {threads?.map((t) => <ThreadRow key={t.id} t={t} onOpen={setThreadId} />)}
          </>
        )}
      </div>
    </aside>
  );
}
