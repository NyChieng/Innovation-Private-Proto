import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { CONSERVATION, STATUS, fromServer, initials, relativeTime, titleCase } from '../lib/format.js';
import { useApp } from '../lib/store.jsx';
import { SmartImage, useCardTilt } from './motion.jsx';
import { t } from '../lib/i18n.js';
import * as I from '../lib/icons.jsx';

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export function StatusBadge({ status }) {
  const s = STATUS[status] || { label: titleCase(status), cls: 'badge-neutral' };
  return <span className={'badge ' + s.cls}><span className="dot" />{s.label}</span>;
}

export function ConservationBadge({ code, label, showLabel = true }) {
  if (!code) return null;
  const meta = CONSERVATION[code] || { label: label || code, threat: false };
  return (
    <span className={'cs' + (meta.threat ? ' cs-threat' : '')} title={meta.label}>
      <span className="cs-swatch" style={{ background: `var(--cs-${code})` }}>{code}</span>
      {showLabel && <span>{meta.label}</span>}
    </span>
  );
}

export function Avatar({ name, role, size = '' }) {
  const cls = ['avatar', size && 'avatar-' + size, role && 'avatar-' + role].filter(Boolean).join(' ');
  return <span className={cls} aria-hidden="true">{initials(name)}</span>;
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export function PageHead({ title, sub, children, back }) {
  return (
    <div className="page-head">
      <div>
        {back && (
          <Link to={back.to} className="btn btn-ghost btn-sm" style={{ marginLeft: -10, marginBottom: 6 }}>
            <I.ArrowLeft /> {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children && <div className="row row-wrap">{children}</div>}
    </div>
  );
}

export function Empty({ icon: Icon = I.Leaf, title, children, action }) {
  return (
    <div className="empty">
      <Icon />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Notice({ kind = 'info', icon: Icon, title, children }) {
  const Ico = Icon || (kind === 'warn' ? I.Alert : kind === 'danger' ? I.Alert : kind === 'ok' ? I.CheckCircle : I.Info);
  const cls = { info: '', warn: ' notice-warn', danger: ' notice-danger', ok: ' notice-ok', plain: ' notice-plain' }[kind] || '';
  return (
    <div className={'notice' + cls}>
      <Ico />
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, detail, accent }) {
  return (
    <div className={'stat' + (accent ? ' stat-accent' : '')}>
      <div className="l">{label}</div>
      <div className="n">{value}</div>
      {detail && <div className="d">{detail}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r, style }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function LoadingBlock({ label }) {
  return (
    <div className="empty">
      <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
        <span className="spinner" /> <span className="mute">{label ?? t('Loading')}...</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/*
 * Page scrolling is locked while any dialog is open, counted rather than
 * saved and restored per dialog. A confirm opened from inside another dialog
 * (Deactivate, inside an account) closes in the same render as its parent,
 * and React tears the parent down first: with save-and-restore, the confirm
 * then put back the "hidden" it had seen, and the page stayed frozen.
 */
let scrollLocks = 0;
let scrollBefore = '';
function lockScroll() {
  if (scrollLocks++ === 0) {
    scrollBefore = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}
function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = scrollBefore;
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prevFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeRef.current?.();
        return;
      }
      if (e.key === 'Tab' && ref.current) {
        const nodes = [...ref.current.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )];
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    lockScroll();
    // Move focus into the dialog so keyboard and screen-reader users land here.
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      unlockScroll();
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, []);

  // Rendered into document.body rather than in place. The backdrop is
  // position: fixed, and an ancestor carrying a transform or will-change:
  // transform - which the page wrappers do, for the enter animation - becomes
  // the containing block for it. Left in place, the backdrop is clipped to
  // that page element instead of covering the viewport.
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('Close')}><I.X /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn', icon: Icon, title, body }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>{Icon && <Icon />}{label}</button>
      {open && (
        <Modal
          title={title || label}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>{t('Cancel')}</button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try { await onConfirm(); setOpen(false); } finally { setBusy(false); }
                }}
              >
                {busy && <span className="spinner" />}{confirmLabel || t('Confirm')}
              </button>
            </>
          }
        >
          {body}
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className={'toast toast-' + item.kind} onClick={() => dismissToast(item.id)}>
          {item.kind === 'err' ? <I.Alert /> : <I.CheckCircle />}
          <span className="grow">{item.message}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plant card                                                          */
/* ------------------------------------------------------------------ */

export function PlantCard({ plant, to, showStatus, eager = false, hideSite = false }) {
  const sci = plant.scientific_name || plant.proposed_species_name || t('Unidentified specimen');
  // Visitors know plants by their everyday name; the scientific name sits under it.
  const title = plant.common_name || plant.local_name || sci;
  const showSci = title !== sci;
  const tilt = useCardTilt();
  return (
    <Link className="plant-card" to={to || `/plant/${plant.id}`} {...tilt}>
      <div className="plant-photo">
        <SmartImage src={plant.photo} fallback={plant.photo_remote} tint={plant.photo_tint} alt="" eager={eager} />
        <div className="overlay-tl">
          {showStatus && <StatusBadge status={plant.status} />}
          {plant.species_not_listed && <span className="badge badge-info">{t('Species not listed')}</span>}
        </div>
        {plant.conservation_code && (
          <div className="overlay-tr"><ConservationBadge code={plant.conservation_code} showLabel={false} /></div>
        )}
      </div>
      <div className="plant-card-body">
        <div className="plant-card-title">{title}</div>
        {showSci && <div className="plant-card-name">{sci}</div>}
        {!hideSite && (
          <div className="plant-card-site truncate">
            {plant.location_protected ? t('Location withheld') : fromServer(plant.site_name)}
          </div>
        )}
        <div className="plant-card-foot">
          <span className="mono tiny faint">{plant.plant_code}</span>
          <span className="spacer" />
          {plant.status === 'approved' && plant.view_count > 0 && (
            <span className="tiny faint row" style={{ gap: 4 }}><I.Eye style={{ width: 12, height: 12 }} />{plant.view_count}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function PlantRow({ plant, onClick, children }) {
  const name = plant.scientific_name || plant.proposed_species_name || t('Unidentified');
  return (
    <tr onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <td style={{ width: 54 }}>
        <div style={{ width: 42, height: 42, borderRadius: 8, overflow: 'hidden', background: 'var(--surface-3)' }}>
          <SmartImage src={plant.photo} fallback={plant.photo_remote} tint={plant.photo_tint} alt="" placeholderLabel={false} />
        </div>
      </td>
      <td>
        <div className={plant.scientific_name ? 'sci strong' : 'strong'}>{name}</div>
        <div className="tiny mute">{plant.common_name || (plant.species_not_listed ? t('Awaiting identification') : '—')}</div>
      </td>
      <td className="mono tiny nowrap">{plant.plant_code}</td>
      <td className="small"><span className="truncate" style={{ maxWidth: 210, display: 'block' }}>{fromServer(plant.site_name)}</span></td>
      <td>{plant.conservation_code ? <ConservationBadge code={plant.conservation_code} showLabel={false} /> : <span className="faint">--</span>}</td>
      <td><StatusBadge status={plant.status} /></td>
      <td className="tiny mute nowrap">{relativeTime(plant.registered_at)}</td>
      {children}
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Filter chips                                                        */
/* ------------------------------------------------------------------ */

export function ChipRow({ options, value, onChange, allLabel }) {
  return (
    <div className="row row-wrap" style={{ gap: 7 }}>
      <button className="chip" aria-pressed={!value} onClick={() => onChange('')}>{allLabel ?? t('All')}</button>
      {options.map((o) => {
        const val = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return (
          <button key={val} className="chip" aria-pressed={value === val} onClick={() => onChange(value === val ? '' : val)}>
            {label}
            {typeof o !== 'string' && o.count !== undefined && <span className="tiny" style={{ opacity: 0.7 }}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder: given, large, autoFocus }) {
  const placeholder = given ?? t('Search');
  return (
    <div className={'search' + (large ? ' search-lg' : '')}>
      <I.Search />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={placeholder}
        type="search"
      />
      {value && (
        <button className="btn btn-ghost btn-icon" onClick={() => onChange('')} aria-label={t('Clear search')}><I.X /></button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy-to-clipboard                                                   */
/* ------------------------------------------------------------------ */

export function CopyButton({ text, label, className = 'btn btn-sm' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard API needs a secure context; fall back to a selectable prompt.
          window.prompt(t('Copy this:'), text);
        }
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <I.Check /> : <I.Copy />}{done ? t('Copied') : (label ?? t('Copy'))}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Coming soon                                                         */
/* ------------------------------------------------------------------ */

export function ComingSoon({ icon: Icon = I.Sensor, title, children, note }) {
  return (
    <div className="soon">
      <Icon />
      <h2 style={{ marginBottom: 8 }}>{title}</h2>
      <div className="mute" style={{ maxWidth: '58ch', marginInline: 'auto', fontSize: '0.92rem' }}>{children}</div>
      {note && <div style={{ marginTop: 18 }}><span className="badge badge-warn"><span className="dot" />{note}</span></div>}
    </div>
  );
}
