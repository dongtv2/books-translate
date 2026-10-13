// Shared interface primitives. Every page builds from these so a control
// looks and behaves the same wherever it appears.

const BUTTON_BASE = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-on-accent hover:bg-accent-strong',
  secondary: 'border border-rule bg-page text-ink hover:border-mute',
  ghost: 'text-soft hover:bg-sunken hover:text-ink',
  danger: 'text-flag hover:bg-flag-soft',
  dangerSolid: 'bg-flag text-page hover:opacity-90',
};

const BUTTON_SIZES = {
  sm: 'h-8 px-2.5 text-meta',
  md: 'h-9 px-3.5 text-body',
  lg: 'h-11 px-5 text-lead',
};

// Exposed so a <Link> can share the exact button look.
export function buttonClass(variant = 'secondary', size = 'md', extra = '') {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${extra}`;
}

export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...props }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

// Square icon-only control. `label` is required: it is the accessible name
// and the tooltip, since there is no visible text.
export function IconButton({ label, active = false, tone = 'accent', className = '', children, ...props }) {
  const activeClass = {
    accent: 'bg-accent-soft text-accent',
    flag: 'bg-flag-soft text-flag',
    marker: 'bg-marker-soft text-warn',
  }[tone];
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? activeClass : 'text-mute hover:bg-sunken hover:text-ink'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export const inputClass = 'w-full rounded-md border border-rule bg-page px-3 py-2 text-body text-ink placeholder:text-mute focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';

export function Field({ label, hint, className = '', children }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-meta font-medium text-soft">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-caption text-mute">{hint}</span>}
    </label>
  );
}

// Mutually exclusive choice shown as one joined control (view mode, theme…).
export function Segmented({ options, value, onChange, size = 'md', label, className = '' }) {
  const pad = size === 'sm' ? 'h-7 px-2.5 text-meta' : 'h-8 px-3 text-body';
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex rounded-md border border-rule bg-sunken p-0.5 ${className}`}>
      {options.map((o) => {
        const selected = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.hint}
            onClick={() => onChange(o.key)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] font-medium transition-colors ${pad} ${
              selected ? 'bg-page text-ink shadow-sm' : 'text-mute hover:text-ink'
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Page sections as tabs on one underline (a book's contents, details,
// marks…). Arrow keys move between tabs. Pair each panel with
// role="tabpanel" id={`panel-${key}`} aria-labelledby={`tab-${key}`}.
export function Tabs({ tabs, value, onChange, label, className = '' }) {
  function onKeyDown(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.key === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.key);
    document.getElementById(`tab-${next.key}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`flex gap-1 overflow-x-auto border-b border-rule ${className}`}>
      {tabs.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            id={`tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-lead font-medium transition-colors ${
              selected ? 'border-accent text-ink' : 'border-transparent text-mute hover:text-ink'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span className={`rounded-full px-1.5 text-caption tabular-nums ${selected ? 'bg-accent-soft text-accent' : 'bg-sunken text-mute'}`}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Progress({ value, tone = 'accent', className = '' }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const fill = tone === 'ok' ? 'bg-ok' : 'bg-accent';
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1.5 overflow-hidden rounded-full bg-rule ${className}`}
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const NOTICE_TONES = {
  error: 'border-flag/30 bg-flag-soft text-flag',
  ok: 'border-ok/30 bg-ok-soft text-ok',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  info: 'border-accent/25 bg-accent-soft text-accent',
};

export function Notice({ tone = 'error', action, className = '', children }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border px-3.5 py-2.5 text-body ${NOTICE_TONES[tone]} ${className}`}
    >
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

const TAG_TONES = {
  neutral: 'bg-sunken text-soft',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  flag: 'bg-flag-soft text-flag',
  marker: 'bg-marker-soft text-warn',
};

export function Tag({ tone = 'neutral', className = '', children, ...props }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption font-medium ${TAG_TONES[tone]} ${className}`} {...props}>
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-serif text-headline font-semibold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-body text-mute">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// A white sheet on the desk. Used sparingly: for a form, a table, a page of
// book text. Lists and stats sit directly on the desk.
export function Sheet({ className = '', children, ...props }) {
  return (
    <div className={`rounded-lg border border-rule bg-page ${className}`} {...props}>
      {children}
    </div>
  );
}

export function LoadingLine({ children = 'Đang tải…' }) {
  return <p className="px-4 py-10 text-center text-body text-mute sm:px-8">{children}</p>;
}

// Small anchored panel built on a native <details> disclosure, so it needs
// no open/close state: it closes on an outside click or Escape. `align`
// picks which edge of the trigger the panel lines up with.
export function Popover({ trigger, label, align = 'right', width = 'w-64', triggerClassName = '', children }) {
  function attach(el) {
    if (!el) return undefined;
    const onClick = (e) => { if (el.open && !el.contains(e.target)) el.removeAttribute('open'); };
    const onKey = (e) => { if (e.key === 'Escape') el.removeAttribute('open'); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }

  return (
    <details ref={attach} className="relative shrink-0">
      <summary
        title={label}
        aria-label={label}
        className={`flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden ${triggerClassName}`}
      >
        {trigger}
      </summary>
      <div className={`absolute z-30 mt-1.5 rounded-lg border border-rule bg-page p-1.5 shadow-lg ${width} ${align === 'right' ? 'right-0' : 'left-0'}`}>
        {children}
      </div>
    </details>
  );
}

// A row inside a Popover menu. Closes the menu after acting.
export function MenuItem({ onClick, danger = false, disabled = false, icon, children }) {
  function handleClick(e) {
    e.currentTarget.closest('details')?.removeAttribute('open');
    onClick?.();
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-meta transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        danger ? 'text-flag hover:bg-flag-soft' : 'text-ink hover:bg-sunken'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
