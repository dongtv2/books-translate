import { useEffect, useRef, useState, useCallback } from 'react';
import PageContainer from '../components/PageContainer.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, ChevronDown, ChevronRight, Download, Pencil, Plus, Search, Send, Sparkles, Star, Trash2, Undo2 } from 'lucide-react';
import { api, WORD_TYPES, STATUSES } from '../api.js';
import SpeakButton from '../components/SpeakButton.jsx';
import { previewText } from '../lib/inlineMarkdown.js';
import { Button, Field, IconButton, MenuItem, Notice, PageHeader, Popover, Segmented, Sheet, Tag, inputClass } from '../components/ui.jsx';
import VocabProposals from '../components/VocabProposals.jsx';
import VocabDuplicates from '../components/VocabDuplicates.jsx';
import VocabLinks from '../components/VocabLinks.jsx';
import useVocabImport from '../hooks/useVocabImport.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { GenreFilter, GenreManager, GenreTags } from '../components/Genres.jsx';

const STATUS_STYLE = {
  'Thành thạo': { text: 'text-ok', fill: 'bg-ok' },
  'Đang học': { text: 'text-warn', fill: 'bg-warn' },
  'Cần ôn gấp': { text: 'text-flag', fill: 'bg-flag' },
};

// The whole vocabulary as one bar split by status: how much is mastered
// versus still in play is the thing to read here, not four separate totals.
// Each segment filters the table below.
function StatusBreakdown({ stats, status, onPick }) {
  if (!stats || !stats.total) return null;
  return (
    <div className="space-y-2.5">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-rule">
        {STATUSES.map((s) => (
          <div key={s} className={STATUS_STYLE[s].fill} style={{ width: `${((stats.byStatus[s] || 0) / stats.total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => onPick(status === s ? '' : s)}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1 text-body transition-colors ${status === s ? 'bg-page shadow-sm ring-1 ring-rule' : 'hover:bg-page'}`}
          >
            <span className={`h-2 w-2 rounded-full ${STATUS_STYLE[s].fill}`} />
            <span className="text-soft">{s}</span>
            <span className="font-semibold tabular-nums text-ink">{stats.byStatus[s] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// The fixed topics as a row of filter chips with their counts — the shape of
// the vocabulary by meaning at a glance, one tap to narrow the table.
function TopicFilter({ stats, topic, onPick }) {
  if (!stats?.topics?.length) return null;
  const chip = (active) => `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-meta transition-colors ${
    active ? 'border-accent bg-accent-soft text-ink' : 'border-rule text-soft hover:border-mute hover:text-ink'
  }`;
  return (
    <div role="group" aria-label="Lọc theo chủ đề" className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={!topic} onClick={() => onPick('')} className={chip(!topic)}>
        Mọi chủ đề <span className="tabular-nums text-mute">{stats.total}</span>
      </button>
      {stats.topics.filter((t) => t.c > 0 || t.topic === topic).map((t) => (
        <button key={t.topic} type="button" aria-pressed={topic === t.topic} onClick={() => onPick(topic === t.topic ? '' : t.topic)} className={chip(topic === t.topic)}>
          {t.topic} <span className="tabular-nums text-mute">{t.c}</span>
        </button>
      ))}
    </div>
  );
}

// Where a word was collected: the book (with its field) and the chapter,
// linking to the paragraph it came from.
function SourceLine({ row }) {
  if (!row.source_book_id) return <p className="mt-1.5 text-caption text-mute">Không rõ nguồn</p>;
  return (
    <div className="mt-1.5 min-w-0 space-y-0.5 text-caption text-mute">
      <Link to={`/books/${row.source_book_id}`} className="flex min-w-0 items-center gap-1 font-medium text-soft hover:text-accent" title={row.source_book_title}>
        <BookOpen size={12} className="shrink-0" />
        <span className="truncate">{row.source_book_title}</span>
      </Link>
      {row.source_chapter_title && (
        <Link to={`/chapters/${row.source_chapter_id}#paragraph-${row.source_paragraph_id}`} className="block truncate hover:text-accent" title={`${row.source_chapter_title} (mở đoạn chứa từ này)`}>
          {row.source_chapter_title}
        </Link>
      )}
      {row.source_book_domain && <p className="truncate" title={row.source_book_specialty || row.source_book_domain}>{row.source_book_domain}</p>}
    </div>
  );
}

function EditRow({ draft, setDraft, onSave, onCancel, topics }) {
  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  return (
    <tr className="bg-accent-soft/50">
      <td colSpan={6} className="border-b border-rule p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Từ / cụm từ"><input value={draft.term || ''} onChange={set('term')} className={inputClass} /></Field>
          <Field label="IPA"><input value={draft.ipa || ''} onChange={set('ipa')} className={inputClass} /></Field>
          <Field label="Loại từ">
            <select value={draft.word_type || ''} onChange={set('word_type')} className={inputClass}>
              {WORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Trạng thái">
            <select value={draft.status || ''} onChange={set('status')} className={inputClass}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Nghĩa tiếng Việt" className="sm:col-span-2"><input value={draft.meaning_vi || ''} onChange={set('meaning_vi')} className={inputClass} /></Field>
          <Field label="Chủ đề">
            <select value={draft.topic || ''} onChange={set('topic')} className={inputClass}>
              {!topics.includes(draft.topic) && <option value={draft.topic || ''}>Chưa phân loại</option>}
              {topics.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Ngày thêm"><input value={draft.date_added || ''} onChange={set('date_added')} className={inputClass} /></Field>
          <Field label="Câu ví dụ & ngữ cảnh" className="sm:col-span-2 lg:col-span-4"><input value={draft.example || ''} onChange={set('example')} className={inputClass} /></Field>
        </div>
        <div className="mt-4 flex gap-2">
          <Button size="sm" variant="primary" onClick={onSave}>Lưu từ</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Huỷ</Button>
        </div>
      </td>
    </tr>
  );
}

// A word of one's own, typed in directly (from a book, the paragraph's
// vocabulary panel is quicker: the AI fills the details there).
function AddOwnWord({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ term: '', meaning_vi: '', word_type: 'Noun' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const entry = await api.createVocab({ ...draft, scope: 'private' });
      setDraft({ term: '', meaning_vi: '', word_type: 'Noun' });
      setOpen(false);
      onAdded(entry);
    } catch (err) {
      if (err.code === 'exists' && err.data?.scope === 'shared') {
        const entry = await api.setMyVocab(err.data.entry.id).catch(() => err.data.entry);
        setOpen(false);
        onAdded(entry);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Plus size={14} /> Thêm từ của tôi</Button>;
  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-end gap-2 rounded-md border border-rule bg-page p-2">
      <input value={draft.term} onChange={set('term')} placeholder="Từ / cụm từ" aria-label="Từ / cụm từ" required className={`${inputClass.replace('w-full ', '')} w-44 py-1`} />
      <input value={draft.meaning_vi} onChange={set('meaning_vi')} placeholder="Nghĩa tiếng Việt" aria-label="Nghĩa tiếng Việt" required className={`${inputClass.replace('w-full ', '')} min-w-[180px] flex-1 py-1`} />
      <select value={draft.word_type} onChange={set('word_type')} aria-label="Loại từ" className={`${inputClass.replace('w-full ', '')} py-1`}>
        {WORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <Button type="submit" size="sm" variant="primary" disabled={busy}>{busy ? 'Đang thêm…' : 'Thêm'}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(''); }}>Huỷ</Button>
      {error && <p className="basis-full text-caption text-flag">{error}</p>}
      <p className="basis-full text-caption text-mute">Chỉ mình bạn thấy. Từ đã có trong kho chung sẽ được gắn sao vào "Từ của tôi" thay vì tạo bản sao.</p>
    </form>
  );
}

export default function VocabularyPage() {
  const confirm = useConfirm();
  const { can } = useAuth();
  const canEditVocab = can('vocab.edit');
  const canTrackStatus = can('review.own');
  // Own words and "my list" (learners and up).
  const canOwn = can('vocab.own');
  const canEditRow = (r) => (r.owner_id != null ? canOwn : canEditVocab);
  const [stats, setStats] = useState(null);
  const [topics, setTopics] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const [searchParams] = useSearchParams();
  // ?search= comes from the reader's word card ("Kho từ vựng" link).
  const [searchInput, setSearchInput] = useState(() => searchParams.get('search') || '');
  const [search, setSearch] = useState(searchInput);
  // The query is sent once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const requestSeq = useRef(0);
  const [status, setStatus] = useState('');
  const [topic, setTopic] = useState('');
  const [wordType, setWordType] = useState('');
  const [bookId, setBookId] = useState('');
  const [scope, setScope] = useState('');
  // Genre (thể loại sách): '' all, a genre id, 'none' or 'multi'.
  const [genre, setGenre] = useState('');
  const [genreData, setGenreData] = useState(null);
  const [managingGenres, setManagingGenres] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [changeCount, setChangeCount] = useState(0);
  const [classifying, setClassifying] = useState(false);
  const [classifyNote, setClassifyNote] = useState('');

  const refreshStats = useCallback(() => {
    api.vocabStats().then(setStats).catch(() => {});
    api.listGenres().then(setGenreData).catch(() => {});
    api.vocabTopics().then(setTopics).catch(() => {});
  }, []);

  const refreshRows = useCallback(() => {
    // Answers can arrive out of order; only the latest request's is shown.
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    api
      .listVocabulary({ search, status, topic, wordType, bookId, scope, genre, page, pageSize })
      .then((res) => { if (seq === requestSeq.current) { setRows(res.rows); setTotal(res.total); } })
      .catch((e) => { if (seq === requestSeq.current) setError(e.message); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [search, status, topic, wordType, bookId, scope, genre, page]);

  useEffect(refreshStats, [refreshStats]);
  useEffect(refreshRows, [refreshRows]);

  // After an import or a merge: the list, the counts and the duplicate
  // suggestions all change.
  const refreshAll = useCallback(() => {
    refreshRows();
    refreshStats();
    setChangeCount((n) => n + 1);
  }, [refreshRows, refreshStats]);
  const vocabImport = useVocabImport({ canTrackStatus, onDone: refreshAll });

  // A related word picked in a row's links: show it in the list.
  function showTerm(term) {
    setExpandedId(null);
    setSearchInput(term);
  }

  function startEdit(row) {
    setEditingId(row.id);
    setDraft({ ...row });
  }

  async function saveEdit() {
    try {
      await api.updateVocab(editingId, draft);
    } catch (e) {
      // Renamed onto a term the vocabulary already has: one entry per term,
      // so offer to merge this one into it instead.
      if (e.code !== 'exists' || !e.data?.entry) { setError(e.message); return; }
      const other = e.data.entry;
      if (!(await confirm(`"${draft.term}" đã có trong kho (mục "${other.term}": ${other.meaning_vi}). Gộp mục đang sửa vào mục đó? Tiến độ ôn tập được giữ lại.`, { confirmLabel: 'Gộp', danger: false }))) return;
      await api.mergeVocab(other.id, [editingId]);
    }
    setEditingId(null);
    refreshAll();
  }

  // A row changed on the server (my list, note, proposal): show it in place.
  function replaceRow(next) {
    setRows((rs) => rs.map((x) => (x.id === next.id ? { ...next, genres: next.genres ?? x.genres } : x)));
  }

  async function toggleMine(r) {
    try {
      replaceRow(r.in_my_list ? await api.removeMyVocab(r.id) : await api.setMyVocab(r.id, r.my_note || ''));
      refreshStats();
    } catch (e) {
      setError(e.message);
    }
  }

  async function propose(r) {
    if (!(await confirm(`Đề xuất "${r.term}" vào kho chung? Biên tập viên sẽ xem và duyệt; khi được duyệt, mọi người đều thấy từ này, tiến độ ôn của bạn vẫn giữ.`, { confirmLabel: 'Đề xuất', danger: false }))) return;
    try {
      replaceRow(await api.proposeVocab(r.id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function withdraw(r) {
    try {
      replaceRow(await api.withdrawProposal(r.id));
    } catch (e) {
      setError(e.message);
    }
  }

  async function classifyTopics() {
    setClassifying(true);
    setClassifyNote('');
    try {
      const res = await api.classifyVocabTopics();
      setClassifyNote(res.remaining ? `Đã phân loại ${res.classified} từ, còn ${res.remaining} từ chưa phân loại được. Thử lại sau.` : `Đã phân loại ${res.classified} từ.`);
    } catch (e) {
      setClassifyNote(e.message);
    } finally {
      setClassifying(false);
      refreshRows();
      refreshStats();
    }
  }

  async function quickStatusChange(row, newStatus) {
    await api.updateVocab(row.id, { status: newStatus });
    refreshRows();
    refreshStats();
  }

  async function handleDelete(id) {
    if (!(await confirm('Xoá từ này khỏi kho từ vựng?'))) return;
    await api.deleteVocab(id);
    refreshRows();
    refreshStats();
  }

  // Everything matching the current filters (not just this page), as the
  // JSON another install can import, or TSV for spreadsheets / Anki.
  async function exportVocab(format, withProgress = false) {
    try {
      const blob = await api.exportVocab({ format, withProgress: withProgress ? 1 : '', status, topic, wordType, bookId, scope, genre });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocabulary-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  }

  function pickFilter(setter) {
    return (value) => { setPage(1); setter(value); };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = Boolean(search || status || topic || wordType || bookId || scope || genre);
  const selectClass = `${inputClass.replace('w-full ', '')} max-w-full py-1.5`;

  return (
    <PageContainer>
      <PageHeader
        title="Kho từ vựng"
        subtitle={stats ? `${stats.total} từ và cụm từ thu được khi dịch` : undefined}
        actions={
          <>
            {canEditVocab && vocabImport.trigger}
            <Popover
              label="Xuất kho từ vựng"
              width="w-72"
              trigger={<span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-rule bg-page px-3.5 text-body font-medium text-ink hover:border-mute"><Download size={16} /> Xuất</span>}
            >
              <p className="px-2.5 pb-1 pt-0.5 text-caption text-mute">{hasFilters && !search ? 'Các từ khớp bộ lọc hiện tại' : 'Toàn bộ kho'}{search ? ' (không tính ô tìm kiếm)' : ''}</p>
              <MenuItem onClick={() => exportVocab('json')}>JSON — để chia sẻ, nhập lại vào ứng dụng</MenuItem>
              {canTrackStatus && <MenuItem onClick={() => exportVocab('json', true)}>JSON kèm tiến độ ôn tập của tôi</MenuItem>}
              <MenuItem onClick={() => exportVocab('tsv')}>TSV — bảng tính, Anki</MenuItem>
            </Popover>
          </>
        }
      />

      {vocabImport.panel}

      {canEditVocab && <VocabProposals refreshKey={changeCount} onChanged={refreshAll} />}
      {canEditVocab && <VocabDuplicates refreshKey={changeCount} onChanged={() => { refreshRows(); refreshStats(); }} />}

      {canOwn && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Phạm vi"
            size="sm"
            value={scope}
            onChange={pickFilter(setScope)}
            options={[
              { key: '', label: 'Tất cả' },
              { key: 'shared', label: `Kho chung${stats?.scopes ? ` ${stats.scopes.shared}` : ''}` },
              { key: 'mine', label: `Từ của tôi${stats?.scopes ? ` ${stats.scopes.mine}` : ''}`, hint: 'Từ riêng của bạn và từ kho chung bạn đã gắn sao' },
            ]}
          />
          <AddOwnWord onAdded={(entry) => { refreshAll(); setScope('mine'); setSearchInput(entry.term); }} />
        </div>
      )}

      {error && (
        <Notice action={<Button size="sm" onClick={refreshRows}>Thử lại</Button>}>
          Không tải được kho từ vựng: {error}. Kiểm tra backend đang chạy tại http://localhost:3001/api/health.
        </Notice>
      )}

      <GenreFilter data={genreData} genre={genre} onPick={pickFilter(setGenre)} onManage={canEditVocab ? () => setManagingGenres((v) => !v) : null} />
      {managingGenres && genreData && (
        <GenreManager data={genreData} onChange={(next) => { setGenreData(next); refreshRows(); }} onClose={() => setManagingGenres(false)} />
      )}

      <StatusBreakdown stats={stats} status={status} onPick={pickFilter(setStatus)} />

      <TopicFilter stats={stats} topic={topic} onPick={pickFilter(setTopic)} />

      {canEditVocab && stats?.unclassified > 0 && (
        <Notice
          tone="info"
          action={<Button size="sm" onClick={classifyTopics} disabled={classifying}><Sparkles size={14} /> {classifying ? 'Đang phân loại…' : 'Phân loại bằng AI'}</Button>}
        >
          {stats.unclassified} từ chưa thuộc chủ đề nào trong danh sách (từ cũ hoặc mới nhập từ file).
        </Notice>
      )}
      {classifyNote && <Notice tone="ok">{classifyNote}</Notice>}

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm từ hoặc nghĩa, gõ có dấu hay không dấu đều được"
            aria-label="Tìm trong kho từ vựng"
            className={`${inputClass} py-1.5 pl-9`}
          />
        </div>
        {stats?.books?.length > 1 && (
          <select aria-label="Lọc theo sách" value={bookId} onChange={(e) => pickFilter(setBookId)(e.target.value)} className={`${selectClass} w-56 shrink-0`}>
            <option value="">Mọi sách</option>
            {stats.books.map((b) => (
              <option key={b.id ?? 'none'} value={b.id ?? 'none'}>{b.title || 'Không rõ nguồn'} ({b.c})</option>
            ))}
          </select>
        )}
        <select aria-label="Lọc theo loại từ" value={wordType} onChange={(e) => pickFilter(setWordType)(e.target.value)} className={selectClass}>
          <option value="">Mọi loại từ</option>
          {WORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-auto" onClick={() => { setPage(1); setSearchInput(''); setSearch(''); setBookId(''); setScope(''); setStatus(''); setTopic(''); setWordType(''); setGenre(''); }}>
            Bỏ lọc
          </Button>
        )}
      </div>

      <Sheet className="overflow-x-auto">
        <table className="w-full min-w-[860px] table-fixed border-collapse text-body">
          <thead>
            <tr className="bg-sunken text-left text-meta text-mute">
              {[
                // Nghĩa and Ví dụ have no fixed width — under table-fixed they
                // split whatever is left after the control columns claim a
                // safe minimum, so they are the ones that grow on wide pages.
                ['Từ / cụm từ', 'w-[220px]'],
                ['Nghĩa', ''],
                ['Ví dụ', ''],
                ['Chủ đề', 'w-[150px]'],
                ['Trạng thái', 'w-[130px]'],
                ['', 'w-[84px]'],
              ].map(([h, w]) => (
                <th key={h || 'actions'} className={`${w} border-b border-rule px-4 py-2.5 font-medium`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => editingId === r.id ? (
              <EditRow key={r.id} topics={topics} draft={draft} setDraft={setDraft} onSave={saveEdit} onCancel={() => setEditingId(null)} />
            ) : [
              <tr key={r.id} className="group [&>td]:border-b [&>td]:border-rule [&>td]:px-4 [&>td]:py-3 [&>td]:align-top last:[&>td]:border-b-0">
                <td>
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      aria-expanded={expandedId === r.id}
                      onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                      title="Xem từ này xuất hiện ở đâu và các từ liên quan"
                      className="-ml-1 flex min-w-0 items-start gap-0.5 rounded text-left hover:text-accent"
                    >
                      {expandedId === r.id ? <ChevronDown size={14} className="mt-1.5 shrink-0 text-mute" /> : <ChevronRight size={14} className="mt-1.5 shrink-0 text-mute" />}
                      <span className="min-w-0 break-words font-serif text-lead font-semibold text-ink">{r.term}</span>
                    </button>
                    {canOwn && r.owner_id == null && (
                      <IconButton label={r.in_my_list ? `Bỏ ${r.term} khỏi Từ của tôi` : `Thêm ${r.term} vào Từ của tôi`} active={Boolean(r.in_my_list)} tone="marker"
                        onClick={() => toggleMine(r)} className="!h-6 !w-6"><Star size={13} fill={r.in_my_list ? 'currentColor' : 'none'} /></IconButton>
                    )}
                    <SpeakButton id={`vocab-${r.id}`} text={r.term} size={14} className="-mt-0.5 !h-6 !w-6" />
                  </div>
                  <p className="mt-0.5 break-words text-meta text-mute">{[r.ipa, r.word_type].filter(Boolean).join('  ')}</p>
                  {r.owner_id != null && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      <Tag tone="accent">Từ riêng</Tag>
                      {r.proposal_status === 'pending' && <Tag tone="warn">Chờ duyệt</Tag>}
                      {r.proposal_status === 'rejected' && <Tag tone="flag" title={r.proposal_note}>Không được duyệt{r.proposal_note ? `: ${r.proposal_note}` : ''}</Tag>}
                    </p>
                  )}
                  {r.my_note && <p className="mt-1 line-clamp-2 text-caption text-soft" title={r.my_note}>✎ {r.my_note}</p>}
                </td>
                <td className="break-words text-ink">{r.meaning_vi}</td>
                <td className="break-words">
                  <span className="line-clamp-3 font-serif italic text-soft" title={previewText(r.example)}>{previewText(r.example)}</span>
                  <SourceLine row={r} />
                </td>
                <td>
                  <p className="break-words text-soft">{r.topic || <span className="text-mute">Chưa phân loại</span>}</p>
                  <GenreTags
                    row={r}
                    genres={genreData?.genres}
                    canEdit={canEditVocab}
                    onChanged={(ids) => { replaceRow({ ...r, genres: ids }); api.listGenres().then(setGenreData).catch(() => {}); }}
                  />
                  <p className="mt-0.5 text-caption tabular-nums text-mute">{r.date_added}</p>
                </td>
                <td>
                  {canTrackStatus ? (
                  <select
                    aria-label={`Trạng thái của ${r.term}`}
                    value={r.status}
                    onChange={(e) => quickStatusChange(r, e.target.value)}
                    className={`-ml-1 cursor-pointer rounded-md border border-transparent bg-transparent px-1 py-0.5 text-meta font-medium hover:border-rule ${STATUS_STYLE[r.status]?.text || 'text-soft'}`}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  ) : <span className="text-meta text-mute">—</span>}
                </td>
                <td>
                  <div className={`-my-1 flex justify-end gap-0.5 ${canEditRow(r) ? '' : 'hidden'}`}>
                    {r.owner_id != null && (r.proposal_status === 'pending'
                      ? <IconButton label="Rút đề xuất" onClick={() => withdraw(r)}><Undo2 size={15} /></IconButton>
                      : <IconButton label="Đề xuất vào kho chung" onClick={() => propose(r)}><Send size={15} /></IconButton>)}
                    <IconButton label={`Sửa ${r.term}`} onClick={() => startEdit(r)}><Pencil size={15} /></IconButton>
                    <IconButton label={`Xoá ${r.term}`} onClick={() => handleDelete(r.id)} className="hover:!bg-flag-soft hover:!text-flag"><Trash2 size={15} /></IconButton>
                  </div>
                </td>
              </tr>,
              expandedId === r.id && (
                <tr key={`${r.id}-links`} className="bg-sunken/60">
                  <td colSpan={6} className="border-b border-rule px-4 py-3">
                    <VocabLinks id={r.id} onPick={showTerm} row={r} canOwn={canOwn} canEdit={canEditVocab} onRowChange={replaceRow} />
                  </td>
                </tr>
              ),
            ])}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  {hasFilters ? (
                    <p className="text-body text-soft">Không có từ nào khớp bộ lọc.</p>
                  ) : (
                    <>
                      <p className="font-serif text-heading font-semibold text-ink">Kho từ vựng còn trống</p>
                      <p className="mx-auto mt-1.5 max-w-md text-body text-soft">
                        Từ mới được thêm vào đây mỗi khi bạn dịch một đoạn văn bằng AI. <Link to="/library" className="text-accent underline underline-offset-2">Mở một cuốn sách</Link> để bắt đầu.
                      </p>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Sheet>

      {total > 0 && (
        <div className="flex items-center justify-between text-body text-mute">
          <span className="tabular-nums">{total} từ, trang {page}/{totalPages}</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Trang trước</Button>
            <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Trang sau</Button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
