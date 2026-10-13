import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Field, Notice, inputClass } from '../components/ui.jsx';
import { BrandMark, BrandName } from '../components/Brand.jsx';
import { BRAND } from '../lib/brand.js';

function AuthShell({ title, subtitle, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-desk px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark size={112} />
          <h2 className="sr-only">{BRAND.name}</h2>
          <BrandName tagline className="text-[30px]" />
        </div>
        <div className="rounded-lg border border-rule bg-page p-6 shadow-sm">
          <h1 className="font-serif text-title font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-body leading-relaxed text-soft">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-6 text-center text-meta leading-relaxed text-mute">
          {BRAND.message}
          <span className="mt-1 block text-caption">{BRAND.metta}</span>
        </p>
      </div>
    </div>
  );
}

function ssoErrorFromUrl() {
  const msg = new URLSearchParams(window.location.search).get('ssoError');
  if (msg) window.history.replaceState(null, '', window.location.pathname);
  return msg;
}

export function LoginPage() {
  const { sso, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(ssoErrorFromUrl);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(email, password);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const returnTo = encodeURIComponent(window.location.pathname + window.location.hash);

  return (
    <AuthShell title="Đăng nhập" subtitle={sso?.enabled ? 'Dùng tài khoản SSO của bạn.' : undefined}>
      {error && <Notice className="mb-4">{error}</Notice>}
      {sso?.enabled && (
        <a href={`/api/auth/sso/login?returnTo=${returnTo}`} className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent text-lead font-medium text-on-accent hover:bg-accent-strong">
          <LogIn size={17} /> Đăng nhập bằng {sso.label}
        </a>
      )}
      {sso?.enabled && sso?.passwordLogin && (
        <div className="my-5 flex items-center gap-3 text-caption text-mute">
          <span className="h-px flex-1 bg-rule" /> hoặc bằng mật khẩu <span className="h-px flex-1 bg-rule" />
        </div>
      )}
      {(!sso?.enabled || sso?.passwordLogin) && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Mật khẩu">
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </Field>
          <Button type="submit" variant={sso?.enabled ? 'secondary' : 'primary'} size="lg" className="w-full" disabled={busy}>
            {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-caption text-mute">Chưa có tài khoản? Liên hệ quản trị viên để được cấp.</p>
    </AuthShell>
  );
}

export function SetupPage() {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) { setError('Hai lần nhập mật khẩu không khớp.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.setup({ token: form.token.trim(), name: form.name, email: form.email, password: form.password });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Tạo tài khoản quản trị"
      subtitle="Ứng dụng chưa có tài khoản nào. Tài khoản đầu tiên là quản trị và nhận lại toàn bộ tiến độ ôn tập, đánh dấu đã có."
    >
      {error && <Notice className="mb-4">{error}</Notice>}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Mã thiết lập" hint="In trong log khi khởi động server, và trong file server/data/setup-token.txt.">
          <input required value={form.token} onChange={set('token')} className={inputClass} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Họ tên"><input value={form.name} onChange={set('name')} className={inputClass} autoComplete="name" /></Field>
        <Field label="Email"><input type="email" required value={form.email} onChange={set('email')} className={inputClass} autoComplete="username" /></Field>
        <Field label="Mật khẩu" hint="Ít nhất 10 ký tự.">
          <input type="password" required minLength={10} value={form.password} onChange={set('password')} className={inputClass} autoComplete="new-password" />
        </Field>
        <Field label="Nhập lại mật khẩu">
          <input type="password" required value={form.confirm} onChange={set('confirm')} className={inputClass} autoComplete="new-password" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
          {busy ? 'Đang tạo…' : 'Tạo tài khoản quản trị'}
        </Button>
      </form>
    </AuthShell>
  );
}

// Change-password form, used full-screen when an administrator issued a
// temporary password, and inside Settings → Tài khoản.
export function ChangePasswordForm({ requireCurrent = true, onDone }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setDone(false); };

  async function submit(e) {
    e.preventDefault();
    if (form.next !== form.confirm) { setError('Hai lần nhập mật khẩu mới không khớp.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.changePassword(form.current, form.next);
      setForm({ current: '', next: '', confirm: '' });
      setDone(true);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Notice>{error}</Notice>}
      {done && <Notice tone="ok">Đã đổi mật khẩu. Các thiết bị khác đã được đăng xuất.</Notice>}
      {requireCurrent && (
        <Field label="Mật khẩu hiện tại">
          <input type="password" required value={form.current} onChange={set('current')} className={inputClass} autoComplete="current-password" />
        </Field>
      )}
      <Field label="Mật khẩu mới" hint="Ít nhất 10 ký tự.">
        <input type="password" required minLength={10} value={form.next} onChange={set('next')} className={inputClass} autoComplete="new-password" />
      </Field>
      <Field label="Nhập lại mật khẩu mới">
        <input type="password" required value={form.confirm} onChange={set('confirm')} className={inputClass} autoComplete="new-password" />
      </Field>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Đổi mật khẩu'}</Button>
    </form>
  );
}

export function ForcedPasswordChangePage() {
  const { refresh, logout } = useAuth();
  return (
    <AuthShell title="Đặt mật khẩu mới" subtitle="Bạn đang dùng mật khẩu tạm do quản trị cấp. Hãy đặt mật khẩu của riêng mình để tiếp tục.">
      <ChangePasswordForm onDone={refresh} />
      <button type="button" onClick={logout} className="mt-4 text-body text-mute hover:text-ink">Đăng xuất</button>
    </AuthShell>
  );
}
