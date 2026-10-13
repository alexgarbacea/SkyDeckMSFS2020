import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------- Icons

const ICONS = {
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  swap: 'M7 7h11l-3-3M17 17H6l3 3',
  search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5L20 20',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7.6 7.6 0 0 1-2 1.2L15 20.3h-3.6l-.3-2a7.6 7.6 0 0 1-2-1.2l-1.9.7L5.4 14.7 7 13.5a7.6 7.6 0 0 1 0-2.4L5.4 9.9l1.8-3.1 1.9.7a7.6 7.6 0 0 1 2-1.2l.3-2h3.6l.3 2a7.6 7.6 0 0 1 2 1.2l1.9-.7 1.8 3.1-1.6 1.2a7.6 7.6 0 0 1 0 2.4z',
  layout: 'M4 5h16v14H4zM13 5v14M13 12h7',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  follow: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  north: 'M12 3l5 16-5-3.5L7 19z',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  direct: 'M4 12h11M11 7l5 5-5 5M19 5v14',
  info: 'M12 11v6M12 7.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  plane: 'M12 2.5l1.6 7 7.4 3.6v2l-7.4-2-.5 5 2.4 1.8v1.6L12 20.4l-3.5 1.1v-1.6l2.4-1.8-.5-5-7.4 2v-2l7.4-3.6z',
  sync: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8',
  moveTo: 'M12 21s-6-5.6-6-10a6 6 0 1 1 12 0c0 4.4-6 10-6 10zM12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  keyboard: 'M3 7h18v10H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  chevronDown: 'M6 9l6 6 6-6',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------- Buttons

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
};

export function Button({ variant = 'default', size = 'md', icon, className = '', children, ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn btn--${variant} btn--${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/** A lit/unlit push button, like an autopilot mode key with an annunciator bar. */
export function ModeButton({
  on,
  label,
  onClick,
  disabled,
  tone = 'green',
  title,
  wide,
}: {
  on: boolean;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'green' | 'cyan' | 'amber';
  title?: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={`mode-btn mode-btn--${tone} ${on ? 'is-on' : ''} ${wide ? 'mode-btn--wide' : ''}`}
      aria-pressed={on}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <span className="mode-btn__bar" aria-hidden="true" />
      <span className="mode-btn__label">{label}</span>
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true" />
      <span className="switch__text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------- Value field

/**
 * A selectable target value (heading bug, altitude, frequency...). Shows the value in cyan; click to type,
 * scroll or use the arrow buttons to step. Shift makes steps bigger.
 */
export function ValueField({
  label,
  value,
  format,
  parse,
  onCommit,
  step,
  bigStep,
  min,
  max,
  wrap,
  unit,
  disabled,
  size = 'md',
  hint,
}: {
  label: string;
  value: number;
  format: (v: number) => string;
  parse?: (text: string) => number | null;
  onCommit: (v: number) => void;
  step?: number;
  bigStep?: number;
  min?: number;
  max?: number;
  /** Wrap around (e.g. heading 1..360). */
  wrap?: number;
  unit?: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = pending ?? value;

  // Drop the optimistic value once the simulator reports it (or after a while if it never does).
  useEffect(() => {
    if (pending != null && Math.abs(pending - value) < 0.0015) setPending(null);
  }, [value, pending]);
  useEffect(() => {
    if (pending == null) return;
    const t = window.setTimeout(() => setPending(null), 2500);
    return () => window.clearTimeout(t);
  }, [pending]);

  const clamp = (v: number) => {
    if (wrap) return ((v % wrap) + wrap) % wrap || wrap;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  };

  const nudge = (dir: 1 | -1, big: boolean) => {
    if (!step || disabled) return;
    const s = big && bigStep ? bigStep : step;
    const base = pending ?? value;
    const next = clamp(Math.round((base + dir * s) / s) * s);
    setPending(next);
    window.clearTimeout(timer.current);
    // Batch fast scrolling into one command.
    timer.current = window.setTimeout(() => onCommit(next), 120);
  };

  const commitText = () => {
    setEditing(false);
    const v = parse ? parse(text) : Number(text);
    if (v == null || !Number.isFinite(v)) return;
    const c = clamp(v);
    setPending(c);
    onCommit(c);
  };

  return (
    <div className={`value-field value-field--${size} ${disabled ? 'is-disabled' : ''}`} title={hint}>
      <span className="value-field__label">{label}</span>
      <div
        className="value-field__window"
        onWheel={(e) => {
          if (editing) return;
          nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
        }}
      >
        {step != null && (
          <button type="button" className="value-field__step" aria-label={`Decrease ${label}`} disabled={disabled} onClick={(e) => nudge(-1, e.shiftKey)}>
            <Icon name="minus" size={14} />
          </button>
        )}
        {editing ? (
          <input
            ref={inputRef}
            className="value-field__input"
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={label}
          />
        ) : (
          <button
            type="button"
            className="value-field__value"
            disabled={disabled}
            onClick={() => {
              setText(format(shown).replace(/[^\d.\-−A-Z]/gi, '').replace('−', '-'));
              setEditing(true);
            }}
            aria-label={`${label}: ${format(shown)}. Click to type a new value.`}
          >
            {format(shown)}
            {unit && <small>{unit}</small>}
          </button>
        )}
        {step != null && (
          <button type="button" className="value-field__step" aria-label={`Increase ${label}`} disabled={disabled} onClick={(e) => nudge(1, e.shiftKey)}>
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Readouts & layout helpers

export function Readout({
  label,
  value,
  unit,
  tone,
  sub,
  compact,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: 'cyan' | 'magenta' | 'green' | 'amber';
  sub?: ReactNode;
  /** Smaller value text, for long values like wind. */
  compact?: boolean;
}) {
  return (
    <div className={`readout ${tone ? `readout--${tone}` : ''} ${compact ? 'readout--compact' : ''}`}>
      <span className="readout__label">{label}</span>
      <span className="readout__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {sub && <span className="readout__sub">{sub}</span>}
    </div>
  );
}

export function Section({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`section ${className}`}>
      {(title || actions) && (
        <header className="section__head">
          {title && <h3>{title}</h3>}
          {actions && <div className="section__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- Modal

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
  className = '',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean | 'full';
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className={`modal ${wide === 'full' ? 'modal--full' : wide ? 'modal--wide' : ''} ${className}`}>
        <header className="modal__head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
