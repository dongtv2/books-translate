import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { House, Library, NotebookText, Repeat, Settings, PanelLeftClose, PanelLeftOpen, X, LogOut, MessagesSquare } from 'lucide-react';
import { useAuth, roleLabel } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import BookTocTree from './BookTocTree.jsx';
import { BrandMark, BrandName } from './Brand.jsx';
import { IconButton } from './ui.jsx';
import { onBookChanged, onActiveSectionChanged, onReviewChanged, onDiscussionsChanged } from '../lib/bookEvents.js';

const NAV_LINKS = [
  { to: '/', label: 'Trang chủ', Icon: House, end: true },
  { to: '/library', label: 'Thư viện', Icon: Library },
  { to: '/vocabulary', label: 'Kho từ vựng', Icon: NotebookText },
  { to: '/discussions', label: 'Thảo luận', Icon: MessagesSquare, badge: 'discussions' },
  { to: '/review', label: 'Ôn tập', Icon: Repeat, badge: 'due', permission: 'review.own' },
  { to: '/settings', label: 'Cài đặt', Icon: Settings },
];

export function Wordmark({ compact = false }) {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-1.5" title="books.metta.family">
      <BrandMark size={30} />
      {!compact && <BrandName className="whitespace-nowrap text-[15px]" />}
    </Link>
  );
}

// Desktop width of the open sidebar, dragged by its right edge and kept per
// browser (a convenience: anything unreadable falls back to the default).
const WIDTH_KEY = 'bt.sidebarWidth';
const WIDTH_DEFAULT = 300;
const WIDTH_MIN = 240;
const WIDTH_MAX = 560;
const clampWidth = (w) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(w) || WIDTH_DEFAULT)));
function readWidth() {
  try { return clampWidth(localStorage.getItem(WIDTH_KEY) ?? WIDTH_DEFAULT); } catch { return WIDTH_DEFAULT; }
}
function saveWidth(w) {
  try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode: not remembered */ }
}

// The drag handle on the sidebar's right edge (desktop only). Pointer drag,
// arrow keys, double-click for the default width.
function ResizeHandle({ width, onChange, onDragging }) {
  const dragging = useRef(false);
  function onPointerDown(e) {
    e.preventDefault();
    dragging.current = true;
    onDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (dragging.current) onChange(clampWidth(e.clientX), false);
  }
  function onPointerUp(e) {
    if (!dragging.current) return;
    dragging.current = false;
    onDragging(false);
    onChange(clampWidth(e.clientX), true);
  }
  function onKeyDown(e) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(clampWidth(width - step), true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); onChange(clampWidth(width + step), true); }
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Kéo để đổi độ rộng thanh bên"
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Kéo để đổi độ rộng · bấm đúp để về mặc định"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(WIDTH_DEFAULT, true)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1.5 z-10 hidden w-3 cursor-col-resize touch-none lg:block focus-visible:outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}

// Persists across every page. Always shows primary navigation, and when the
// current route is inside a specific book (/books/:id or /chapters/:id) it
// also fetches and shows that book's Part/Chapter/Section tree underneath.
// On desktop it collapses to an icon rail; on mobile it is an overlay drawer.
export default function Sidebar({ open, onClose, onToggle }) {
  const location = useLocation();
  const [bookCtx, setBookCtx] = useState(null); // { book, currentChapterId, currentSections }
  const [activeSectionId, setActiveSectionId] = useState(null);
  const [dueToday, setDueToday] = useState(0);
  const { user, roles, can, logout } = useAuth();

  const load = useCallback(() => {
    const bookMatch = location.pathname.match(/^\/books\/(\d+)/);
    const chapterMatch = location.pathname.match(/^\/chapters\/(\d+)/);
    if (!bookMatch && !chapterMatch) {
      setBookCtx(null);
      return undefined;
    }

    let cancelled = false;
    async function run() {
      try {
        if (bookMatch) {
          const book = await api.getBook(bookMatch[1]);
          if (!cancelled) setBookCtx({ book, currentChapterId: null, currentSections: null });
        } else {
          const chapter = await api.getChapter(chapterMatch[1]);
          const book = await api.getBook(chapter.book.id);
          if (!cancelled) {
            setBookCtx({
              book,
              currentChapterId: chapter.id,
              currentSections: chapter.sections.map((s) => ({ id: s.id, heading: s.heading, heading_vi: s.heading_vi })),
            });
          }
        }
      } catch {
        if (!cancelled) setBookCtx(null);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [location.pathname]);

  useEffect(() => load(), [load]);
  // The Part/Chapter/Section tree is fetched independently of BookPage and
  // ChapterPage, so it doesn't know when they add/rename/move/delete
  // something — this event (dispatched by those pages after every mutation)
  // is what keeps it in sync without requiring a manual page reload.
  useEffect(() => onBookChanged(load), [load]);
  useEffect(() => onActiveSectionChanged(setActiveSectionId), []);

  // Words due today, shown as a count beside "Ôn tập" so the daily review is
  // visible from anywhere. Refreshed on navigation and after each grading.
  const canReview = can('review.own');
  const loadDue = useCallback(() => {
    if (!canReview) return;
    api.reviewStats().then((s) => setDueToday(s.dueToday || 0)).catch(() => {});
  }, [canReview]);
  useEffect(loadDue, [loadDue, location.pathname]);
  useEffect(() => onReviewChanged(loadDue), [loadDue]);

  // Term discussions with news for the user (unread), beside "Thảo luận".
  const [discussionNews, setDiscussionNews] = useState(0);
  const loadDiscussions = useCallback(() => {
    api.threadSummary().then((s) => setDiscussionNews(s.unread || 0)).catch(() => {});
  }, []);
  useEffect(loadDiscussions, [loadDiscussions, location.pathname]);
  useEffect(() => onDiscussionsChanged(loadDiscussions), [loadDiscussions]);
  const badges = {
    due: { count: dueToday, title: `${dueToday} từ đến hạn ôn hôm nay` },
    discussions: { count: discussionNews, title: `${discussionNews} thảo luận có hoạt động mới` },
  };

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);

  // Links must close the mobile overlay drawer after navigating but must NOT
  // touch the desktop column, which should stay open across pages.
  function closeOnMobile() {
    if (!window.matchMedia('(min-width: 1024px)').matches) onClose();
  }

  return (
    <>
      {open && <div onClick={onClose} className="fixed inset-0 z-30 bg-ink/40 lg:hidden" />}
      <aside
        style={{ '--sidebar-w': `${width}px` }}
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-rule bg-page lg:sticky lg:top-0 lg:z-0 lg:h-screen lg:shrink-0 lg:translate-x-0 ${
          resizing ? '' : 'transition-[width,transform] duration-200'
        } ${open ? 'w-72 translate-x-0 lg:w-(--sidebar-w)' : 'w-72 -translate-x-full lg:w-14'}`}
      >
        {open && (
          <ResizeHandle
            width={width}
            onDragging={setResizing}
            onChange={(w, done) => { setWidth(w); if (done) saveWidth(w); }}
          />
        )}
        <div className={`flex h-14 shrink-0 items-center ${open ? 'justify-between px-4' : 'justify-center'}`}>
          <Wordmark compact={!open} />
          {open && (
            <>
              <IconButton label="Thu gọn thanh bên" onClick={onToggle} className="hidden lg:grid">
                <PanelLeftClose size={18} />
              </IconButton>
              <IconButton label="Đóng" onClick={onClose} className="lg:hidden">
                <X size={18} />
              </IconButton>
            </>
          )}
        </div>

        <nav className={`shrink-0 space-y-0.5 ${open ? 'px-3' : 'px-2'}`}>
          {NAV_LINKS.filter((l) => !l.permission || can(l.permission)).map(({ to, label, Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={closeOnMobile}
              title={open ? undefined : label}
              className={({ isActive }) =>
                `relative flex h-9 items-center gap-2.5 rounded-md text-body font-medium transition-colors ${
                  open ? 'px-2.5' : 'justify-center'
                } ${isActive ? 'bg-accent-soft text-accent' : 'text-soft hover:bg-sunken hover:text-ink'}`
              }
            >
              <Icon size={18} className="shrink-0" />
              {open && <span className="flex-1">{label}</span>}
              {badge && badges[badge].count > 0 && (
                open ? (
                  <span className="rounded-full bg-accent px-1.5 text-caption font-semibold tabular-nums text-on-accent" title={badges[badge].title}>
                    {badges[badge].count}
                  </span>
                ) : (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />
                )
              )}
            </NavLink>
          ))}
        </nav>

        {!open && (
          <div className="mt-2 hidden justify-center lg:flex">
            <IconButton label="Mở thanh bên" onClick={onToggle}>
              <PanelLeftOpen size={18} />
            </IconButton>
          </div>
        )}

        {open && bookCtx && (
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-rule px-3 py-4">
            <BookTocTree
              book={bookCtx.book}
              currentChapterId={bookCtx.currentChapterId}
              currentSections={bookCtx.currentSections}
              activeSectionId={activeSectionId}
              onNavigate={closeOnMobile}
            />
          </div>
        )}
        {user && (
          <div className={`mt-auto shrink-0 border-t border-rule ${open ? 'flex items-center gap-2.5 px-3 py-3' : 'flex flex-col items-center gap-1 py-3'}`}>
            <span
              title={open ? undefined : `${user.name} (${user.email})`}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-meta font-semibold text-accent"
            >
              {(user.name || user.email).trim().charAt(0).toUpperCase()}
            </span>
            {open && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-meta font-medium text-ink">{user.name || user.email}</p>
                <p className="truncate text-caption text-mute">{user.effectiveRoles.map((r) => roleLabel(roles, r)).join(', ') || 'Chưa có vai trò'}</p>
              </div>
            )}
            <IconButton label="Đăng xuất" onClick={logout}>
              <LogOut size={16} />
            </IconButton>
          </div>
        )}
      </aside>
    </>
  );
}
