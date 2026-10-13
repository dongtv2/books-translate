import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookCheck, Download, LoaderCircle, MessagesSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, WORD_TYPES } from '../api.js';
import PageContainer from '../components/PageContainer.jsx';
import { Button, IconButton, Notice, PageHeader, Segmented, Sheet, Tabs, Tag, inputClass } from '../components/ui.jsx';
import { ThreadStatus, loadTopics, timeAgo, displayName } from '../components/TermDiscussion.jsx';
import { AssignmentChips } from '../components/Assignments.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { notifyDiscussionsChanged } from '../lib/bookEvents.js';
import { isPassage } from '../lib/threadAnchors.js';

// Team work across books: the term discussions (open and decided), the
// glossary of decided translations by book and topic, and the parts of books
// assigned to the signed-in user.

const selectClass = 'h-9 rounded-md border border-rule bg-page px-2.5 text-body text-ink focus:border-accent focus:outline-none';

function useBooks() {
  const [books, setBooks] = useState([]);
  useEffect(() => { api.listBooks().then(setBooks).catch(() => {}); }, []);
  return books;
}

const bookTitle = (b) => b.title_vi || b.title_en;

// ---- discussions ------------------------------------------------------------------

function ThreadsTab({ books, bookId, setBookId }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('open');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.listThreads({ bookId, status: status === 'all' ? '' : status, filter, q })
        .then((r) => live && setRows(r)).catch((e) => live && setError(e.message));
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [bookId, status, filter, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Trạng thái"
          value={status}
          onChange={setStatus}
          options={[{ key: 'open', label: 'Chưa chốt cách dịch' }, { key: 'resolved', label: 'Đã chốt cách dịch' }, { key: 'all', label: 'Tất cả' }]}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={selectClass} aria-label="Lọc">
          <option value="">Mọi thảo luận</option>
          <option value="unread">Có hoạt động mới</option>
          <option value="assigned">Phần được giao cho tôi</option>
          <option value="mine">Tôi đã tham gia</option>
        </select>
        <select value={bookId} onChange={(e) => setBookId(e.target.value)} className={`${selectClass} max-w-xs`} aria-label="Sách">
          <option value="">Mọi sách</option>
          {books.map((b) => <option key={b.id} value={b.id}>{bookTitle(b)}</option>)}
        </select>
        <label className="relative min-w-48 flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm từ, đề xuất, bình luận…" className={`${inputClass} h-9 pl-8`} />
        </label>
      </div>

      {error && <Notice>{error}</Notice>}
      {!rows && !error && <p className="text-body text-mute">Đang tải…</p>}
      {rows?.length === 0 && (
        <div className="rounded-lg border border-dashed border-rule px-6 py-10 text-center">
          <p className="font-serif text-heading font-semibold text-ink">Không có thảo luận nào</p>
          <p className="mt-1.5 text-body text-soft">Trong trang chương, bôi chọn một từ hay cụm từ rồi bấm “Thảo luận” để bắt đầu.</p>
        </div>
      )}
      {rows?.length > 0 && (
        <Sheet className="divide-y divide-rule">
          {rows.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => navigate(`/chapters/${t.chapter_id}?thread=${t.id}#paragraph-${t.paragraph_id}`)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-sunken/60"
            >
              <MessagesSquare size={16} className={`mt-1 shrink-0 ${t.status === 'resolved' ? 'text-ok' : 'text-warn'}`} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={`font-serif text-ink ${isPassage(t.term) ? 'line-clamp-2 text-body' : 'text-lead font-semibold'}`}>{t.term}</span>
                  {isPassage(t.term) && <Tag>Câu</Tag>}
                  {t.side === 'vi' && <Tag>Bản dịch</Tag>}
                  <ThreadStatus status={t.status} />
                  {t.discussion_status === 'closed' && <Tag>Đã đóng bình luận</Tag>}
                  {t.unread ? <span className="h-2 w-2 rounded-full bg-accent" title="Có hoạt động mới" /> : null}
                </p>
                {t.status === 'resolved' && <p className="mt-0.5 text-body text-ok">→ {t.resolution_vi}</p>}
                {t.context && !isPassage(t.term) && <p className="mt-0.5 line-clamp-1 font-serif text-meta text-soft">{t.context}</p>}
                <p className="mt-1 truncate text-caption text-mute">
                  {t.book_title} › {t.chapter_title}{t.section_heading ? ` › ${t.section_heading}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right text-caption text-mute">
                <p>{timeAgo(t.updated_at)}</p>
                <p className="tabular-nums">{t.proposal_count} đề xuất · {t.post_count} bài</p>
                <p>{displayName(t.created_by_name)}</p>
              </div>
            </button>
          ))}
        </Sheet>
      )}
    </div>
  );
}

// ---- glossary ------------------------------------------------------------------------

function GlossaryForm({ entry, books, topics, onSave, onCancel }) {
  const [form, setForm] = useState({
    term: entry?.term || '', meaning_vi: entry?.meaning_vi || '', word_type: entry?.word_type || '', topic: entry?.topic || '',
    note: entry?.note || '', bookId: entry ? entry.book_id ?? '' : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const small = 'h-8 rounded border border-rule bg-page px-2 text-meta text-ink focus:border-accent focus:outline-none';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({ ...form, bookId: form.bookId ? Number(form.bookId) : null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 bg-sunken/60 px-4 py-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr]">
        <input autoFocus value={form.term} onChange={set('term')} placeholder="Thuật ngữ (tiếng Anh)" className={`${small} font-semibold`} aria-label="Thuật ngữ" />
        <input value={form.meaning_vi} onChange={set('meaning_vi')} placeholder="Cách dịch đã thống nhất" className={small} aria-label="Cách dịch" />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select value={form.word_type} onChange={set('word_type')} className={small} aria-label="Loại từ">
          <option value="">Loại từ…</option>
          {WORD_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <select value={form.topic} onChange={set('topic')} className={small} aria-label="Chủ đề">
          <option value="">Chủ đề…</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={form.bookId} onChange={set('bookId')} className={small} aria-label="Phạm vi">
          <option value="">Mọi sách</option>
          {books.map((b) => <option key={b.id} value={b.id}>{bookTitle(b)}</option>)}
        </select>
      </div>
      <input value={form.note} onChange={set('note')} placeholder="Ghi chú cho người dịch (tuỳ chọn)" className={`${small} w-full`} aria-label="Ghi chú" />
      {error && <Notice>{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy || !form.term.trim() || !form.meaning_vi.trim()}>
          {busy && <LoaderCircle size={14} className="animate-spin" />} Lưu
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}

function GlossaryTab({ books, bookId, setBookId }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const canManage = can('glossary.manage');
  const [scope, setScope] = useState('');
  const [topic, setTopic] = useState('');
  const [q, setQ] = useState('');
  const [topics, setTopics] = useState([]);
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null); // entry id | 'new'
  const [error, setError] = useState('');

  useEffect(() => { loadTopics().then(setTopics); }, []);
  const load = useCallback(() => {
    api.listGlossary({ bookId, scope: bookId ? scope : scope === 'all' ? 'all' : '', topic, q }).then(setRows).catch((e) => setError(e.message));
  }, [bookId, scope, topic, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  async function save(entry, form) {
    if (entry) await api.updateGlossary(entry.id, form);
    else await api.createGlossary(form);
    setEditing(null);
    load();
  }

  function exportTsv() {
    const head = ['Thuật ngữ', 'Cách dịch', 'Loại từ', 'Chủ đề', 'Phạm vi', 'Ghi chú'];
    const lines = rows.map((g) => [g.term, g.meaning_vi, g.word_type, g.topic, g.book_title || 'Mọi sách', g.note].map((v) => String(v || '').replace(/[\t\n]/g, ' ')).join('\t'));
    const blob = new Blob([[head.join('\t'), ...lines].join('\n')], { type: 'text/tab-separated-values' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'thuat-ngu.tsv' });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-body text-soft">
        Cách dịch nhóm đã thống nhất. Khi dịch một đoạn bằng AI hoặc hỏi trợ lý, các thuật ngữ của sách đó và thuật ngữ dùng chung xuất hiện trong đoạn được gửi kèm như quy định bắt buộc.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={bookId} onChange={(e) => setBookId(e.target.value)} className={`${selectClass} max-w-xs`} aria-label="Sách">
          <option value="">Mọi sách</option>
          {books.map((b) => <option key={b.id} value={b.id}>{bookTitle(b)}</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} className={selectClass} aria-label="Phạm vi">
          {bookId ? (
            <>
              <option value="">Của sách + dùng chung</option>
              <option value="book">Chỉ của sách này</option>
            </>
          ) : (
            <>
              <option value="">Mọi phạm vi</option>
              <option value="all">Chỉ dùng chung mọi sách</option>
            </>
          )}
        </select>
        <select value={topic} onChange={(e) => setTopic(e.target.value)} className={selectClass} aria-label="Chủ đề">
          <option value="">Mọi chủ đề</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="relative min-w-48 flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm thuật ngữ, cách dịch…" className={`${inputClass} h-9 pl-8`} />
        </label>
        {rows?.length > 0 && <Button onClick={exportTsv}><Download size={15} /> TSV</Button>}
        {canManage && <Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} /> Thêm</Button>}
      </div>

      {error && <Notice>{error}</Notice>}
      <Sheet className="divide-y divide-rule overflow-hidden">
        {editing === 'new' && <GlossaryForm books={books} topics={topics} entry={bookId ? { book_id: Number(bookId) } : null} onSave={(f) => save(null, f)} onCancel={() => setEditing(null)} />}
        {!rows && <p className="px-4 py-6 text-body text-mute">Đang tải…</p>}
        {rows?.length === 0 && editing !== 'new' && <p className="px-4 py-8 text-center text-body text-mute">Chưa có thuật ngữ nào được chốt.</p>}
        {rows?.map((g) => (editing === g.id ? (
          <GlossaryForm key={g.id} books={books} topics={topics} entry={g} onSave={(f) => save(g, f)} onCancel={() => setEditing(null)} />
        ) : (
          <div key={g.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0 basis-52 flex-1">
              <p className="font-serif text-lead font-semibold text-ink">{g.term}</p>
              <p className="text-caption text-mute">{[g.word_type, g.topic].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            <div className="min-w-0 basis-64 flex-[1.5]">
              <p className="text-body text-ink">{g.meaning_vi}</p>
              {g.note && <p className="text-caption text-soft">{g.note}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Tag tone={g.book_id ? 'accent' : 'neutral'} className="max-w-[14rem] truncate" title={g.book_title || 'Mọi sách'}>{g.book_id ? g.book_title : 'Mọi sách'}</Tag>
              {g.thread_chapter_id && (
                <Link to={`/chapters/${g.thread_chapter_id}?thread=${g.thread_id}#paragraph-${g.thread_paragraph_id}`} title="Xem thảo luận đã chốt" className="grid h-8 w-8 place-items-center rounded-md text-mute hover:bg-sunken hover:text-accent">
                  <MessagesSquare size={15} />
                </Link>
              )}
              {canManage && (
                <>
                  <IconButton label="Sửa" onClick={() => setEditing(g.id)}><Pencil size={15} /></IconButton>
                  <IconButton
                    label="Xoá"
                    className="hover:!bg-flag-soft hover:!text-flag"
                    onClick={async () => { if (await confirm(`Xoá “${g.term}” khỏi bảng thuật ngữ? AI sẽ không còn bị buộc dùng cách dịch này.`)) { await api.deleteGlossary(g.id); load(); } }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </>
              )}
            </div>
          </div>
        )))}
      </Sheet>
    </div>
  );
}

// ---- my assignments -------------------------------------------------------------------

function MineTab() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.myAssignments().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="text-body text-mute">Đang tải…</p>;
  if (!rows.length) {
    return <p className="text-body text-soft">Bạn chưa được phân công phần nào. Biên tập viên phân công trong tab “Nhóm dịch” của trang sách.</p>;
  }
  return (
    <Sheet className="divide-y divide-rule">
      {rows.map((a) => {
        const href = a.chapter_id ? `/chapters/${a.chapter_id}${a.paragraph_id ? `#paragraph-${a.paragraph_id}` : ''}` : `/books/${a.book_id}`;
        return (
          <Link key={a.id} to={href} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-sunken/60">
            <AssignmentChips assignments={[a]} />
            <span className="min-w-0 flex-1 truncate text-body text-ink">
              {a.book_title}
              {a.chapter_title && <span className="text-soft"> › {a.chapter_title}</span>}
              {a.section_heading && <span className="text-soft"> › {a.section_heading}</span>}
              {a.paragraph_id && <span className="text-soft"> › một đoạn</span>}
            </span>
          </Link>
        );
      })}
    </Sheet>
  );
}

export default function DiscussionsPage() {
  const [params, setParams] = useSearchParams();
  const books = useBooks();
  const tab = params.get('tab') || 'threads';
  const bookId = params.get('bookId') || '';
  const update = (patch) => setParams((p) => {
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    return p;
  }, { replace: true });

  // Opening the page counts as seeing the badge's news.
  useEffect(() => { notifyDiscussionsChanged(); }, []);

  return (
    <PageContainer>
      <PageHeader
        title="Thảo luận & thuật ngữ"
        subtitle="Cùng nhau thống nhất cách dịch từ, cụm từ; cách dịch được chốt thành ngữ cảnh cho mọi lần dịch sau."
      />
      <Tabs
        label="Thảo luận"
        value={tab}
        onChange={(t) => update({ tab: t === 'threads' ? '' : t })}
        tabs={[
          { key: 'threads', label: <span className="inline-flex items-center gap-1.5"><MessagesSquare size={16} /> Thảo luận</span> },
          { key: 'glossary', label: <span className="inline-flex items-center gap-1.5"><BookCheck size={16} /> Thuật ngữ đã chốt</span> },
          { key: 'mine', label: 'Việc của tôi' },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'threads' && <ThreadsTab books={books} bookId={bookId} setBookId={(v) => update({ bookId: v })} />}
        {tab === 'glossary' && <GlossaryTab books={books} bookId={bookId} setBookId={(v) => update({ bookId: v })} />}
        {tab === 'mine' && <MineTab />}
      </div>
    </PageContainer>
  );
}
