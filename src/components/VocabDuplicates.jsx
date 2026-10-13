import { useEffect, useState } from 'react';
import { Combine, X } from 'lucide-react';
import { api } from '../api.js';
import { Button, Sheet } from './ui.jsx';

// Groups of entries the server thinks are one item stored twice ("attachment
// to" / "attachment", "non-adaptive" / "nonadaptive"). For each, pick the
// entry to keep and merge the rest into it — everyone's review progress and
// history move along — or mark the group as different words.
function Group({ group, onMerged, onDismissed }) {
  const [keepId, setKeepId] = useState(group[0].id);
  const [busy, setBusy] = useState(false);

  async function act(fn) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  return (
    <li className="space-y-2 border-b border-rule px-4 py-3 last:border-b-0">
      <div role="radiogroup" aria-label="Giữ lại mục nào" className="space-y-1">
        {group.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-baseline gap-2 text-body">
            <input type="radio" name={`keep-${group[0].id}`} checked={keepId === r.id} onChange={() => setKeepId(r.id)} />
            <span className="font-serif font-semibold text-ink">{r.term}</span>
            <span className="text-meta text-mute">{r.word_type}</span>
            <span className="min-w-0 truncate text-soft" title={r.meaning_vi}>{r.meaning_vi}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => act(async () => {
          await api.mergeVocab(keepId, group.map((r) => r.id).filter((id) => id !== keepId));
          onMerged();
        })}>
          <Combine size={14} /> Gộp vào mục đã chọn
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(async () => {
          await api.dismissVocabDuplicates(group.map((r) => r.id));
          onDismissed();
        })}>
          Không phải trùng
        </Button>
      </div>
    </li>
  );
}

export default function VocabDuplicates({ refreshKey, onChanged }) {
  const [groups, setGroups] = useState([]);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api.vocabDuplicates().then(setGroups).catch(() => setGroups([]));
  }, [refreshKey, reload]);

  if (!groups.length) return null;
  const refresh = () => { setReload((n) => n + 1); onChanged?.(); };

  return (
    <Sheet>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-body text-soft">
          <span className="font-semibold tabular-nums text-ink">{groups.length}</span> nhóm từ có thể đang bị lưu trùng.
        </p>
        <Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen((v) => !v)}>
          {open ? <><X size={14} /> Đóng</> : 'Xem và gộp'}
        </Button>
      </div>
      {open && (
        <ul className="border-t border-rule">
          {groups.map((g) => <Group key={g.map((r) => r.id).join('-')} group={g} onMerged={refresh} onDismissed={refresh} />)}
        </ul>
      )}
    </Sheet>
  );
}
