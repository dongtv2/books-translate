import { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { ACCEPTED, prepareCover } from '../lib/coverImage.js';
import BookCover from './BookCover.jsx';

// The book page's cover, with ways to set it for editors: the button
// under it, dropping an image file on it, or pasting one (Ctrl/⌘+V) while
// it has focus. The image is scaled and compressed in the browser
// (lib/coverImage.js) and shown at once; the saved cover replaces the
// preview when the upload finishes, and a failed upload brings the old
// cover back.
export default function BookCoverEditor({ book, canEdit, onChange }) {
  const confirm = useConfirm();
  const input = useRef(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);

  if (!canEdit) return <BookCover book={book} size="lg" priority />;

  async function use(file) {
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setError('');
    setSaved(null);
    setBusy('prepare');
    let url = '';
    try {
      const cover = await prepareCover(file);
      url = cover.preview;
      setPreview(url);
      setBusy('upload');
      const fields = await api.uploadCover(book.id, cover);
      onChange(fields);
      setSaved({ before: file.size, after: cover.lg.size + cover.sm.size });
    } catch (e) {
      setError(e.message);
    } finally {
      setPreview('');
      if (url) URL.revokeObjectURL(url);
      busyRef.current = false;
      setBusy('');
    }
  }

  async function remove() {
    if (!(await confirm('Bỏ ảnh bìa và dùng lại bìa chữ?', { confirmLabel: 'Bỏ ảnh bìa' }))) return;
    try {
      await api.deleteCover(book.id);
      onChange({ cover_lg: '', cover_sm: '', cover_color: '' });
      setSaved(null);
    } catch (e) {
      setError(e.message);
    }
  }

  const imageFrom = (items) => [...(items || [])].find((f) => f.type?.startsWith('image/'));
  const hasCover = Boolean(book.cover_lg);
  const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  return (
    <div className="w-40 shrink-0 space-y-2">
      <div
        role="button"
        tabIndex={0}
        aria-label={hasCover ? 'Đổi ảnh bìa: bấm để chọn ảnh, kéo thả hoặc dán ảnh vào đây' : 'Thêm ảnh bìa: bấm để chọn ảnh, kéo thả hoặc dán ảnh vào đây'}
        title="Bấm để chọn ảnh, kéo thả hoặc dán (Ctrl/⌘+V) ảnh vào đây"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onPaste={(e) => { const f = imageFrom(e.clipboardData?.files); if (f) { e.preventDefault(); use(f); } }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); use(imageFrom(e.dataTransfer?.files)); }}
        className={`group relative block cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-accent ${dragging ? 'ring-2 ring-accent ring-offset-2' : ''}`}
      >
        <BookCover book={book} size="lg" priority preview={preview} />
        <span className={`absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-ink/55 text-center text-caption font-medium text-white transition-opacity ${busy || dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}>
          {busy ? <LoaderCircle size={20} className="animate-spin" /> : <ImagePlus size={20} />}
          {busy === 'prepare' ? 'Đang tối ưu ảnh…' : busy === 'upload' ? 'Đang lưu…' : dragging ? 'Thả ảnh vào đây' : hasCover ? 'Đổi ảnh bìa' : 'Thêm ảnh bìa'}
        </span>
      </div>
      <input ref={input} type="file" accept={ACCEPTED} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; use(f); }} />
      <div className="flex items-center justify-between gap-2 text-caption">
        <button type="button" onClick={() => input.current?.click()} disabled={Boolean(busy)} className="text-soft hover:text-accent disabled:opacity-50">
          {hasCover ? 'Đổi ảnh bìa' : 'Thêm ảnh bìa'}
        </button>
        {hasCover && !busy && (
          <button type="button" onClick={remove} className="inline-flex items-center gap-1 text-mute hover:text-flag" aria-label="Bỏ ảnh bìa"><Trash2 size={12} /></button>
        )}
      </div>
      {saved && <p className="text-caption text-ok">Đã lưu · {kb(saved.before)} → {kb(saved.after)}</p>}
      {error && <p role="alert" className="text-caption text-flag">{error}</p>}
    </div>
  );
}
