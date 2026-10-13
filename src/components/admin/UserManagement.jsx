import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { useAuth, roleLabel } from '../../context/AuthContext.jsx';
import { useConfirm } from '../../context/ConfirmContext.jsx';
import { Button, Field, IconButton, Notice, Segmented, Tag, inputClass } from '../ui.jsx';

const VIEWS = [
  { key: 'users', label: 'Người dùng' },
  { key: 'groups', label: 'Nhóm' },
  { key: 'roles', label: 'Vai trò' },
  { key: 'sso', label: 'SSO' },
];

const ROLE_ORDER = ['admin', 'editor', 'learner', 'guest'];
const ROLE_TONE = { admin: 'flag', editor: 'accent', learner: 'ok', guest: 'neutral' };

function formatDate(s) {
  if (!s) return 'Chưa đăng nhập';
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function CheckList({ options, value, onChange, columns = 2 }) {
  return (
    <div className={`grid gap-1.5 ${columns === 2 ? 'sm:grid-cols-2' : ''}`}>
      {options.map((o) => (
        <label key={o.key} className="flex cursor-pointer items-start gap-2 rounded-md border border-rule px-3 py-2 text-body hover:border-mute">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-accent"
            checked={value.includes(o.key)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.key] : value.filter((v) => v !== o.key))}
          />
          <span>
            <span className="block font-medium text-ink">{o.label}</span>
            {o.hint && <span className="block text-caption text-mute">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

// Shown once, right after the server generates it.
function TemporaryPassword({ email, password, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <Notice tone="warn" action={<Button size="sm" variant="ghost" onClick={onClose}>Đã lưu</Button>}>
      <p>Mật khẩu tạm cho <strong>{email}</strong>, chỉ hiện một lần. Người dùng phải đổi khi đăng nhập lần đầu.</p>
      <p className="mt-1.5 flex items-center gap-2">
        <code className="rounded bg-page px-2 py-0.5 font-mono text-lead text-ink">{password}</code>
        <IconButton label={copied ? 'Đã chép' : 'Chép'} onClick={() => { navigator.clipboard.writeText(password); setCopied(true); }}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </IconButton>
      </p>
    </Notice>
  );
}

// ---- users ------------------------------------------------------------------

function UserEditor({ initial, groups, roleOptions, onSave, onCancel, isNew }) {
  const [draft, setDraft] = useState({
    email: initial?.email || '',
    name: initial?.name || '',
    roles: initial?.roles || ['learner'],
    groupIds: initial?.groups?.map((g) => g.id) || [],
    status: initial?.status || 'active',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave(draft);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
      {error && <Notice>{error}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <input type="email" value={draft.email} disabled={!isNew} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} className={`${inputClass} disabled:opacity-60`} />
        </Field>
        <Field label="Họ tên">
          <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} className={inputClass} />
        </Field>
      </div>
      <div>
        <p className="mb-1.5 text-meta font-medium text-soft">Vai trò gán trực tiếp</p>
        <CheckList options={roleOptions} value={draft.roles} onChange={(roles) => setDraft((d) => ({ ...d, roles }))} />
        {initial && Object.values(initial.roleSources || {}).includes('sso') && (
          <p className="mt-1.5 text-caption text-warn">Vai trò của người này đang đồng bộ từ SSO; lần đăng nhập SSO sau có thể ghi đè thay đổi ở đây.</p>
        )}
      </div>
      {groups.length > 0 && (
        <div>
          <p className="mb-1.5 text-meta font-medium text-soft">Nhóm</p>
          <CheckList options={groups.map((g) => ({ key: g.id, label: g.name, hint: g.roles.map((r) => roleLabel(Object.fromEntries(roleOptions.map((o) => [o.key, o])), r)).join(', ') }))} value={draft.groupIds} onChange={(groupIds) => setDraft((d) => ({ ...d, groupIds }))} />
        </div>
      )}
      {!isNew && (
        <label className="flex cursor-pointer items-center gap-2 text-body text-soft">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={draft.status === 'disabled'} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.checked ? 'disabled' : 'active' }))} />
          Khoá tài khoản (đăng xuất ngay mọi thiết bị, không đăng nhập được nữa)
        </label>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : isNew ? 'Tạo người dùng' : 'Lưu thay đổi'}</Button>
        <Button variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
      {isNew && <p className="text-caption text-mute">Ứng dụng tạo một mật khẩu tạm và hiện nó một lần sau khi tạo. Người dùng có tài khoản SSO cũng có thể đăng nhập bằng SSO khi SSO được bật.</p>}
    </div>
  );
}

function UsersView({ roles }) {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const [users, setUsers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null); // user id | 'new' | null
  const [temp, setTemp] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.adminUsers().then(setUsers).catch((e) => setError(e.message));
    api.adminGroups().then(setGroups).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const roleOptions = ROLE_ORDER.map((k) => ({ key: k, label: roles[k]?.label || k, hint: roles[k]?.description }));

  async function create(draft) {
    const res = await api.adminCreateUser({ email: draft.email, name: draft.name, roles: draft.roles, groupIds: draft.groupIds });
    setTemp({ email: draft.email, password: res.temporaryPassword });
    setEditing(null);
    load();
  }

  async function update(id, draft) {
    await api.adminUpdateUser(id, { name: draft.name, roles: draft.roles, groupIds: draft.groupIds, status: draft.status });
    setEditing(null);
    load();
  }

  async function resetPassword(u) {
    if (!(await confirm(`Tạo mật khẩu tạm mới cho ${u.email}? Người này sẽ bị đăng xuất khỏi mọi thiết bị.`, { confirmLabel: 'Tạo mật khẩu tạm', danger: false }))) return;
    try {
      const res = await api.adminResetPassword(u.id);
      setTemp({ email: u.email, password: res.temporaryPassword });
    } catch (e) { setError(e.message); }
  }

  async function remove(u) {
    if (!(await confirm(`Xoá tài khoản ${u.email}? Tiến độ ôn tập và đánh dấu của người này sẽ mất; sách và từ vựng chung không bị ảnh hưởng.`))) return;
    try { await api.adminDeleteUser(u.id); load(); } catch (e) { setError(e.message); }
  }

  if (!users) return error ? <Notice>{error}</Notice> : <p className="text-body text-mute">Đang tải…</p>;

  return (
    <div className="space-y-4">
      {error && <Notice action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Đóng</Button>}>{error}</Notice>}
      {temp && <TemporaryPassword {...temp} onClose={() => setTemp(null)} />}
      <div className="flex items-center justify-between">
        <p className="text-body text-soft">{users.length} người dùng</p>
        {editing !== 'new' && <Button size="sm" variant="primary" onClick={() => setEditing('new')}><Plus size={15} /> Thêm người dùng</Button>}
      </div>
      {editing === 'new' && (
        <UserEditor isNew groups={groups} roleOptions={roleOptions} onSave={create} onCancel={() => setEditing(null)} />
      )}
      <ul className="divide-y divide-rule rounded-lg border border-rule">
        {users.map((u) => (
          <li key={u.id} className="p-4">
            {editing === u.id ? (
              <UserEditor initial={u} groups={groups} roleOptions={roleOptions} onSave={(d) => update(u.id, d)} onCancel={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-body font-semibold text-accent">
                  {(u.name || u.email).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-body font-medium text-ink">
                    {u.name || u.email}
                    {u.id === me.id && <Tag>Bạn</Tag>}
                    {u.status === 'disabled' && <Tag tone="flag">Đã khoá</Tag>}
                    {u.sso && <Tag tone="accent">SSO</Tag>}
                  </p>
                  <p className="truncate text-meta text-mute">{u.email}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {u.roles.map((r) => <Tag key={r} tone={ROLE_TONE[r]}>{roleLabel(roles, r)}</Tag>)}
                    {u.groupRoles.filter((g) => !u.roles.includes(g.role)).map((g) => (
                      <Tag key={`${g.group_name}-${g.role}`} tone={ROLE_TONE[g.role]} title={`Qua nhóm ${g.group_name}`}>{roleLabel(roles, g.role)} · nhóm {g.group_name}</Tag>
                    ))}
                    {!u.effectiveRoles.length && <Tag tone="warn">Chưa có vai trò</Tag>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="mr-2 hidden text-caption text-mute sm:block">{formatDate(u.lastLoginAt)}</span>
                  <IconButton label="Sửa" onClick={() => setEditing(u.id)}><Pencil size={15} /></IconButton>
                  <IconButton label="Tạo mật khẩu tạm" onClick={() => resetPassword(u)}><KeyRound size={15} /></IconButton>
                  {u.id !== me.id && <IconButton label="Xoá" onClick={() => remove(u)} className="hover:!bg-flag-soft hover:!text-flag"><Trash2 size={15} /></IconButton>}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- groups -----------------------------------------------------------------

function GroupEditor({ initial, users, roleOptions, onSave, onCancel }) {
  const [draft, setDraft] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    roles: initial?.roles || ['learner'],
    memberIds: initial?.members?.map((m) => m.id) || [],
  });
  const [error, setError] = useState('');

  async function save() {
    setError('');
    try { await onSave(draft); } catch (e) { setError(e.message); }
  }

  return (
    <div className="space-y-4 rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
      {error && <Notice>{error}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tên nhóm"><input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} className={inputClass} placeholder="VD: Gia đình, Lớp tiếng Anh" /></Field>
        <Field label="Mô tả"><input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} className={inputClass} /></Field>
      </div>
      <div>
        <p className="mb-1.5 text-meta font-medium text-soft">Vai trò của thành viên trong nhóm</p>
        <CheckList options={roleOptions} value={draft.roles} onChange={(roles) => setDraft((d) => ({ ...d, roles }))} />
      </div>
      <div>
        <p className="mb-1.5 text-meta font-medium text-soft">Thành viên</p>
        <CheckList options={users.map((u) => ({ key: u.id, label: u.name || u.email, hint: u.email }))} value={draft.memberIds} onChange={(memberIds) => setDraft((d) => ({ ...d, memberIds }))} />
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={save}>{initial ? 'Lưu nhóm' : 'Tạo nhóm'}</Button>
        <Button variant="ghost" onClick={onCancel}>Huỷ</Button>
      </div>
    </div>
  );
}

function GroupsView({ roles }) {
  const confirm = useConfirm();
  const [groups, setGroups] = useState(null);
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.adminGroups().then(setGroups).catch((e) => setError(e.message));
    api.adminUsers().then(setUsers).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const roleOptions = ROLE_ORDER.map((k) => ({ key: k, label: roles[k]?.label || k, hint: roles[k]?.description }));

  async function save(id, draft) {
    if (id) await api.adminUpdateGroup(id, draft); else await api.adminCreateGroup(draft);
    setEditing(null);
    load();
  }
  async function remove(g) {
    if (!(await confirm(`Xoá nhóm "${g.name}"? Thành viên mất các vai trò đến từ nhóm này.`))) return;
    try { await api.adminDeleteGroup(g.id); load(); } catch (e) { setError(e.message); }
  }

  if (!groups) return error ? <Notice>{error}</Notice> : <p className="text-body text-mute">Đang tải…</p>;

  return (
    <div className="space-y-4">
      {error && <Notice>{error}</Notice>}
      <div className="flex items-center justify-between gap-4">
        <p className="text-body text-soft">Gán vai trò cho cả nhóm thay vì từng người. Quyền của một người là gộp vai trò trực tiếp và vai trò của các nhóm họ thuộc.</p>
        {editing !== 'new' && <Button size="sm" variant="primary" onClick={() => setEditing('new')}><Plus size={15} /> Tạo nhóm</Button>}
      </div>
      {editing === 'new' && <GroupEditor users={users} roleOptions={roleOptions} onSave={(d) => save(null, d)} onCancel={() => setEditing(null)} />}
      {groups.length === 0 && editing !== 'new' && <p className="rounded-lg border border-dashed border-rule px-4 py-8 text-center text-body text-mute">Chưa có nhóm nào.</p>}
      <ul className="space-y-3">
        {groups.map((g) => (
          <li key={g.id} className="rounded-lg border border-rule p-4">
            {editing === g.id ? (
              <GroupEditor initial={g} users={users} roleOptions={roleOptions} onSave={(d) => save(g.id, d)} onCancel={() => setEditing(null)} />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{g.name}</p>
                  {g.description && <p className="text-meta text-mute">{g.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {g.roles.map((r) => <Tag key={r} tone={ROLE_TONE[r]}>{roleLabel(roles, r)}</Tag>)}
                  </div>
                  <p className="mt-2 text-meta text-soft">{g.members.length ? g.members.map((m) => m.name || m.email).join(', ') : 'Chưa có thành viên'}</p>
                </div>
                <div className="flex gap-1">
                  <IconButton label="Sửa nhóm" onClick={() => setEditing(g.id)}><Pencil size={15} /></IconButton>
                  <IconButton label="Xoá nhóm" onClick={() => remove(g)} className="hover:!bg-flag-soft hover:!text-flag"><Trash2 size={15} /></IconButton>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- roles (reference) ----------------------------------------------------------

function RolesView() {
  const [data, setData] = useState(null);
  useEffect(() => { api.adminRoles().then(setData).catch(() => {}); }, []);
  if (!data) return <p className="text-body text-mute">Đang tải…</p>;
  const roles = ROLE_ORDER.map((k) => data.roles.find((r) => r.key === k)).filter(Boolean);
  return (
    <div className="space-y-3">
      <p className="text-body text-soft">Bốn vai trò cố định, mỗi vai trò mở một nhóm chức năng. Máy chủ kiểm tra quyền ở từng yêu cầu, không chỉ ẩn nút trên giao diện.</p>
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full min-w-[560px] border-collapse text-body">
          <thead>
            <tr className="bg-sunken text-left text-meta text-mute">
              <th className="border-b border-rule px-4 py-2.5 font-medium">Chức năng</th>
              {roles.map((r) => <th key={r.key} className="w-24 border-b border-rule px-3 py-2.5 text-center font-medium">{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.permissions.map((p) => (
              <tr key={p.key} className="[&>td]:border-b [&>td]:border-rule last:[&>td]:border-b-0">
                <td className="px-4 py-2.5 text-ink">{p.label}</td>
                {roles.map((r) => (
                  <td key={r.key} className="px-3 py-2.5 text-center">
                    {r.permissions.includes(p.key) ? <Check size={16} className="mx-auto text-ok" aria-label="Có" /> : <span className="text-mute" aria-label="Không">–</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- SSO ----------------------------------------------------------------------

function SsoView({ roles }) {
  const [config, setConfig] = useState(null);
  const [test, setTest] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.adminSso().then(setConfig).catch((e) => setError(e.message)); }, []);
  if (!config) return error ? <Notice>{error}</Notice> : <p className="text-body text-mute">Đang tải…</p>;

  const set = (k) => (e) => { setConfig((c) => ({ ...c, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); setSaved(false); };
  const setMap = (role) => (e) => { setConfig((c) => ({ ...c, roleMapping: { ...c.roleMapping, [role]: e.target.value } })); setSaved(false); };

  async function save() {
    setError('');
    try {
      const next = await api.adminSaveSso(config);
      setConfig(next);
      setSaved(true);
    } catch (e) { setError(e.message); }
  }
  async function runTest() {
    setTest({ busy: true });
    try { setTest(await api.adminTestSso(config.issuer)); } catch (e) { setTest({ ok: false, error: e.message }); }
  }

  return (
    <div className="space-y-6">
      <Notice tone={config.enabled ? 'ok' : 'info'}>
        {config.enabled ? 'SSO đang bật: màn đăng nhập có nút đăng nhập bằng SSO.' : 'SSO đang ở chế độ chờ: điền cấu hình, kiểm tra kết nối, rồi bật khi client Keycloak đã sẵn sàng.'}
      </Notice>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Issuer (realm Keycloak)" hint="Dạng https://<máy-chủ-sso>/realms/<tên-realm>">
          <input value={config.issuer} onChange={set('issuer')} className={inputClass} spellCheck={false} />
        </Field>
        <Field label="Địa chỉ công khai của app" hint="Dùng để tạo Redirect URI.">
          <input value={config.publicUrl} onChange={set('publicUrl')} className={inputClass} spellCheck={false} />
        </Field>
        <Field label="Client ID"><input value={config.clientId} onChange={set('clientId')} className={inputClass} spellCheck={false} /></Field>
        <Field label="Client secret" hint={config.hasClientSecret ? 'Đã lưu. Nhập để thay.' : 'Để trống nếu client là public (chỉ PKCE).'}>
          <input type="password" value={config.clientSecret} onChange={set('clientSecret')} className={inputClass} autoComplete="off" />
        </Field>
        <Field label="Scopes"><input value={config.scopes} onChange={set('scopes')} className={inputClass} spellCheck={false} /></Field>
        <Field label="Chữ trên nút đăng nhập"><input value={config.buttonLabel} onChange={set('buttonLabel')} className={inputClass} /></Field>
      </div>

      <div className="rounded-lg border border-rule bg-sunken px-4 py-3 text-body">
        <p className="font-medium text-ink">Redirect URI cần khai báo trong Keycloak</p>
        <code className="mt-1 block break-all font-mono text-meta text-accent">{config.redirectUri}</code>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-meta text-soft">
          <li>Trong realm, tạo client OpenID Connect với Client ID ở trên; bật Standard flow, tắt Implicit và Direct access grants.</li>
          <li>Bật Client authentication rồi chép secret vào đây (hoặc để client public, chỉ dùng PKCE).</li>
          <li>Valid redirect URIs: Redirect URI ở trên. Valid post logout redirect URIs: {config.publicUrl}/*. Web origins: {config.publicUrl}.</li>
          <li>Tạo các client role như cột bên phải bảng dưới và gán cho người dùng hoặc nhóm trong Keycloak.</li>
        </ol>
      </div>

      <div>
        <p className="mb-1.5 text-meta font-medium text-soft">Ánh xạ vai trò Keycloak → vai trò trong app</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLE_ORDER.map((r) => (
            <label key={r} className="flex items-center gap-3 text-body">
              <span className="w-24 shrink-0 text-ink">{roleLabel(roles, r)}</span>
              <input value={config.roleMapping[r] || ''} onChange={setMap(r)} className={`${inputClass} py-1.5`} placeholder="(không ánh xạ)" spellCheck={false} />
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-caption text-mute">Nhận cả realm role, client role và tên group. Khi token có vai trò được ánh xạ, vai trò của người dùng trong app được đặt theo SSO ở mỗi lần đăng nhập.</p>
      </div>

      <div className="space-y-2 text-body text-soft">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={config.autoProvision} onChange={set('autoProvision')} />
          Tự tạo tài khoản khi người dùng SSO đăng nhập lần đầu, với vai trò
          <select value={config.defaultRole} onChange={set('defaultRole')} className="rounded-md border border-rule bg-page px-2 py-1 text-body">
            {ROLE_ORDER.map((r) => <option key={r} value={r}>{roleLabel(roles, r)}</option>)}
          </select>
          nếu SSO không gửi vai trò nào.
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={config.allowPasswordLogin} onChange={set('allowPasswordLogin')} />
          Vẫn cho đăng nhập bằng mật khẩu khi SSO đang bật
        </label>
        <label className="flex cursor-pointer items-center gap-2 font-medium text-ink">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={config.enabled} onChange={set('enabled')} />
          Bật đăng nhập SSO
        </label>
      </div>

      {error && <Notice>{error}</Notice>}
      {saved && <Notice tone="ok">Đã lưu cấu hình SSO.</Notice>}
      {test && !test.busy && (
        <Notice tone={test.ok ? 'ok' : 'error'}>
          {test.ok ? `Kết nối được tới ${test.issuer}. ${test.pkce ? 'Có hỗ trợ PKCE.' : 'Không thấy hỗ trợ PKCE (S256).'}` : `Không kết nối được: ${test.error}`}
        </Notice>
      )}
      <div className="flex flex-wrap gap-2 border-t border-rule pt-5">
        <Button variant="primary" onClick={save}>Lưu cấu hình SSO</Button>
        <Button onClick={runTest} disabled={test?.busy}>{test?.busy ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</Button>
      </div>
    </div>
  );
}

export default function UserManagement() {
  const { roles } = useAuth();
  const [view, setView] = useState('users');
  return (
    <div className="space-y-5">
      <Segmented label="Mục quản lý" options={VIEWS} value={view} onChange={setView} />
      {view === 'users' && <UsersView roles={roles} />}
      {view === 'groups' && <GroupsView roles={roles} />}
      {view === 'roles' && <RolesView />}
      {view === 'sso' && <SsoView roles={roles} />}
    </div>
  );
}
