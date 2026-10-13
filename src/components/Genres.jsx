import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { api } from '../api.js';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { Button, IconButton, Notice, Popover, Sheet, inputClass } from './ui.jsx';

// Genres (thể loại) on the vocabulary page: a filter row, the editors'
// manager, and one word's genre tags. Server side: server/genres.js.

const chip = (active) => `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-meta transition-colors ${
  active ? 'border-accent bg-accent-soft text-ink' : 'border-rule text-soft hover:border-mute hover:text-ink'
}`;

// The row of genre chips with word counts. genre: '' (all), an id as a
// string, 'none' or 'multi' (words in two or more genres).
export function GenreFilter({ data, genre, onPick, onManage }) {
  if (!data) return null;
  const total = data.genres.reduce((n, g) => n + g.wordCount, 0) + data.ungrouped;
  return (
    <div role="group" aria-label="Lọc theo thể loại sách" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-caption font-medium uppercase tracking-wide text-mute">Thể loại</span>
      <button type="button" aria-pressed={!genre} onClick={() => onPick('')} className={chip(!genre)}>Tất cả</button>
      {data.genres.map((g) => (
        <button
          key={g.id}
          type="button"
          title={g.description || undefined}
          aria-pressed={genre === String(g.id)}
          onClick={() => onPick(genre === String(g.id) ? '' : String(g.id))}
          className={chip(genre === String(g.id))}
        >
          {g.name} <span className="tabular-nums text-mute">{g.wordCount}</span>
        </button>
      ))}
      {data.ungrouped > 0 && (
        <button type="button" aria-pressed={genre === 'none'} onClick={() => onPick(genre === 'none' ? '' : 'none')} className={chip(genre === 'none')}>
          Chưa xếp thể loại <span className="tabular-nums text-mute">{data.ungrouped}</span>
        </button>
      )}
      {data.multi > 0 && (
        <button
          type="button"
          title="Từ thuộc từ hai thể loại trở lên — nên xem lại có đúng không"
          aria-pressed={genre === 'multi'}
          onClick={() => onPick(genre === 'multi' ? '' : 'multi')}
          className={chip(genre === 'multi')}
        >
          Thuộc nhiều thể loại <span className="tabular-nums text-mute">{data.multi}</span>
        </button>
      )}
      {onManage && (
        <Button size="sm" variant="ghost" onClick={onManage} title={`${total} từ`}>
          <Tags size={14} /> Quản lý thể loại
        </Button>
      )}
    </div>
  );
}

function GenreForm({ initial = {}, submitLabel, onSubmit, onCancel }) {
  const [draft, setDraft] = useState({ name: initial.name || '', description: initial.description || '', keywords: initial.keywords || '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    if (!draft.name.trim()) { setError('Hãy đặt tên thể loại.'); return; }
    setSaving(true);
    setError('');
    try {
      await onSubmit(draft);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      <input value={draft.name} onChange={set('name')} placeholder="Tên thể loại (vd. Kỹ năng sống)" aria-label="Tên thể loại" className={inputClass} autoFocus />
      <input value={draft.description} onChange={set('description')} placeholder="Mô tả ngắn" aria-label="Mô tả" className={inputClass} />
      <input
        value={draft.keywords}
        onChange={set('keywords')}
        placeholder="Từ khoá nhận diện sách, cách nhau bởi dấu phẩy (vd. kỹ năng, self-help)"
        aria-label="Từ khoá nhận diện sách"
        className={`${inputClass} sm:col-span-2`}
      />
      {error && <p className="text-meta text-flag sm:col-span-2">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" variant="primary" disabled={saving}>{submitLabel}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </form>
  );
}

// Create, rename, describe, reorder and delete genres (vocab.edit). A book is
// filed under the first genre (in this order) whose keywords appear in its
// field, specialty or title, unless an editor picked its genre by hand.
export function GenreManager({ data, onChange, onClose }) {
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  async function run(fn) {
    setError('');
    try {
      onChange(await fn());
    } catch (err) {
      setError(err.message);
    }
  }
  async function remove(g) {
    if (!(await confirm(`Xoá thể loại "${g.name}"? Sách trong thể loại này sẽ được xếp lại tự động theo từ khoá; không từ vựng nào bị xoá.`))) return;
    run(() => api.deleteGenre(g.id));
  }

  return (
    <Sheet className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-heading font-semibold text-ink">Thể loại sách</h2>
          <p className="text-meta text-mute">
            Sách được xếp vào thể loại đầu tiên (theo thứ tự dưới đây) có từ khoá xuất hiện trong lĩnh vực, chuyên môn hoặc tên sách — trừ khi đã chọn tay ở trang sách. Từ vựng thuộc thể loại của các sách chứa nó.
          </p>
        </div>
        <IconButton label="Đóng" onClick={onClose}><X size={18} /></IconButton>
      </div>
      {error && <Notice>{error}</Notice>}
      <ul className="divide-y divide-rule rounded-lg border border-rule">
        {data.genres.map((g, i) => (
          <li key={g.id} className="px-3 py-2">
            {editingId === g.id ? (
              <GenreForm
                initial={g}
                submitLabel="Lưu"
                onCancel={() => setEditingId(null)}
                onSubmit={async (draft) => { onChange(await api.updateGenre(g.id, draft)); setEditingId(null); }}
              />
            ) : (
              <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-ink">
                    {g.name} <span className="text-caption font-normal text-mute">· {g.bookCount} sách · {g.wordCount} từ</span>
                  </p>
                  {g.description && <p className="text-meta text-soft">{g.description}</p>}
                  <p className="truncate text-caption text-mute" title={g.keywords}>Từ khoá: {g.keywords || '— (chỉ chọn tay)'}</p>
                </div>
                <IconButton label="Chuyển lên" disabled={i === 0} onClick={() => run(() => api.updateGenre(g.id, { sort_order: i - 1 }))}><ArrowUp size={15} /></IconButton>
                <IconButton label="Chuyển xuống" disabled={i === data.genres.length - 1} onClick={() => run(() => api.updateGenre(g.id, { sort_order: i + 1 }))}><ArrowDown size={15} /></IconButton>
                <IconButton label="Sửa" onClick={() => setEditingId(g.id)}><Pencil size={15} /></IconButton>
                <IconButton label="Xoá" onClick={() => remove(g)}><Trash2 size={15} /></IconButton>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <GenreForm
          submitLabel="Tạo thể loại"
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => { onChange(await api.createGenre(draft)); setAdding(false); }}
        />
      ) : (
        <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Thêm thể loại</Button>
      )}
    </Sheet>
  );
}

// One word's genres as small tags; editors open a list to tick genres on/off.
export function GenreTags({ row, genres, canEdit, onChanged }) {
  const names = new Map((genres || []).map((g) => [g.id, g.name]));
  const mine = row.genres || [];
  const [error, setError] = useState('');
  async function toggle(gid, on) {
    setError('');
    try {
      const res = await api.setVocabGenre(row.id, gid, on);
      onChanged(res.genres);
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {mine.map((gid) => names.has(gid) && (
        <span key={gid} className="rounded-full bg-sunken px-2 py-0.5 text-caption text-soft">{names.get(gid)}</span>
      ))}
      {canEdit && row.owner_id == null && genres?.length > 0 && (
        <Popover
          label="Chọn thể loại cho từ này"
          align="left"
          width="w-60"
          trigger={<span className="rounded-full border border-dashed border-rule px-2 py-0.5 text-caption text-mute hover:text-ink">{mine.length ? 'Sửa' : '+ Thể loại'}</span>}
        >
          <p className="px-2 pb-1 pt-0.5 text-caption text-mute">Mặc định theo sách chứa từ; chọn tay sẽ ghi đè.</p>
          {genres.map((g) => (
            <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-meta hover:bg-sunken">
              <input type="checkbox" className="accent-accent" checked={mine.includes(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
              {g.name}
            </label>
          ))}
          {error && <p className="px-2 py-1 text-caption text-flag">{error}</p>}
        </Popover>
      )}
    </div>
  );
}
