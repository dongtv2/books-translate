import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { api } from '../api.js';
import { Button, Sheet, inputClass } from './ui.jsx';

// Words users asked to add to the shared vocabulary, for editors. Approving
// makes the word shared (the proposer keeps their progress); when the
// shared vocabulary already has it, the proposal folds into that entry.
function Proposal({ p, onDone }) {
  const [meaning, setMeaning] = useState(p.meaning_vi);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const [working, setWorking] = useState(false);

  async function act(fn) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    try { await fn(); onDone(); } catch (e) { setError(e.message); } finally { busy.current = false; setWorking(false); }
  }

  return (
    <li className="space-y-2 border-b border-rule px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-serif font-semibold text-ink">{p.term}</span>
        <span className="text-meta text-mute">{[p.ipa, p.word_type].filter(Boolean).join(' · ')}</span>
        <span className="text-caption text-mute">đề xuất bởi {p.owner_name || p.owner_email}</span>
      </div>
      {p.proposal_note && <p className="text-meta text-soft">“{p.proposal_note}”</p>}
      {p.shared_id && (
        <p className="text-meta text-warn">Kho chung đã có “{p.shared_term}”: {p.shared_meaning}. Duyệt sẽ gộp vào mục đó (giữ nghĩa của kho chung).</p>
      )}
      {!p.shared_id && (
        <label className="block text-meta text-soft">
          Nghĩa sẽ vào kho chung
          <input value={meaning} onChange={(e) => setMeaning(e.target.value)} className={`${inputClass} mt-1 py-1`} />
        </label>
      )}
      {rejecting && (
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Lý do (người đề xuất sẽ thấy)" aria-label="Lý do từ chối" className={`${inputClass} py-1`} />
      )}
      {error && <p className="text-caption text-flag">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!rejecting ? (
          <>
            <Button size="sm" variant="primary" disabled={working} onClick={() => act(() => api.approveProposal(p.id, p.shared_id ? {} : { meaning_vi: meaning }))}>
              <Check size={14} /> Duyệt
            </Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => setRejecting(true)}><X size={14} /> Từ chối</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="danger" disabled={working} onClick={() => act(() => api.rejectProposal(p.id, note))}>Xác nhận từ chối</Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Huỷ</Button>
          </>
        )}
      </div>
    </li>
  );
}

export default function VocabProposals({ refreshKey, onChanged }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api.vocabProposals().then(setItems).catch(() => setItems([]));
  }, [refreshKey, reload]);

  if (!items.length) return null;
  return (
    <Sheet>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-body text-soft"><span className="font-semibold tabular-nums text-ink">{items.length}</span> từ được đề xuất vào kho chung, đang chờ duyệt.</p>
        <Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen((v) => !v)}>{open ? 'Đóng' : 'Xem và duyệt'}</Button>
      </div>
      {open && (
        <ul className="border-t border-rule">
          {items.map((p) => <Proposal key={p.id} p={p} onDone={() => { setReload((n) => n + 1); onChanged?.(); }} />)}
        </ul>
      )}
    </Sheet>
  );
}
