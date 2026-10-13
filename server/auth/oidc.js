// OpenID Connect sign-in against an SSO provider (e.g. Keycloak), using the
// authorization-code flow with PKCE. Off until an administrator fills in and
// enables the configuration in Settings. No provider address is shipped:
// SSO_ISSUER / SSO_PUBLIC_URL in .env only prefill the form.
import crypto from 'node:crypto';
import { safeReturnTo } from '../security.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { db } from '../db.js';

const CONFIG_KEY = 'sso_config';

export const DEFAULT_SSO_CONFIG = {
  enabled: false,
  issuer: process.env.SSO_ISSUER || '',
  clientId: process.env.SSO_CLIENT_ID || '',
  clientSecret: '',
  scopes: 'openid profile email',
  publicUrl: process.env.SSO_PUBLIC_URL || '',
  buttonLabel: 'SSO',
  allowPasswordLogin: true,
  autoProvision: true,
  defaultRole: 'guest',
  // SSO role (realm or client role, or group name) → app role. When any of
  // these is present at sign-in, the user's roles are set from SSO.
  roleMapping: { admin: 'books-admin', editor: 'books-editor', learner: 'books-learner', guest: 'books-guest' },
};

export function getSsoConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CONFIG_KEY);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* default */ }
  if (saved.clientSecret) saved.clientSecret = decryptSecret(saved.clientSecret);
  return { ...DEFAULT_SSO_CONFIG, ...saved, roleMapping: { ...DEFAULT_SSO_CONFIG.roleMapping, ...(saved.roleMapping || {}) } };
}

export function saveSsoConfig(patch) {
  const current = getSsoConfig();
  const next = { ...current, ...patch, roleMapping: { ...current.roleMapping, ...(patch.roleMapping || {}) } };
  if (patch.clientSecret === undefined || patch.clientSecret?.startsWith('•')) next.clientSecret = current.clientSecret;
  next.issuer = (next.issuer || '').trim().replace(/\/$/, '');
  // The kept secret is only ever sent to the issuer it was entered for.
  if (next.issuer !== current.issuer && (patch.clientSecret === undefined || patch.clientSecret?.startsWith('•'))) next.clientSecret = '';
  next.publicUrl = (next.publicUrl || '').trim().replace(/\/$/, '');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CONFIG_KEY, JSON.stringify({ ...next, clientSecret: encryptSecret(next.clientSecret) }));
  discoveryCache = null;
  return next;
}

export function maskedSsoConfig(config = getSsoConfig()) {
  const s = config.clientSecret || '';
  return { ...config, clientSecret: s ? `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : '', hasClientSecret: Boolean(s) };
}

export function isSsoReady(config = getSsoConfig()) {
  return Boolean(config.enabled && config.issuer && config.clientId && config.publicUrl);
}

export function redirectUri(config = getSsoConfig()) {
  return `${config.publicUrl}/api/auth/sso/callback`;
}

// ---- discovery and keys ------------------------------------------------------

let discoveryCache = null;

export async function discover(issuer) {
  if (discoveryCache && discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < 600000) return discoveryCache.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Không đọc được cấu hình OIDC từ ${issuer} (HTTP ${res.status}).`);
  const doc = await res.json();
  if (doc.issuer !== issuer) throw new Error(`Issuer không khớp: máy chủ trả về "${doc.issuer}".`);
  discoveryCache = { issuer, doc, at: Date.now(), jwks: null };
  return doc;
}

async function signingKey(doc, kid, refresh = false) {
  if (!discoveryCache.jwks || refresh) {
    const res = await fetch(doc.jwks_uri);
    if (!res.ok) throw new Error('Không tải được khoá ký (JWKS) của SSO.');
    discoveryCache.jwks = (await res.json()).keys || [];
  }
  const jwk = discoveryCache.jwks.find((k) => k.kid === kid && (k.use === 'sig' || !k.use));
  if (!jwk && !refresh) return signingKey(doc, kid, true); // key rotated
  if (!jwk) throw new Error('Không tìm thấy khoá ký phù hợp cho token SSO.');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

const ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', PS256: 'sha256', ES256: 'sha256', ES384: 'sha384' };

async function verifyJwt(token, doc) {
  const [h, p, sig] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`Thuật toán ký không được hỗ trợ: ${header.alg}`);
  const key = await signingKey(doc, header.kid);
  const opts = { key };
  if (header.alg.startsWith('PS')) { opts.padding = crypto.constants.RSA_PKCS1_PSS_PADDING; opts.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST; }
  if (header.alg.startsWith('ES')) opts.dsaEncoding = 'ieee-p1363';
  const ok = crypto.verify(alg, Buffer.from(`${h}.${p}`), opts, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Chữ ký token SSO không hợp lệ.');
  return payload;
}

// ---- the flow ------------------------------------------------------------------

// state → { nonce, verifier, returnTo, at } — short-lived, single process.
const pending = new Map();

export async function beginLogin(returnTo = '/') {
  const config = getSsoConfig();
  if (!isSsoReady(config)) throw new Error('SSO chưa được bật.');
  const doc = await discover(config.issuer);
  for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k);

  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pending.set(state, { nonce, verifier, returnTo: safeReturnTo(returnTo), at: Date.now() });

  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    scope: config.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

// Returns { claims, roles, idToken, returnTo } for a valid callback.
export async function completeLogin({ code, state }) {
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow || Date.now() - flow.at > 600000) throw new Error('Phiên đăng nhập SSO đã hết hạn, hãy thử lại.');
  const config = getSsoConfig();
  const doc = await discover(config.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(config),
    client_id: config.clientId,
    code_verifier: flow.verifier,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SSO từ chối đổi mã đăng nhập: ${tokens.error_description || tokens.error || res.status}`);

  const claims = await verifyJwt(tokens.id_token, doc);
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new Error('Token SSO có issuer không khớp.');
  if (!aud.includes(config.clientId)) throw new Error('Token SSO không dành cho ứng dụng này.');
  if (claims.exp < now - 60) throw new Error('Token SSO đã hết hạn.');
  if (claims.nonce !== flow.nonce) throw new Error('Token SSO không khớp phiên đăng nhập.');

  // Keycloak puts roles in the access token (realm_access / resource_access)
  // unless mappers add them to the ID token; read both.
  let access = {};
  if (tokens.access_token?.split('.').length === 3) {
    try { access = await verifyJwt(tokens.access_token, doc); } catch { access = {}; }
  }
  const roles = new Set();
  for (const src of [claims, access]) {
    for (const r of src.realm_access?.roles || []) roles.add(r);
    for (const r of src.resource_access?.[config.clientId]?.roles || []) roles.add(r);
    for (const g of src.groups || []) roles.add(String(g).replace(/^\//, ''));
  }
  return { claims, roles: [...roles], idToken: tokens.id_token, returnTo: flow.returnTo };
}

export async function logoutUrl(idToken) {
  const config = getSsoConfig();
  if (!isSsoReady(config)) return null;
  const doc = await discover(config.issuer).catch(() => null);
  if (!doc?.end_session_endpoint) return null;
  const url = new URL(doc.end_session_endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: `${config.publicUrl}/`,
    ...(idToken ? { id_token_hint: idToken } : {}),
  }).toString();
  return url.toString();
}

// App roles granted by the SSO roles/groups in the token, per roleMapping.
export function mapSsoRoles(ssoRoles, config = getSsoConfig()) {
  const have = new Set(ssoRoles.map((r) => r.toLowerCase()));
  return Object.entries(config.roleMapping)
    .filter(([, ssoRole]) => ssoRole && have.has(ssoRole.toLowerCase()))
    .map(([appRole]) => appRole);
}
