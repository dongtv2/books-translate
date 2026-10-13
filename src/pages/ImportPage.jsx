import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ClipboardPaste, FilePlus2, FileText, Upload } from 'lucide-react';
import { api, BOOK_META_FIELDS } from '../api.js';
import { Button, Field, Notice, PageHeader, Sheet, inputClass } from '../components/ui.jsx';

const METHODS = [
  { key: 'docx', label: 'Tải lên file .docx', hint: 'Đã có bảng song ngữ trong Word', Icon: FileText },
  { key: 'text', label: 'Dán văn bản', hint: 'Chỉ có tiếng Anh, dịch trong app', Icon: ClipboardPaste },
  { key: 'blank', label: 'Tạo sách trống', hint: 'Thêm chương và đoạn văn dần dần', Icon: FilePlus2 },
];

function MethodPicker({ value, onChange }) {
  return (
    <div role="radiogroup" aria-label="Cách thêm sách" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {METHODS.map(({ key, label, hint, Icon }) => {
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(key)}
            className={`flex items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
              selected ? 'border-accent bg-accent-soft' : 'border-rule bg-page hover:border-mute'
            }`}
          >
            <Icon size={20} className={`mt-0.5 shrink-0 ${selected ? 'text-accent' : 'text-mute'}`} />
            <span>
              <span className="block text-body font-semibold text-ink">{label}</span>
              <span className="mt-0.5 block text-meta text-soft">{hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DocxDropzone({ file, onFile }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) onFile(dropped);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dragging ? 'border-accent bg-accent-soft' : 'border-rule'
      }`}
    >
      <Upload size={24} className="text-mute" />
      {file ? (
        <p className="text-body text-ink">
          <span className="font-semibold">{file.name}</span>{' '}
          <span className="tabular-nums text-mute">({Math.max(1, Math.round(file.size / 1024))} KB)</span>
        </p>
      ) : (
        <p className="text-body text-soft">Kéo file .docx vào đây</p>
      )}
      <Button size="sm" onClick={() => inputRef.current?.click()}>{file ? 'Chọn file khác' : 'Chọn file trên máy'}</Button>
      <input
        ref={inputRef}
        type="file"
        accept=".docx"
        onChange={(e) => onFile(e.target.files?.[0] || null)}
        className="sr-only"
        aria-label="Chọn file .docx"
      />
    </div>
  );
}

function MetaForm({ meta, updateMeta, onlyRequired = false }) {
  const fields = onlyRequired ? BOOK_META_FIELDS.filter((f) => ['title_en', 'title_vi', 'author'].includes(f.key)) : BOOK_META_FIELDS;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map((f) => (
        <Field key={f.key} label={f.required ? `${f.label} (bắt buộc)` : f.label}>
          <input value={meta[f.key] || ''} onChange={(e) => updateMeta(f.key, e.target.value)} className={inputClass} />
        </Field>
      ))}
    </div>
  );
}

export default function ImportPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('docx');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [file, setFile] = useState(null);

  const [meta, setMeta] = useState(Object.fromEntries(BOOK_META_FIELDS.map((f) => [f.key, ''])));
  const [rawText, setRawText] = useState('');

  function updateMeta(key, value) {
    setMeta((m) => ({ ...m, [key]: value }));
  }

  async function handleDocxSubmit() {
    if (!file) { setError('Chọn một file .docx trước khi nhập.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await api.importDocx(file);
      navigate(`/books/${res.bookId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleTextSubmit() {
    if (!meta.title_en.trim()) { setError('Nhập tên sách (tiếng Anh).'); return; }
    if (!rawText.trim()) { setError('Dán nội dung văn bản cần nhập.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await api.importText({ ...meta, rawText });
      navigate(`/books/${res.bookId}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleBlankSubmit() {
    if (!meta.title_en.trim()) { setError('Nhập tên sách (tiếng Anh).'); return; }
    setLoading(true);
    setError('');
    try {
      const book = await api.createBook(meta);
      navigate(`/books/${book.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-8">
      <Link to="/library" className="inline-flex items-center gap-1.5 text-body font-medium text-soft hover:text-accent">
        <ArrowLeft size={16} /> Thư viện
      </Link>
      <PageHeader title="Thêm sách" />

      <MethodPicker value={tab} onChange={(key) => { setTab(key); setError(''); }} />

      {error && <Notice>{error}</Notice>}

      {tab === 'docx' && (
        <Sheet className="space-y-5 p-5">
          <p className="text-body leading-relaxed text-soft">
            Dùng cho file Word đã có bảng English / Vietnamese / Phrase &amp; Remark. Cấu trúc Phần, Chương, Mục lấy theo Heading 1, 2, 3; bản dịch và ghi chú có sẵn được giữ nguyên, các mục Vocabulary đã có IPA và loại từ được đưa thẳng vào kho từ vựng.
          </p>
          <DocxDropzone file={file} onFile={(f) => { setFile(f); setError(''); }} />
          <Button variant="primary" onClick={handleDocxSubmit} disabled={loading || !file}>
            {loading ? 'Đang nhập…' : 'Nhập file'}
          </Button>
        </Sheet>
      )}

      {tab === 'text' && (
        <Sheet className="space-y-5 p-5">
          <p className="text-body leading-relaxed text-soft">
            Các đoạn được tách theo dòng trống. Dòng bắt đầu bằng PART hoặc CHAPTER (hay PHẦN, CHƯƠNG) thành ranh giới Phần và Chương; dòng ngắn viết hoa thành tiêu đề mục. Cột tiếng Việt để trống, bạn dịch bằng AI trong từng chương.
          </p>
          <MetaForm meta={meta} updateMeta={updateMeta} onlyRequired />
          <Field label="Nội dung sách (tiếng Anh)">
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={14}
              placeholder={'PART 1: ...\nCHAPTER 1: ...\n\nĐoạn văn đầu tiên...\n\nĐoạn văn thứ hai...'}
              className={`${inputClass} font-serif leading-relaxed`}
            />
          </Field>
          <Button variant="primary" onClick={handleTextSubmit} disabled={loading}>
            {loading ? 'Đang nhập…' : 'Nhập văn bản'}
          </Button>
        </Sheet>
      )}

      {tab === 'blank' && (
        <Sheet className="space-y-5 p-5">
          <p className="text-body leading-relaxed text-soft">Tạo một cuốn sách trống, sau đó thêm chương và dán từng đoạn văn để dịch dần.</p>
          <MetaForm meta={meta} updateMeta={updateMeta} />
          <Button variant="primary" onClick={handleBlankSubmit} disabled={loading}>
            {loading ? 'Đang tạo…' : 'Tạo sách'}
          </Button>
        </Sheet>
      )}
    </div>
  );
}
