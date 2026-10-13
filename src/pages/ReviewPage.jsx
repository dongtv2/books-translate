import { useEffect, useState, useCallback } from 'react';
import PageContainer from '../components/PageContainer.jsx';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Flame } from 'lucide-react';
import { api, STATUSES, WORD_TYPES, REVIEW_GRADES } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import SpeakButton from '../components/SpeakButton.jsx';
import { Button, Field, Notice, PageHeader, Progress, Segmented, Sheet, inputClass } from '../components/ui.jsx';
import { notifyReviewChanged } from '../lib/bookEvents.js';

const TABS = [
  { key: 'srs', label: 'Ôn theo lịch' },
  { key: 'practice', label: 'Thực hành tự do' },
];

// Grade buttons, keyed 1–4 in the same order as on screen.
const GRADE_STYLE = {
  again: 'border-flag/40 text-flag hover:bg-flag-soft',
  hard: 'border-warn/40 text-warn hover:bg-warn-soft',
  good: 'border-ok/40 text-ok hover:bg-ok-soft',
  easy: 'border-accent/40 text-accent hover:bg-accent-soft',
};
const GRADE_LABEL = { again: 'Quên', hard: 'Khó', good: 'Tốt', easy: 'Dễ' };

function Kbd({ children }) {
  return <kbd className="rounded border border-rule bg-sunken px-1.5 py-0.5 font-sans text-caption font-medium text-mute">{children}</kbd>;
}

function isTypingTarget(target) {
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(target?.tagName);
}

function ReviewSummary({ stats }) {
  if (!stats) return null;
  const items = [
    ['Đến hạn hôm nay', stats.dueToday],
    ['Đã ôn hôm nay', stats.reviewedToday],
    ['Cần ôn gấp', stats.byStatus['Cần ôn gấp']],
    ['Thành thạo', stats.byStatus['Thành thạo']],
  ];
  return (
    <dl className="flex flex-wrap items-end gap-x-10 gap-y-4 border-y border-rule py-4">
      {items.map(([label, value]) => (
        <div key={label}>
          <dd className="font-serif text-headline font-semibold tabular-nums text-ink">{value ?? 0}</dd>
          <dt className="text-meta text-mute">{label}</dt>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-2 text-body text-soft" title="Số ngày liên tiếp có ôn tập">
        <Flame size={18} className={stats.streakDays > 0 ? 'text-warn' : 'text-mute'} />
        <span><span className="font-semibold tabular-nums text-ink">{stats.streakDays}</span> ngày liên tiếp</span>
      </div>
    </dl>
  );
}

// Which words to practise: all the user sees, only their own (own words and
// shared words on their list), or only the shared vocabulary.
const SCOPE_OPTIONS = [['', 'Tất cả từ'], ['mine', 'Từ của tôi'], ['shared', 'Kho chung']];

function CategoryFilters({ topic, setTopic, wordType, setWordType, status, setStatus, scope, setScope, topics, children }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {setScope && (
        <Field label="Phạm vi">
          <select value={scope} onChange={(e) => setScope(e.target.value)} className={inputClass}>
            {SCOPE_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
      )}
      <Field label="Chủ đề">
        <select value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass}>
          <option value="">Tất cả chủ đề</option>
          {topics.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Loại từ">
        <select value={wordType} onChange={(e) => setWordType(e.target.value)} className={inputClass}>
          <option value="">Mọi loại từ</option>
          {WORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Trạng thái">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
          <option value="">Mọi trạng thái</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      {children}
    </div>
  );
}

function SrsSession({ topics, onReviewed, chapterId = '' }) {
  const [scope, setScope] = useState('');
  const [topic, setTopic] = useState('');
  const [wordType, setWordType] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(20);

  const [dueCountTotal, setDueCountTotal] = useState(null);
  const [queue, setQueue] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [grading, setGrading] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [error, setError] = useState('');

  const loadPreview = useCallback(() => {
    setError('');
    api.dueVocab({ topic, wordType, status, chapterId, scope, limit: 1 }).then((res) => setDueCountTotal(res.dueCountTotal)).catch((e) => setError(e.message));
  }, [topic, wordType, status, chapterId, scope]);

  useEffect(loadPreview, [loadPreview]);

  async function start() {
    setLoading(true);
    setError('');
    try {
      const res = await api.dueVocab({ topic, wordType, status, chapterId, scope, limit });
      setQueue(res.rows);
      setDueCountTotal(res.dueCountTotal);
      setCursor(0);
      setReviewedCount(0);
      setRevealed(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const current = queue?.[cursor];
  const finished = queue && cursor >= queue.length;

  const grade = useCallback(async (g) => {
    setGrading(true);
    setError('');
    try {
      await api.reviewVocab(queue[cursor].id, g);
      setReviewedCount((c) => c + 1);
      setRevealed(false);
      setCursor((c) => c + 1);
      onReviewed?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setGrading(false);
    }
  }, [queue, cursor, onReviewed]);

  // Space or Enter turns the card; 1–4 grade it. Keys are ignored while
  // focus is on a control, so a focused button isn't triggered twice.
  useEffect(() => {
    if (!current) return undefined;
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && !grading && ['1', '2', '3', '4'].includes(e.key)) {
        grade(REVIEW_GRADES[Number(e.key) - 1].key);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, grading, grade]);

  function endSession() {
    setQueue(null);
    loadPreview();
  }

  if (!queue) {
    const willReview = dueCountTotal === null ? null : Math.min(dueCountTotal, limit);
    return (
      <Sheet className="space-y-5 p-5">
        <CategoryFilters topic={topic} setTopic={setTopic} wordType={wordType} setWordType={setWordType} status={status} setStatus={setStatus} scope={scope} setScope={setScope} topics={topics}>
          <Field label="Số từ tối đa mỗi phiên">
            <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 20)} className={inputClass} />
          </Field>
        </CategoryFilters>

        {error ? (
          <Notice action={<Button size="sm" onClick={loadPreview}>Thử lại</Button>}>Không tải được dữ liệu ôn tập: {error}</Notice>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
            <p className="text-body text-soft">
              {dueCountTotal === null
                ? 'Đang tải…'
                : dueCountTotal === 0
                  ? 'Không còn từ nào đến hạn với bộ lọc này. Hẹn bạn ngày mai, hoặc thử Thực hành tự do.'
                  : `${dueCountTotal} từ đến hạn khớp bộ lọc.`}
            </p>
            <Button variant="primary" size="lg" onClick={start} disabled={loading || !dueCountTotal}>
              {loading ? 'Đang tải…' : willReview ? `Bắt đầu ôn ${willReview} từ` : 'Bắt đầu ôn'}
            </Button>
          </div>
        )}
      </Sheet>
    );
  }

  if (finished) {
    return (
      <Sheet className="px-6 py-12 text-center">
        <p className="font-serif text-headline font-semibold text-ink">Đã ôn xong {reviewedCount} từ</p>
        <p className="mt-2 text-body text-soft">Lịch ôn của từng từ đã được tính lại theo mức bạn chấm.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="primary" onClick={endSession}>Ôn phiên khác</Button>
          <Link to="/library" className="inline-flex h-9 items-center rounded-md px-3.5 text-body font-medium text-soft hover:bg-sunken hover:text-ink">Về thư viện</Link>
        </div>
      </Sheet>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center gap-3">
        <Progress value={(cursor / queue.length) * 100} className="flex-1" />
        <span className="text-meta tabular-nums text-mute">Thẻ {cursor + 1}/{queue.length}</span>
        <Button size="sm" variant="ghost" onClick={endSession}>Kết thúc phiên</Button>
      </div>

      {error && <Notice>{error}</Notice>}

      <Sheet className="px-6 py-10 text-center sm:px-10">
        <div className="flex items-center justify-center gap-2">
          <p className="break-words font-serif text-[40px] font-semibold leading-tight text-ink">{current.term}</p>
          <SpeakButton id={`srs-${current.id}`} text={current.term} size={20} className="!h-9 !w-9" />
        </div>
        <p className="mt-2 text-lead text-soft">{current.ipa}</p>
        <p className="mt-1 text-meta text-mute">{[current.word_type, current.topic].filter(Boolean).join(', ')}</p>

        {!revealed ? (
          <div className="mt-9">
            <Button variant="primary" size="lg" onClick={() => setRevealed(true)}>Hiện nghĩa</Button>
            <p className="mt-3 hidden text-caption text-mute sm:block">hoặc nhấn <Kbd>Space</Kbd></p>
          </div>
        ) : (
          <div className="mt-8 space-y-3 border-t border-rule pt-7 text-left">
            <p className="font-serif text-title leading-snug text-ink">{current.meaning_vi}</p>
            {current.example && (
              <div className="flex items-start gap-1.5">
                <p className="font-serif text-lead italic leading-relaxed text-soft">{current.example}</p>
                <SpeakButton id={`srs-example-${current.id}`} text={current.example} />
              </div>
            )}
            <p className="text-caption tabular-nums text-mute">Đã ôn {current.repetitions} lần, khoảng lặp hiện tại {current.interval_days} ngày</p>
            {current.source_chapter_id && (
              <Link to={`/chapters/${current.source_chapter_id}#paragraph-${current.source_paragraph_id}`} className="inline-flex items-center gap-1 text-meta font-medium text-accent hover:text-accent-strong">
                Xem từ này trong đoạn sách gốc <ArrowRight size={14} />
              </Link>
            )}
            {current.source_book_title && (
              <p className="text-caption text-mute">
                Từ sách <span className="text-soft">{current.source_book_title}</span>
                {current.source_chapter_title && <>, {current.source_chapter_title}</>}
                {current.source_book_domain && <> ({current.source_book_domain})</>}
              </p>
            )}
          </div>
        )}
      </Sheet>

      {revealed && (
        <div className="grid grid-cols-4 gap-2">
          {REVIEW_GRADES.map((g, i) => (
            <button
              key={g.key}
              type="button"
              onClick={() => grade(g.key)}
              disabled={grading}
              className={`flex flex-col items-center gap-1 rounded-lg border bg-page px-2 py-3 text-body font-semibold transition-colors disabled:opacity-50 ${GRADE_STYLE[g.key]}`}
            >
              {GRADE_LABEL[g.key]}
              <span className="hidden sm:block"><Kbd>{i + 1}</Kbd></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FreePractice({ topics }) {
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState('Cần ôn gấp');
  const [topic, setTopic] = useState('');
  const [wordType, setWordType] = useState('');
  const [limit, setLimit] = useState(15);
  const [words, setWords] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hideMeaning, setHideMeaning] = useState(true);
  const [shown, setShown] = useState(() => new Set());

  async function load() {
    setLoading(true);
    try {
      const res = await api.reviewWords({ status, topic, wordType, scope, limit });
      setWords(res);
      setShown(new Set());
    } finally {
      setLoading(false);
    }
  }

  function reveal(id) {
    setShown((s) => new Set(s).add(id));
  }

  return (
    <div className="space-y-5">
      <Sheet className="space-y-5 p-5">
        <CategoryFilters topic={topic} setTopic={setTopic} wordType={wordType} setWordType={setWordType} status={status} setStatus={setStatus} scope={scope} setScope={setScope} topics={topics}>
          <Field label="Số từ">
            <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(e.target.value)} className={inputClass} />
          </Field>
        </CategoryFilters>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
          <label className="flex cursor-pointer items-center gap-2 text-body text-soft">
            <input type="checkbox" checked={hideMeaning} onChange={(e) => setHideMeaning(e.target.checked)} className="h-4 w-4 accent-accent" />
            Che nghĩa, bấm vào từng dòng để xem
          </label>
          <Button variant="primary" onClick={load} disabled={loading}>
            {loading ? 'Đang tải…' : words ? 'Lấy bảng khác' : 'Lấy bảng thực hành'}
          </Button>
        </div>
      </Sheet>

      {words && (
        <Sheet className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-body">
            <thead>
              <tr className="bg-sunken text-left text-meta text-mute">
                <th className="border-b border-rule px-4 py-2.5 font-medium">Từ / cụm từ</th>
                <th className="border-b border-rule px-4 py-2.5 font-medium">Nghĩa</th>
                <th className="w-[130px] border-b border-rule px-4 py-2.5 font-medium">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {words.map((w) => {
                const visible = !hideMeaning || shown.has(w.id);
                return (
                  <tr key={w.id} className="[&>td]:border-b [&>td]:border-rule [&>td]:px-4 [&>td]:py-3 [&>td]:align-top last:[&>td]:border-b-0">
                    <td>
                      <div className="flex items-center gap-1">
                        <span className="font-serif text-lead font-semibold text-ink">{w.term}</span>
                        <SpeakButton id={`practice-${w.id}`} text={w.term} size={14} className="!h-6 !w-6" />
                      </div>
                      <p className="mt-0.5 text-meta text-mute">{[w.ipa, w.word_type].filter(Boolean).join('  ')}</p>
                    </td>
                    <td>
                      {visible ? (
                        <span className="text-ink">{w.meaning_vi}</span>
                      ) : (
                        <button type="button" onClick={() => reveal(w.id)} className="rounded-md border border-dashed border-rule px-2.5 py-0.5 text-meta text-mute hover:border-accent hover:text-accent">
                          Xem nghĩa
                        </button>
                      )}
                    </td>
                    <td><StatusBadge status={w.status} /></td>
                  </tr>
                );
              })}
              {words.length === 0 && <tr><td colSpan={3} className="px-4 py-10 text-center text-soft">Không có từ nào khớp bộ lọc.</td></tr>}
            </tbody>
          </table>
        </Sheet>
      )}
    </div>
  );
}

export default function ReviewPage() {
  const [tab, setTab] = useState('srs');
  // Arriving from the end of a chapter: review only that chapter's words.
  const [params, setParams] = useSearchParams();
  const chapterId = params.get('chapter') || '';
  const [chapterTitle, setChapterTitle] = useState('');
  useEffect(() => {
    if (!chapterId) { setChapterTitle(''); return; }
    api.getChapter(chapterId).then((c) => setChapterTitle(c.title)).catch(() => setChapterTitle(''));
  }, [chapterId]);
  const [topics, setTopics] = useState([]);
  const [stats, setStats] = useState(null);

  const refreshStats = useCallback(() => {
    api.reviewStats().then(setStats).catch(() => {});
    notifyReviewChanged();
  }, []);

  useEffect(() => {
    api.vocabTopics().then(setTopics).catch(() => {});
    refreshStats();
  }, [refreshStats]);

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Ôn tập từ vựng"
        actions={<Segmented label="Kiểu ôn tập" options={TABS} value={tab} onChange={setTab} />}
      />
      <ReviewSummary stats={stats} />
      {chapterId && tab === 'srs' && (
        <Notice tone="info" action={<Button size="sm" variant="ghost" onClick={() => setParams({})}>Ôn tất cả từ</Button>}>
          Chỉ ôn các từ của chương <strong>{chapterTitle || '…'}</strong>.{' '}
          <Link to={`/chapters/${chapterId}`} className="underline underline-offset-2">Quay lại chương</Link>
        </Notice>
      )}
      {tab === 'srs' ? <SrsSession key={chapterId} topics={topics} onReviewed={refreshStats} chapterId={chapterId} /> : <FreePractice topics={topics} />}
    </PageContainer>
  );
}
