import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, Notice, Segmented, Sheet } from '../components/ui.jsx';

// Columns of the TSV the vocabulary page exports, mapped back to fields, so
// a spreadsheet round-trip (export, edit, import) works. English headers are
// accepted too, for files made by hand.
const TSV_FIELDS = {
  'từ / cụm từ': 'term', term: 'term', word: 'term',
  ipa: 'ipa',
  'loại từ': 'word_type', word_type: 'word_type', type: 'word_type',
  'nghĩa tiếng việt': 'meaning_vi', meaning_vi: 'meaning_vi', meaning: 'meaning_vi',
  'câu ví dụ & ngữ cảnh': 'example', example: 'example',
  'chủ đề': 'topic', topic: 'topic',
  'ngày thêm': 'date_added', date_added: 'date_added',
  'trạng thái': 'status',
};

// The entries in a picked file: the app's JSON export (or a bare array of
// entries), or a tab-separated table with a header row.
export function parseVocabFile(name, text) {
  const body = text.replace(/^﻿/, '');
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(body)) {
    const data = JSON.parse(body);
    const entries = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(entries)) throw new Error('File JSON không có danh sách "entries".');
    return { entries, format: Array.isArray(data) ? undefined : data.format };
  }
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('File không có dòng dữ liệu nào.');
  const header = lines[0].split('\t').map((h) => TSV_FIELDS[h.trim().toLowerCase()] || null);
  if (!header.includes('term') || !header.includes('meaning_vi')) {
    throw new Error('Dòng đầu của file TSV cần có cột "Từ / Cụm từ" và "Nghĩa tiếng Việt" (như file xuất từ trang này).');
  }
  const entries = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const entry = {};
    header.forEach((field, i) => { if (field) entry[field] = cells[i] ?? ''; });
    if (entry.status) entry.progress = { status: entry.status };
    delete entry.status;
    return entry;
  });
  return { entries };
}

const MODES = [
  { key: 'skip', label: 'Chỉ thêm từ mới', hint: 'Từ đã có trong kho giữ nguyên' },
  { key: 'fill', label: 'Bổ sung chỗ trống', hint: 'Thêm từ mới và điền IPA, ví dụ, chủ đề… còn trống của từ đã có' },
  { key: 'overwrite', label: 'Ghi đè', hint: 'Thêm từ mới và thay nội dung từ đã có bằng nội dung trong file' },
];

const ACTION_LABEL = { add: 'Thêm mới', update: 'Cập nhật', unchanged: 'Đã có', duplicate: 'Trùng trong file', invalid: 'Bỏ qua' };

// Import: picks a file, previews what it would do to the vocabulary (a dry
// run on the server, per mode), and imports on confirmation. Returns the
// header button and the panel separately, so the page places each.
export default function useVocabImport({ canTrackStatus, onDone }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null); // { name, entries, format, hasProgress }
  const [mode, setMode] = useState('fill');
  const [withProgress, setWithProgress] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;
    api.importVocab({ format: file.format, entries: file.entries, mode, dryRun: true })
      .then((r) => { if (!cancelled) { setPreview(r); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [file, mode]);

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setResult('');
    setPreview(null);
    try {
      const parsed = parseVocabFile(f.name, await f.text());
      setFile({ name: f.name, ...parsed, hasProgress: parsed.entries.some((x) => x?.progress?.status) });
      setError('');
    } catch (err) {
      setFile(null);
      setError(`Không đọc được ${f.name}: ${err.message}`);
    }
  }

  async function runImport() {
    setBusy(true);
    try {
      const r = await api.importVocab({ format: file.format, entries: file.entries, mode, withProgress });
      setResult(`Đã nhập ${file.name}: thêm ${r.added} từ, cập nhật ${r.updated}, ${r.unchanged} từ đã có giữ nguyên${r.progress ? `, nhận tiến độ ôn của ${r.progress} từ` : ''}.`);
      setFile(null);
      setPreview(null);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const close = () => { setFile(null); setPreview(null); setError(''); };
  const changed = preview ? preview.items.filter((i) => i.action !== 'unchanged') : [];

  const trigger = (
    <>
      <input ref={inputRef} type="file" accept=".json,.tsv,.txt,application/json,text/tab-separated-values" className="hidden" onChange={pick} />
      <Button onClick={() => inputRef.current?.click()} title="Nhập từ file JSON (xuất từ ứng dụng) hoặc TSV">
        <Upload size={16} /> Nhập
      </Button>
    </>
  );

  const panel = (file || error || result) ? (
    <div className="space-y-2">
      {result && <Notice tone="ok" action={<IconButton label="Đóng" onClick={() => setResult('')}><X size={15} /></IconButton>}>{result}</Notice>}
      {error && !file && <Notice action={<IconButton label="Đóng" onClick={() => setError('')}><X size={15} /></IconButton>}>{error}</Notice>}
      {file && (
        <Sheet className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-ink">Nhập {file.name}</p>
              <p className="text-meta text-mute">{file.entries.length} dòng. Từ đã có trong kho (kể cả dạng chia khác, viết hoa/thường, gạch nối) không bị thêm lần hai.</p>
            </div>
            <IconButton label="Huỷ nhập" onClick={close}><X size={16} /></IconButton>
          </div>
          <Segmented label="Cách xử lý từ đã có" size="sm" options={MODES} value={mode} onChange={setMode} className="max-w-full overflow-x-auto" />
          <p className="text-caption text-mute">{MODES.find((m) => m.key === mode).hint}.</p>
          {file.hasProgress && canTrackStatus && (
            <label className="flex items-center gap-2 text-meta text-soft">
              <input type="checkbox" checked={withProgress} onChange={(e) => setWithProgress(e.target.checked)} />
              Nhận cả tiến độ ôn tập trong file (chỉ cho những từ bạn chưa từng ôn)
            </label>
          )}
          {error && <Notice>{error}</Notice>}
          {preview ? (
            <>
              <p className="text-body text-ink">
                <strong className="tabular-nums">{preview.added}</strong> từ mới · <strong className="tabular-nums">{preview.updated}</strong> cập nhật · <span className="tabular-nums">{preview.unchanged}</span> đã có
                {preview.duplicatesInFile > 0 && <> · <span className="tabular-nums">{preview.duplicatesInFile}</span> trùng trong file</>}
                {preview.invalid > 0 && <> · <span className="tabular-nums text-flag">{preview.invalid}</span> dòng lỗi</>}
              </p>
              {changed.length > 0 && (
                <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md bg-sunken p-2 text-meta">
                  {changed.slice(0, 200).map((i) => (
                    <li key={i.index} className="flex gap-2">
                      <span className="w-28 shrink-0 text-mute">{ACTION_LABEL[i.action]}</span>
                      <span className="min-w-0 break-words text-ink">
                        {i.term}
                        {i.existing && i.existing !== i.term && <span className="text-mute"> → {i.existing}</span>}
                        {i.fields && <span className="text-mute"> ({i.fields.join(', ')})</span>}
                        {i.note && <span className="text-mute"> — {i.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Button variant="primary" size="sm" onClick={runImport} disabled={busy || (!preview.added && !preview.updated && !withProgress)}>
                  {busy ? 'Đang nhập…' : 'Nhập vào kho'}
                </Button>
                <Button variant="ghost" size="sm" onClick={close}>Huỷ</Button>
              </div>
            </>
          ) : !error && <p className="text-meta text-mute">Đang kiểm tra file…</p>}
        </Sheet>
      )}
    </div>
  ) : null;

  return { trigger, panel };
}
