// /api/admin — user, group, role and SSO management (needs users.manage).
import { Router } from 'express';
import { db } from '../db.js';
import {
  getUser, getUserByEmail, createUser, publicUser, setUserRoles, deleteUserSessions, activeAdminCount, rolesOf,
} from '../auth/store.js';
import { hashPassword, validatePassword, randomPassword } from '../auth/passwords.js';
import { ROLES, ROLE_KEYS, PERMISSIONS } from '../auth/permissions.js';
import { getSsoConfig, saveSsoConfig, maskedSsoConfig, discover, redirectUri } from '../auth/oidc.js';

const router = Router();

function wouldRemoveLastAdmin(userId, nextHasAdmin) {
  const hadAdmin = rolesOf(userId).effective.includes('admin');
  return hadAdmin && !nextHasAdmin && activeAdminCount(userId) === 0;
}

// ---- roles (read-only reference) ------------------------------------------------
router.get('/roles', (_req, res) => {
  res.json({
    roles: ROLE_KEYS.map((k) => ({ key: k, ...ROLES[k] })),
    permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
  });
});

// ---- users -----------------------------------------------------------------------
router.get('/users', (_req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser));
});

// POST { email, name, roles[], groupIds[], password? } — without a password a
// temporary one is generated and returned once; the user must change it.
router.post('/users', (req, res) => {
  const { email = '', name = '', roles = ['learner'], groupIds = [], password } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email không hợp lệ.' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'Email này đã có tài khoản.' });
  const temp = password ? null : randomPassword();
  const pw = password || temp;
  const pwError = validatePassword(pw);
  if (pwError) return res.status(400).json({ error: pwError });
  const user = createUser({ email, name, passwordHash: hashPassword(pw), roles, mustChangePassword: Boolean(temp) });
  const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
  for (const g of groupIds) ins.run(Number(g), user.id);
  res.json({ user: publicUser(getUser(user.id)), temporaryPassword: temp });
});

// PATCH { name?, roles?, groupIds?, status? }
router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = getUser(id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const { name, roles, groupIds, status } = req.body || {};

  if (status && !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
  if (status === 'disabled' && id === req.user.id) return res.status(400).json({ error: 'Không thể tự khoá tài khoản của mình.' });
  if (roles && wouldRemoveLastAdmin(id, roles.includes('admin') || rolesOf(id).viaGroups.some((g) => g.role === 'admin'))) {
    return res.status(400).json({ error: 'Phải còn ít nhất một quản trị đang hoạt động.' });
  }
  if (status === 'disabled' && rolesOf(id).effective.includes('admin') && activeAdminCount(id) === 0) {
    return res.status(400).json({ error: 'Phải còn ít nhất một quản trị đang hoạt động.' });
  }

  db.transaction(() => {
    if (name !== undefined) db.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), id);
    if (status) db.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    if (roles) setUserRoles(id, roles, 'app');
    if (groupIds) {
      db.prepare('DELETE FROM group_members WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
      for (const g of groupIds) ins.run(Number(g), id);
    }
  })();
  if (status === 'disabled') deleteUserSessions(id);
  res.json(publicUser(getUser(id)));
});

// POST /users/:id/reset-password — returns a new temporary password once.
router.post('/users/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  if (!getUser(id)) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  const temp = randomPassword();
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?").run(hashPassword(temp), id);
  deleteUserSessions(id);
  res.json({ temporaryPassword: temp });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Không thể tự xoá tài khoản của mình.' });
  if (!getUser(id)) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
  if (rolesOf(id).effective.includes('admin') && activeAdminCount(id) === 0) return res.status(400).json({ error: 'Phải còn ít nhất một quản trị đang hoạt động.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- groups ----------------------------------------------------------------------
function groupView(g) {
  return {
    ...g,
    roles: db.prepare('SELECT role FROM group_roles WHERE group_id = ?').all(g.id).map((r) => r.role),
    members: db.prepare('SELECT u.id, u.email, u.name FROM users u JOIN group_members gm ON gm.user_id = u.id WHERE gm.group_id = ? ORDER BY u.name').all(g.id),
  };
}

router.get('/groups', (_req, res) => {
  res.json(db.prepare('SELECT * FROM groups ORDER BY name').all().map(groupView));
});

function saveGroupRolesAndMembers(id, { roles, memberIds }) {
  if (roles) {
    db.prepare('DELETE FROM group_roles WHERE group_id = ?').run(id);
    const ins = db.prepare('INSERT INTO group_roles (group_id, role) VALUES (?, ?)');
    for (const r of roles.filter((x) => ROLE_KEYS.includes(x))) ins.run(id, r);
  }
  if (memberIds) {
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    const ins = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
    for (const u of memberIds) ins.run(id, Number(u));
  }
}

router.post('/groups', (req, res) => {
  const { name = '', description = '', roles = [], memberIds = [] } = req.body || {};
  if (!name.trim()) return res.status(400).json({ error: 'Thiếu tên nhóm.' });
  try {
    const id = db.transaction(() => {
      const gid = db.prepare('INSERT INTO groups (name, description) VALUES (?, ?)').run(name.trim(), description.trim()).lastInsertRowid;
      saveGroupRolesAndMembers(gid, { roles, memberIds });
      return gid;
    })();
    res.json(groupView(db.prepare('SELECT * FROM groups WHERE id = ?').get(id)));
  } catch (err) {
    res.status(409).json({ error: /UNIQUE/.test(err.message) ? 'Đã có nhóm trùng tên.' : err.message });
  }
});

router.patch('/groups/:id', (req, res) => {
  const id = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json({ error: 'Không tìm thấy nhóm.' });
  const { name, description, roles, memberIds } = req.body || {};
  // Changing a group can take admin away from people; keep one admin.
  const before = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  try {
    db.transaction(() => {
      if (name !== undefined || description !== undefined) {
        db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run((name ?? before.name).trim(), (description ?? before.description).trim(), id);
      }
      saveGroupRolesAndMembers(id, { roles, memberIds });
      if (activeAdminCount() === 0) throw new Error('Phải còn ít nhất một quản trị đang hoạt động.');
    })();
  } catch (err) {
    return res.status(400).json({ error: /UNIQUE/.test(err.message) ? 'Đã có nhóm trùng tên.' : err.message });
  }
  res.json(groupView(db.prepare('SELECT * FROM groups WHERE id = ?').get(id)));
});

router.delete('/groups/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
      if (activeAdminCount() === 0) throw new Error('Phải còn ít nhất một quản trị đang hoạt động.');
    })();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true });
});

// ---- SSO configuration -----------------------------------------------------------
router.get('/sso', (_req, res) => {
  const config = getSsoConfig();
  res.json({ ...maskedSsoConfig(config), redirectUri: redirectUri(config) });
});

router.put('/sso', (req, res) => {
  const allowed = ['enabled', 'issuer', 'clientId', 'clientSecret', 'scopes', 'publicUrl', 'buttonLabel', 'allowPasswordLogin', 'autoProvision', 'defaultRole', 'roleMapping'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (patch.defaultRole && !ROLE_KEYS.includes(patch.defaultRole)) return res.status(400).json({ error: 'Vai trò mặc định không hợp lệ.' });
  const next = { ...getSsoConfig(), ...patch };
  if (next.enabled && next.allowPasswordLogin === false && !req.user.sso_subject) {
    return res.status(400).json({ error: 'Hãy đăng nhập bằng SSO thành công ít nhất một lần trước khi tắt đăng nhập mật khẩu, để không tự khoá mình.' });
  }
  const saved = saveSsoConfig(patch);
  res.json({ ...maskedSsoConfig(saved), redirectUri: redirectUri(saved) });
});

// POST /sso/test — { issuer } — reads the provider's discovery document.
router.post('/sso/test', async (req, res) => {
  const issuer = String(req.body?.issuer || getSsoConfig().issuer).trim().replace(/\/$/, '');
  try {
    const doc = await discover(issuer);
    res.json({ ok: true, issuer: doc.issuer, authorization: doc.authorization_endpoint, pkce: (doc.code_challenge_methods_supported || []).includes('S256') });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

export default router;
