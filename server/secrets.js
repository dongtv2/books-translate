// Encryption at rest for stored credentials (AI provider API keys, the SSO
// client secret): AES-256-GCM, stored as "enc:v1:<iv>:<tag>:<data>".
//
// The key comes from SETTINGS_SECRET (any long random string) or, when that
// is unset, from secret.key next to the database, created on first use with
// owner-only permissions. It is never stored in the database, so a database
// file or backup on its own does not reveal the credentials. Losing the key
// only means re-entering them in Settings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirectory } from './db.js';

const PREFIX = 'enc:v1:';
let key = null;

function loadKey() {
  if (key) return key;
  if (process.env.SETTINGS_SECRET) {
    key = crypto.createHash('sha256').update(process.env.SETTINGS_SECRET).digest();
    return key;
  }
  const file = path.join(dataDirectory, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} không phải khoá 32 byte hợp lệ.`);
  return key;
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function encryptSecret(plain) {
  if (!plain || isEncrypted(plain)) return plain || '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

// Plain text passes through (values saved before encryption existed); a
// value that cannot be decrypted (another machine's key) reads as empty.
export function decryptSecret(stored) {
  if (!isEncrypted(stored)) return stored || '';
  try {
    const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    console.error('[secrets] a stored credential could not be decrypted (different secret key?) — re-enter it in Settings.');
    return '';
  }
}
