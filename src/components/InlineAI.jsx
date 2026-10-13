import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, LoaderCircle, Sparkles, X } from 'lucide-react';
import { previewText } from '../lib/inlineMarkdown.js';
import { diffWords, diffStats } from '../lib/textDiff.js';
import { AnswerText, DiffView } from './AiText.jsx';
import { Button, Notice } from './ui.jsx';

// Quick requests per editor field. `revise` asks for new content for the
// field; without it the AI only answers.
const QUICK = {
  english_md: [
    { label: 'Sửa lỗi chính tả, OCR', instruction: 'Sửa lỗi chính tả, lỗi OCR và lỗi gõ (ví dụ chữ dính, chữ thừa như "er"). Không đổi câu chữ của tác giả.', revise: true },
    { label: 'Giải thích', instruction: 'Giải thích nghĩa và cấu trúc của phần này, nêu thành ngữ hoặc ẩn dụ nếu có.', revise: false },
  ],
  vietnamese_md: [
    { label: 'Tự nhiên hơn', instruction: 'Viết lại cho tự nhiên, trôi chảy như người Việt viết, giữ đúng và đủ ý gốc.', revise: true },
    { label: 'Sát nghĩa gốc hơn', instruction: 'Dịch lại sát nghĩa bản gốc hơn, không thêm không bớt ý.', revise: true },
    { label: 'Ngắn gọn hơn', instruction: 'Viết gọn hơn, bỏ chữ thừa, giữ đủ ý.', revise: true },
    { label: 'Kiểm tra lỗi dịch', instruction: 'Đối chiếu với bản gốc, chỉ ra chỗ dịch sai, thiếu hoặc thừa ý (trích EN → VI).', revise: false },
  ],
  phrases_verbs_md: [
    { label: 'Bổ sung cụm từ', instruction: 'Bổ sung các cụm động từ, collocation, thành ngữ đáng chú ý còn thiếu trong đoạn gốc, giữ các mục đang có.', revise: true },
    { label: 'Chuẩn hoá định dạng', instruction: 'Chuẩn hoá mọi dòng về đúng định dạng của ô, sửa nghĩa nếu chưa đúng ngữ cảnh.', revise: true },
  ],
  vocabulary_md: [
    { label: 'Bổ sung từ vựng', instruction: 'Bổ sung các từ vựng khó còn thiếu trong đoạn gốc, giữ các mục đang có.', revise: true },
    { label: 'Thêm IPA & loại từ', instruction: 'Thêm IPA và loại từ cho các mục còn thiếu, sửa định dạng cho thống nhất.', revise: true },
  ],
  citation_en_md: [
    { label: 'Sửa lỗi chính tả', instruction: 'Sửa lỗi chính tả và định dạng trích dẫn, không đổi nội dung.', revise: true },
  ],
  citation_vi_md: [
    { label: 'Dịch trích dẫn', instruction: 'Dịch phần trích dẫn & chú thích tiếng Anh sang tiếng Việt.', revise: true },
  ],
  citations_md: [
    { label: 'Chuẩn hoá định dạng', instruction: 'Chuẩn hoá các dòng về đúng định dạng của ô.', revise: true },
  ],
  remarks_note: [
    { label: 'Gợi ý ghi chú', instruction: 'Viết một ghi chú dịch thuật ngắn: lựa chọn thuật ngữ, chỗ khó và cách đã xử lý.', revise: true },
  ],
};

// The AI tucked inside one editor field: quick requests, a free-text
// request, and a proposed new content for the field shown as a difference,
// applied to the draft only on "Áp dụng vào ô". `selection` limits the
// change to the text the user had selected.
export default function InlineAI({ field, label, value, selection, onClearSelection, run, onApply, onClose }) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]); // { role, content, revision?, base?, applied? }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const quick = QUICK[field] || [];

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function send(instruction, revise) {
    const text = instruction.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setInput('');
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: 'user', content: text }]);
    try {
      const r = await run({ instruction: text, selection, revise, history });
      setTurns((t) => [...t, { role: 'assistant', content: r.reply, revision: r.revision, base: value }]);
    } catch (e) {
      setError(e.message);
      setTurns((t) => t.slice(0, -1));
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  function apply(i) {
    onApply(turns[i].revision);
    setTurns((t) => t.map((x, j) => (j === i ? { ...x, applied: true } : x)));
  }

  const last = turns.length - 1;

  return (
    <div className="border-t border-accent/30 bg-accent-soft/30 px-3 py-2.5 font-sans">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="shrink-0 text-accent" />
        <p className="min-w-0 flex-1 truncate text-meta font-medium text-ink">AI cho ô {label}</p>
        <button type="button" aria-label="Đóng AI của ô này" onClick={onClose} className="grid h-6 w-6 place-items-center rounded text-mute hover:bg-rule hover:text-ink">
          <X size={14} />
        </button>
      </div>

      {selection && (
        <p className="mt-1.5 flex items-start gap-1.5 text-caption text-soft">
          <span className="shrink-0 text-mute">Chỉ sửa phần chọn:</span>
          <span className="line-clamp-2 min-w-0 flex-1 italic">“{selection}”</span>
          <button type="button" onClick={onClearSelection} className="shrink-0 text-mute hover:text-ink">Bỏ chọn</button>
        </p>
      )}

      {turns.length > 0 && (
        <div className="mt-2.5 max-h-[28rem] space-y-3 overflow-y-auto">
          {turns.map((t, i) => (
            t.role === 'user' ? (
              <p key={i} className="ml-auto w-fit max-w-[90%] rounded-md bg-page px-2.5 py-1.5 text-meta text-ink shadow-sm">{t.content}</p>
            ) : (
              <div key={i} className="space-y-2 [&_.text-body]:text-meta">
                <AnswerText text={t.content} />
                {t.revision && <Proposal turn={t} current={value} stale={i !== last} onApply={() => apply(i)} />}
              </div>
            )
          ))}
        </div>
      )}
      {busy && (
        <p className="mt-2 flex items-center gap-1.5 text-meta text-mute" role="status">
          <LoaderCircle size={13} className="animate-spin" /> Đang xử lý…
        </p>
      )}
      {error && <Notice className="mt-2">{error}</Notice>}

      {quick.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {quick.map((q) => (
            <button
              key={q.label}
              type="button"
              disabled={busy}
              onClick={() => send(q.instruction, q.revise)}
              className="rounded-full border border-rule bg-page px-2.5 py-0.5 text-caption text-soft hover:border-accent hover:text-ink disabled:opacity-50"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="mt-2 flex items-end gap-2 rounded-md border border-rule bg-page px-2.5 py-1.5 focus-within:border-accent"
      >
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); }
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          }}
          placeholder={selection ? 'Muốn sửa phần chọn thế nào?' : 'Hỏi hoặc yêu cầu sửa ô này…'}
          aria-label={`Yêu cầu AI cho ô ${label}`}
          className="max-h-28 min-w-0 flex-1 resize-none bg-transparent text-meta text-ink placeholder:text-mute focus:outline-none [field-sizing:content]"
        />
        <button type="submit" aria-label="Gửi" disabled={!input.trim() || busy} className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent text-on-accent disabled:opacity-40">
          <ArrowUp size={13} />
        </button>
      </form>
    </div>
  );
}

function Proposal({ turn, current, stale, onApply }) {
  const [view, setView] = useState('diff');
  // Compared with the field as it is now, which is what applying replaces.
  const stats = useMemo(() => diffStats(diffWords(previewText(current), previewText(turn.revision))), [current, turn.revision]);
  return (
    <div className="overflow-hidden rounded-md border border-rule bg-page">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-2.5 py-1.5 text-caption">
        <span className="font-medium text-ink">
          Đề xuất <span className="ml-1 tabular-nums text-flag">−{stats.removed}</span> <span className="tabular-nums text-ok">+{stats.added}</span>
        </span>
        <button type="button" onClick={() => setView((v) => (v === 'diff' ? 'after' : 'diff'))} className="text-mute hover:text-ink">
          {view === 'diff' ? 'Xem bản sau' : 'Xem khác biệt'}
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto px-2.5 py-2">
        {view === 'diff'
          ? <DiffView before={current} after={turn.revision} className="!text-meta" />
          : <p className="whitespace-pre-line font-serif text-meta leading-relaxed text-ink">{previewText(turn.revision)}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-rule px-2.5 py-1.5">
        {turn.applied ? (
          <span className="flex items-center gap-1 text-caption font-medium text-ok"><Check size={13} /> Đã áp dụng vào ô. Nhớ Lưu đoạn.</span>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={onApply}><Check size={13} /> Áp dụng vào ô</Button>
            {stale && <span className="text-caption text-mute">Đề xuất cũ hơn</span>}
          </>
        )}
      </div>
    </div>
  );
}
