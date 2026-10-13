import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Bookmark, Flag, Flame, Highlighter, Languages, Library, Repeat } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import BookCover from '../components/BookCover.jsx';
import PageContainer from '../components/PageContainer.jsx';
import { Notice, Progress, Sheet, LoadingLine, buttonClass } from '../components/ui.jsx';

// The signed-in user's reading desk: where they are in their books, today's
// review, what they marked, the newest words, and (for editors) what still
// needs translating. Everything comes from /api/me/home in one call.

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 11 ? 'Chào buổi sáng' : h < 14 ? 'Chào buổi trưa' : h < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
  const first = (name || '').trim().split(/\s+/).pop();
  return first ? `${part}, ${first}` : part;
}

function today() {
  const s = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const pct = (p) => (p?.total ? Math.round(((p.translated || 0) / p.total) * 100) : 0);

function SectionHeading({ children, to, linkLabel }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="font-serif text-heading font-semibold text-ink">{children}</h2>
      {to && (
        <Link to={to} className="inline-flex items-center gap-1 text-meta font-medium text-accent hover:text-accent-strong">
          {linkLabel} <ArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}

// The book open on the desk: cover, where the reader is, and a bilingual
// taste of the chapter set as facing pages, the way the reader shows it.
function CurrentBook({ item }) {
  const { book, chapter, excerpt, paragraphId } = item;
  return (
    <Sheet className="overflow-hidden">
      <div className="grid lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <div className="flex gap-5 p-5 sm:p-6">
          <BookCover book={book} className="!w-28 shrink-0" />
          <div className="flex min-w-0 flex-col">
            <p className="text-meta text-mute">Đang đọc</p>
            <Link to={`/books/${book.id}`} className="mt-0.5 line-clamp-3 font-serif text-heading font-semibold leading-snug text-ink hover:text-accent">
              {book.title_vi || book.title_en}
            </Link>
            <p className="mt-2 text-meta text-soft">Chương {chapter.number} trên {chapter.count}</p>
            <p className="line-clamp-2 text-body font-medium text-ink">{chapter.title}</p>
            <div className="mt-auto pt-4">
              <Link to={`/chapters/${chapter.id}${paragraphId ? `#paragraph-${paragraphId}` : ''}`} className={buttonClass('primary', 'md')}>
                <BookOpen size={16} /> Đọc tiếp
              </Link>
            </div>
          </div>
        </div>
        {excerpt ? (
          <Link
            to={`/chapters/${chapter.id}#paragraph-${excerpt.paragraphId}`}
            className="group grid grid-cols-1 border-t border-rule bg-sunken/60 sm:grid-cols-2 lg:border-l lg:border-t-0"
            title="Mở đoạn này trong chương"
          >
            <p className="line-clamp-[8] p-5 font-serif text-lead leading-relaxed text-ink sm:p-6">
              {excerpt.isWhereStopped && <span className="mb-1.5 block font-sans text-caption font-medium text-accent">Bạn dừng ở đây</span>}
              {excerpt.english}
            </p>
            <p className="line-clamp-[8] border-rule p-5 font-serif text-lead leading-relaxed text-soft max-sm:border-t sm:border-l sm:p-6">{excerpt.vietnamese}</p>
          </Link>
        ) : (
          <div className="grid place-items-center border-t border-rule bg-sunken/60 p-6 text-body text-mute lg:border-l lg:border-t-0">
            Chương này chưa có đoạn nào được dịch.
          </div>
        )}
      </div>
    </Sheet>
  );
}

function AlsoReading({ items }) {
  if (!items.length) return null;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map(({ book, chapter }) => (
        <li key={book.id}>
          <Link to={`/chapters/${chapter.id}`} className="group flex items-center gap-3 rounded-lg border border-rule bg-page p-3 hover:border-accent">
            <BookCover book={book} size="sm" className="!w-10" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium text-ink">{book.title_vi || book.title_en}</span>
              <span className="block truncate text-caption text-mute">{chapter.title}</span>
            </span>
            <ArrowRight size={16} className="shrink-0 text-mute group-hover:text-accent" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// Seven columns, one per day, height = reviews graded that day. A single
// series: no legend, the heading names it; each column has a tooltip and the
// numbers are also listed for screen readers.
function WeekChart({ week }) {
  const max = Math.max(1, ...week.map((d) => d.count));
  const label = (d) => new Date(`${d.date}T00:00:00`).toLocaleDateString('vi-VN', { weekday: 'narrow' });
  return (
    <figure>
      <div className="flex h-16 items-end gap-[2px]" aria-hidden="true">
        {week.map((d, i) => (
          <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className="mx-auto w-full max-w-6 rounded-t bg-[var(--color-chart)]"
              style={{ height: d.count ? `${Math.max(8, (d.count / max) * 100)}%` : '2px', opacity: d.count ? 1 : 0.25 }}
            />
            <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-caption text-page group-hover:block">
              {d.count} lượt{i === week.length - 1 ? ' hôm nay' : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-center text-caption text-mute" aria-hidden="true">
        {week.map((d) => <span key={d.date} className="flex-1">{label(d)}</span>)}
      </div>
      <figcaption className="sr-only">
        Số lượt ôn 7 ngày qua: {week.map((d) => `${d.date}: ${d.count}`).join('; ')}
      </figcaption>
    </figure>
  );
}

function ReviewCard({ review }) {
  return (
    <Sheet className="flex h-full flex-col p-5">
      <SectionHeading>Ôn tập hôm nay</SectionHeading>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-serif text-display font-semibold tabular-nums leading-none text-ink">{review.dueToday}</p>
          <p className="mt-1.5 text-meta text-soft">từ đến hạn</p>
        </div>
        <div className="text-right text-meta text-soft">
          <p className="flex items-center justify-end gap-1.5">
            <Flame size={15} className={review.streakDays ? 'text-warn' : 'text-mute'} />
            <span><span className="font-semibold tabular-nums text-ink">{review.streakDays}</span> ngày liên tiếp</span>
          </p>
          <p className="mt-1"><span className="font-semibold tabular-nums text-ink">{review.reviewedToday}</span> lượt hôm nay</p>
        </div>
      </div>
      <div className="mt-5">
        <p className="mb-2 text-caption text-mute">Lượt ôn mỗi ngày, 7 ngày qua</p>
        <WeekChart week={review.week} />
      </div>
      <div className="mt-auto pt-5">
        <Link to="/review" className={buttonClass(review.dueToday ? 'primary' : 'secondary', 'md', 'w-full')}>
          <Repeat size={16} /> {review.dueToday ? `Ôn ${Math.min(review.dueToday, 20)} từ` : 'Mở trang ôn tập'}
        </Link>
      </div>
    </Sheet>
  );
}

const MARK_ICON = {
  flag: { Icon: Flag, tone: 'text-flag', label: 'Cần xem lại' },
  bookmark: { Icon: Bookmark, tone: 'text-accent', label: 'Bookmark' },
  highlight: { Icon: Highlighter, tone: 'text-warn', label: 'Highlight' },
};

function MarksCard({ marks }) {
  return (
    <Sheet className="h-full p-5">
      <SectionHeading>Đánh dấu gần đây</SectionHeading>
      {marks.length === 0 ? (
        <p className="text-body text-mute">Khi đọc, rê chuột vào một đoạn để đánh dấu cần xem lại, bookmark hoặc highlight. Các đoạn đó sẽ hiện ở đây.</p>
      ) : (
        <ul className="-mx-2 space-y-1">
          {marks.map((m) => {
            const { Icon, tone, label } = MARK_ICON[m.kind];
            return (
              <li key={m.paragraphId}>
                <Link to={`/chapters/${m.chapterId}#paragraph-${m.paragraphId}`} className="flex gap-2.5 rounded-md px-2 py-2 hover:bg-sunken">
                  <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} aria-label={label} />
                  <span className="min-w-0">
                    <span className="block truncate text-caption text-mute">{m.chapterTitle}</span>
                    <span className="line-clamp-2 font-serif text-body leading-snug text-ink">{m.excerpt}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

function WordsCard({ words }) {
  return (
    <Sheet className="h-full p-5">
      <SectionHeading to="/vocabulary" linkLabel="Kho từ vựng">Từ mới trong kho</SectionHeading>
      <ul className="space-y-2.5">
        {words.map((w) => (
          <li key={w.id} className="min-w-0">
            <p className="flex items-baseline gap-2">
              <span className="font-serif text-lead font-semibold text-ink">{w.term}</span>
              <span className="truncate text-caption text-mute">{w.ipa}</span>
            </p>
            <p className="truncate text-meta text-soft">{w.meaning_vi}</p>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function TodoCard({ todo }) {
  if (!todo?.length) return null;
  return (
    <section>
      <SectionHeading>Cần dịch tiếp</SectionHeading>
      <ul className="grid gap-3 sm:grid-cols-2">
        {todo.map((c) => {
          const done = c.total - c.pending;
          return (
            <li key={c.chapterId}>
              <Link to={`/chapters/${c.chapterId}`} className="group block rounded-lg border border-rule bg-page p-4 hover:border-accent">
                <span className="block truncate text-caption text-mute">{c.bookTitle}</span>
                <span className="mt-0.5 block truncate text-body font-medium text-ink group-hover:text-accent">{c.title}</span>
                <span className="mt-3 flex items-center gap-3">
                  <Progress value={(done / c.total) * 100} className="flex-1" />
                  <span className="shrink-0 text-caption tabular-nums text-soft">
                    <Languages size={13} className="mr-1 inline align-[-2px] text-mute" />còn {c.pending} đoạn
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Shelf({ books }) {
  return (
    <section>
      <SectionHeading to="/library" linkLabel={`Cả thư viện (${books.length})`}>Thư viện</SectionHeading>
      <ul className="grid grid-cols-3 gap-x-5 gap-y-6 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
        {books.slice(0, 8).map((b) => (
          <li key={b.id}>
            <Link to={`/books/${b.id}`} className="group block">
              <BookCover book={b} className="transition-transform duration-200 group-hover:-translate-y-1" />
              <span className="mt-2 block line-clamp-2 text-meta font-medium leading-snug text-ink group-hover:text-accent">{b.title_vi || b.title_en}</span>
              <span className="text-caption tabular-nums text-mute">{pct(b)}% đã dịch</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HomePage() {
  const { user, can } = useAuth();
  const [home, setHome] = useState(null);
  const [books, setBooks] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.myHome().then(setHome).catch((e) => setError(e.message));
    api.listBooks()
      .then((rows) => setBooks(rows.map((b) => ({ ...b, total: b.paragraphCount, translated: b.translatedCount }))))
      .catch(() => {});
  }, []);

  if (error) return <PageContainer><Notice>{error}</Notice></PageContainer>;
  if (!home) return <LoadingLine />;

  const [current, ...others] = home.reading;
  const sideCards = [
    home.review && <ReviewCard key="review" review={home.review} />,
    home.marks && <MarksCard key="marks" marks={home.marks} />,
    home.newWords.length > 0 && <WordsCard key="words" words={home.newWords} />,
  ].filter(Boolean);

  return (
    <PageContainer className="space-y-10">
      <header>
        <p className="text-meta text-mute">{today()}</p>
        <h1 className="mt-1 font-serif text-headline font-semibold leading-tight text-ink">{greeting(user.name)}</h1>
      </header>

      <section className="space-y-3">
        {current ? (
          <>
            <CurrentBook item={current} />
            <AlsoReading items={others} />
          </>
        ) : (
          <Sheet className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <p className="font-serif text-heading font-semibold text-ink">Bàn đọc đang trống</p>
              <p className="mt-1 text-body text-soft">Mở một cuốn sách trong thư viện; chương bạn đọc gần nhất sẽ luôn chờ sẵn ở đây.</p>
            </div>
            <Link to="/library" className={buttonClass('primary')}><Library size={16} /> Chọn sách</Link>
          </Sheet>
        )}
      </section>

      {sideCards.length > 0 && (
        <div className={`grid gap-4 ${sideCards.length === 3 ? 'lg:grid-cols-3' : sideCards.length === 2 ? 'lg:grid-cols-2' : ''}`}>
          {sideCards}
        </div>
      )}

      {can('books.edit') && <TodoCard todo={home.todo} />}

      {books.length > 0 && <Shelf books={books} />}
    </PageContainer>
  );
}
