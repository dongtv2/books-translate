import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDirectory } from '../db.js';
import {
  userCount, getUserByEmail, createUser, publicUser, createSession, deleteSession, deleteUserSessions,
  adoptLegacyProgress, setUserRoles, rolesOf,
} from '../auth/store.js';
import { hashPassword, verifyPassword, burnPasswordCheck, validatePassword } from '../auth/passwords.js';
import { setSessionCookie, clearSessionCookie, CSRF_HEADER } from '../auth/middleware.js';
import { getSsoConfig, isSsoReady, beginLogin, completeLogin, logoutUrl, mapSsoRoles } from '../auth/oidc.js';
import { ROLES } from '../auth/permissions.js';

const router = Router();

// ---- first-run setup ---------------------------------------------------------
// While there are no users, the first administrator is created with a one-time
// token written to the server log and to server/data/setup-token.txt — so
// whoever happens to reach a freshly deployed app first cannot claim it.
//
// Unless DEFAULT_ADMIN=0, a fresh install instead gets a default administrator
// (admin@localhost / admin) that must choose a new password at first login.
export const DEFAULT_ADMIN = { email: 'admin@localhost', password: 'admin' };
let setupToken = null;
export function announceSetupTokenIfNeeded() {
  if (userCount() > 0) return;
  if (process.env.DEFAULT_ADMIN !== '0') {
    createUser({ email: DEFAULT_ADMIN.email, name: 'Admin', passwordHash: hashPassword(DEFAULT_ADMIN.password), roles: ['admin'], mustChangePassword: true });
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(' Books Translate chưa có tài khoản nào — đã tạo quản trị mặc định:');
    console.log(`   ${DEFAULT_ADMIN.email} / ${DEFAULT_ADMIN.password}  (phải đổi mật khẩu khi đăng nhập lần đầu)`);
    console.log(' Đặt DEFAULT_ADMIN=0 để dùng mã thiết lập một lần thay cho tài khoản này.');
    console.log('────────────────────────────────────────────────────────────\n');
    return;
  }
  setupToken = crypto.randomBytes(9).toString('base64url');
  const file = path.join(dataDirectory, 'setup-token.txt');
  try { fs.writeFileSync(file, `${setupToken}\n`, { mode: 0o600 }); } catch { /* log is enough */ }
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Books Translate chưa có tài khoản nào.');
  console.log(` Mã thiết lập quản trị: ${setupToken}`);
  console.log(` (cũng lưu trong ${file})`);
  console.log('────────────────────────────────────────────────────────────\n');
}

function ssoPublicInfo() {
  const c = getSsoConfig();
  return { enabled: isSsoReady(c), label: c.buttonLabel, passwordLogin: !isSsoReady(c) || c.allowPasswordLogin };
}

function requireCsrf(req, res) {
  if (!req.get(CSRF_HEADER)) {
    res.status(403).json({ error: 'Yêu cầu bị chặn (thiếu header bảo vệ CSRF).' });
    return false;
  }
  return true;
}

// GET /api/auth/me — who is signed in, what they may do, and how to sign in.
router.get('/me', (req, res) => {
  res.json({
    setupRequired: userCount() === 0,
    user: req.user ? publicUser(req.user) : null,
    permissions: req.user ? [...req.permissions] : [],
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, description: r.description }])),
    sso: ssoPublicInfo(),
  });
});

// POST /api/auth/setup — { token, email, name, password }
router.post('/setup', (req, res) => {
  if (!requireCsrf(req, res)) return;
  if (userCount() > 0) return res.status(409).json({ error: 'Ứng dụng đã có tài khoản quản trị.' });
  const { token, email, name, password } = req.body || {};
  const a = Buffer.from(String(token || '')); const b = Buffer.from(String(setupToken || ''));
  if (!setupToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Mã thiết lập không đúng. Xem log của server hoặc file setup-token.txt cạnh cơ sở dữ liệu (server/data/).' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Email không hợp lệ.' });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const user = createUser({ email, name: name || email.split('@')[0], passwordHash: hashPassword(password), roles: ['admin'] });
  adoptLegacyProgress(user.id);
  setupToken = null;
  try { fs.unlinkSync(path.join(dataDirectory, 'setup-token.txt')); } catch { /* already gone */ }
  const { token: sessionToken } = createSession(user.id, { userAgent: req.get('user-agent') });
  setSessionCookie(req, res, sessionToken);
  res.json({ ok: true });
});

// ---- password sign-in --------------------------------------------------------

// Per-IP and per-email failure counters: 8 failures in 15 minutes locks that
// key for the rest of the window.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
function tooMany(key) {
  const f = failures.get(key);
  return f && Date.now() - f.first < WINDOW && f.count >= 8;
}
// Forget windows that have ended, so the map does not grow with every
// address and e-mail ever tried.
setInterval(() => {
  const now = Date.now();
  for (const [key, f] of failures) if (now - f.first > WINDOW) failures.delete(key);
}, WINDOW).unref();
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count += 1;
}

// POST /api/auth/login — { email, password }
router.post('/login', (req, res) => {
  if (!requireCsrf(req, res)) return;
  if (!ssoPublicInfo().passwordLogin) return res.status(403).json({ error: 'Đăng nhập bằng mật khẩu đã tắt. Hãy dùng SSO.' });
  const { email = '', password = '' } = req.body || {};
  const keys = [`ip:${req.ip}`, `email:${email.toLowerCase().trim()}`];
  if (keys.some(tooMany)) return res.status(429).json({ error: 'Sai quá nhiều lần. Thử lại sau 15 phút.' });

  const user = getUserByEmail(email);
  const ok = user?.password_hash ? verifyPassword(password, user.password_hash) : (burnPasswordCheck(password), false);
  if (!ok || user.status !== 'active') {
    keys.forEach(recordFailure);
    return res.status(401).json({ error: user && user.status !== 'active' && ok ? 'Tài khoản đã bị khoá.' : 'Email hoặc mật khẩu không đúng.' });
  }
  keys.forEach((k) => failures.delete(k));
  const { token } = createSession(user.id, { userAgent: req.get('user-agent') });
  setSessionCookie(req, res, token);
  res.json({ ok: true, mustChangePassword: Boolean(user.must_change_password) });
});

// POST /api/auth/logout — returns { redirect } when the SSO session should end too.
router.post('/logout', async (req, res) => {
  if (!requireCsrf(req, res)) return;
  const wasSso = req.session?.auth_method === 'sso';
  const idToken = req.session?.id_token;
  deleteSession(req.sessionToken);
  clearSessionCookie(req, res);
  res.json({ ok: true, redirect: wasSso ? await logoutUrl(idToken) : null });
});

// POST /api/auth/password — { currentPassword, newPassword } for the signed-in user.
router.post('/password', (req, res) => {
  if (!requireCsrf(req, res)) return;
  if (!req.user) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (req.user.password_hash && !verifyPassword(currentPassword, req.user.password_hash)) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?")
    .run(hashPassword(newPassword), req.user.id);
  deleteUserSessions(req.user.id, req.sessionToken); // sign out other devices
  res.json({ ok: true });
});

// ---- SSO ---------------------------------------------------------------------

// GET /api/auth/sso/login?returnTo=/chapters/8 — browser navigation, not fetch.
router.get('/sso/login', async (req, res) => {
  try {
    res.redirect(await beginLogin(String(req.query.returnTo || '/')));
  } catch (err) {
    res.redirect(`/?ssoError=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/auth/sso/callback — the redirect URI registered in Keycloak.
router.get('/sso/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`/?ssoError=${encodeURIComponent(msg)}`);
  if (req.query.error) return fail(`SSO báo lỗi: ${req.query.error_description || req.query.error}`);
  try {
    const config = getSsoConfig();
    const { claims, roles: ssoRoles, idToken, returnTo } = await completeLogin({ code: String(req.query.code || ''), state: String(req.query.state || '') });
    const email = claims.email || (claims.preferred_username?.includes('@') ? claims.preferred_username : null);
    const name = claims.name || claims.preferred_username || email || 'Người dùng SSO';

    // Same SSO account → same user; otherwise link an existing account with
    // the same (verified) email; otherwise create one if allowed.
    let user = db.prepare('SELECT * FROM users WHERE sso_issuer = ? AND sso_subject = ?').get(claims.iss, claims.sub);
    if (!user && email && claims.email_verified !== false) {
      user = getUserByEmail(email);
      if (user) db.prepare("UPDATE users SET sso_issuer = ?, sso_subject = ?, updated_at = datetime('now') WHERE id = ?").run(claims.iss, claims.sub, user.id);
    }
    const mapped = mapSsoRoles(ssoRoles, config);
    if (!user) {
      if (!config.autoProvision) return fail('Tài khoản SSO này chưa được cấp quyền vào Books Translate. Liên hệ quản trị.');
      if (!email) return fail('Tài khoản SSO không có email.');
      const first = userCount() === 0;
      user = createUser({ email, name, roles: first ? ['admin'] : (mapped.length ? mapped : [config.defaultRole]), ssoIssuer: claims.iss, ssoSubject: claims.sub });
      if (first) adoptLegacyProgress(user.id);
    } else if (mapped.length) {
      // Roles managed in Keycloak win when it sends any mapped role.
      setUserRoles(user.id, mapped, 'sso');
    }
    if (user.status !== 'active') return fail('Tài khoản đã bị khoá.');
    if (!rolesOf(user.id).effective.length) setUserRoles(user.id, [config.defaultRole], 'app');

    const { token } = createSession(user.id, { authMethod: 'sso', idToken, userAgent: req.get('user-agent') });
    setSessionCookie(req, res, token);
    res.redirect(returnTo || '/');
  } catch (err) {
    console.error('[sso]', err);
    fail(err.message);
  }
});

export default router;
