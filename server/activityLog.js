// Who did what, for the admin's activity page: one row per request that
// changes something (plus sign-ins), named by action ("paragraph.translate",
// "vocab.merge"…), with the entity it touched, the outcome and how long it
// took.
//
// Safety rules, because this sits in front of every API call:
// - It never stores request bodies: only the NAMES of the fields sent (and
//   the e-mail of a sign-in attempt). Passwords, API keys and book text
//   never reach the log.
// - Writing is batched off the request path (flushed every second or every
//   100 rows in one transaction); a failure to log is counted and reported,
//   never turned into a failed request.
// - ACTIVITY_LOG=0 switches it off without a deploy; rows older than
//   ACTIVITY_RETENTION_DAYS (default 180) are deleted daily.
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL DEFAULT 0,
    ip TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at);
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, at);
  CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action, at);
  CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
`);

export const enabled = () => process.env.ACTIVITY_LOG !== '0';
const RETENTION_DAYS = Math.max(7, Number(process.env.ACTIVITY_RETENTION_DAYS) || 180);

// Requests that are not worth a row: reading position and display
// preferences (saved on every scroll / toggle), read-aloud, the per-card
// review grade (already in review_log) and AI suggestions that save nothing.
const SKIP = [
  /^PUT \/api\/me\/(reading|preferences)$/,
  /^POST \/api\/tts\//,
  /^POST \/api\/vocabulary\/\d+\/review$/,
  /^POST \/api\/vocabulary\/suggest$/,
  /^POST \/api\/books\/\d+\/suggest-context$/,
  /^POST \/api\/settings\/(test|models)$/,
  /^POST \/api\/admin\/sso\/test$/,
];

// [method, path pattern, action, entity type]. The first number in the
// path is the entity id. Order matters: specific paths before general ones.
const ROUTES = [
  ['POST', /^\/api\/auth\/login$/, 'auth.login', 'user'],
  ['POST', /^\/api\/auth\/logout$/, 'auth.logout', 'user'],
  ['POST', /^\/api\/auth\/password$/, 'auth.password', 'user'],
  ['POST', /^\/api\/auth\/setup$/, 'auth.setup', 'user'],
  ['POST', /^\/api\/auth\//, 'auth.sso', 'user'],

  ['POST', /^\/api\/admin\/users\/\d+\/reset-password$/, 'admin.user.reset_password', 'user'],
  ['POST', /^\/api\/admin\/users$/, 'admin.user.create', 'user'],
  ['PATCH', /^\/api\/admin\/users\/\d+$/, 'admin.user.update', 'user'],
  ['DELETE', /^\/api\/admin\/users\/\d+$/, 'admin.user.delete', 'user'],
  ['POST', /^\/api\/admin\/groups$/, 'admin.group.create', 'group'],
  ['PATCH', /^\/api\/admin\/groups\/\d+$/, 'admin.group.update', 'group'],
  ['DELETE', /^\/api\/admin\/groups\/\d+$/, 'admin.group.delete', 'group'],
  ['PUT', /^\/api\/admin\/sso$/, 'admin.sso.update', null],
  ['POST', /^\/api\/admin\/database\/backups$/, 'admin.backup.create', null],
  ['GET', /^\/api\/admin\/database\/backups\/[^/]+\/download$/, 'admin.backup.download', null],
  ['POST', /^\/api\/admin\/database\/merges\/\d+\/undo$/, 'vocab.merge_undo', 'merge'],
  ['POST', /^\/api\/admin\/database\/integrity$/, 'admin.integrity', null],

  ['POST', /^\/api\/paragraphs\/\d+\/translate$/, 'paragraph.translate', 'paragraph'],
  ['POST', /^\/api\/paragraphs\/\d+\/assistant\/\d+\/approve$/, 'assistant.approve', 'paragraph'],
  ['POST', /^\/api\/paragraphs\/\d+\/assistant\/\d+\/reject$/, 'assistant.reject', 'paragraph'],
  ['POST', /^\/api\/paragraphs\/\d+\/assistant\/\d+\/revert$/, 'assistant.revert', 'paragraph'],
  ['DELETE', /^\/api\/paragraphs\/\d+\/assistant$/, 'assistant.clear', 'paragraph'],
  ['POST', /^\/api\/paragraphs\/\d+\/assistant/, 'assistant.ask', 'paragraph'],
  ['PATCH', /^\/api\/paragraphs\/\d+$/, 'paragraph.update', 'paragraph'],
  ['DELETE', /^\/api\/paragraphs\/\d+$/, 'paragraph.delete', 'paragraph'],

  ['POST', /^\/api\/import\//, 'book.import', 'book'],
  ['POST', /^\/api\/books$/, 'book.create', 'book'],
  ['PATCH', /^\/api\/books\/\d+$/, 'book.update', 'book'],
  ['PUT', /^\/api\/books\/\d+\/access$/, 'book.access', 'book'],
  ['*', /^\/api\/books\/\d+\/cover$/, 'book.cover', 'book'],
  ['DELETE', /^\/api\/books\/\d+$/, 'book.delete', 'book'],
  ['POST', /^\/api\/books\/\d+\/(parts|chapters)$/, 'book.structure', 'book'],
  ['*', /^\/api\/(parts|chapters|sections)\/\d+/, 'book.structure', null],

  ['POST', /^\/api\/vocabulary\/import$/, 'vocab.import', null],
  ['POST', /^\/api\/vocabulary\/merge$/, 'vocab.merge', 'vocabulary'],
  ['POST', /^\/api\/vocabulary\/duplicates\/dismiss$/, 'vocab.dismiss_duplicates', null],
  ['POST', /^\/api\/vocabulary\/classify-topics$/, 'vocab.classify', null],
  ['POST', /^\/api\/vocabulary\/proposals\/\d+\/approve$/, 'vocab.proposal_approve', 'vocabulary'],
  ['POST', /^\/api\/vocabulary\/proposals\/\d+\/reject$/, 'vocab.proposal_reject', 'vocabulary'],
  ['POST', /^\/api\/vocabulary\/\d+\/propose$/, 'vocab.propose', 'vocabulary'],
  ['DELETE', /^\/api\/vocabulary\/\d+\/propose$/, 'vocab.propose_withdraw', 'vocabulary'],
  ['*', /^\/api\/vocabulary\/\d+\/mine$/, 'vocab.mine', 'vocabulary'],
  ['POST', /^\/api\/vocabulary\/\d+\/senses$/, 'vocab.sense', 'vocabulary'],
  ['*', /^\/api\/vocabulary\/senses\/\d+$/, 'vocab.sense', 'sense'],
  ['POST', /^\/api\/vocabulary$/, 'vocab.create', 'vocabulary'],
  ['PATCH', /^\/api\/vocabulary\/\d+$/, 'vocab.update', 'vocabulary'],
  ['DELETE', /^\/api\/vocabulary\/\d+$/, 'vocab.delete', 'vocabulary'],

  ['POST', /^\/api\/discussions\/\d+\/resolve$/, 'discussion.resolve', 'thread'],
  ['*', /^\/api\/discussions/, 'discussion.post', 'thread'],
  ['*', /^\/api\/glossary/, 'glossary.change', 'glossary'],
  ['*', /^\/api\/assignments/, 'assignment.change', 'assignment'],
  ['*', /^\/api\/prompts/, 'prompt.change', 'prompt'],
  ['PUT', /^\/api\/settings$/, 'settings.ai.update', null],
];

// The action for a request, or null when it is not logged.
// Reads that are worth a row all the same: taking a copy of the database.
const LOGGED_READS = [/^\/api\/admin\/database\/backups\/[^/]+\/download$/];

export function classify(method, path) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method) && !(method === 'GET' && LOGGED_READS.some((re) => re.test(path)))) return null;
  const key = `${method} ${path}`;
  if (SKIP.some((re) => re.test(key))) return null;
  for (const [m, re, action, entityType] of ROUTES) {
    if ((m === '*' || m === method) && re.test(path)) {
      const id = path.match(/\/(\d+)(?:\/|$)/)?.[1];
      return { action, entityType: id ? (entityType || path.split('/')[2]) : entityType, entityId: id ? Number(id) : null };
    }
  }
  return { action: `other.${method.toLowerCase()}`, entityType: null, entityId: null };
}

// What may be kept about a request body: the field names, a few numbers
// that identify what was acted on, and the e-mail of a sign-in attempt.
// Everything else (values) is dropped.
const SAFE_NUMBERS = ['keepId', 'mergeIds', 'ids', 'mode', 'dryRun', 'reexplainAll'];
export function safeDetail(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const detail = { fields: Object.keys(body).filter((k) => !/password|secret|token|key/i.test(k)).slice(0, 30) };
  for (const k of SAFE_NUMBERS) {
    const v = body[k];
    if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[a-z]{1,12}$/.test(v))) detail[k] = v;
    else if (Array.isArray(v) && v.every((x) => Number.isInteger(Number(x)))) detail[k] = v.slice(0, 50).map(Number);
  }
  if (Array.isArray(body.entries)) detail.entries = body.entries.length;
  if (path === '/api/auth/login' && typeof body.email === 'string') detail.email = body.email.trim().toLowerCase().slice(0, 200);
  return detail;
}

// ---- batched writer ---------------------------------------------------

const queue = [];
export const stats = { written: 0, dropped: 0, lastError: '', lastErrorAt: null };
const MAX_QUEUE = 5000;
const insert = db.prepare(`
  INSERT INTO activity_log (at, user_id, action, method, path, entity_type, entity_id, status, ms, ip, detail)
  VALUES (@at, @user_id, @action, @method, @path, @entity_type, @entity_id, @status, @ms, @ip, @detail)
`);
const findUserByEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE');

export function record(row) {
  if (!enabled()) return;
  if (queue.length >= MAX_QUEUE) { stats.dropped += 1; return; }
  queue.push(row);
  if (queue.length >= 100) flush();
}

// Writes everything queued in one transaction. Returns how many rows.
export function flush() {
  if (!queue.length) return 0;
  const rows = queue.splice(0, queue.length);
  try {
    db.transaction(() => { for (const r of rows) insert.run(r); })();
    stats.written += rows.length;
    return rows.length;
  } catch {
    // One bad row must not cost the whole batch: write them one by one.
    let written = 0;
    for (const r of rows) {
      try {
        insert.run(r);
        written += 1;
      } catch (err) {
        stats.dropped += 1;
        stats.lastError = err.message;
        stats.lastErrorAt = new Date().toISOString();
        console.error('[activity] could not write a log row:', err.message);
      }
    }
    stats.written += written;
    return written;
  }
}

export function prune(days = RETENTION_DAYS) {
  try {
    return db.prepare("DELETE FROM activity_log WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(`-${days} days`).changes;
  } catch (err) {
    console.error('[activity] prune failed:', err.message);
    return 0;
  }
}

let timers = null;
export function startBackgroundJobs() {
  if (timers) return;
  prune();
  timers = [setInterval(flush, 1000), setInterval(() => prune(), 24 * 3600 * 1000)];
  timers.forEach((t) => t.unref());
  const finish = () => flush();
  process.once('beforeExit', finish);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { finish(); process.exit(0); });
}

// Express middleware for /api. Mounted before authentication, so refused
// requests (401/403) are logged too; req.user is read when the response
// finishes, after the auth middleware has run.
export function activityMiddleware(req, res, next) {
  if (!enabled()) return next();
  const path = req.originalUrl.split('?')[0];
  let kind;
  try {
    kind = classify(req.method, path);
  } catch {
    kind = null;
  }
  if (!kind) return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const detail = safeDetail(path, req.body);
      let userId = req.user?.id ?? null;
      if (!userId && kind.action === 'auth.login' && res.statusCode < 300 && detail.email) userId = findUserByEmail.get(detail.email)?.id ?? null;
      record({
        at: new Date().toISOString(),
        user_id: userId,
        action: kind.action,
        method: req.method,
        path: path.slice(0, 300),
        entity_type: kind.entityType,
        entity_id: kind.entityId,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
        ip: String(req.ip || '').slice(0, 64),
        detail: JSON.stringify(detail),
      });
    } catch (err) {
      stats.dropped += 1;
      stats.lastError = err.message;
    }
  });
  next();
}
