import { createContext, useContext, useEffect, useState } from 'react';
import { UI_SCALE_OPTIONS } from '../lib/uiScale.js';

const STORAGE_KEY = 'bt_layout_settings';

const DEFAULT_SETTINGS = {
  contentWidth: 'wide', // 'normal' | 'wide' | 'full'
  fontSize: 'base', // 'sm' | 'base' | 'lg'
  uiScale: 'md', // 'md' | 'lg' | 'xl' — the whole interface (index.css --ui-scale)
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  chapterViewMode: 'read', // 'read' | 'edit'
  theme: 'system', // 'system' | 'light' | 'dark'
  readingFont: 'serif', // 'serif' | 'sans'
  showNotes: true, // notes column next to the two text columns
  showVocabHints: true, // mark words already in the vocabulary in the English column
  showThreadMarks: true, // mark words and sentences under discussion (TermDiscussion)
};

export const CONTENT_WIDTH_OPTIONS = [
  { key: 'normal', label: 'Vừa', hint: 'Gọn, dễ đọc trên màn hình nhỏ', className: 'max-w-5xl' },
  { key: 'wide', label: 'Rộng', hint: 'Mặc định, đủ chỗ cho cả cột ghi chú', className: 'max-w-[96rem]' },
  { key: 'full', label: 'Toàn màn hình', hint: 'Dùng hết chiều ngang màn hình', className: 'max-w-none' },
];

export const FONT_SIZE_OPTIONS = [
  { key: 'sm', label: 'Nhỏ' },
  { key: 'base', label: 'Vừa' },
  { key: 'lg', label: 'Lớn' },
];


export const THEME_OPTIONS = [
  { key: 'system', label: 'Theo máy' },
  { key: 'light', label: 'Sáng' },
  { key: 'dark', label: 'Tối' },
];

export const READING_FONT_OPTIONS = [
  { key: 'serif', label: 'Literata · có chân' },
  { key: 'sans', label: 'Be Vietnam Pro · không chân' },
];

const FONT_SIZE_CLASSES = {
  paragraph: { sm: 'text-[1rem]', base: 'text-[1.125rem]', lg: 'text-[1.25rem]' },
  remarksHeading: { sm: 'text-[0.75rem]', base: 'text-[0.8125rem]', lg: 'text-[0.875rem]' },
  remarksBody: { sm: 'text-[0.8125rem]', base: 'text-[0.875rem]', lg: 'text-[0.9375rem]' },
  citation: { sm: 'text-[0.875rem]', base: 'text-[1rem]', lg: 'text-[1.125rem]' },
};

const LayoutSettingsContext = createContext(null);

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function LayoutSettingsProvider({ children }) {
  const [settings, setSettings] = useState(loadInitial);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  // The dark theme is a variable override keyed on <html data-theme>, so the
  // "follow the system" choice has to be resolved here and kept in sync when
  // the OS switches appearance.
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(settings.theme); };
    apply();
    if (settings.theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  useEffect(() => {
    const scale = UI_SCALE_OPTIONS.find((o) => o.key === settings.uiScale)?.scale ?? 1;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
  }, [settings.uiScale]);

  function updateSettings(patch) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  // Replaces everything with the signed-in user's saved preferences (see
  // PreferencesSync); unknown or missing keys fall back to the defaults.
  function replaceSettings(saved) {
    setSettings({ ...DEFAULT_SETTINGS, ...saved });
  }

  return (
    <LayoutSettingsContext.Provider value={{ settings, updateSettings, replaceSettings }}>
      {children}
    </LayoutSettingsContext.Provider>
  );
}

export function useLayoutSettings() {
  const ctx = useContext(LayoutSettingsContext);
  if (!ctx) throw new Error('useLayoutSettings phải được gọi bên trong LayoutSettingsProvider.');
  return ctx;
}

export function contentWidthClass(key) {
  return CONTENT_WIDTH_OPTIONS.find((o) => o.key === key)?.className || CONTENT_WIDTH_OPTIONS[1].className;
}

export function fontSizeClass(group, key) {
  return FONT_SIZE_CLASSES[group]?.[key] || FONT_SIZE_CLASSES[group].base;
}
