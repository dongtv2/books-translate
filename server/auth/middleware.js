// Request authentication and per-route authorization for /api.
import { getUser, sessionFromToken, effectivePermissions, SESSION_MAX_AGE_SECONDS } from './store.js';
import { ruleFor } from './permissions.js';

export const SESSION_COOKIE = 'bt_session';
// Requests that change data must carry this header. A cross-site form or
// image cannot set custom headers, and a cross-site fetch that tries needs a
// CORS preflight this server never approves — so this blocks CSRF.
export const CSRF_HEADER = 'x-books-translate';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

export function setSessionCookie(req, res, token) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE_SECONDS}`];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// Attaches req.user / req.permissions / req.session when the session cookie
// is valid. Never rejects by itself.
export function authenticate(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = sessionFromToken(token);
  if (session) {
    const user = getUser(session.user_id);
    if (user && user.status === 'active') {
      req.user = user;
      req.session = session;
      req.sessionToken = token;
      req.permissions = new Set(effectivePermissions(user.id));
    }
  }
  next();
}

export function can(req, permission) {
  return Boolean(req.permissions?.has(permission));
}

// Guards everything under /api except the public auth endpoints.
export function authorize(req, res, next) {
  const path = req.originalUrl.split('?')[0];
  if (path === '/api/health' || path.startsWith('/api/auth/')) return next();

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.get(CSRF_HEADER)) {
    return res.status(403).json({ error: 'Yêu cầu bị chặn (thiếu header bảo vệ CSRF).' });
  }
  if (!req.user) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });

  // A temporary password (set by an admin) must be replaced before anything
  // else: only reading one's own workspace is allowed until then; changing
  // the password is under /api/auth/, which is open.
  if (req.user.must_change_password && !(req.method === 'GET' && path.startsWith('/api/me/'))) {
    return res.status(403).json({ error: 'Hãy đổi mật khẩu tạm trước khi tiếp tục.', code: 'must_change_password' });
  }

  const rule = ruleFor(req.method, path);
  if (!rule) {
    console.warn(`[auth] no permission rule for ${req.method} ${path} — refused`);
    return res.status(403).json({ error: 'Chức năng này chưa được cấp quyền truy cập.' });
  }
  const needs = rule.need === null ? [] : Array.isArray(rule.need) ? rule.need : [rule.need];
  if (needs.length && !needs.some((p) => can(req, p))) {
    return res.status(403).json({ error: 'Tài khoản của bạn không có quyền dùng chức năng này.' });
  }
  next();
}
