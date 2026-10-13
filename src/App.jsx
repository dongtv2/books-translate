import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar, { Wordmark } from './components/Sidebar.jsx';
import { IconButton } from './components/ui.jsx';
import HomePage from './pages/HomePage.jsx';
import LibraryPage from './pages/LibraryPage.jsx';
import PreferencesSync from './components/PreferencesSync.jsx';
// Each page beyond home and library is its own chunk, fetched when first
// needed; the reading pages are fetched in the background once the app is
// idle, so opening a book stays instant.
const pages = {
  book: () => import('./pages/BookPage.jsx'),
  chapter: () => import('./pages/ChapterPage.jsx'),
  vocabulary: () => import('./pages/VocabularyPage.jsx'),
  review: () => import('./pages/ReviewPage.jsx'),
  discussions: () => import('./pages/DiscussionsPage.jsx'),
  settings: () => import('./pages/SettingsPage.jsx'),
  import: () => import('./pages/ImportPage.jsx'),
};
const BookPage = lazy(pages.book);
const ChapterPage = lazy(pages.chapter);
const VocabularyPage = lazy(pages.vocabulary);
const ReviewPage = lazy(pages.review);
const DiscussionsPage = lazy(pages.discussions);
const SettingsPage = lazy(pages.settings);
const ImportPage = lazy(pages.import);

function usePrefetchPages() {
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    const handle = idle(() => { pages.book(); pages.chapter(); pages.vocabulary(); pages.review(); });
    return () => (window.cancelIdleCallback || clearTimeout)(handle);
  }, []);
}
import { LoginPage, SetupPage, ForcedPasswordChangePage } from './pages/LoginPage.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { LoadingLine, Notice } from './components/ui.jsx';

// One toggle drives both: an overlay drawer on mobile (closed by default)
// and a collapsible column on desktop (open by default) — so it needs a
// viewport-aware initial value.
function getInitialSidebarOpen() {
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(min-width: 1024px)').matches;
}

// A page the signed-in user lacks the permission for goes back to the library.
function Guard({ permission, children }) {
  const { can } = useAuth();
  return can(permission) ? children : <Navigate to="/" replace />;
}

export default function App() {
  const auth = useAuth();
  if (auth.status === 'loading') return <LoadingLine />;
  if (auth.status === 'error') return <div className="mx-auto max-w-md p-8"><Notice>Không kết nối được tới máy chủ: {auth.error}</Notice></div>;
  if (auth.status === 'setup') return <SetupPage />;
  if (auth.status === 'anon') return <LoginPage />;
  if (auth.user?.mustChangePassword) return <ForcedPasswordChangePage />;
  return <AppShell />;
}

function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarOpen);
  usePrefetchPages();

  // A wide side panel (the translation assistant) asks for room with
  // "bt:make-room": the sidebar folds to its icon rail while the panel is
  // open and comes back when it closes, if it was open before.
  const foldedForRoom = useRef(false);
  useEffect(() => {
    const onRoom = (e) => {
      if (!window.matchMedia('(min-width: 1024px)').matches) return;
      if (e.detail) {
        setSidebarOpen((open) => { if (open) foldedForRoom.current = true; return false; });
      } else if (foldedForRoom.current) {
        foldedForRoom.current = false;
        setSidebarOpen(true);
      }
    };
    window.addEventListener('bt:make-room', onRoom);
    return () => window.removeEventListener('bt:make-room', onRoom);
  }, []);

  return (
    <div className="flex min-h-screen bg-desk">
      <PreferencesSync />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onToggle={() => setSidebarOpen((v) => !v)} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile only: the desktop sidebar carries the wordmark and toggle. */}
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-rule bg-page px-3 lg:hidden">
          <IconButton label="Mở thanh bên" onClick={() => setSidebarOpen(true)}>
            <Menu size={18} />
          </IconButton>
          <Wordmark />
        </header>
        <main className="min-w-0 flex-1">
          <Suspense fallback={<LoadingLine />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/import" element={<Guard permission="books.edit"><ImportPage /></Guard>} />
            <Route path="/books/:id" element={<BookPage />} />
            <Route path="/chapters/:id" element={<ChapterPage />} />
            <Route path="/vocabulary" element={<VocabularyPage />} />
            <Route path="/discussions" element={<DiscussionsPage />} />
            <Route path="/review" element={<Guard permission="review.own"><ReviewPage /></Guard>} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
