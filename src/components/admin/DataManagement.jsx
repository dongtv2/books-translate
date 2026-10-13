import { useEffect, useRef, useState } from 'react';
import { DatabaseBackup, Download, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '../../api.js';
import { useConfirm } from '../../context/ConfirmContext.jsx';
import { Button, Notice, Tag } from '../ui.jsx';

const KIND_LABEL = { auto: 'Tự động', manual: 'Thủ công', 'pre-migration': 'Trước chuyển đổi' };
const REASON_LABEL = { manual: 'Gộp tay', cleanup: 'Dọn dữ liệu' };

function mb(bytes) {
  if (bytes == null) return '—';
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function when(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

// Hours since an ISO time.
const hoursSince = (s) => (s ? (Date.now() - new Date(s)) / 3600000 : Infinity);

// The admin's view of the database: is it backed up, is it sound, how big
// is it, and the vocabulary merges with undo. Restoring is a command, shown
// here but not offered as a button (it replaces everyone's data).
export default function DataManagement() {
  const confirm = useConfirm();
  const [st, setSt] = useState(null);
  const [backups, setBackups] = useState([]);
  const [merges, setMerges] = useState([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [integrity, setIntegrity] = useState(null);
  const [undoNote, setUndoNote] = useState('');
  const [reloads, setReloads] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.adminDbStatus(), api.adminBackups(), api.adminMerges()])
      .then(([s, b, m]) => { if (!cancelled) { setSt(s); setBackups(b); setMerges(m); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [reloads]);
  const reload = () => setReloads((n) => n + 1);

  // One action at a time; a second click while one runs does nothing.
  async function run(key, fn) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }

  const backupNow = () => run('backup', async () => {
    await api.adminCreateBackup(note.trim());
    setNote('');
    reload();
  });

  const checkIntegrity = () => run('integrity', async () => setIntegrity(await api.adminIntegrity()));

  const undo = (m) => run(`undo-${m.id}`, async () => {
    if (!(await confirm(`Tách "${m.merged_term}" ra khỏi "${m.kept_term}" như trước khi gộp? Tiến độ ôn và lịch sử ôn của mục đó được trả lại.`, { confirmLabel: 'Hoàn tác', danger: false }))) return;
    const r = await api.adminUndoMerge(m.id);
    setError('');
    setIntegrity(null);
    setUndoNote(`Đã tách lại: ${r.restored.join(', ')}.${r.notes.length ? ` ${r.notes.join(' ')}` : ''}`);
    reload();
  });

  if (error && !st) return <Notice action={<Button size="sm" onClick={reload}>Thử lại</Button>}>Không tải được thông tin dữ liệu: {error}</Notice>;
  if (!st) return <p className="text-meta text-mute">Đang tải…</p>;

  const stale = hoursSince(st.lastBackup?.createdAt) > 26;
  const lowDisk = st.freeBytes != null && st.freeBytes < Math.max(500 * 1048576, 5 * (st.main + st.wal));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-serif text-heading font-semibold text-ink">Dữ liệu & sao lưu</h2>
        <p className="mt-1 text-body text-soft">Sao lưu tự động mỗi ngày (giữ 7 bản ngày, 4 bản tuần, 10 bản thủ công), kiểm tra toàn vẹn và hoàn tác các lần gộp từ vựng.</p>
      </div>

      {error && <Notice>{error}</Notice>}
      {!st.autoBackup && <Notice tone="warn">Sao lưu tự động đang tắt (BACKUP_AUTO=0 trên máy chủ).</Notice>}
      {st.schedule.lastError && <Notice tone="warn">Lần sao lưu tự động gần nhất thất bại: {st.schedule.lastError}</Notice>}
      {stale && <Notice tone="warn">Chưa có bản sao lưu nào trong hơn một ngày qua.</Notice>}
      {lowDisk && <Notice tone="warn">Ổ đĩa sắp đầy: còn {mb(st.freeBytes)}. Sao lưu sẽ dừng khi không đủ chỗ.</Notice>}

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ['Database', mb(st.main + st.wal), st.wal ? `gồm ${mb(st.wal)} nhật ký WAL` : ''],
          ['Sao lưu gần nhất', when(st.lastBackup?.createdAt), st.lastBackup ? KIND_LABEL[st.lastBackup.kind] : 'chưa có'],
          ['Số bản sao lưu', String(st.backupCount), mb(st.backupBytes)],
          ['Ổ đĩa còn trống', mb(st.freeBytes), ''],
        ].map(([k, v, sub]) => (
          <div key={k} className="rounded-lg border border-rule px-3 py-2.5">
            <p className="text-caption text-mute">{k}</p>
            <p className="mt-0.5 font-semibold tabular-nums text-ink">{v}</p>
            {sub && <p className="text-caption text-mute">{sub}</p>}
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-medium text-ink">Bản sao lưu</h3>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ghi chú (tuỳ chọn)"
            aria-label="Ghi chú cho bản sao lưu"
            maxLength={200}
            className="w-48 rounded-md border border-rule bg-page px-2.5 py-1.5 text-meta text-ink placeholder:text-mute focus:border-accent focus:outline-none"
          />
          <Button size="sm" variant="primary" onClick={backupNow} disabled={Boolean(busy)}>
            <DatabaseBackup size={14} /> {busy === 'backup' ? 'Đang sao lưu…' : 'Sao lưu ngay'}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-meta">
            <thead>
              <tr className="text-left text-mute">
                {['Thời gian', 'Loại', 'Kích thước', 'Nội dung', 'Kiểm tra', ''].map((h) => <th key={h} className="border-b border-rule px-2 py-1.5 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.name} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums text-ink">{when(b.createdAt)}{b.note && <span className="block text-caption text-mute">{b.note}</span>}</td>
                  <td className="text-soft">{KIND_LABEL[b.kind] || b.kind}</td>
                  <td className="tabular-nums text-soft">{mb(b.size)}</td>
                  <td className="text-soft">{b.counts ? `${b.counts.paragraphs ?? '—'} đoạn · ${b.counts.vocabulary ?? '—'} từ · ${b.counts.users ?? '—'} người` : '—'}</td>
                  <td>{b.verified ? <Tag tone="ok">Tốt</Tag> : <Tag tone="warn">Chưa kiểm tra</Tag>}</td>
                  <td className="text-right">
                    <a href={api.adminBackupUrl(b.name)} download className="inline-flex items-center gap-1 text-accent hover:underline" title={b.name}>
                      <Download size={13} /> Tải về
                    </a>
                  </td>
                </tr>
              ))}
              {!backups.length && <tr><td colSpan={6} className="px-2 py-6 text-center text-soft">Chưa có bản sao lưu nào. Bấm "Sao lưu ngay".</td></tr>}
            </tbody>
          </table>
        </div>
        <details className="rounded-md bg-sunken px-3 py-2 text-meta text-soft">
          <summary className="cursor-pointer text-ink">Cách khôi phục từ một bản sao lưu</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Dừng server (Ctrl+C ở cửa sổ đang chạy <code>npm run dev</code> / <code>npm start</code>).</li>
            <li>Chạy <code>npm run db:restore -- &lt;tên bản sao lưu&gt;</code> trong thư mục dự án. Lệnh kiểm tra bản sao lưu, sao lưu database hiện tại rồi mới thay thế, và hỏi xác nhận.</li>
            <li>Khởi động lại server.</li>
          </ol>
          <p className="mt-2">Thư mục sao lưu: <code className="break-all">{st.backupDir}</code></p>
        </details>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-medium text-ink">Kiểm tra toàn vẹn</h3>
          <Button size="sm" onClick={checkIntegrity} disabled={Boolean(busy)}>
            <ShieldCheck size={14} /> {busy === 'integrity' ? 'Đang kiểm tra…' : 'Kiểm tra ngay'}
          </Button>
        </div>
        {integrity && (integrity.ok
          ? <Notice tone="ok">Database nguyên vẹn, không có liên kết hỏng ({integrity.ms} ms).</Notice>
          : (
            <Notice tone="error">
              Phát hiện vấn đề: {integrity.integrity.join('; ')}
              {integrity.foreignKeys.length > 0 && ` · ${integrity.foreignKeys.length} liên kết hỏng (bảng ${[...new Set(integrity.foreignKeys.map((f) => f.table))].join(', ')})`}.
              {' '}Nên sao lưu ngay rồi báo lại; nếu dữ liệu hỏng, khôi phục từ bản sao lưu gần nhất có trạng thái Tốt.
            </Notice>
          ))}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-meta">
            <thead>
              <tr className="text-left text-mute">{['Bảng', 'Số dòng', 'Dung lượng'].map((h) => <th key={h} className="border-b border-rule px-2 py-1.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {st.tables.slice(0, 12).map((t) => (
                <tr key={t.name} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-2 [&>td]:py-1">
                  <td className="font-mono text-caption text-ink">{t.name}</td>
                  <td className="tabular-nums text-soft">{t.rows.toLocaleString('vi-VN')}</td>
                  <td className="tabular-nums text-soft">{mb(t.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-medium text-ink">Lịch sử gộp từ vựng</h3>
        {undoNote && <Notice tone="ok">{undoNote}</Notice>}
        <div className="max-h-96 overflow-auto">
          <table className="w-full min-w-[640px] border-collapse text-meta">
            <thead>
              <tr className="text-left text-mute">{['Thời gian', 'Đã gộp', 'Vào mục', 'Lý do', ''].map((h) => <th key={h} className="sticky top-0 border-b border-rule bg-page px-2 py-1.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {merges.filter((m) => m.merged_id != null).map((m) => (
                <tr key={m.id} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-2 [&>td]:py-1.5 [&>td]:align-top">
                  <td className="whitespace-nowrap tabular-nums text-soft">{when(m.created_at)}</td>
                  <td className="text-ink">{m.merged_term}<span className="block text-caption text-mute">{m.merged_meaning}</span></td>
                  <td className="text-ink">{m.kept_term || <span className="text-mute">(đã xoá)</span>}</td>
                  <td className="text-soft">{REASON_LABEL[m.reason] || (m.reason.startsWith('normalize') ? 'Chuẩn hoá khoá' : m.reason)}{m.by_email && <span className="block text-caption text-mute">{m.by_email}</span>}</td>
                  <td className="text-right">
                    {m.undone_at ? <Tag>Đã hoàn tác</Tag> : m.undoable ? (
                      <Button size="sm" variant="ghost" onClick={() => undo(m)} disabled={Boolean(busy)}><Undo2 size={13} /> Hoàn tác</Button>
                    ) : <span className="text-caption text-mute" title="Gộp trước khi có chức năng hoàn tác, hoặc do chuẩn hoá khoá">không hoàn tác được</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
