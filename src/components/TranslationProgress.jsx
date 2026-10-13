import { useEffect, useState } from 'react';
import { Button, Progress } from './ui.jsx';

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Docked to the bottom of the viewport while a chapter is being translated,
// so the reader can keep scrolling through finished paragraphs and still see
// progress and reach Cancel.
export default function TranslationProgress({ progress, onCancel, onDismiss }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!progress || progress.finished) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [progress?.finished, progress?.startedAt]);

  if (!progress) return null;

  const { total, done, failed, insertedWordCount, startedAt, currentPreview, finished, cancelled } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const elapsedMs = (finished ? progress.finishedAt || now : now) - startedAt;
  const etaMs = done > 0 && !finished ? (elapsedMs / done) * (total - done) : null;

  return (
    <div role="status" className="sticky bottom-4 z-20 mx-auto w-full max-w-2xl rounded-lg border border-rule bg-page p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body font-semibold text-ink">
          {finished
            ? cancelled
              ? `Đã huỷ sau ${done}/${total} đoạn`
              : `Đã dịch xong ${done}/${total} đoạn`
            : `Đang dịch ${done}/${total} đoạn…`}
        </p>
        {!finished ? (
          <Button size="sm" variant="danger" onClick={onCancel}>Huỷ dịch</Button>
        ) : (
          onDismiss && <Button size="sm" variant="ghost" onClick={onDismiss}>Đóng</Button>
        )}
      </div>

      <Progress value={pct} tone={finished && !cancelled ? 'ok' : 'accent'} className="mt-3" />

      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-meta tabular-nums text-soft">
        <span>Đã chạy {formatDuration(elapsedMs)}</span>
        {etaMs !== null && <span>Còn khoảng {formatDuration(etaMs)}</span>}
        <span>{insertedWordCount} từ mới vào kho</span>
        {failed > 0 && <span className="font-medium text-flag">{failed} đoạn lỗi, bấm dịch lại để thử tiếp</span>}
      </div>

      {!finished && currentPreview && (
        <p className="mt-2 truncate font-serif text-meta italic text-mute">{currentPreview}…</p>
      )}
    </div>
  );
}
