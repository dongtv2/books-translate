import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import ParagraphCard from './ParagraphCard.jsx';
import { Button, Sheet, inputClass } from './ui.jsx';
import InlineTitle from './InlineTitle.jsx';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { useLayoutSettings } from '../context/LayoutSettingsContext.jsx';
import { paragraphGridCols } from '../lib/paragraphLayout.js';

export default function SectionBlock({ section, index = 0, onRefresh, onParagraphUpdated, readMode = false }) {
  const sectionNumber = index + 1;
  const confirm = useConfirm();
  const { settings } = useLayoutSettings();
  const showNotes = settings.showNotes !== false;
  const [addingText, setAddingText] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleAddParagraphs() {
    if (!addingText.trim()) return;
    setBusy(true);
    try {
      await api.addParagraphs(section.id, addingText);
      setAddingText('');
      setShowAdd(false);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveHeading(heading) {
    await api.updateSection(section.id, { heading });
    onRefresh();
  }

  async function handleSaveHeadingVi(headingVi) {
    await api.updateSection(section.id, { heading_vi: headingVi });
    onRefresh();
  }

  async function handleDeleteSection() {
    if (!(await confirm('Xoá mục này và toàn bộ đoạn văn bên trong?'))) return;
    await api.deleteSection(section.id);
    onRefresh();
  }

  return (
    <section id={`section-${section.id}`} className="scroll-mt-28 space-y-3">
      {readMode ? (
        // Sections created without a heading are the common case — the "add
        // paragraph to this chapter" flow appends to one transparently — so
        // in read mode they show no title bar at all.
        section.heading && (
          <h2 className="font-serif text-title font-semibold leading-snug text-ink">
            {section.heading}
            {section.heading_vi && <span className="mt-0.5 block text-lead font-normal text-soft">{section.heading_vi}</span>}
          </h2>
        )
      ) : (
        // Edit mode: the heading is edited in place, like the paragraphs.
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 flex-1">
            <InlineTitle
              value={section.heading || ''}
              label={`Tiêu đề mục ${sectionNumber}`}
              placeholder={sectionNumber === 1 ? 'Đoạn mở đầu chương — đặt tiêu đề để thành một mục' : 'Chưa có tiêu đề — đặt tiêu đề để thành một mục'}
              onSave={handleSaveHeading}
              className="font-serif text-title font-semibold leading-snug text-ink"
            />
            {section.heading && (
              <InlineTitle
                value={section.heading_vi || ''}
                label={`Tiêu đề tiếng Việt của mục ${sectionNumber}`}
                placeholder="Tiêu đề mục tiếng Việt"
                onSave={handleSaveHeadingVi}
                className="font-serif text-lead leading-snug text-soft"
              />
            )}
          </div>
          {(section.heading || section.paragraphs.length === 0) && (
            <Button size="sm" variant="danger" onClick={handleDeleteSection}>Xoá mục</Button>
          )}
        </div>
      )}

      {section.paragraphs.length === 0 ? (
        <p className="text-body italic text-mute">Mục này chưa có đoạn văn nào.</p>
      ) : (
        <Sheet>
          {/* Column labels once, on the chapter's first spread; the layout
              repeats identically below so later sections don't need them. */}
          {index === 0 && (
            <div className={`hidden rounded-t-lg border-b border-rule bg-sunken text-caption font-medium text-mute lg:grid ${paragraphGridCols(showNotes || !readMode)}`}>
              <span />
              <span className="py-2 pr-7">English</span>
              <span className="border-l border-rule px-7 py-2">Tiếng Việt</span>
              {(showNotes || !readMode) && <span className="border-l border-rule px-6 py-2">Ghi chú</span>}
            </div>
          )}
          {section.paragraphs.map((p, i) => (
            <ParagraphCard key={p.id} paragraph={p} onRefresh={onRefresh} onUpdated={onParagraphUpdated} index={i} readMode={readMode} />
          ))}
        </Sheet>
      )}

      {!readMode && (
        showAdd ? (
          <div className="space-y-2.5 rounded-lg border border-dashed border-rule p-3">
            <textarea
              autoFocus
              value={addingText}
              onChange={(e) => setAddingText(e.target.value)}
              placeholder="Dán thêm đoạn văn tiếng Anh. Để một dòng trống giữa các đoạn."
              rows={4}
              className={inputClass}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={handleAddParagraphs} disabled={busy}>
                {busy ? 'Đang thêm…' : 'Thêm đoạn văn'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowAdd(false); setAddingText(''); }}>Huỷ</Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Thêm đoạn văn vào mục này
          </Button>
        )
      )}
    </section>
  );
}
