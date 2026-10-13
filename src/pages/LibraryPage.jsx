import { useEffect, useState } from 'react';
import PageContainer from '../components/PageContainer.jsx';
import { Link } from 'react-router-dom';
import { Lock, Plus } from 'lucide-react';
import { api } from '../api.js';
import BookCover from '../components/BookCover.jsx';
import { Button, buttonClass, Notice, PageHeader, Progress, LoadingLine } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function percent(book) {
  return book.paragraphCount > 0 ? Math.round((book.translatedCount / book.paragraphCount) * 100) : 0;
}

function BookCard({ book }) {
  const pct = percent(book);
  return (
    <Link to={`/books/${book.id}`} className="group flex flex-col gap-3">
      <BookCover book={book} className="transition-transform duration-200 group-hover:-translate-y-1" />
      <div className="min-w-0 space-y-1.5">
        <p className="line-clamp-2 font-serif text-lead font-semibold leading-snug text-ink group-hover:text-accent">
          {book.title_vi || book.title_en}
        </p>
        {book.author && <p className="truncate text-meta text-mute">{book.author}</p>}
        <div className="flex items-center gap-2 pt-0.5">
          <Progress value={pct} tone={pct === 100 ? 'ok' : 'accent'} className="flex-1" />
          <span className="shrink-0 text-caption tabular-nums text-mute">
            {pct === 100 ? 'Đã dịch xong' : `${pct}%`}
          </span>
        </div>
        <p className="flex items-center gap-2 text-caption text-mute">
          {book.chapterCount} chương
          {book.visibility === 'restricted' && <span className="inline-flex items-center gap-1" title="Chỉ những người được cấp quyền mới thấy sách này"><Lock size={11} /> Hạn chế</span>}
        </p>
      </div>
    </Link>
  );
}

export default function LibraryPage() {
  const { can } = useAuth();
  const canEdit = can('books.edit');
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    api.listBooks().then(setBooks).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <PageContainer className="space-y-8">
      <PageHeader
        title="Thư viện"
        subtitle={books.length > 0 ? `${books.length} cuốn sách` : undefined}
        actions={canEdit && (
          <Link to="/import" className={buttonClass('primary')}>
            <Plus size={16} /> Thêm sách
          </Link>
        )}
      />

      {error && (
        <Notice action={<Button size="sm" onClick={load}>Thử lại</Button>}>
          Không tải được thư viện: {error}. Kiểm tra backend đang chạy tại http://localhost:3001/api/health.
        </Notice>
      )}

      {loading && !error && <LoadingLine />}

      {!loading && !error && books.length === 0 && (
        <div className="rounded-lg border border-dashed border-rule px-6 py-14 text-center">
          <p className="font-serif text-title font-semibold text-ink">Thư viện còn trống</p>
          <p className="mx-auto mt-2 max-w-md text-body text-soft">
            {canEdit
              ? 'Tải lên file .docx đã có bảng song ngữ, dán văn bản tiếng Anh, hoặc tạo một cuốn sách trống rồi dịch dần.'
              : 'Chưa có sách nào bạn được xem. Biên tập viên sẽ thêm sách, hoặc quản trị viên cấp quyền xem cho bạn.'}
          </p>
          {canEdit && (
            <Link to="/import" className={buttonClass('primary', 'md', 'mt-5')}>
              <Plus size={16} /> Thêm sách đầu tiên
            </Link>
          )}
        </div>
      )}

      {books.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[1800px]:grid-cols-7">
            {books.map((b) => <BookCard key={b.id} book={b} />)}
          </div>
        </>
      )}
    </PageContainer>
  );
}
