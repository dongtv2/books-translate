import { useEffect, useRef, useState } from 'react';
import { Globe, Lock, X } from 'lucide-react';
import { api } from '../api.js';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { Button, IconButton, Notice, Segmented, Sheet, Tag, inputClass } from './ui.jsx';

const MODES = [
  { key: 'public', label: 'Công khai', icon: <Globe size={13} /> },
  { key: 'restricted', label: 'Hạn chế', icon: <Lock size={13} /> },
];

// Who may see a book. Everyone sees the current state; admins and the
// book's owner change it. Restricted: only the owner, the people and groups
// listed, and admins see the book and anything inside it.
export default function BookAccess({ bookId }) {
  const confirm = useConfirm();
  const [access, setAccess] = useState(null);
  const [draft, setDraft] = useState(null);
  const [people, setPeople] = useState({ users: [], groups: [] });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.bookAccess(bookId)
      .then((a) => {
        if (cancelled) return;
        setAccess(a);
        if (a.canManage) api.assignablePeople().then((p) => { if (!cancelled) setPeople(p); }).catch(() => {});
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [bookId]);

  // Nothing to show until it loads (or if the book cannot be read).
  if (!access) return null;

  const startEdit = () => setDraft({ visibility: access.visibility, userIds: access.users.map((u) => u.id), groupIds: access.groups.map((g) => g.id) });
  const toggle = (key, id) => setDraft((d) => ({ ...d, [key]: d[key].includes(id) ? d[key].filter((x) => x !== id) : [...d[key], id] }));

  async function save() {
    if (saving.current) return;
    // Restricting a book with nobody listed leaves it to its owner and admins.
    if (draft.visibility === 'restricted' && access.visibility === 'public'
      && !(await confirm('Chỉ chủ sách, quản trị viên và những người/nhóm đã chọn còn thấy sách này (cả bản dịch, thảo luận, phân công). Tiếp tục?', { confirmLabel: 'Hạn chế', danger: false }))) return;
    saving.current = true;
    setBusy(true);
    try {
      setAccess(await api.setBookAccess(bookId, draft));
      setDraft(null);
      setSaved(true);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const name = (u) => u.name || u.email;
  const restricted = access.visibility === 'restricted';

  return (
    <Sheet className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-serif text-heading font-semibold text-ink">Quyền xem</h2>
        {access.canManage && !draft && <Button size="sm" variant="ghost" onClick={() => { setSaved(false); startEdit(); }}>Thay đổi</Button>}
      </div>

      {!draft && (
        <>
          <p className="flex items-center gap-1.5 text-body text-ink">
            {restricted ? <Lock size={15} /> : <Globe size={15} />}
            {restricted ? 'Hạn chế: chỉ những người được cấp quyền' : 'Công khai: mọi người dùng đều thấy'}
          </p>
          {access.owner && <p className="text-meta text-soft">Chủ sách: {name(access.owner)}</p>}
          {restricted && (
            <div className="flex flex-wrap gap-1.5">
              {access.users.map((u) => <Tag key={`u${u.id}`}>{name(u)}</Tag>)}
              {access.groups.map((g) => <Tag key={`g${g.id}`} tone="accent">nhóm {g.name}</Tag>)}
              {!access.users.length && !access.groups.length && <span className="text-meta text-mute">Chưa cấp cho ai ngoài chủ sách và quản trị viên.</span>}
            </div>
          )}
          {saved && <Notice tone="ok">Đã lưu quyền xem.</Notice>}
        </>
      )}

      {draft && (
        <div className="space-y-3">
          <Segmented label="Chế độ hiển thị" size="sm" options={MODES} value={draft.visibility} onChange={(v) => setDraft((d) => ({ ...d, visibility: v }))} />
          {draft.visibility === 'restricted' && (
            <>
              <PickList title="Người dùng" items={people.users} selected={draft.userIds} label={name} onToggle={(id) => toggle('userIds', id)} />
              <PickList title="Nhóm" items={people.groups} selected={draft.groupIds} label={(g) => g.name} onToggle={(id) => toggle('groupIds', id)} />
              <p className="text-caption text-mute">Chủ sách và quản trị viên luôn thấy sách.</p>
            </>
          )}
          {error && <Notice>{error}</Notice>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(''); }}>Huỷ</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// Selected items as removable chips, the rest in a filterable list.
function PickList({ title, items, selected, label, onToggle }) {
  const [q, setQ] = useState('');
  const chosen = items.filter((i) => selected.includes(i.id));
  const rest = items.filter((i) => !selected.includes(i.id) && label(i).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="space-y-1.5">
      <p className="text-meta font-medium text-soft">{title}</p>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((i) => (
            <span key={i.id} className="inline-flex items-center gap-0.5 rounded bg-accent-soft py-0.5 pl-2 pr-0.5 text-caption text-ink">
              {label(i)}
              <IconButton label={`Bỏ ${label(i)}`} onClick={() => onToggle(i.id)} className="!h-5 !w-5"><X size={11} /></IconButton>
            </span>
          ))}
        </div>
      )}
      {items.length > 6 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm…" aria-label={`Tìm ${title.toLowerCase()}`} className={`${inputClass} py-1`} />}
      <div className="max-h-36 overflow-y-auto rounded-md border border-rule">
        {rest.length ? rest.slice(0, 50).map((i) => (
          <button key={i.id} type="button" onClick={() => onToggle(i.id)} className="block w-full px-2.5 py-1 text-left text-meta text-ink hover:bg-sunken">
            + {label(i)}
          </button>
        )) : <p className="px-2.5 py-1.5 text-caption text-mute">{items.length ? 'Đã chọn hết' : 'Chưa có ai'}</p>}
      </div>
    </div>
  );
}
