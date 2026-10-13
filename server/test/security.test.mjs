// Security fixes from the 2026-10-11 review, each checked against the attack
// it closes: a saved API key sent to a new address, credentials stored in
// clear, read-aloud abuse, missing headers, open redirects, temporary
// passwords kept, error pages leaking internals, rate limits. Runs on a
// throwaway copy of the database whose real keys are wiped first:
//   npm run test:security
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-security-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0', COVER_DIR: path.join(tmp, 'covers') });
delete process.env.SETTINGS_SECRET;

const { db } = await import('../db.js');
const settings = await import('../settingsStore.js');
const secrets = await import('../secrets.js');
const oidc = await import('../auth/oidc.js');
const { safeReturnTo } = await import('../security.js');
const { createSession, createUser, purgeExpiredSessions } = await import('../auth/store.js');
const { hashPassword } = await import('../auth/passwords.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// A local fake "AI provider" that records the Authorization header it gets.
const seen = [];
const trap = http.createServer((req, res) => { seen.push(req.headers.authorization || ''); res.writeHead(500); res.end('{}'); });
await new Promise((r) => trap.listen(0, r));
const trapUrl = `http://127.0.0.1:${trap.address().port}/v1`;

// Wipe every real key in this copy, then plant a fake one at the trap.
const cfg = settings.getSettings();
for (const k of ['anthropic', 'gemini', 'openai', 'nvidia', 'riva']) cfg[k] = { ...cfg[k], apiKey: '' };
settings.saveSettings({ ...cfg, openai: { ...cfg.openai, apiKey: 'sk-FAKE-PLANTED-0001', baseUrl: trapUrl } });

await test('API keys are encrypted at rest and read back intact', () => {
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'llm_config'").get().value;
  assert.ok(!raw.includes('sk-FAKE-PLANTED-0001'), 'no clear-text key in the database');
  assert.match(JSON.parse(raw).openai.apiKey, /^enc:v1:/);
  assert.equal(settings.getSettings().openai.apiKey, 'sk-FAKE-PLANTED-0001');
  assert.ok(fs.existsSync(path.join(tmp, 'secret.key')), 'key file next to the copy');
  assert.equal(fs.statSync(path.join(tmp, 'secret.key')).mode & 0o077, 0, 'owner-only permissions');
  // a value encrypted under another key reads as empty instead of failing
  const foreign = `enc:v1:${Buffer.alloc(12).toString('base64')}:${Buffer.alloc(16).toString('base64')}:${Buffer.from('x').toString('base64')}`;
  assert.equal(secrets.decryptSecret(foreign), '');
  assert.equal(secrets.decryptSecret('plain-old'), 'plain-old');
});

await test('the SSO client secret is encrypted and dropped when the issuer changes', () => {
  oidc.saveSsoConfig({ issuer: 'https://idp.example/realms/a', clientSecret: 'CLIENT-SECRET-XYZ' });
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'sso_config'").get()?.value || '';
  assert.ok(raw && !raw.includes('CLIENT-SECRET-XYZ'));
  assert.equal(oidc.getSsoConfig().clientSecret, 'CLIENT-SECRET-XYZ');
  oidc.saveSsoConfig({ issuer: 'https://idp.example/realms/a', clientSecret: '•••••XYZ' });
  assert.equal(oidc.getSsoConfig().clientSecret, 'CLIENT-SECRET-XYZ', 'kept for the same issuer');
  oidc.saveSsoConfig({ issuer: 'https://attacker.example', clientSecret: '•••••XYZ' });
  assert.equal(oidc.getSsoConfig().clientSecret, '', 'not carried to another issuer');
});

await test('redirects after sign-in stay on this site', () => {
  for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'javascript:alert(1)', '/%0d%0aSet-Cookie:x', '\t/x', '']) {
    assert.equal(safeReturnTo(bad), bad === '/%0d%0aSet-Cookie:x' ? '/%0d%0aSet-Cookie:x' : '/', bad);
  }
  assert.equal(safeReturnTo('/chapters/8?x=1#paragraph-3'), '/chapters/8?x=1#paragraph-3');
});

await test('expired sessions are purged', () => {
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('expired-test', ?, '2000-01-01T00:00:00.000Z')").run(uid);
  assert.ok(purgeExpiredSessions() >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = 'expired-test'").get().c, 0);
});

const admin = db.prepare("SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin' LIMIT 1").get();
const temp = createUser({ email: `temp-${Date.now()}@t.local`, roles: ['learner'], passwordHash: hashPassword('Temp-password-1'), mustChangePassword: true });
const guest = createUser({ email: `guest-${Date.now()}@t.local`, roles: ['guest'] });
const tokens = { admin: createSession(admin.id).token, temp: createSession(temp.id).token, guest: createSession(guest.id).token };

const port = 39000 + Math.floor(Math.random() * 900);
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), RATE_TTS: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 250));
}
const call = async (method, p, { as = 'admin', body, raw } = {}) => {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-books-translate': '1', ...(as ? { Cookie: `bt_session=${tokens[as]}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
};

try {
  await test('a saved key is never sent to a different address', async () => {
    seen.length = 0;
    const moved = await call('POST', '/api/settings/test', { body: { provider: 'openai', config: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '••••0001', model: 'x' } } });
    assert.equal(moved.status, 400);
    assert.match(moved.json.error, /nhập lại API key/);
    const models = await call('POST', '/api/settings/models', { body: { provider: 'openai', config: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '••••0001' } } });
    assert.equal(models.status, 400);
    // to the saved address the saved key is still used
    await call('POST', '/api/settings/test', { body: { provider: 'openai', config: { baseUrl: trapUrl, apiKey: '••••0001', model: 'x' } } });
    assert.deepEqual(seen, ['Bearer sk-FAKE-PLANTED-0001']);
  });

  await test('saving a new address with the masked key clears the key', async () => {
    const r = await call('PUT', '/api/settings', { body: { openai: { baseUrl: 'http://127.0.0.1:2/v1', apiKey: '••••0001' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.openai.hasApiKey, false);
    assert.ok(!r.text.includes('sk-FAKE'));
    // same address + masked key keeps it
    await call('PUT', '/api/settings', { body: { openai: { baseUrl: trapUrl, apiKey: 'sk-FAKE-PLANTED-0002' } } });
    const kept = await call('PUT', '/api/settings', { body: { openai: { baseUrl: trapUrl, apiKey: '••••0002', model: 'y' } } });
    assert.equal(kept.json.openai.hasApiKey, true);
  });

  await test('security headers on pages and API', async () => {
    for (const p of ['/', '/api/health']) {
      const r = await fetch(`http://localhost:${port}${p}`);
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors 'none'/, p);
      assert.match(csp, /object-src 'none'/);
      assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-powered-by'), null);
    }
    if (fs.existsSync(path.join(root, 'dist/index.html'))) {
      const csp = (await fetch(`http://localhost:${port}/`)).headers.get('content-security-policy');
      assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, 'the inline theme script is allowed by hash');
    }
  });

  await test('read-aloud: type, length and rate are limited', async () => {
    assert.equal((await call('POST', '/api/tts/speak', { as: 'guest', body: { text: 123 } })).status, 400);
    assert.equal((await call('POST', '/api/tts/speak', { as: 'guest', body: { text: 'a'.repeat(4001) } })).status, 413);
    assert.equal((await call('POST', '/api/tts/speak', { as: 'guest', body: { text: '' } })).status, 400);
    const fourth = await call('POST', '/api/tts/speak', { as: 'guest', body: { text: '' } });
    assert.equal(fourth.status, 429, 'RATE_TTS=3: the 4th call in a minute is refused');
    assert.ok(Number(fourth.headers.get('retry-after')) > 0);
    assert.equal(fourth.json.code, 'rate_limited');
  });

  await test('a temporary password must be changed before using the API', async () => {
    assert.equal((await call('GET', '/api/vocabulary?pageSize=1', { as: 'temp' })).status, 403);
    assert.equal((await call('GET', '/api/books', { as: 'temp' })).json.code, 'must_change_password');
    assert.equal((await call('GET', '/api/me/preferences', { as: 'temp' })).status, 200);
    assert.equal((await call('POST', '/api/auth/password', { as: 'temp', body: { currentPassword: 'Temp-password-1', newPassword: 'New-password-123' } })).status, 200);
    assert.equal((await call('GET', '/api/vocabulary?pageSize=1', { as: 'temp' })).status, 200);
  });

  await test('errors answer JSON without internals', async () => {
    const bad = await call('POST', '/api/vocabulary', { raw: '{"term": ' });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('content-type')?.split(';')[0], 'application/json');
    assert.ok(!/at |node_modules|\/Users\//.test(bad.text), bad.text);
    const missing = await call('GET', '/api/nothing-here');
    assert.ok([403, 404].includes(missing.status));
    assert.ok(missing.json, 'JSON, not the app page');
  });
} catch (err) {
  console.error(out);
  throw err;
} finally {
  await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  trap.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`security: ${passed} checks passed`);
