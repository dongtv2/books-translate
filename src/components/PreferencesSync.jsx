import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useLayoutSettings } from '../context/LayoutSettingsContext.jsx';

// Keeps display preferences (theme, font size, width, voice…) with the
// account: on sign-in the saved ones are applied — or, the first time, this
// browser's current ones are saved — and every later change is saved after a
// short pause. The browser copy stays as a cache for the next page load.
export default function PreferencesSync() {
  const { user } = useAuth();
  const { settings, replaceSettings } = useLayoutSettings();
  const ready = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    ready.current = false;
    if (!user) return undefined;
    let cancelled = false;
    api.myPreferences().then(({ preferences }) => {
      if (cancelled) return;
      if (preferences) replaceSettings(preferences);
      else api.savePreferences(settings).catch(() => {});
      ready.current = true;
    }).catch(() => { ready.current = true; });
    return () => { cancelled = true; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user || !ready.current) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.savePreferences(settings).catch(() => {}), 800);
    return () => clearTimeout(timer.current);
  }, [settings, user]);

  return null;
}
