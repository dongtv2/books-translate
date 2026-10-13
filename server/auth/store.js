// Users, groups, role assignments, sessions and per-user progress tables.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ROLE_KEYS, permissionsFor } from './permissions.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    sso_issuer TEXT,
    sso_subject TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso ON users(sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );
  -- source: 'app' (assigned in the app) or 'sso' (synced from SSO roles at sign-in)
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'app',
    PRIMARY KEY (user_id, role)
  );
  CREATE TABLE IF NOT EXISTS group_roles (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (group_id, role)
  );

  -- id is the SHA-256 of the cookie token, so a leaked database cannot be
  -- used to hijack sessions.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auth_method TEXT NOT NULL DEFAULT 'password',
    id_token TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- Per-user state on shared content: review schedule and paragraph marks.
  CREATE TABLE IF NOT EXISTS vocab_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Đang học',
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_date TEXT NOT NULL DEFAULT '',
    last_reviewed_at TEXT,
    PRIMARY KEY (user_id, vocabulary_id)
  );
  CREATE TABLE IF NOT EXISTS paragraph_marks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    is_bookmarked INTEGER NOT NULL DEFAULT 0,
    is_highlighted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, paragraph_id)
  );
`);

// A personal workspace on the shared library: where each user stopped
// reading in each book, and their display preferences (theme, font size,
// width…), so both follow the account across devices.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_reading (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, book_id)
  );
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
{
  const cols = db.prepare('PRAGMA table_info(user_reading)').all().map((c) => c.name);
  // The paragraph the reader was at, so "Đọc tiếp" lands on it, not just the chapter.
  if (!cols.includes('paragraph_id')) db.exec('ALTER TABLE user_reading ADD COLUMN paragraph_id INTEGER REFERENCES paragraphs(id) ON DELETE SET NULL');
}
{
  const cols = db.prepare('PRAGMA table_info(paragraph_marks)').all().map((c) => c.name);
  if (!cols.includes('updated_at')) db.exec("ALTER TABLE paragraph_marks ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
}

{
  const cols = db.prepare('PRAGMA table_info(review_log)').all().map((c) => c.name);
  if (!cols.includes('user_id')) db.exec('ALTER TABLE review_log ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_log_user ON review_log(user_id, reviewed_date)');
}

// ---- users -----------------------------------------------------------------

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim());
}

export function rolesOf(userId) {
  const direct = db.prepare('SELECT role, source FROM user_roles WHERE user_id = ?').all(userId);
  const viaGroups = db.prepare(`
    SELECT DISTINCT gr.role, g.name AS group_name FROM group_roles gr
    JOIN group_members gm ON gm.group_id = gr.group_id
    JOIN groups g ON g.id = gr.group_id
    WHERE gm.user_id = ?
  `).all(userId);
  const effective = [...new Set([...direct.map((r) => r.role), ...viaGroups.map((r) => r.role)])].filter((r) => ROLE_KEYS.includes(r));
  return { direct, viaGroups, effective };
}

export function effectivePermissions(userId) {
  return permissionsFor(rolesOf(userId).effective);
}

export function publicUser(user) {
  if (!user) return null;
  const roles = rolesOf(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    hasPassword: Boolean(user.password_hash),
    sso: Boolean(user.sso_subject),
    mustChangePassword: Boolean(user.must_change_password),
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    roles: roles.direct.map((r) => r.role),
    roleSources: Object.fromEntries(roles.direct.map((r) => [r.role, r.source])),
    groupRoles: roles.viaGroups,
    effectiveRoles: roles.effective,
    groups: db.prepare('SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? ORDER BY g.name').all(user.id),
  };
}

export function setUserRoles(userId, roles, source = 'app') {
  const valid = roles.filter((r) => ROLE_KEYS.includes(r));
  db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_roles (user_id, role, source) VALUES (?, ?, ?)');
    for (const r of valid) ins.run(userId, r, source);
  })();
}

export function createUser({ email, name = '', passwordHash = null, roles = [], mustChangePassword = false, ssoIssuer = null, ssoSubject = null }) {
  const info = db.prepare(`
    INSERT INTO users (email, name, password_hash, must_change_password, sso_issuer, sso_subject)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.trim(), name.trim(), passwordHash, mustChangePassword ? 1 : 0, ssoIssuer, ssoSubject);
  setUserRoles(info.lastInsertRowid, roles, ssoSubject ? 'sso' : 'app');
  return getUser(info.lastInsertRowid);
}

// Number of active users who would still hold the admin role — used to stop
// the last administrator from locking everyone out.
export function activeAdminCount(excludingUserId = null) {
  return db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS c FROM users u
    WHERE u.status = 'active' AND u.id IS NOT ?
      AND (EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = 'admin')
        OR EXISTS (SELECT 1 FROM group_roles gr JOIN group_members gm ON gm.group_id = gr.group_id WHERE gm.user_id = u.id AND gr.role = 'admin'))
  `).get(excludingUserId).c;
}

// The first administrator inherits the review schedule, streak and paragraph
// marks recorded before accounts existed (they were global then).
export function adoptLegacyProgress(userId) {
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO vocab_progress (user_id, vocabulary_id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at)
      SELECT ?, id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at FROM vocabulary
    `).run(userId);
    db.prepare(`
      INSERT OR IGNORE INTO paragraph_marks (user_id, paragraph_id, is_flagged, is_bookmarked, is_highlighted)
      SELECT ?, id, is_flagged, is_bookmarked, is_highlighted FROM paragraphs
      WHERE is_flagged = 1 OR is_bookmarked = 1 OR is_highlighted = 1
    `).run(userId);
    db.prepare('UPDATE review_log SET user_id = ? WHERE user_id IS NULL').run(userId);
  })();
}

// ---- sessions ----------------------------------------------------------------

const SESSION_DAYS = 14;
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(userId, { authMethod = 'password', idToken = null, userAgent = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, auth_method, id_token, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash(token), userId, authMethod, idToken, (userAgent || '').slice(0, 200), expires);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return { token, expires };
}

export function sessionFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hash(token));
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    return null;
  }
  // Sliding expiry, touched at most once a minute.
  if (Date.now() - new Date(`${s.last_seen_at.replace(' ', 'T')}Z`).getTime() > 60000) {
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), s.id);
  }
  return s;
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(token));
}

export function deleteUserSessions(userId, exceptToken = null) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, hash(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86400;

// Expired sessions are otherwise only removed when someone presents them.
export function purgeExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()).changes;
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref();
