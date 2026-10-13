import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { Button, IconButton, Notice, Segmented, Tag, inputClass } from '../ui.jsx';
import UserWorkspace from './UserWorkspace.jsx';

// Vietnamese names for the logged actions (server/activityLog.js). Unknown
// actions show as their key.
const ACTION_LABEL = {
  'auth.login': 'Đăng nhập', 'auth.logout': 'Đăng xuất', 'auth.password': 'Đổi mật khẩu', 'auth.setup': 'Khởi tạo quản trị', 'auth.sso': 'Đăng nhập SSO',
  'admin.user.create': 'Tạo người dùng', 'admin.user.update': 'Sửa người dùng', 'admin.user.delete': 'Xoá người dùng', 'admin.user.reset_password': 'Đặt lại mật khẩu',
  'admin.group.create': 'Tạo nhóm', 'admin.group.update': 'Sửa nhóm', 'admin.group.delete': 'Xoá nhóm', 'admin.sso.update': 'Sửa cấu hình SSO', 'admin.backup.create': 'Tạo bản sao lưu', 'admin.backup.download': 'Tải bản sao lưu', 'admin.integrity': 'Kiểm tra toàn vẹn',
  'paragraph.translate': 'Dịch đoạn bằng AI', 'paragraph.update': 'Sửa đoạn văn', 'paragraph.delete': 'Xoá đoạn văn',
  'assistant.ask': 'Hỏi trợ lý AI', 'assistant.approve': 'Duyệt đề xuất AI', 'assistant.reject': 'Bỏ đề xuất AI', 'assistant.revert': 'Hoàn tác đề xuất AI', 'assistant.clear': 'Xoá hội thoại AI',
  'book.import': 'Nhập sách', 'book.create': 'Tạo sách', 'book.update': 'Sửa thông tin sách', 'book.delete': 'Xoá sách', 'book.structure': 'Sửa cấu trúc sách', 'book.access': 'Đổi quyền xem sách', 'book.cover': 'Đổi ảnh bìa',
  'vocab.create': 'Thêm từ', 'vocab.update': 'Sửa từ / trạng thái', 'vocab.delete': 'Xoá từ', 'vocab.import': 'Nhập kho từ', 'vocab.merge': 'Gộp từ trùng',
  'vocab.dismiss_duplicates': 'Đánh dấu không trùng', 'vocab.propose': 'Đề xuất từ vào kho chung', 'vocab.propose_withdraw': 'Rút đề xuất', 'vocab.proposal_approve': 'Duyệt đề xuất từ', 'vocab.proposal_reject': 'Từ chối đề xuất từ', 'vocab.mine': 'Sửa “Từ của tôi”', 'vocab.sense': 'Sửa nghĩa theo sách', 'vocab.merge_undo': 'Hoàn tác gộp từ', 'vocab.classify': 'Phân loại chủ đề bằng AI',
  'discussion.post': 'Thảo luận thuật ngữ', 'discussion.resolve': 'Chốt thuật ngữ', 'glossary.change': 'Sửa bảng thuật ngữ',
  'assignment.change': 'Phân công', 'prompt.change': 'Sửa prompt', 'settings.ai.update': 'Sửa cấu hình AI',
};
const label = (action) => ACTION_LABEL[action] || action;

const GROUPS = [
  { key: '', label: 'Tất cả' },
  { key: 'paragraph', label: 'Dịch & sửa' },
  { key: 'vocab', label: 'Từ vựng' },
  { key: 'auth', label: 'Đăng nhập' },
  { key: 'admin', label: 'Quản trị' },
];

const PERIODS = [
  { key: 7, label: '7 ngày' },
  { key: 30, label: '30 ngày' },
  { key: 90, label: '90 ngày' },
];

function when(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

// The result in words: a wrong password is not the same as a refused right.
function outcome(r) {
  if (r.status >= 500) return 'Lỗi máy chủ';
  if (r.action === 'auth.login' && r.status === 401) return 'Sai thông tin';
  if (r.status === 429) return 'Quá nhiều lần';
  if (r.status === 401 || r.status === 403) return 'Bị chặn';
  if (r.status >= 400) return 'Không hợp lệ';
  return 'Thành công';
}

// Where a row points, as a short readable reference.
function target(r) {
  if (r.detail?.email) return r.detail.email;
  if (r.entity_type && r.entity_id) return `${r.entity_type} #${r.entity_id}`;
  if (r.detail?.entries) return `${r.detail.entries} mục`;
  return '';
}

// One line per user for the chosen period: when they were last seen and
// the main things they did.
function Summary({ days, onPickUser }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.adminActivitySummary(days)
      .then((d) => { if (!cancelled) { setData(d); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [days]);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-meta text-mute">Đang tải…</p>;
  const n = (u, ...keys) => keys.reduce((s, k) => s + (u.actions[k] || 0), 0);
  return (
    <div className="space-y-2">
      {data.failedLogins > 0 && (
        <Notice tone="warn">{data.failedLogins} lần đăng nhập thất bại trong {days} ngày qua.</Notice>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-meta">
          <thead>
            <tr className="text-left text-mute">
              {['Người dùng', 'Hoạt động gần nhất', 'Dịch AI', 'Sửa đoạn', 'Từ vựng', 'Lượt ôn', 'Lỗi / bị chặn'].map((h) => (
                <th key={h} className="border-b border-rule px-2 py-1.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-2 [&>td]:py-1.5">
                <td>
                  <button type="button" className="text-left text-ink hover:text-accent" onClick={() => onPickUser(u.id)} title="Xem nhật ký của người này">
                    {u.name || u.email}
                  </button>
                  {u.status !== 'active' && <Tag tone="flag" className="ml-1">đã khoá</Tag>}
                  {u.name && <span className="block text-caption text-mute">{u.email}</span>}
                </td>
                <td className="tabular-nums text-soft">{when([u.last_action_at, u.last_seen_at && `${u.last_seen_at.replace(' ', 'T')}Z`].filter(Boolean).sort().pop())}</td>
                <td className="tabular-nums">{n(u, 'paragraph.translate') || '—'}</td>
                <td className="tabular-nums">{n(u, 'paragraph.update', 'assistant.approve') || '—'}</td>
                <td className="tabular-nums">{n(u, 'vocab.create', 'vocab.update', 'vocab.delete', 'vocab.import', 'vocab.merge') || '—'}</td>
                <td className="tabular-nums">{u.reviews ? `${u.reviews} (${u.reviewDays} ngày)` : '—'}</td>
                <td className={`tabular-nums ${u.failed ? 'text-flag' : ''}`}>{u.failed || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ActivityLog() {
  const [days, setDays] = useState(30);
  const [filters, setFilters] = useState({ userId: '', group: '', failed: false, from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);
  const seq = useRef(0);
  const pageSize = 50;
  // Loading while the rows on screen are not those of the current request.
  const requestKey = JSON.stringify({ filters, page, reloads });
  const loading = !error && data?.key !== requestKey;

  const load = useCallback(() => {
    const mine = ++seq.current;
    api.adminActivity({ ...filters, failed: filters.failed ? 1 : '', page, pageSize })
      .then((d) => { if (mine === seq.current) { setData({ ...d, key: JSON.stringify({ filters, page, reloads }) }); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError(e.message); });
    api.adminActivityHealth().then(setHealth).catch(() => {});
  }, [filters, page, reloads]);

  useEffect(load, [load]);
  useEffect(() => { api.adminUsers().then(setUsers).catch(() => {}); }, []);

  const set = (key) => (value) => { setPage(1); setFilters((f) => ({ ...f, [key]: value })); };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const selectClass = `${inputClass.replace('w-full ', '')} py-1.5`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-serif text-heading font-semibold text-ink">Nhật ký hoạt động</h2>
        <p className="mt-1 text-body text-soft">
          Mọi thao tác thay đổi dữ liệu, đăng nhập và yêu cầu bị chặn. Chỉ lưu tên trường được gửi, không lưu nội dung, mật khẩu hay khoá API.
        </p>
      </div>

      {health && !health.enabled && <Notice tone="warn">Nhật ký đang tắt (ACTIVITY_LOG=0 trên máy chủ).</Notice>}
      {health?.dropped > 0 && (
        <Notice tone="warn">{health.dropped} dòng nhật ký không ghi được{health.lastError ? ` (lỗi gần nhất: ${health.lastError})` : ''}. Ứng dụng vẫn chạy bình thường.</Notice>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-ink">Theo người dùng</h3>
          <Segmented size="sm" label="Khoảng thời gian" options={PERIODS} value={days} onChange={setDays} />
        </div>
        <Summary days={days} onPickUser={(id) => set('userId')(String(id))} />
        {Number(filters.userId) > 0 && <UserWorkspace userId={Number(filters.userId)} onClose={() => set('userId')('')} />}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-medium text-ink">Chi tiết</h3>
          <IconButton label="Tải lại" onClick={() => setReloads((n) => n + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Lọc theo người dùng" value={filters.userId} onChange={(e) => set('userId')(e.target.value)} className={selectClass}>
            <option value="">Mọi người</option>
            <option value="none">Chưa đăng nhập</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
          <Segmented size="sm" label="Loại thao tác" options={GROUPS} value={filters.group} onChange={set('group')} className="max-w-full overflow-x-auto" />
          <label className="flex items-center gap-1.5 text-meta text-soft">
            <input type="checkbox" checked={filters.failed} onChange={(e) => set('failed')(e.target.checked)} /> Chỉ lỗi / bị chặn
          </label>
          <input type="date" aria-label="Từ ngày" value={filters.from} onChange={(e) => set('from')(e.target.value)} className={selectClass} />
          <input type="date" aria-label="Đến ngày" value={filters.to} onChange={(e) => set('to')(e.target.value)} className={selectClass} />
        </div>

        {error && <Notice action={<Button size="sm" onClick={() => { setError(''); setReloads((n) => n + 1); }}>Thử lại</Button>}>Không tải được nhật ký: {error}</Notice>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-meta">
            <thead>
              <tr className="text-left text-mute">
                {['Thời gian', 'Người dùng', 'Thao tác', 'Đối tượng', 'Kết quả', 'Thời lượng'].map((h) => (
                  <th key={h} className="border-b border-rule px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums text-soft">{when(r.at)}</td>
                  <td className="text-ink">{r.user_name || r.user_email || <span className="text-mute">—</span>}</td>
                  <td>
                    <span className="text-ink">{label(r.action)}</span>
                    {r.detail?.fields?.length > 0 && <span className="block text-caption text-mute" title="Các trường được gửi">{r.detail.fields.join(', ')}</span>}
                  </td>
                  <td className="text-soft">{target(r)}</td>
                  <td>
                    <Tag tone={r.status >= 500 ? 'flag' : r.status >= 400 ? 'warn' : 'ok'}>
                      {outcome(r)} · {r.status}
                    </Tag>
                  </td>
                  <td className="tabular-nums text-mute">{r.ms} ms</td>
                </tr>
              ))}
              {data && !data.rows.length && (
                <tr><td colSpan={6} className="px-2 py-8 text-center text-soft">Không có hoạt động nào khớp bộ lọc.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {data && data.total > pageSize && (
          <div className="flex items-center justify-between text-meta text-mute">
            <span className="tabular-nums">{data.total} dòng, trang {page}/{totalPages}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Trang trước</Button>
              <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Trang sau</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
