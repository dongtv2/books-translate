import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, LoaderCircle, MessagesSquare, Plus, Users, X } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Notice, Tag, buttonClass } from './ui.jsx';

// Who translates and who reviews which part of a book. A reviewer may decide
// ("chốt") the term discussions in their part (server/discussions.js).

export const ROLE_LABELS = { translator: 'Dịch', reviewer: 'Duyệt' };

const who = (a) => (a.group_id ? `Nhóm ${a.group_name}` : a.user_name || a.user_email);
const scopeOf = (a) => (a.paragraph_id ? 'đoạn' : a.section_id ? 'mục' : a.chapter_id ? 'chương' : 'sách');

export function AssignmentChips({ assignments, showScope = false, onRemove }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {assignments.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1 rounded-full border border-rule bg-page py-0.5 pl-1 pr-2 text-caption text-soft">
          <Tag tone={a.role === 'reviewer' ? 'ok' : 'accent'} className="!rounded-full">{ROLE_LABELS[a.role]}</Tag>
          <span className="font-medium text-ink">{who(a)}</span>
          {showScope && <span className="text-mute">· {scopeOf(a)}</span>}
          {onRemove && (
            <button type="button" onClick={() => onRemove(a)} aria-label={`Bỏ phân công ${who(a)}`} className="-mr-1 grid h-4 w-4 place-items-center rounded-full text-mute hover:bg-flag-soft hover:text-flag">
              <X size={11} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

let peoplePromise = null;
const loadPeople = () => (peoplePromise ??= api.assignablePeople().catch((e) => { peoplePromise = null; throw e; }));

const small = 'rounded border border-rule bg-page px-2 py-1 text-meta text-ink focus:border-accent focus:outline-none';

// scopes: [{ key, label, payload }] — where the assignment goes; the first
// is the default. Shown to team.manage only.
export function AssignForm({ scopes, onAdded, compact = false }) {
  const [people, setPeople] = useState(null);
  const [open, setOpen] = useState(!compact);
  const [scope, setScope] = useState(scopes[0].key);
  const [person, setPerson] = useState('');
  const [role, setRole] = useState('translator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) loadPeople().then(setPeople).catch((e) => setError(e.message)); }, [open]);

  async function add(e) {
    e.preventDefault();
    if (!person) return;
    const [kind, id] = person.split(':');
    setBusy(true);
    setError('');
    try {
      await api.createAssignment({ ...scopes.find((s) => s.key === scope).payload, role, [kind === 'g' ? 'groupId' : 'userId']: Number(id) });
      setPerson('');
      onAdded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-caption font-medium text-mute hover:text-accent">
        <Plus size={13} /> Phân công
      </button>
    );
  }
  return (
    <form onSubmit={add} className="flex flex-wrap items-center gap-1.5">
      {scopes.length > 1 && (
        <select value={scope} onChange={(e) => setScope(e.target.value)} className={small} aria-label="Phạm vi">
          {scopes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      )}
      <select value={person} onChange={(e) => setPerson(e.target.value)} className={`${small} min-w-0 max-w-[12rem] flex-1`} aria-label="Người hoặc nhóm">
        <option value="">{people ? 'Chọn người / nhóm…' : 'Đang tải…'}</option>
        {people?.groups.length > 0 && (
          <optgroup label="Nhóm">
            {people.groups.map((g) => <option key={`g${g.id}`} value={`g:${g.id}`}>{g.name}</option>)}
          </optgroup>
        )}
        {people && (
          <optgroup label="Người dùng">
            {people.users.map((u) => <option key={`u${u.id}`} value={`u:${u.id}`}>{u.name || u.email}</option>)}
          </optgroup>
        )}
      </select>
      <select value={role} onChange={(e) => setRole(e.target.value)} className={small} aria-label="Vai trò">
        {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <Button type="submit" size="sm" disabled={busy || !person} className="!h-7">
        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />} Thêm
      </Button>
      {compact && <Button size="sm" variant="ghost" className="!h-7" onClick={() => setOpen(false)}>Xong</Button>}
      {error && <Notice className="w-full">{error}</Notice>}
    </form>
  );
}

// One row of the book's team tree: a label, its assignments, and the
// add form for managers.
function TeamRow({ label, depth = 0, items, canManage, payload, onChange, children, toggle }) {
  const confirm = (a) => api.deleteAssignment(a.id).then(onChange);
  return (
    <div className={depth ? 'border-t border-rule' : ''}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5" style={{ paddingLeft: depth * 20 }}>
        <span className="flex min-w-0 basis-96 items-center gap-1 text-body text-ink" title={typeof label === 'string' ? label : undefined}>
          {toggle}
          <span className="truncate">{label}</span>
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {items.length > 0 && <AssignmentChips assignments={items} onRemove={canManage ? confirm : undefined} />}
          {canManage && <AssignForm compact scopes={[{ key: 'x', label: '', payload }]} onAdded={onChange} />}
          {!items.length && !canManage && <span className="text-caption text-mute">—</span>}
        </div>
      </div>
      {children}
    </div>
  );
}

// The "Nhóm dịch" tab of a book: the team on the book, each chapter and
// each section, and a way into the book's discussions and glossary.
export function BookTeam({ book }) {
  const { can } = useAuth();
  const canManage = can('team.manage');
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.listAssignments({ bookId: book.id }).then((r) => setItems(r.assignments)).catch((e) => setError(e.message));
    api.listThreads({ bookId: book.id }).then((rows) => setCounts({
      open: rows.filter((t) => t.status === 'open').length,
      resolved: rows.filter((t) => t.status === 'resolved').length,
    })).catch(() => {});
  }, [book.id]);
  useEffect(load, [load]);

  if (error) return <Notice>{error}</Notice>;
  if (!items) return <p className="text-body text-mute">Đang tải…</p>;

  // In table-of-contents order: the parts' chapters, then those outside a part.
  const chapters = [...book.parts.flatMap((p) => p.chapters), ...book.chaptersWithoutPart];
  const at = (pred) => items.filter((a) => !a.paragraph_id && pred(a));
  const paragraphLevel = items.filter((a) => a.paragraph_id);
  const toggle = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-body text-soft">
          Phân công người <span className="font-medium text-ink">Dịch</span> và người <span className="font-medium text-ink">Duyệt</span> theo sách, chương hoặc mục. Người duyệt được chốt cách dịch các từ đang thảo luận trong phần của mình.
        </p>
        <Link to={`/discussions?bookId=${book.id}`} className={buttonClass('secondary', 'md')}>
          <MessagesSquare size={16} /> Thảo luận{counts ? ` (${counts.open} mở · ${counts.resolved} đã chốt)` : ''}
        </Link>
      </div>

      <div className="rounded-lg border border-rule bg-page px-4">
        <TeamRow label={<span className="font-semibold">Cả cuốn sách</span>} items={at((a) => !a.chapter_id)} canManage={canManage} payload={{ bookId: book.id }} onChange={load} />
        {chapters.map((c) => {
          const open = expanded.has(c.id);
          const sectionItems = at((a) => a.chapter_id === c.id && a.section_id);
          return (
            <TeamRow
              key={c.id}
              depth={1}
              label={c.title}
              items={at((a) => a.chapter_id === c.id && !a.section_id)}
              canManage={canManage}
              payload={{ chapterId: c.id }}
              onChange={load}
              toggle={c.sections?.some((s) => s.heading) ? (
                <button type="button" onClick={() => toggle(c.id)} aria-expanded={open} aria-label={open ? 'Thu gọn các mục' : 'Hiện các mục'} className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute hover:text-ink">
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span className="w-5 shrink-0" />}
            >
              {(open || sectionItems.length > 0) && c.sections?.filter((s) => s.heading && (open || sectionItems.some((a) => a.section_id === s.id))).map((s) => (
                <TeamRow key={s.id} depth={2} label={s.heading} items={sectionItems.filter((a) => a.section_id === s.id)} canManage={canManage} payload={{ sectionId: s.id }} onChange={load} />
              ))}
            </TeamRow>
          );
        })}
      </div>

      {paragraphLevel.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-meta font-medium text-soft"><Users size={14} /> Phân công theo từng đoạn</p>
          <ul className="space-y-1.5">
            {paragraphLevel.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-meta">
                <Link to={`/chapters/${a.chapter_id}#paragraph-${a.paragraph_id}`} className="text-soft hover:text-accent">{a.chapter_title} · đoạn #{a.paragraph_id}</Link>
                <AssignmentChips assignments={[a]} onRemove={canManage ? (x) => api.deleteAssignment(x.id).then(load) : undefined} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
