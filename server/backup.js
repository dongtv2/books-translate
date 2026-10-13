// Backups of the SQLite database and the admin's view of its health.
//
// - A backup is `VACUUM INTO` a new file: a consistent snapshot even while
//   the app is writing, compacted, written in one synchronous call (a few
//   milliseconds for this app's size). Each file is checked right after it
//   is written (quick_check, row counts) and gets a .json sidecar with its
//   size, sha256 and the check's result; a backup that fails the check is
//   deleted, never listed as good.
// - Kinds: "auto" (daily), "manual" (admin button), "pre-migration" (taken
//   by code before it rewrites data). Rotation keeps 7 daily + 4 weekly
//   autos and the 10 newest of each other kind, and never deletes the
//   newest good backup.
// - Restoring is deliberately not a web button: it replaces everyone's data.
//   It is `npm run db:restore -- <file>` with the server stopped (see
//   server/scripts/restoreBackup.mjs).
// BACKUP_AUTO=0 stops the daily backup; BACKUP_DIR moves the folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, dataDirectory } from './db.js';

export const backupDir = () => process.env.BACKUP_DIR || path.join(dataDirectory, 'backups');
// Cover images (bookCovers.js) live in files, not in the database; each
// backup also mirrors them into backups/covers/. Their names carry a content
// hash, so a file is copied once and never changes; rotation leaves them.
const coverSource = () => process.env.COVER_DIR || path.join(dataDirectory, 'covers');

export function mirrorCovers() {
  const from = coverSource();
  if (!fs.existsSync(from)) return 0;
  const to = path.join(backupDir(), 'covers');
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(from)) {
    if (!/^book-\d+-[0-9a-f]{12}-(lg|sm)\.(webp|jpg|png)$/.test(name) || fs.existsSync(path.join(to, name))) continue;
    fs.copyFileSync(path.join(from, name), path.join(to, name));
    copied += 1;
  }
  return copied;
}
const KINDS = ['auto', 'manual', 'pre-migration'];
const NAME_RE = /^books-(\d{8}-\d{6}(?:-\d{3})?)-(auto|manual|pre-migration)\.db$/;
export const status = { lastError: '', lastErrorAt: null, lastAutoAt: null, skipped: '' };

// Tables whose row counts are recorded with each backup and shown on the
// data page: enough to tell at a glance that a backup holds the books.
const KEY_TABLES = ['books', 'chapters', 'paragraphs', 'vocabulary', 'users', 'vocab_progress', 'review_log', 'glossary'];

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Free bytes on the disk holding `dir`, or null when unknown.
export function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function dbFileSize() {
  const file = db.name;
  const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  return { main: size(file), wal: size(`${file}-wal`) };
}

// Opens a backup read-only and checks it: SQLite's quick_check plus the key
// tables' row counts. Never throws.
export function verifyFile(file) {
  let check;
  try {
    check = new Database(file, { readonly: true, fileMustExist: true });
    const result = check.pragma('quick_check', { simple: true });
    const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const counts = Object.fromEntries(KEY_TABLES.filter((t) => tables.has(t)).map((t) => [t, check.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c]));
    return { ok: result === 'ok' && tables.has('paragraphs'), integrity: result, counts };
  } catch (err) {
    return { ok: false, integrity: err.message, counts: {} };
  } finally {
    check?.close();
  }
}

// Writes a backup and returns its listing entry. Throws when it cannot be
// made (disk full, folder not writable, check failed).
export function createBackup({ kind = 'manual', userId = null, note = '' } = {}) {
  if (!KINDS.includes(kind)) throw new Error('Loại sao lưu không hợp lệ.');
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const { main, wal } = dbFileSize();
  const free = freeBytes(dir);
  const needed = Math.max(200 * 1024 * 1024, 3 * (main + wal));
  if (free != null && free < needed) {
    throw new Error(`Ổ đĩa còn ${Math.round(free / 1048576)} MB, cần ít nhất ${Math.round(needed / 1048576)} MB để sao lưu an toàn.`);
  }
  const name = `books-${stamp()}-${kind}.db`;
  const file = path.join(dir, name);
  const started = Date.now();
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new Error(`Không tạo được bản sao lưu: ${err.message}`);
  }
  const check = verifyFile(file);
  if (!check.ok) {
    fs.rmSync(file, { force: true });
    throw new Error(`Bản sao lưu vừa tạo không qua kiểm tra (${check.integrity}), đã huỷ.`);
  }
  const meta = {
    name, kind, note: String(note || '').slice(0, 200), createdAt: new Date().toISOString(), createdBy: userId,
    size: fs.statSync(file).size, sha256: sha256(file), ms: Date.now() - started, integrity: check.integrity, counts: check.counts,
  };
  try {
    meta.coversCopied = mirrorCovers();
  } catch (err) {
    // the database copy is what matters; report the covers and go on
    meta.coversError = err.message;
    console.error('[backup] covers not mirrored:', err.message);
  }
  fs.writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2));
  rotate();
  return meta;
}

// Every backup in the folder, newest first, with its sidecar (or what can
// be read without one).
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .map((name) => {
      const file = path.join(dir, name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')); } catch { /* no sidecar */ }
      const [, ts, kind] = name.match(NAME_RE);
      const createdAt = meta.createdAt || `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
      return { ...meta, name, kind, createdAt, size: fs.statSync(file).size, verified: meta.integrity === 'ok' };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// The full path of a listed backup, or null: names from a request are only
// ever looked up in the listing, so "../" and other paths cannot escape the
// folder.
export function backupPath(name) {
  const hit = listBackups().find((b) => b.name === name);
  return hit ? path.join(backupDir(), hit.name) : null;
}

// Which backups rotation removes, given the listing (newest first) and now.
// Pure, so it can be tested with made-up dates.
export function rotationPlan(backups, now = new Date()) {
  const keep = new Set();
  const good = backups.filter((b) => b.verified !== false);
  if (good[0]) keep.add(good[0].name);
  const autos = backups.filter((b) => b.kind === 'auto');
  autos.slice(0, 7).forEach((b) => keep.add(b.name));
  const weeks = new Set();
  for (const b of autos) {
    const age = (now - new Date(b.createdAt)) / 86400000;
    if (age > 35) continue;
    const week = Math.floor(age / 7);
    if (week >= 1 && !weeks.has(week)) { weeks.add(week); keep.add(b.name); }
  }
  for (const kind of ['manual', 'pre-migration']) backups.filter((b) => b.kind === kind).slice(0, 10).forEach((b) => keep.add(b.name));
  return backups.filter((b) => !keep.has(b.name)).map((b) => b.name);
}

export function rotate() {
  const dir = backupDir();
  for (const name of rotationPlan(listBackups())) {
    fs.rmSync(path.join(dir, name), { force: true });
    fs.rmSync(path.join(dir, `${name}.json`), { force: true });
  }
}

// A backup taken by code before it rewrites data (a migration). Failing to
// back up stops the caller only when `required`.
export function backupBeforeMigration(note, { required = false } = {}) {
  try {
    return createBackup({ kind: 'pre-migration', note });
  } catch (err) {
    console.error(`[backup] before "${note}": ${err.message}`);
    if (required) throw err;
    return null;
  }
}

// The daily backup: at start-up when the newest auto backup is older than a
// day, then checked hourly.
function autoBackupIfDue() {
  if (process.env.BACKUP_AUTO === '0') { status.skipped = 'BACKUP_AUTO=0'; return; }
  const newest = listBackups().find((b) => b.kind === 'auto');
  if (newest && Date.now() - new Date(newest.createdAt) < 23.5 * 3600 * 1000) return;
  try {
    createBackup({ kind: 'auto' });
    status.lastAutoAt = new Date().toISOString();
    status.lastError = '';
  } catch (err) {
    status.lastError = err.message;
    status.lastErrorAt = new Date().toISOString();
    console.error('[backup] daily backup failed:', err.message);
  }
}

let timer = null;
export function startBackupSchedule() {
  if (timer) return;
  autoBackupIfDue();
  timer = setInterval(autoBackupIfDue, 3600 * 1000);
  timer.unref();
}

// Size and row count of each table (sizes from the dbstat table when this
// SQLite build has it).
export function tableStats() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
  let sizes = {};
  try {
    sizes = Object.fromEntries(db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all().map((r) => [r.name, r.bytes]));
  } catch { /* dbstat not compiled in */ }
  return tables.map((name) => ({ name, rows: db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c, bytes: sizes[name] ?? null }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);
}

// Full integrity check of the live database: SQLite's integrity_check and
// foreign keys that point nowhere.
export function integrityReport() {
  const started = Date.now();
  const integrity = db.pragma('integrity_check').map((r) => r.integrity_check);
  const foreignKeys = db.pragma('foreign_key_check').slice(0, 50);
  return { ok: integrity.length === 1 && integrity[0] === 'ok' && !foreignKeys.length, integrity: integrity.slice(0, 50), foreignKeys, ms: Date.now() - started };
}
