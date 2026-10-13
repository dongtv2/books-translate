import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// A title edited in place (chapter title, section heading) in the chapter's
// edit mode: it looks like the title, wraps like it, and saves itself on
// Enter or when focus leaves. Escape puts back the saved title.
export default function InlineTitle({ value, onSave, placeholder, className = '', label }) {
  const [draft, setDraft] = useState(value || '');
  const [status, setStatus] = useState(''); // '' | 'saving' | 'error'
  const ref = useRef(null);

  useEffect(() => { setDraft(value || ''); }, [value]);

  // Grow with the text, so a long title wraps instead of scrolling.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  async function commit() {
    const next = draft.trim();
    if (next === (value || '').trim()) { setDraft(value || ''); return; }
    setStatus('saving');
    try {
      await onSave(next);
      setStatus('');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="relative -mx-2 min-w-0 flex-1">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(value || ''); requestAnimationFrame(() => ref.current?.blur()); }
        }}
        className={`block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-0.5 placeholder:font-normal placeholder:text-mute hover:border-rule/70 focus:border-accent/60 focus:bg-page focus:outline-none ${className}`}
      />
      {status && (
        <span className={`absolute -bottom-5 left-2 text-caption ${status === 'error' ? 'text-flag' : 'text-mute'}`}>
          {status === 'error' ? 'Không lưu được tiêu đề. Sửa lại để thử lần nữa.' : 'Đang lưu…'}
        </span>
      )}
    </div>
  );
}
