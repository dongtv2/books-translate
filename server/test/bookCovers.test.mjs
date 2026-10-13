// Cover images: only real images are stored, size caps hold, files are
// named by the server and cleaned up on replace/delete, caching headers are
// right, and covers follow book permissions and scopes. Throwaway copy of
// the database and a temp cover folder:
//   npm run test:covers
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-covers-'));
const dbPath = path.join(tmp, 'books.db');
const coverDir = path.join(tmp, 'covers');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0', COVER_DIR: coverDir });

const { db } = await import('../db.js');
const { createSession, createUser } = await import('../auth/store.js');
const { sniffImage } = await import('../bookCovers.js');

let passed = 0;
let restoreCase = null;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// A real PNG of w×h in one color, built by hand (no image library needed).
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await test('only real WebP, JPEG and PNG bytes count as images', () => {
  assert.equal(sniffImage(png(2, 3, [1, 2, 3])), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.equal(sniffImage(Buffer.from('hi')), null);
});

const book = db.prepare('SELECT id FROM books ORDER BY id LIMIT 1').get().id;
const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const tokens = {
  admin: createSession(admin.id).token,
  learner: createSession(createUser({ email: `l-${Date.now()}@t.local`, roles: ['learner'] }).id).token,
  guest: createSession(createUser({ email: `g-${Date.now()}@t.local`, roles: ['guest'] }).id).token,
};
const restricted = db.prepare("INSERT INTO books (title_en, visibility) VALUES ('Hidden', 'restricted')").run().lastInsertRowid;

const port = 39000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const base = `http://localhost:${port}/api`;
const headers = (as) => ({ 'x-books-translate': '1', Cookie: `bt_session=${tokens[as]}` });
function upload(id, files, { as = 'admin', fields = { color: '#336699', width: '600', height: '900' } } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [k, buf] of Object.entries(files)) form.append(k, new Blob([buf]), `${k}.png`);
  return fetch(`${base}/books/${id}/cover`, { method: 'PUT', headers: headers(as), body: form });
}
const filesOnDisk = () => (fs.existsSync(coverDir) ? fs.readdirSync(coverDir).sort() : []);

try {
  let first;
  await test('an editor uploads a cover; it is served with long-lived caching', async () => {
    const lg = png(60, 90, [40, 80, 120]);
    const sm = png(20, 30, [40, 80, 120]);
    const r = await upload(book, { lg, sm });
    assert.equal(r.status, 200, await r.clone().text());
    first = await r.json();
    assert.match(first.cover_lg, new RegExp(`^book-${book}-[0-9a-f]{12}-lg\\.png$`));
    assert.equal(first.cover_color, '#336699');
    assert.equal(first.cover_w, 600);
    const got = await fetch(`${base}/books/${book}/cover/lg?v=${first.cover_lg}`, { headers: headers('guest') });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(lg));
    const listed = await (await fetch(`${base}/books`, { headers: headers('guest') })).json();
    assert.equal(listed.find((b) => b.id === book).cover_sm, first.cover_sm);
  });

  await test('replacing a cover deletes the old files', async () => {
    const r = await upload(book, { lg: png(60, 90, [200, 10, 10]), sm: png(20, 30, [200, 10, 10]) });
    const next = await r.json();
    assert.notEqual(next.cover_lg, first.cover_lg);
    assert.deepEqual(filesOnDisk(), [next.cover_lg, next.cover_sm].sort());
  });

  await test('fake images, missing files, oversize files and bad colors are refused', async () => {
    const before = filesOnDisk();
    assert.equal((await upload(book, { lg: Buffer.from('<svg onload=alert(1)>'), sm: png(2, 3, [0, 0, 0]) })).status, 415);
    assert.equal((await upload(book, { lg: png(6, 9, [0, 0, 0]) })).status, 400);
    assert.equal((await upload(book, { lg: Buffer.concat([png(6, 9, [0, 0, 0]), Buffer.alloc(2 * 1024 * 1024)]), sm: png(2, 3, [0, 0, 0]) })).status, 413);
    const bigSm = Buffer.concat([png(2, 3, [0, 0, 0]), Buffer.alloc(500 * 1024)]);
    assert.equal((await upload(book, { lg: png(6, 9, [0, 0, 0]), sm: bigSm })).status, 413);
    assert.deepEqual(filesOnDisk(), before, 'nothing written by refused uploads');
    const odd = await (await upload(book, { lg: png(6, 9, [1, 1, 1]), sm: png(2, 3, [1, 1, 1]) }, { fields: { color: 'red;background:url(x)', width: '-5', height: 'x' } })).json();
    assert.equal(odd.cover_color, '');
    assert.equal(odd.cover_w, null);
  });

  await test('only editors change covers; covers follow book scopes', async () => {
    assert.equal((await upload(book, { lg: png(6, 9, [0, 0, 0]), sm: png(2, 3, [0, 0, 0]) }, { as: 'learner' })).status, 403);
    assert.equal((await fetch(`${base}/books/${book}/cover`, { method: 'DELETE', headers: headers('learner') })).status, 403);
    assert.equal((await upload(restricted, { lg: png(6, 9, [0, 0, 0]), sm: png(2, 3, [0, 0, 0]) })).status, 200, 'admin sees it');
    assert.equal((await fetch(`${base}/books/${restricted}/cover/lg`, { headers: headers('learner') })).status, 404, 'others do not');
    assert.equal((await fetch(`${base}/books/${book}/cover/other`, { headers: headers('guest') })).status, 403);
  });

  await test('removing the cover, or the book, removes its files', async () => {
    assert.equal((await fetch(`${base}/books/${book}/cover`, { method: 'DELETE', headers: headers('admin') })).status, 200);
    assert.equal((await fetch(`${base}/books/${book}/cover/lg`, { headers: headers('guest') })).status, 404);
    assert.ok(!filesOnDisk().some((f) => f.startsWith(`book-${book}-`)));
    assert.ok(filesOnDisk().some((f) => f.startsWith(`book-${restricted}-`)));
    assert.equal((await fetch(`${base}/books/${restricted}`, { method: 'DELETE', headers: headers('admin') })).status, 200);
    assert.deepEqual(filesOnDisk(), []);
  });

  await test('backups mirror cover files; restore brings lost ones back', async () => {
  const r = await (await upload(book, { lg: png(6, 9, [9, 9, 9]), sm: png(2, 3, [9, 9, 9]) })).json();
  const backup = await (await fetch(`${base}/admin/database/backups`, { method: 'POST', headers: { ...headers('admin'), 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.ok(backup.coversCopied >= 2, JSON.stringify(backup));
  const mirror = path.join(tmp, 'backups', 'covers');
  assert.ok(fs.existsSync(path.join(mirror, r.cover_lg)) && fs.existsSync(path.join(mirror, r.cover_sm)));
  restoreCase = { backup: backup.name, files: [r.cover_lg, r.cover_sm] };
});

await test('a cover file lost from disk answers 404 (the page falls back)', async () => {
    const r = await (await upload(book, { lg: png(6, 9, [5, 5, 5]), sm: png(2, 3, [5, 5, 5]) })).json();
    fs.rmSync(path.join(coverDir, r.cover_lg));
    assert.equal((await fetch(`${base}/books/${book}/cover/lg`, { headers: headers('guest') })).status, 404);
    assert.equal((await fetch(`${base}/books/${book}/cover/sm`, { headers: headers('guest') })).status, 200);
  });
} catch (err) {
  console.error(out);
  throw err;
} finally {
  await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
}

await test('restore (server stopped) puts back cover files missing from disk', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const f of restoreCase.files) fs.rmSync(path.join(coverDir, f), { force: true });
  const r = spawnSync(process.execPath, ['server/scripts/restoreBackup.mjs', restoreCase.backup, '--yes'], { cwd: root, env: { ...process.env, PORT: String(port) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Trả lại 2 file ảnh bìa/);
  for (const f of restoreCase.files) assert.ok(fs.existsSync(path.join(coverDir, f)));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`book covers: ${passed} checks passed`);
