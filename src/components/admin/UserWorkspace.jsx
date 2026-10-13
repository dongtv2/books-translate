import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Lock, X } from 'lucide-react';
import { api } from '../../api.js';
import { IconButton, Notice, Tag } from '../ui.jsx';

const ROLE = { admin: 'Quản trị', editor: 'Biên tập', learner: 'Học viên', guest: 'Khách' };
const VIA = { public: 'công khai', owner: 'chủ sách', user: 'được cấp', group: 'qua nhóm', admin: 'quản trị' };

function when(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-rule px-3 py-2">
      <p className="text-caption text-mute">{label}</p>
      <p className="font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="text-caption text-mute">{sub}</p>}
    </div>
  );
}

// One user's workspace as an admin sees it: the books they can see (and
// why), where they are reading, their review and AI use, assignments and
// open sessions.
export default function UserWorkspace({ userId, onClose }) {
  const [ws, setWs] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.adminUserWorkspace(userId)
      .then((d) => { if (!cancelled) { setWs(d); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [userId]);

  if (error) return <Notice>{error}</Notice>;
  if (!ws || ws.user.id !== Number(userId)) return <p className="text-meta text-mute">Đang tải workspace…</p>;
  const status = Object.fromEntries(ws.vocabStatus.map((s) => [s.status, s.c]));
  const visible = ws.books.filter((b) => b.visible);
  const hidden = ws.books.filter((b) => !b.visible);

  return (
    <div className="space-y-4 rounded-lg border border-rule bg-sunken/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{ws.user.name || ws.user.email}</p>
          <p className="text-caption text-mute">
            {ws.user.email} · {ws.roles.map((r) => ROLE[r] || r).join(', ') || 'không vai trò'}{ws.groups.length ? ` · nhóm ${ws.groups.map((g) => g.name).join(', ')}` : ''}
            {ws.user.status !== 'active' && ' · đã khoá'}
          </p>
        </div>
        <IconButton label="Đóng workspace" onClick={onClose}><X size={15} /></IconButton>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="Từ đang học / thành thạo" value={`${status['Đang học'] || 0} / ${status['Thành thạo'] || 0}`} sub={`${status['Cần ôn gấp'] || 0} cần ôn gấp · ${ws.due} đến hạn`} />
        <Stat label="Lượt ôn 30 ngày" value={ws.reviews.last30 || 0} sub={`${ws.reviews.days30 || 0} ngày · lần cuối ${when(ws.reviews.last_at)}`} />
        <Stat label="Hỏi trợ lý AI 30 ngày" value={ws.assistant.last30 || 0} sub={`${ws.assistant.approved || 0} đề xuất được duyệt`} />
        <Stat label="Đánh dấu" value={(ws.marks.flagged || 0) + (ws.marks.bookmarked || 0) + (ws.marks.highlighted || 0)} sub={`${ws.marks.flagged || 0} xem lại · ${ws.marks.bookmarked || 0} bookmark`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <p className="text-meta font-medium text-soft">Sách thấy được ({visible.length}/{ws.books.length})</p>
          <ul className="space-y-1 text-meta">
            {visible.map((b) => (
              <li key={b.id} className="flex items-center gap-1.5">
                {b.visibility === 'restricted' ? <Lock size={12} className="text-mute" /> : <Globe size={12} className="text-mute" />}
                <Link to={`/books/${b.id}`} className="truncate text-ink hover:text-accent">{b.title}</Link>
                <Tag className="shrink-0">{VIA[b.via] || b.via}</Tag>
              </li>
            ))}
            {hidden.map((b) => (
              <li key={b.id} className="flex items-center gap-1.5 text-mute">
                <Lock size={12} /> <span className="truncate line-through">{b.title}</span> <span className="shrink-0 text-caption">không thấy</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-meta font-medium text-soft">Đang đọc</p>
          {ws.reading.length ? (
            <ul className="space-y-1 text-meta">
              {ws.reading.map((r) => (
                <li key={r.book_id} className="min-w-0">
                  <Link to={`/chapters/${r.chapter_id}${r.paragraph_id ? `#paragraph-${r.paragraph_id}` : ''}`} className="text-ink hover:text-accent">{r.book_title}</Link>
                  <span className="block truncate text-caption text-mute">{r.chapter_title} · {when(r.updated_at)}</span>
                  {!visible.some((b) => b.id === r.book_id) && <span className="block text-caption text-warn">không còn quyền xem sách này</span>}
                </li>
              ))}
            </ul>
          ) : <p className="text-meta text-mute">Chưa đọc sách nào.</p>}
          {ws.assignments.length > 0 && (
            <>
              <p className="pt-2 text-meta font-medium text-soft">Phân công</p>
              <ul className="space-y-0.5 text-meta text-ink">
                {ws.assignments.map((a) => (
                  <li key={a.id}>{a.role === 'reviewer' ? 'Duyệt' : 'Dịch'}: {a.book_title}{a.chapter_title ? ` — ${a.chapter_title}` : ''}{a.via_group ? <span className="text-mute"> (nhóm {a.via_group})</span> : ''}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <p className="text-caption text-mute">
        {ws.sessions.length} phiên đăng nhập còn hiệu lực{ws.sessions[0] ? `, hoạt động gần nhất ${when(ws.sessions[0].last_seen_at)}` : ''} · tạo tài khoản {when(ws.user.created_at)}
      </p>
    </div>
  );
}
