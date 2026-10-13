import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Button } from '../components/ui.jsx';

const ConfirmContext = createContext(null);

// Styled replacement for window.confirm(): const ok = await confirm('...')
export function ConfirmProvider({ children }) {
  const [dialog, setDialog] = useState(null); // { message, confirmLabel, danger, resolve }

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      setDialog({
        message,
        confirmLabel: options.confirmLabel || 'Xoá',
        cancelLabel: options.cancelLabel || 'Huỷ',
        danger: options.danger !== false,
        resolve,
      });
    });
  }, []);

  function handle(result) {
    dialog?.resolve(result);
    setDialog(null);
  }

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { dialog.resolve(false); setDialog(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" onClick={() => handle(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-rule bg-page p-5 shadow-xl"
          >
            <p className="text-lead leading-relaxed text-ink">{dialog.message}</p>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handle(false)}>{dialog.cancelLabel}</Button>
              <Button variant={dialog.danger ? 'dangerSolid' : 'primary'} autoFocus onClick={() => handle(true)}>
                {dialog.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm phải được gọi bên trong ConfirmProvider.');
  return ctx;
}
