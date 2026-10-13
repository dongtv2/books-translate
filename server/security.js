// Cross-cutting protections for the HTTP server: response security headers
// (CSP and friends), per-user rate limits on expensive endpoints, safe
// redirect targets, and the last-resort error handler.
import crypto from 'node:crypto';
import fs from 'node:fs';

// ---- security headers ---------------------------------------------------------

// The inline scripts of the built index.html (the theme-before-paint
// snippet) are allowed by their hash, so the policy needs no
// 'unsafe-inline' for scripts. Computed once from the file actually served.
function inlineScriptHashes(indexHtml) {
  try {
    const html = fs.readFileSync(indexHtml, 'utf8');
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  } catch {
    return [];
  }
}

export function securityHeaders({ indexHtml } = {}) {
  const scriptHashes = indexHtml ? inlineScriptHashes(indexHtml) : [];
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // style attributes (cover colors, progress widths) and Google Fonts' CSS
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // covers, previews of picked images, exported files, read-aloud audio
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// ---- rate limits ------------------------------------------------------------

// Fixed one-minute windows per (limit, user) — or per IP before sign-in.
// In memory: enough for a single server process; counters reset on restart.
const windows = new Map();
const WINDOW_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(key);
}, WINDOW_MS).unref();

// Limits per minute, overridable from the environment, e.g. RATE_ASSISTANT=60.
// 0 turns a limit off.
export const LIMITS = {
  assistant: 30, // AI chat about a paragraph (paid API calls)
  translate: 60, // AI translation of one paragraph
  ai: 30, // other AI helpers: word suggestions, book context, topics
  tts: 60, // read-aloud synthesis
  upload: 20, // imports, cover images
};

export function rateLimit(name) {
  return (req, res, next) => {
    const max = Number(process.env[`RATE_${name.toUpperCase()}`] ?? LIMITS[name]);
    if (!max) return next();
    const who = req.user ? `u${req.user.id}` : `ip${req.ip}`;
    const key = `${name}:${who}`;
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > max) {
      const retry = Math.ceil((w.start + WINDOW_MS - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Bạn đã dùng chức năng này quá ${max} lần trong một phút. Thử lại sau ${retry} giây.`, code: 'rate_limited' });
    }
    next();
  };
}

// The rate-limited endpoints, matched before the route runs.
const LIMITED = [
  ['POST', /^\/api\/paragraphs\/\d+\/assistant/, 'assistant'],
  ['POST', /^\/api\/paragraphs\/\d+\/translate$/, 'translate'],
  ['POST', /^\/api\/(vocabulary\/suggest|vocabulary\/classify-topics|books\/\d+\/suggest-context)$/, 'ai'],
  ['POST', /^\/api\/tts\/speak$/, 'tts'],
  ['POST', /^\/api\/import\//, 'upload'],
  ['PUT', /^\/api\/books\/\d+\/cover$/, 'upload'],
];
const limiters = Object.fromEntries(Object.keys(LIMITS).map((n) => [n, rateLimit(n)]));

export function rateLimits(req, res, next) {
  const path = req.originalUrl.split('?')[0];
  const hit = LIMITED.find(([m, re]) => m === req.method && re.test(path));
  return hit ? limiters[hit[2]](req, res, next) : next();
}

// ---- redirects ----------------------------------------------------------------

// A same-site path to send the browser to after sign-in, or "/". Rejects
// anything a browser could read as another host: "//x", "/\\x", schemes,
// control characters.
export function safeReturnTo(value) {
  const v = String(value || '');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!v.startsWith('/') || v.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(v)) return '/';
  try {
    const url = new URL(v, 'http://app.invalid');
    return url.origin === 'http://app.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

// ---- errors --------------------------------------------------------------------

// Last handler: a JSON error without internals (no stack, no paths). The
// full error goes to the server log.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  const message = status === 400 && err.type === 'entity.parse.failed' ? 'Dữ liệu gửi lên không phải JSON hợp lệ.'
    : status === 413 ? 'Dữ liệu gửi lên quá lớn.'
      : status < 500 && err.expose ? err.message : 'Máy chủ gặp lỗi. Thử lại sau.';
  res.status(status).json({ error: message });
}
