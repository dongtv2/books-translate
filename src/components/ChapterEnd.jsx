import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Repeat } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { buttonClass } from './ui.jsx';

const SHOWN = 12;

// The end of a chapter is where reading turns into learning: the words this
// chapter added to the vocabulary, a way to review exactly those, and the way
// on to the next chapter.
export default function ChapterEnd({ chapter }) {
  const { can } = useAuth();
  const words = chapter.vocabulary || [];
  const next = chapter.nextChapter;
  const prev = chapter.prevChapter;

  return (
    <section aria-label="Cuối chương" className="space-y-6 border-t border-rule pt-8">
      {words.length > 0 && (
        <div className="rounded-lg border border-rule bg-page p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-meta text-mute">Hết chương</p>
              <h2 className="font-serif text-heading font-semibold text-ink">{words.length} từ và cụm từ mới trong chương này</h2>
            </div>
            {can('review.own') && (
              <Link to={`/review?chapter=${chapter.id}`} className={buttonClass('primary')}>
                <Repeat size={16} /> Ôn các từ của chương
              </Link>
            )}
          </div>
          <ul className="mt-4 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {words.slice(0, SHOWN).map((w) => (
              <li key={w.id} className="min-w-0">
                <a
                  href={`#paragraph-${w.source_paragraph_id}`}
                  title={`${w.term}: ${w.meaning_vi} (bấm để xem đoạn có từ này)`}
                  className="block rounded-md px-2 py-1.5 -mx-2 hover:bg-sunken"
                >
                  <span className="block truncate font-serif text-lead font-semibold text-ink">{w.term}</span>
                  <span className="block truncate text-meta text-soft">{w.meaning_vi}</span>
                </a>
              </li>
            ))}
          </ul>
          {words.length > SHOWN && (
            <p className="mt-3 text-meta text-mute">
              và {words.length - SHOWN} từ khác.{' '}
              <Link to="/vocabulary" className="text-accent underline underline-offset-2 hover:text-accent-strong">Xem trong kho từ vựng</Link>
            </p>
          )}
        </div>
      )}

      {(prev || next) && (
        <nav aria-label="Chuyển chương" className="flex flex-col-reverse gap-3 sm:flex-row sm:items-stretch">
          {prev ? (
            <Link to={`/chapters/${prev.id}`} className="group flex items-center gap-3 rounded-lg border border-rule bg-page px-4 py-3 hover:border-accent sm:w-1/3">
              <ArrowLeft size={18} className="shrink-0 text-mute group-hover:text-accent" />
              <span className="min-w-0">
                <span className="block text-caption text-mute">Chương trước <kbd className="ml-1 font-sans">←</kbd></span>
                <span className="block truncate text-body font-medium text-ink">{prev.title}</span>
              </span>
            </Link>
          ) : <span className="hidden sm:block sm:w-1/3" />}
          {next && (
            <Link to={`/chapters/${next.id}`} className="group flex flex-1 items-center justify-between gap-4 rounded-lg bg-accent px-5 py-4 text-on-accent hover:bg-accent-strong">
              <span className="min-w-0">
                <span className="block text-meta opacity-80">Đọc tiếp chương sau <kbd className="ml-1 font-sans">→</kbd></span>
                <span className="block truncate font-serif text-heading font-semibold">{next.title}</span>
              </span>
              <ArrowRight size={22} className="shrink-0" />
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
