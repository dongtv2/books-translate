// Restores the database from a backup. Run with the server STOPPED:
//   npm run db:restore -- books-20261011-070000-000-auto.db
//   npm run db:restore -- /path/to/file.db [--yes]
// Steps: refuse if the server answers; check the backup (quick_check, the
// sha256 in its .json); back up the current database first (kind
// pre-migration, so rotation keeps it); then swap the files. Nothing is
// changed until every check has passed.
// Deliberately independent of the app's modules: opening the app's db.js
// would run its schema code on the database being replaced.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.BOOKS_DB_PATH || path.join(root, 'data', 'books.db');
const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const target = args.find((a) => !a.startsWith('--'));
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!target) {
  console.log(`Cách dùng: npm run db:restore -- <tên hoặc đường dẫn bản sao lưu> [--yes]\nCác bản trong ${backupDir}:`);
  if (fs.existsSync(backupDir)) fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().reverse().forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
const source = fs.existsSync(target) ? path.resolve(target) : path.join(backupDir, path.basename(target));
if (!fs.existsSync(source)) fail(`Không tìm thấy ${target}`);
if (path.resolve(source) === path.resolve(dbPath)) fail('Đó chính là database đang dùng.');

// 1. The server must be stopped: it holds the database open.
const port = process.env.PORT || 3001;
try {
  const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) fail(`Server đang chạy ở cổng ${port}. Dừng server (Ctrl+C) rồi chạy lại lệnh này.`);
} catch { /* not running: good */ }

// 2. The backup must be sound.
function inspect(file) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = d.pragma('quick_check', { simple: true });
    const count = (t) => { try { return d.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c; } catch { return '—'; } };
    return { check, counts: { books: count('books'), paragraphs: count('paragraphs'), vocabulary: count('vocabulary'), users: count('users') } };
  } finally {
    d.close();
  }
}
const incoming = inspect(source);
if (incoming.check !== 'ok') fail(`Bản sao lưu bị hỏng: ${incoming.check}`);
const metaFile = `${source}.json`;
if (fs.existsSync(metaFile)) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (meta.sha256 && meta.sha256 !== hash) fail('Mã sha256 của bản sao lưu không khớp với lúc tạo — file đã bị thay đổi.');
}
const current = fs.existsSync(dbPath) ? inspect(dbPath) : { counts: {} };

console.log(`Database đang dùng: ${dbPath}`);
console.log(`  hiện tại:  ${JSON.stringify(current.counts)}`);
console.log(`  khôi phục: ${JSON.stringify(incoming.counts)}  ← ${path.basename(source)}`);
if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Mọi thay đổi sau thời điểm của bản sao lưu sẽ mất (database hiện tại vẫn được sao lưu lại trước). Gõ KHOI PHUC để tiếp tục: ');
  rl.close();
  if (answer.trim() !== 'KHOI PHUC') fail('Đã huỷ, không thay đổi gì.');
}

// 3. Keep the current database, then swap.
if (fs.existsSync(dbPath)) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*/, '');
  const safety = path.join(backupDir, `books-${stamp}-000-pre-migration.db`);
  const live = new Database(dbPath);
  live.prepare('VACUUM INTO ?').run(safety);
  live.close();
  fs.writeFileSync(`${safety}.json`, JSON.stringify({ kind: 'pre-migration', note: `trước khi khôi phục ${path.basename(source)}`, createdAt: new Date().toISOString(), integrity: inspect(safety).check }, null, 2));
  console.log(`✓ Đã sao lưu database hiện tại: ${path.basename(safety)}`);
}
const tmp = `${dbPath}.restoring`;
fs.copyFileSync(source, tmp);
for (const ext of ['-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
fs.renameSync(tmp, dbPath);
const after = inspect(dbPath);
if (after.check !== 'ok') fail(`Sau khi khôi phục, kiểm tra báo lỗi: ${after.check}. Bản trước đó vẫn ở ${backupDir}.`);
console.log(`✓ Đã khôi phục từ ${path.basename(source)}: ${JSON.stringify(after.counts)}`);
// Cover images the restored database names but the covers folder lacks
// come back from the backups' mirror (backup.js mirrorCovers).
const coverDir = process.env.COVER_DIR || path.join(path.dirname(dbPath), 'covers');
const mirror = path.join(backupDir, 'covers');
if (fs.existsSync(mirror)) {
  const restored = new Database(dbPath, { readonly: true });
  let names = [];
  try { names = restored.prepare("SELECT cover_lg AS a, cover_sm AS b FROM books").all().flatMap((r) => [r.a, r.b]).filter(Boolean); } catch { /* no cover columns yet */ }
  restored.close();
  let back = 0;
  fs.mkdirSync(coverDir, { recursive: true });
  for (const name of names) {
    if (/^[\w.-]+$/.test(name) && !fs.existsSync(path.join(coverDir, name)) && fs.existsSync(path.join(mirror, name))) {
      fs.copyFileSync(path.join(mirror, name), path.join(coverDir, name));
      back += 1;
    }
  }
  if (back) console.log(`✓ Trả lại ${back} file ảnh bìa từ bản sao lưu.`);
}
console.log('Khởi động lại server: npm run dev (hoặc npm start).');
