import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import { loadReading, clearReading } from '../lib/lastRead.js';

const AuthContext = createContext(null);

// Who is signed in and what they may do. `can(permission)` drives what the
// interface shows; the server enforces the same permissions on every call
// (server/auth/permissions.js), so hiding a control is a courtesy, not the
// protection.
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, permissions: [], roles: {}, sso: null, setupRequired: false });

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      // The personal workspace loads before the app renders, so pages can
      // read the reading position synchronously.
      if (me.user) await loadReading(); else clearReading();
      setState({
        status: me.setupRequired ? 'setup' : me.user ? 'authed' : 'anon',
        user: me.user,
        permissions: me.permissions,
        roles: me.roles,
        sso: me.sso,
        setupRequired: me.setupRequired,
      });
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: e.message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => setState((s) => (s.status === 'authed' ? { ...s, status: 'anon', user: null, permissions: [] } : s));
    window.addEventListener('bt:unauthorized', onUnauthorized);
    return () => window.removeEventListener('bt:unauthorized', onUnauthorized);
  }, []);

  const can = useCallback((permission) => state.permissions.includes(permission), [state.permissions]);

  async function logout() {
    const res = await api.logout().catch(() => null);
    // An SSO session also ends at the SSO provider, which then sends the
    // browser back here.
    if (res?.redirect) window.location.assign(res.redirect);
    else await refresh();
  }

  return (
    <AuthContext.Provider value={{ ...state, can, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải được gọi bên trong AuthProvider.');
  return ctx;
}

export function roleLabel(roles, key) {
  return roles?.[key]?.label || key;
}
