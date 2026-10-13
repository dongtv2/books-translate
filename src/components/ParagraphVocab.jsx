import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api, WORD_TYPES } from '../api.js';
import { plainText } from '../lib/inlineMarkdown.js';
import { findTerms } from '../lib/vocabMatch.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { Button } from './ui.jsx';

// The vocabulary entries of the chapter (its knownTerms), shared by every
// paragraph editor so a word added or edited in one paragraph shows up in
// the others — and in the reading view's word marks — right away.
const ChapterVocabContext = createContext(null);

export function ChapterVocabProvider({ entries, setEntries, bookId, chapterId, children }) {
  const value = useMemo(() => ({
    entries: entries || [],
    bookId,
    chapterId,
    upsert: (entry) => setEntries((list) => {
      const rest = (list || []).filter((e) => e.id !== entry.id);
      const old = (list || []).find((e) => e.id === entry.id);
      return [...rest, { ...old, ...entry }];
    }),
    remove: (id) => setEntries((list) => (list || []).filter((e) => e.id !== id)),
  }), [entries, setEntries, bookId, chapterId]);
  return <ChapterVocabContext.Provider value={value}>{children}</ChapterVocabContext.Provider>;
}

let topicsPromise = null;
const loadTopics = () => (topicsPromise ??= api.vocabTopics().catch(() => { topicsPromise = null; return []; }));

// Words shown before "Xem thêm", so the notes column stays short.
const COLLAPSED = 5;

const fieldClass = 'w-full rounded border border-rule bg-page px-2 py-1 text-meta text-ink focus:border-accent focus:outline-none';

function VocabForm({ entry, topics, canEdit, isNew = false, busy, onField, onCreate, onDelete, onClose }) {
  const [draft, setDraft] = useState(entry);
  useEffect(() => { setDraft(entry); }, [entry]);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  // Existing entries save each field as it is left; a new one is saved as a
  // whole with "Lưu vào kho".
  const commit = (k) => () => { if (!isNew && draft[k] !== entry[k]) onField(k, draft[k]); };

  return (
    <li className="space-y-1.5 bg-sunken/60 px-2 py-2">
      <div className="flex items-center gap-1">
        <input aria-label="Từ / cụm từ" value={draft.term || ''} onChange={set('term')} onBlur={commit('term')} disabled={!canEdit} className={`${fieldClass} font-semibold`} />
        <button type="button" aria-label="Đóng" onClick={onClose} className="grid h-6 w-6 shrink-0 place-items-center rounded text-mute hover:bg-rule hover:text-ink"><X size={13} /></button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <input aria-label="IPA" placeholder="/IPA/" value={draft.ipa || ''} onChange={set('ipa')} onBlur={commit('ipa')} disabled={!canEdit} className={fieldClass} />
        <select aria-label="Loại từ" value={draft.word_type || ''} onChange={(e) => { set('word_type')(e); if (!isNew) onField('word_type', e.target.value); }} disabled={!canEdit} className={fieldClass}>
          {!draft.word_type && <option value="">Loại từ</option>}
          {WORD_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      <input aria-label="Nghĩa tiếng Việt" placeholder="Nghĩa tiếng Việt" value={draft.meaning_vi || ''} onChange={set('meaning_vi')} onBlur={commit('meaning_vi')} disabled={!canEdit} className={fieldClass} />
      <select aria-label="Chủ đề" value={draft.topic || ''} onChange={(e) => { set('topic')(e); if (!isNew) onField('topic', e.target.value); }} disabled={!canEdit} className={fieldClass}>
        {!topics.includes(draft.topic) && <option value={draft.topic || ''}>Chưa phân loại</option>}
        {topics.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <textarea aria-label="Câu ví dụ" placeholder="Câu ví dụ" rows={2} value={draft.example || ''} onChange={set('example')} onBlur={commit('example')} disabled={!canEdit} className={`${fieldClass} resize-none font-serif`} />
      {canEdit && (
        <div className="flex items-center gap-2 pt-0.5">
          {isNew ? (
            <Button size="sm" variant="primary" disabled={busy || !draft.term?.trim()} onClick={() => onCreate(draft)}>
              {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />} Lưu vào kho
            </Button>
          ) : (
            <span className="text-caption text-mute">Tự lưu khi rời ô</span>
          )}
          {!isNew && (
            <button type="button" onClick={onDelete} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-mute hover:bg-flag-soft hover:text-flag">
              <Trash2 size={12} /> Xoá khỏi kho
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// "Kho từ vựng của đoạn" in the paragraph editor: the vocabulary entries
// that occur in this paragraph (or were collected from it), editable in
// place, and a field to add a new one — the selected English text is taken
// as the term, and the AI fills in IPA, word type, meaning and topic.
export default function ParagraphVocab({ paragraphId, englishMd }) {
  const ctx = useContext(ChapterVocabContext);
  const confirm = useConfirm();
  const { can } = useAuth();
  // Editors change the shared vocabulary; learners add words of their own
  // (and change only those).
  const canEdit = can('vocab.edit');
  const canAdd = canEdit || can('vocab.own');
  const canEditEntry = (w) => canEdit || w.owner_id != null;
  const [topics, setTopics] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { loadTopics().then(setTopics); }, []);

  // The last text selected inside this paragraph, remembered as it changes:
  // by the time the add field is clicked the selection is already gone.
  const lastSelection = useRef('');
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      const row = document.getElementById(`paragraph-${paragraphId}`);
      if (sel && !sel.isCollapsed && row?.contains(sel.anchorNode) && !(sel.anchorNode instanceof HTMLInputElement)) {
        const text = sel.toString().trim();
        if (text && text.length <= 80) lastSelection.current = text;
      }
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [paragraphId]);

  const plain = useMemo(() => plainText(englishMd || ''), [englishMd]);
  const words = useMemo(() => {
    if (!ctx) return [];
    const order = new Map(findTerms(plain, ctx.entries).map((m, i) => [m.id, i]));
    return ctx.entries
      .filter((e) => order.has(e.id) || e.source_paragraph_id === paragraphId)
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  }, [ctx, plain, paragraphId]);

  if (!ctx) return null;

  // The text selected in this paragraph is offered as the new term.
  function takeSelection() {
    if (!term && lastSelection.current) setTerm(lastSelection.current);
  }

  async function startAdd(e) {
    e.preventDefault();
    const t = term.trim();
    if (!t) return;
    setError('');
    setBusy('suggest');
    try {
      setAdding({ term: t, source_paragraph_id: paragraphId, ...(await api.suggestVocab({ term: t, paragraphId })) });
    } catch (err) {
      setAdding({ term: t, source_paragraph_id: paragraphId });
      setError(`AI chưa điền được (${err.message}). Bạn tự điền nhé.`);
    } finally {
      setBusy('');
    }
  }

  async function create(draft) {
    setBusy('create');
    setError('');
    try {
      const entry = await api.createVocab({ ...draft, source_paragraph_id: paragraphId });
      ctx.upsert(entry);
      setAdding(null);
      setTerm('');
      setShowAll(true);
    } catch (err) {
      const existing = err.code === 'exists' && err.data?.entry;
      if (existing) {
        // A learner's word the shared vocabulary already has: put it on their
        // list instead of making a copy.
        const entry = !canEdit && err.data.scope === 'shared' ? await api.setMyVocab(existing.id).catch(() => existing) : existing;
        ctx.upsert(entry); setAdding(null); setOpenId(entry.id); setShowAll(true);
        setError(!canEdit && err.data.scope === 'shared' ? `"${entry.term}" đã có trong kho chung — đã thêm vào "Từ của tôi".` : err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy('');
    }
  }

  async function saveField(entry, key, value) {
    try {
      // Shown with this book's own meaning: editing it changes that sense,
      // not the word's general meaning.
      if (key === 'meaning_vi' && entry.sense_id) {
        await api.updateSense(entry.sense_id, { meaning_vi: value });
        ctx.upsert({ ...entry, meaning_vi: value });
        setError('');
        return;
      }
      ctx.upsert(await api.updateVocab(entry.id, { [key]: value }));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(entry) {
    if (!(await confirm(`Xoá "${entry.term}" khỏi kho từ vựng? Tiến độ ôn tập của từ này cũng mất.`))) return;
    try {
      await api.deleteVocab(entry.id);
      ctx.remove(entry.id);
      setOpenId(null);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <p className="mb-1 flex items-baseline justify-between text-caption font-medium text-mute">
        Kho từ vựng của đoạn <span className="tabular-nums">{words.length}</span>
      </p>
      {words.length > 0 && (
        <ul className="divide-y divide-rule/70 overflow-hidden rounded-md border border-rule/70">
          {(showAll ? words : words.slice(0, COLLAPSED)).map((w) => (openId === w.id ? (
            <VocabForm
              key={w.id}
              entry={w}
              topics={topics}
              canEdit={canEditEntry(w)}
              onField={(k, v) => saveField(w, k, v)}
              onDelete={() => remove(w)}
              onClose={() => setOpenId(null)}
            />
          ) : (
            <li key={w.id}>
              <button type="button" onClick={() => setOpenId(w.id)} className="block w-full px-2 py-1.5 text-left text-meta hover:bg-sunken">
                <span className="font-semibold text-ink">{w.term}</span>
                {w.owner_id != null && <span className="ml-1.5 rounded bg-accent-soft px-1 text-caption text-accent" title="Từ riêng của bạn">riêng</span>}
                {w.ipa && <span className="ml-1.5 text-mute">{w.ipa}</span>}
                {w.word_type && <span className="ml-1.5 italic text-mute">{w.word_type}</span>}
                <span className="block leading-snug text-soft">{w.meaning_vi}</span>
                {w.meaning_general && <span className="block text-caption text-mute" title={`Nghĩa chung: ${w.meaning_general}`}>nghĩa trong sách này</span>}
                {w.source_book_id && w.source_book_id !== ctx.bookId && (
                  <span className="block truncate text-caption text-mute" title={w.source_book_title}>Từ sách khác: {w.source_book_title}</span>
                )}
                {w.source_book_id === ctx.bookId && w.source_chapter_id && w.source_chapter_id !== ctx.chapterId && (
                  <span className="block truncate text-caption text-mute" title={w.source_chapter_title}>Đã có từ {w.source_chapter_title}</span>
                )}
              </button>
            </li>
          )))}
        </ul>
      )}
      {words.length > COLLAPSED && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-caption text-mute hover:text-accent">
          {showAll ? 'Thu gọn' : `Xem thêm ${words.length - COLLAPSED} từ`}
        </button>
      )}

      {canAdd && (adding ? (
        <ul className="mt-1.5 overflow-hidden rounded-md border border-accent/40">
          <VocabForm
            entry={adding}
            topics={topics}
            canEdit
            isNew
            busy={busy === 'create'}
            onCreate={create}
            onClose={() => setAdding(null)}
          />
        </ul>
      ) : (
        <form onSubmit={startAdd} className="mt-1.5 flex items-center gap-1">
          <input
            value={term}
            onMouseDown={takeSelection}
            onFocus={takeSelection}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={canEdit ? 'Thêm từ (chọn chữ ở cột English rồi bấm vào đây)' : 'Thêm từ của tôi (chọn chữ ở cột English rồi bấm vào đây)'}
            aria-label={canEdit ? 'Thêm từ vào kho' : 'Thêm từ của tôi'}
            className={fieldClass}
          />
          <button type="submit" disabled={!term.trim() || Boolean(busy)} title="Thêm, AI điền IPA, loại từ, nghĩa" className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-rule bg-page px-2 text-caption font-medium text-soft hover:border-accent hover:text-accent disabled:opacity-50">
            {busy === 'suggest' ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />} Thêm
          </button>
        </form>
      ))}
      {error && <p className="mt-1 text-caption text-flag">{error}</p>}
    </div>
  );
}
