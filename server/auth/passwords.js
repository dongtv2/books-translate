// Password hashing with scrypt (Node's built-in, memory-hard). Stored as
// "scrypt$N$r$p$salt$hash", so the cost can be raised later without breaking
// existing hashes.
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 10;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`;
  }
  return null;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

// Spends the same time as a real check, so "no such user" and "wrong
// password" cannot be told apart by timing.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));
export function burnPasswordCheck(password) {
  verifyPassword(password || '', DUMMY);
}

export function randomPassword() {
  // 16 chars from an unambiguous alphabet.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
