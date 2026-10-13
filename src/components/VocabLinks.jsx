import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { inputClass } from './ui.jsx';

// The user's own note on a word: kept on their list ("Từ của tôi"), seen
// by nobody else.
function MyNote({ row, onSaved }) {
  const [note, setNote] = useState(row.my_note || '');
  const [state, setState] = useState('');
  const dirty = note !== (row.my_note || '');
  async function save() {
    setState('saving');
    try {
      onSaved(await api.setMyVocab(row.id, note));
      setState('saved');
    } catch (e) {
      setState(e.message);
    }
  }
  return (
    <div>
      <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">Ghi chú của tôi</p>
      <textarea value={note} onChange={(e) => { setNote(e.target.value); setState(''); }} rows={2} maxLength={2000}
        placeholder="Chỉ mình bạn thấy: mẹo nhớ, nghĩa trong ngữ cảnh khác…" aria-label="Ghi chú của tôi"
        className="w-full resize-y rounded-md border border-rule bg-page px-2.5 py-1.5 text-meta text-ink placeholder:text-mute focus:border-accent focus:outline-none" />
      <div className="mt-1 flex items-center gap-2">
        <button type="button" onClick={save} disabled={!dirty || state === 'saving'} className="text-meta font-medium text-accent disabled:text-mute">
          {state === 'saving' ? 'Đang lưu…' : 'Lưu ghi chú'}
        </button>
        {state === 'saved' && <span className="text-caption text-ok">Đã lưu{row.owner_id == null ? ', từ này đã vào "Từ của tôi"' : ''}.</span>}
        {state && !['saving', 'saved'].includes(state) && <span className="text-caption text-flag">{state}</span>}
      </div>
    </div>
  );
}

// What one vocabulary entry connects to: every paragraph it occurs in (any
// book, not only the one it was collected from), its word family and the
// phrases built on it, the team's glossary decision and term discussions.
// `onPick` opens a related entry in the vocabulary list.
// A shared word's meanings per book: listed for everyone, written by
// editors. A book without one uses the general meaning (or that of a book
// of the same field).
function Senses({ wordId, senses, canEdit, onChange }) {
  const [books, setBooks] = useState(null);
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  async function startAdd() {
    setError('');
    if (!books) setBooks(await api.listBooks().catch(() => []));
    setDraft({ bookId: '', meaning_vi: '' });
  }
  async function run(fn) {
    try { await fn(); setError(''); onChange(); } catch (e) { setError(e.message); }
  }
  const taken = new Set(senses.map((x) => x.book_id));

  if (!senses.length && !canEdit) return null;
  return (
    <div>
      <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">Nghĩa theo sách</p>
      {senses.length === 0 && <p className="text-meta text-mute">Chưa có — mọi sách dùng nghĩa chung.</p>}
      <ul className="space-y-1">
        {senses.map((x) => (
          <li key={x.id} className="text-meta">
            {editing?.id === x.id ? (
              <span className="flex gap-1">
                <input value={editing.meaning_vi} onChange={(e) => setEditing({ ...editing, meaning_vi: e.target.value })} aria-label="Nghĩa" className={`${inputClass} py-0.5`} />
                <button type="button" className="text-accent" onClick={() => run(async () => { await api.updateSense(x.id, { meaning_vi: editing.meaning_vi }); setEditing(null); })}>Lưu</button>
              </span>
            ) : (
              <>
                <span className="text-mute">{x.book_title}:</span> <span className="text-ink">{x.meaning_vi}</span>
                {canEdit && (
                  <span className="ml-2 inline-flex gap-2 text-caption">
                    <button type="button" className="text-soft hover:text-accent" onClick={() => setEditing({ id: x.id, meaning_vi: x.meaning_vi })}>Sửa</button>
                    <button type="button" className="text-soft hover:text-flag" onClick={() => run(() => api.deleteSense(x.id))}>Xoá</button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && !draft && <button type="button" onClick={startAdd} className="mt-1 text-meta text-accent">+ Thêm nghĩa cho một sách</button>}
      {canEdit && draft && (
        <div className="mt-1 space-y-1">
          <select value={draft.bookId} onChange={(e) => setDraft({ ...draft, bookId: e.target.value })} aria-label="Sách" className={`${inputClass} py-1`}>
            <option value="">Chọn sách…</option>
            {(books || []).filter((b) => !taken.has(b.id)).map((b) => <option key={b.id} value={b.id}>{b.title_vi || b.title_en}{b.domain ? ` (${b.domain})` : ''}</option>)}
          </select>
          <input value={draft.meaning_vi} onChange={(e) => setDraft({ ...draft, meaning_vi: e.target.value })} placeholder="Nghĩa trong sách này" aria-label="Nghĩa trong sách này" className={`${inputClass} py-1`} />
          <div className="flex gap-2 text-meta">
            <button type="button" className="font-medium text-accent disabled:text-mute" disabled={!draft.bookId || !draft.meaning_vi.trim()}
              onClick={() => run(async () => { await api.addSense(wordId, { bookId: Number(draft.bookId), meaning_vi: draft.meaning_vi }); setDraft(null); })}>Thêm</button>
            <button type="button" className="text-soft" onClick={() => setDraft(null)}>Huỷ</button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-caption text-flag">{error}</p>}
    </div>
  );
}

export default function VocabLinks({ id, onPick, row, canOwn = false, canEdit = false, onRowChange }) {
  const [links, setLinks] = useState(null);
  const [error, setError] = useState('');

  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.vocabLinks(id)
      .then((l) => { if (!cancelled) setLinks(l); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [id, reloads]);

  if (error) return <p className="text-meta text-flag">{error}</p>;
  if (!links) return <p className="text-meta text-mute">Đang tìm liên kết…</p>;

  const related = (title, rows) => rows.length > 0 && (
    <div>
      <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <button key={r.id} type="button" onClick={() => onPick(r.term)} title={r.meaning_vi}
            className="rounded-full border border-rule px-2.5 py-0.5 text-meta text-soft hover:border-accent hover:text-ink">
            {r.term} <span className="text-mute">{r.word_type}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">
          Xuất hiện trong {links.occurrenceCount} đoạn văn
        </p>
        {links.occurrences.length ? (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {links.occurrences.map((o) => (
              <li key={o.paragraph_id} className="text-meta">
                <Link to={`/chapters/${o.chapter_id}#paragraph-${o.paragraph_id}`} className="block rounded px-1 py-0.5 hover:bg-sunken">
                  <span className="font-serif italic text-ink">{o.sentence || '…'}</span>
                  <span className="block truncate text-caption text-mute">{o.chapter_title}{o.translated ? '' : ' · chưa dịch'}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="text-meta text-mute">Không tìm thấy trong sách nào.</p>}
      </div>
      <div className="min-w-0 space-y-3">
        {canOwn && row && <MyNote row={row} onSaved={(r) => onRowChange?.(r)} />}
        {links.owner_id == null && <Senses wordId={id} senses={links.senses || []} canEdit={canEdit} onChange={() => setReloads((n) => n + 1)} />}
        {related('Cùng họ từ', links.family)}
        {related('Cụm từ chứa từ này', links.phrases)}
        {links.glossary.length > 0 && (
          <div>
            <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">Thuật ngữ đã thống nhất</p>
            {links.glossary.map((g) => (
              <p key={g.id} className="text-meta text-ink">
                {g.term} = <strong>{g.meaning_vi}</strong> <span className="text-mute">({g.book_title || 'mọi sách'})</span>
              </p>
            ))}
          </div>
        )}
        {links.threads.length > 0 && (
          <div>
            <p className="mb-1 text-caption font-medium uppercase tracking-wide text-mute">Thảo luận</p>
            {links.threads.map((t) => (
              <Link key={t.id} to={`/chapters/${t.chapter_id}#paragraph-${t.paragraph_id}`} className="block text-meta text-soft hover:text-accent">
                {t.term} — {t.status === 'resolved' ? `đã chốt: ${t.resolution_vi}` : 'đang bàn'}
              </Link>
            ))}
          </div>
        )}
        {!links.family.length && !links.phrases.length && !links.glossary.length && !links.threads.length && (
          <p className="text-meta text-mute">Chưa có từ liên quan, thuật ngữ hay thảo luận nào.</p>
        )}
      </div>
    </div>
  );
}
