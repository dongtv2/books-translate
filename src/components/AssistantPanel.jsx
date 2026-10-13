import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, BookCheck, Check, ChevronDown, Eraser, Feather, Languages, ListChecks, LoaderCircle, MessageSquareQuote,
  Pencil, ScanSearch, Sparkles, Undo2, X,
} from 'lucide-react';
import { api } from '../api.js';
import { RichText } from '../lib/markdownLite.jsx';
import { AnswerText, DiffView } from './AiText.jsx';
import { previewText } from '../lib/inlineMarkdown.js';
import { diffWords, diffStats } from '../lib/textDiff.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Notice, Segmented, Tag, inputClass } from './ui.jsx';

// The translation assistant beside the chapter: a chat about one paragraph,
// built-in analysis skills, and proposed translations shown as a
// before/after comparison that is applied only when the user approves it.

const SKILL_ICONS = {
  accuracy: ScanSearch,
  natural: Feather,
  terms: BookCheck,
  intent: MessageSquareQuote,
  explain: Languages,
  vocab: ListChecks,
  summary: Sparkles,
};

const AssistantContext = createContext(null);

export function useAssistant() {
  return useContext(AssistantContext);
}

// Wraps the chapter: knows which paragraph the assistant is open for.
export function AssistantProvider({ children }) {
  const [openId, setOpenId] = useState(null);
  const isOpen = openId != null;

  // Fold the app sidebar while the panel is open, so the chapter keeps all
  // its columns beside it (see AppShell in App.jsx).
  useEffect(() => {
    if (!isOpen) return undefined;
    window.dispatchEvent(new CustomEvent('bt:make-room', { detail: true }));
    return () => window.dispatchEvent(new CustomEvent('bt:make-room', { detail: false }));
  }, [isOpen]);
  const value = useMemo(() => ({
    openId,
    open: (id) => setOpenId(id),
    close: () => setOpenId(null),
  }), [openId]);
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

const STATUS_TAG = {
  approved: { tone: 'ok', label: 'Đã áp dụng' },
  rejected: { tone: 'neutral', label: 'Đã bỏ qua' },
  reverted: { tone: 'neutral', label: 'Đã hoàn tác' },
};

function RevisionCard({ message, paragraph, canApply, onChanged }) {
  const pending = message.revision_status === 'pending';
  // A pending proposal is compared with the translation as it is now — that
  // is what applying it replaces. A decided one shows what it changed.
  const base = pending ? paragraph.vietnamese_md || '' : message.revision_before || '';
  const stale = pending && base.trim() !== (message.revision_before || '').trim();
  const [view, setView] = useState('diff');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.revision_after);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const after = editing ? text : message.revision_after;
  const stats = useMemo(() => diffStats(diffWords(previewText(base), previewText(after))), [base, after]);

  async function run(kind, fn) {
    setBusy(kind);
    setError('');
    try {
      await onChanged(await fn());
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-rule bg-page">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-sunken px-3 py-2">
        <p className="text-meta font-semibold text-ink">
          Bản dịch đề xuất
          <span className="ml-2 font-normal tabular-nums text-mute">
            <span className="text-flag">−{stats.removed}</span> <span className="text-ok">+{stats.added}</span> từ
          </span>
        </p>
        <Segmented
          size="sm"
          label="Cách so sánh"
          value={view}
          onChange={setView}
          options={[{ key: 'diff', label: 'Khác biệt' }, { key: 'both', label: 'Trước / Sau' }]}
        />
      </div>

      <div className="space-y-3 px-3 py-3">
        {stale && <p className="text-caption text-warn">Bản dịch đã đổi sau khi AI đề xuất; so sánh dưới đây là với bản hiện tại.</p>}
        {editing ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className={`${inputClass} font-serif leading-relaxed`} />
        ) : view === 'diff' ? (
          <DiffView before={base} after={after} />
        ) : (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-caption font-medium text-mute">Trước</p>
              <p className="font-serif text-body leading-relaxed text-soft"><RichText text={base || '(chưa có bản dịch)'} /></p>
            </div>
            <div className="border-t border-rule pt-3">
              <p className="mb-1 text-caption font-medium text-mute">Sau</p>
              <p className="font-serif text-body leading-relaxed text-ink"><RichText text={after} /></p>
            </div>
          </div>
        )}
        {error && <Notice>{error}</Notice>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2.5">
        {pending ? (
          canApply ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(busy) || !after.trim()}
                onClick={() => run('approve', () => api.approveRevision(paragraph.id, message.id, { text: editing ? text : undefined, force: stale }))}
              >
                {busy === 'approve' ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} Áp dụng bản này
              </Button>
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { setEditing((v) => !v); setText(message.revision_after); }}>
                <Pencil size={14} /> {editing ? 'Thôi sửa' : 'Sửa trước khi áp dụng'}
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" disabled={Boolean(busy)} onClick={() => run('reject', () => api.rejectRevision(paragraph.id, message.id))}>
                Bỏ qua
              </Button>
            </>
          ) : (
            <>
              <span className="text-caption text-mute">Cần quyền biên tập để áp dụng vào sách.</span>
              <Button size="sm" variant="ghost" className="ml-auto" disabled={Boolean(busy)} onClick={() => run('reject', () => api.rejectRevision(paragraph.id, message.id))}>
                Bỏ qua
              </Button>
            </>
          )
        ) : (
          <>
            <Tag tone={STATUS_TAG[message.revision_status]?.tone}>{STATUS_TAG[message.revision_status]?.label}</Tag>
            {message.revision_status === 'approved' && canApply && (
              <Button size="sm" variant="ghost" className="ml-auto" disabled={Boolean(busy)} onClick={() => run('revert', () => api.revertRevision(paragraph.id, message.id))}>
                <Undo2 size={14} /> Hoàn tác
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SkillGrid({ skills, onPick, disabled }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {skills.map((s) => {
        const Icon = SKILL_ICONS[s.key] || Sparkles;
        return (
          <button
            key={s.key}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s.key)}
            className="flex items-start gap-2.5 rounded-lg border border-rule bg-page px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0">
              <span className="block text-body font-medium text-ink">{s.label}</span>
              <span className="block text-caption leading-snug text-mute">{s.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SkillChips({ skills, onPick, disabled }) {
  return (
    <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2">
      {skills.map((s) => {
        const Icon = SKILL_ICONS[s.key] || Sparkles;
        return (
          <button
            key={s.key}
            type="button"
            disabled={disabled}
            title={s.description}
            onClick={() => onPick(s.key)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-meta text-soft hover:border-accent hover:text-ink disabled:opacity-50"
          >
            <Icon size={13} className="text-accent" /> {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function AssistantPanel({ paragraph, index, onParagraphUpdated }) {
  const assistant = useAssistant();
  const { can } = useAuth();
  const canApply = can('books.edit');
  const [skills, setSkills] = useState([]);
  const [messages, setMessages] = useState(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(null); // the user message being answered
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const scroller = useRef(null);
  const inputRef = useRef(null);
  const pid = paragraph.id;

  useEffect(() => {
    let live = true;
    setMessages(null);
    setError('');
    api.getAssistant(pid)
      .then((r) => { if (live) { setSkills(r.skills); setMessages(r.messages); } })
      .catch((e) => live && setError(e.message));
    inputRef.current?.focus();
    // After the page makes room for the panel, keep the paragraph in view.
    const frame = requestAnimationFrame(() => document.getElementById(`paragraph-${pid}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => { live = false; cancelAnimationFrame(frame); };
  }, [pid]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') assistant.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistant]);

  const send = useCallback(async ({ message = '', skill = '' }) => {
    if (pending || (!message.trim() && !skill)) return;
    const label = skill ? skills.find((s) => s.key === skill)?.label || 'Áp dụng góp ý vào bản dịch' : message.trim();
    setPending({ content: label, skill });
    setError('');
    setInput('');
    try {
      const r = await api.askAssistant(pid, { message, skill });
      setMessages((m) => [...(m || []), ...r.messages]);
    } catch (e) {
      setError(e.message);
      if (!skill) setInput(message);
    } finally {
      setPending(null);
    }
  }, [pending, pid, skills]);

  async function handleRevisionChange(result) {
    setMessages((m) => m.map((x) => (x.id === result.message.id ? result.message : x)));
    if (result.paragraph) onParagraphUpdated(result.paragraph);
  }

  async function clearThread() {
    await api.clearAssistant(pid);
    setMessages([]);
  }

  const lastAssistant = messages?.findLast((m) => m.role === 'assistant');
  const empty = messages && messages.length === 0 && !pending;

  return (
    <aside
      aria-label="Trợ lý dịch"
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-rule bg-desk shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.25)] sm:w-[460px]"
    >
      <header className="border-b border-rule bg-page px-4 pb-3 pt-3.5">
        <div className="flex items-start gap-2">
          <Sparkles size={18} className="mt-1 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-heading font-semibold text-ink">Trợ lý dịch</h2>
            <p className="text-meta text-mute">Đoạn {index + 1}. Mọi thay đổi chỉ vào sách khi bạn duyệt.</p>
          </div>
          {messages?.length > 0 && (
            <button type="button" title="Xoá hội thoại" aria-label="Xoá hội thoại" onClick={clearThread} className="grid h-8 w-8 place-items-center rounded-md text-mute hover:bg-sunken hover:text-ink">
              <Eraser size={16} />
            </button>
          )}
          <button type="button" aria-label="Đóng trợ lý" onClick={assistant.close} className="grid h-8 w-8 place-items-center rounded-md text-mute hover:bg-sunken hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <button
          type="button"
          aria-expanded={showSource}
          onClick={() => setShowSource((v) => !v)}
          className="mt-2.5 flex w-full items-start gap-2 rounded-md bg-sunken px-3 py-2 text-left"
        >
          <span className={`min-w-0 flex-1 font-serif text-meta leading-snug text-soft ${showSource ? '' : 'line-clamp-2'}`}>
            {previewText(paragraph.english_md)}
          </span>
          <ChevronDown size={15} className={`mt-0.5 shrink-0 text-mute transition-transform ${showSource ? 'rotate-180' : ''}`} />
        </button>
      </header>

      <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!messages && !error && <p className="text-body text-mute">Đang tải…</p>}

        {empty && (
          <div className="space-y-4">
            <p className="text-body leading-relaxed text-soft">
              Hỏi bất cứ điều gì về đoạn này, chạy một kỹ năng phân tích, hoặc nói điều bạn muốn sửa trong bản dịch. Khi AI đề xuất bản mới, bạn xem so sánh trước và sau rồi mới quyết định áp dụng.
            </p>
            <SkillGrid skills={skills} onPick={(skill) => send({ skill })} disabled={Boolean(pending)} />
          </div>
        )}

        {messages?.map((m) => (
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-line rounded-lg rounded-br-sm bg-accent-soft px-3 py-2 text-body text-ink">
                {m.skill && <Sparkles size={13} className="-mt-0.5 mr-1.5 inline text-accent" />}
                {m.content}
              </p>
            </div>
          ) : (
            <div key={m.id}>
              <AnswerText text={m.content} />
              {m.revision_after && (
                <RevisionCard message={m} paragraph={paragraph} canApply={canApply} onChanged={handleRevisionChange} />
              )}
              {m === lastAssistant && !m.revision_after && m.skill !== 'summary' && m.skill !== 'vocab' && !pending && (
                <button
                  type="button"
                  onClick={() => send({ skill: 'apply' })}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-md text-meta font-medium text-accent hover:text-accent-strong"
                >
                  <Pencil size={13} /> Áp dụng góp ý này vào bản dịch
                </button>
              )}
            </div>
          )
        ))}

        {pending && (
          <>
            <div className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-line rounded-lg rounded-br-sm bg-accent-soft px-3 py-2 text-body text-ink">{pending.content}</p>
            </div>
            <p className="flex items-center gap-2 text-body text-mute" role="status">
              <LoaderCircle size={15} className="animate-spin" /> Đang {pending.skill ? 'phân tích' : 'trả lời'}…
            </p>
          </>
        )}

        {error && <Notice>{error}</Notice>}
      </div>

      <footer className="border-t border-rule bg-page px-4 pb-4 pt-3">
        {!empty && skills.length > 0 && <SkillChips skills={skills} onPick={(skill) => send({ skill })} disabled={Boolean(pending)} />}
        <form
          onSubmit={(e) => { e.preventDefault(); send({ message: input }); }}
          className="flex items-end gap-2 rounded-lg border border-rule bg-page px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send({ message: input }); }
            }}
            rows={Math.min(6, Math.max(2, input.split('\n').length))}
            placeholder="Hỏi về đoạn này, hoặc yêu cầu: “dịch câu 2 trang trọng hơn”"
            aria-label="Tin nhắn cho trợ lý"
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-body text-ink placeholder:text-mute focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Gửi"
            disabled={!input.trim() || Boolean(pending)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-on-accent hover:bg-accent-strong disabled:opacity-40"
          >
            <ArrowUp size={16} />
          </button>
        </form>
        <p className="mt-1.5 text-caption text-mute">Enter để gửi, Shift + Enter để xuống dòng.</p>
      </footer>
    </aside>
  );
}
