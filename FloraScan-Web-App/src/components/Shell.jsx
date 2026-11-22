import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store.jsx';
import { Avatar } from './ui.jsx';
import { ScrollProgress } from './motion.jsx';
import { BackToTop, Fern } from './forest.jsx';
import { homeFor, roleLabel } from '../lib/format.js';
import { LANGUAGES, t } from '../lib/i18n.js';
import * as I from '../lib/icons.jsx';

/* ------------------------------------------------------------------ */
/* Navigation model - one definition drives web sidebar and phone menu */
/* ------------------------------------------------------------------ */

/** An item is shown when its `need` is held, or any of its `needAny` are. */
const allowed = (can, item) =>
  (!item.need || can(item.need))
  && (!item.needAny || item.needAny.some((c) => can(c)))
  && (!item.hideIf || !can(item.hideIf));

export function staffNav(can, counts) {
  const groups = [];

  const plants = [
    { to: '/staff/plants', label: t('Plant register'), icon: I.Leaf, count: counts?.all, needAny: ['plant.view_all', 'plant.create'] },
    { to: '/staff/register', label: t('Register a plant'), icon: I.Plus, need: 'plant.create' },
    { to: '/staff/review', label: t('Review queue'), icon: I.CheckCircle, need: 'plant.approve', count: counts?.queue, alert: !!counts?.queue },
    { to: '/staff/submissions', label: t('My submissions'), icon: I.Clock, need: 'plant.create', hideIf: 'plant.approve' },
    { to: '/staff/tags', label: t('Print QR tags'), icon: I.Printer, need: 'qr.print' },
    { to: '/staff/species', label: t('Species list'), icon: I.Book, need: 'species.manage' },
    { to: '/staff/reports', label: t('Visitor reports'), icon: I.Flag, need: 'report.view', count: counts?.open_reports, alert: !!counts?.open_reports },
  ].filter((i) => allowed(can, i));
  if (plants.length) groups.push({ title: t('Plant management'), items: plants });

  const monitoring = [
    { to: '/staff/iot', label: t('IoT monitoring'), icon: I.Sensor, need: 'sensor.view' },
  ].filter((i) => !i.need || can(i.need));
  if (monitoring.length) groups.push({ title: t('Monitoring'), items: monitoring });

  const admin = [
    { to: '/staff/users', label: t('Staff accounts'), icon: I.Users, need: 'user.view' },
    { to: '/staff/activity', label: t('Activity log'), icon: I.Activity, need: 'system.audit' },
    { to: '/staff/audit', label: t('Audit trail'), icon: I.Shield, need: 'system.audit' },
    { to: '/staff/settings', label: t('System settings'), icon: I.Settings, need: 'system.settings' },
  ].filter((i) => !i.need || can(i.need));
  if (admin.length) groups.push({ title: t('Administration'), items: admin });

  return groups;
}

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

export function Brand({ to = '/', sub }) {
  return (
    <Link className="brand" to={to}>
      {/* The app icon: a QR scan frame around a leaf. Simplified slightly from
          the installed-icon artwork so it still reads at 32px. */}
      <span className="brand-mark">
        <svg viewBox="0 0 512 512" fill="none" aria-hidden="true">
          <g stroke="#a8e06a" strokeWidth="34" strokeLinecap="round">
            <path d="M120 188v-44a26 26 0 0 1 26-26h44" />
            <path d="M392 188v-44a26 26 0 0 0-26-26h-44" />
            <path d="M120 324v44a26 26 0 0 0 26 26h44" />
            <path d="M392 324v44a26 26 0 0 1-26 26h-44" />
          </g>
          <g transform="rotate(45 256 256)">
            <path d="M256 348C198 318 186 214 256 160C326 214 314 318 256 348Z" fill="#fff" />
            <path d="M256 368V184" stroke="#176039" strokeWidth="16" strokeLinecap="round" />
          </g>
        </svg>
      </span>
      <span>
        <span className="brand-name" style={{ display: 'block' }}>FloraScan</span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Theme switch                                                        */
/* ------------------------------------------------------------------ */

const THEMES = [
  { v: 'system', label: () => t('Automatic theme (follow device)'), icon: I.ThemeAuto },
  { v: 'light', label: () => t('Light theme'), icon: I.Sun },
  { v: 'dark', label: () => t('Dark theme'), icon: I.Moon },
];

/** Light, dark, or follow the device - in the header, so visitors can reach it too. */
export function ThemeSwitch() {
  const { theme, setTheme } = useApp();
  return (
    <div className="segmented theme-switch" role="group" aria-label={t('Colour theme')}>
      {THEMES.map(({ v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={theme === v}
          aria-label={label()}
          title={label()}
          className={theme === v ? 'active' : ''}
          onClick={() => setTheme(v)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Language switch                                                     */
/* ------------------------------------------------------------------ */

/**
 * English, Malay or Chinese. A native select rather than three buttons: it
 * fits the phone header beside the theme switch, and the platform's own
 * picker is the most accessible control there is. Each option is labelled
 * in its own language, so someone who cannot read the current one can still
 * find theirs.
 */
export function LanguageSwitch() {
  const { lang, setLang } = useApp();
  return (
    <label className="lang-switch" title={t('Language')}>
      <I.Globe aria-hidden="true" />
      <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('Language')}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.html}>{l.label}</option>
        ))}
      </select>
      <span className="lang-short" aria-hidden="true">{LANGUAGES.find((l) => l.code === lang)?.short}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Account menu                                                        */
/* ------------------------------------------------------------------ */

function AccountMenu() {
  const { user, signOut, counts } = useApp();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!e.target.closest('.acct-wrap')) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) {
    return (
      <Link to="/login" className="btn btn-soft btn-sm">
        <I.User /> {t('Staff sign in')}
      </Link>
    );
  }

  return (
    <div className="acct-wrap" style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar name={user.full_name} role={user.role} size="sm" />
        <span className="nowrap">{user.full_name.split(' ')[0]}</span>
        <I.ChevronDown style={{ width: 14, height: 14 }} />
      </button>
      {open && (
        <div
          className="card"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 240, boxShadow: 'var(--sh-3)', zIndex: 80, padding: 6 }}
        >
          <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
            <div className="strong small">{user.full_name}</div>
            <div className="tiny mute truncate">{user.email}</div>
            <div style={{ marginTop: 6 }}><span className="tag">{roleLabel(user.role_label)}</span></div>
          </div>
          <Link className="side-link" to="/staff/notifications" onClick={() => setOpen(false)}>
            <I.Bell /> {t('Notifications')}
            {!!counts?.unread_notifications && <span className="count alert">{counts.unread_notifications}</span>}
          </Link>
          <Link className="side-link" to={homeFor(user)} onClick={() => setOpen(false)}><I.Leaf /> {t('My dashboard')}</Link>
          <Link className="side-link" to="/staff/password" onClick={() => setOpen(false)}><I.Lock /> {t('Sign-in and security')}</Link>
          <Link className="side-link" to="/connect" onClick={() => setOpen(false)}><I.Phone /> {t('Open on phone')}</Link>
          <button
            className="side-link"
            style={{ width: '100%', border: 0, background: 'none' }}
            onClick={async () => { await signOut(); setOpen(false); navigate('/'); }}
          >
            <I.Logout /> {t('Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}

function OfflineBanner() {
  const { online } = useApp();
  if (online) return null;
  return (
    <div className="offline-bar no-print" role="status" aria-live="polite">
      <div className="wrap row" style={{ gap: 8, justifyContent: 'center' }}>
        <I.Alert style={{ width: 15, height: 15, flex: 'none' }} />
        <span>{t('You are offline. Showing pages saved on this device.')}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Web shell                                                           */
/* ------------------------------------------------------------------ */

export function WebShell({ children, sidebar = false }) {
  const inSpecies = useLocation().pathname.startsWith('/species');
  const { user, can, counts } = useApp();
  const groups = sidebar ? staffNav(can, counts) : [];

  return (
    <div className="app">
      <OfflineBanner />
      <header className="topbar no-print">
        <div className={'wrap ' + (sidebar ? 'wrap-wide' : '')}>
          <div className="topbar-in">
            <Brand sub={sidebar ? t('Staff workspace') : t('Niah National Park')} />

            <div className="spacer" />

            {!sidebar && (
              <nav className="nav nav-desktop" aria-label={t('Main')}>
                <NavLink to="/" end>{t('Home')}</NavLink>
                <NavLink to="/browse" className={({ isActive }) => isActive || inSpecies ? 'active' : undefined} aria-current={inSpecies ? 'location' : 'page'}>{t('Explore')}</NavLink>
                <NavLink to="/scan">{t('Scan a tag')}</NavLink>
              </nav>
            )}

            <LanguageSwitch />
            <ThemeSwitch />

            {user && (
              <Link to="/staff/notifications" className="btn btn-ghost btn-icon" aria-label={t('Notifications')} style={{ position: 'relative' }}>
                <I.Bell />
                {!!counts?.unread_notifications && (
                  <span className="dot-badge" style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: 99, background: 'var(--danger-fg)' }} />
                )}
              </Link>
            )}

            <AccountMenu />

          </div>
        </div>
        <ScrollProgress />
      </header>

      {sidebar ? (
        <div className="shell">
          <aside className="sidebar no-print">
            {groups.map((g) => (
              <div className="side-group" key={g.title}>
                <div className="side-title">{g.title}</div>
                {g.items.map((it) => (
                  <NavLink key={it.to} to={it.to} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
                    <it.icon />
                    <span className="grow truncate">{it.label}</span>
                    {it.soon && <span className="tag tiny">{t('Soon')}</span>}
                    {it.count !== undefined && it.count !== null && it.count > 0 && (
                      <span className={'count' + (it.alert ? ' alert' : '')}>{it.count}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
            <div className="side-group">
              <div className="side-title">{t('Public site')}</div>
              <NavLink to="/" className="side-link"><I.External /> {t('View public website')}</NavLink>
              <NavLink to="/connect" className="side-link"><I.Phone /> {t('Open on phone')}</NavLink>
            </div>
          </aside>
          <main className="content">{children}</main>
        </div>
      ) : (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>{children}</main>
      )}

      {!sidebar && (
        <footer className="site-foot no-print">
          <Fern className="foot-fern" />
          <div className="wrap site-foot-in">
            <div className="site-foot-brand">
              <span className="wordmark">FLORASCAN</span>
              <span>{t('Niah National Park, Sarawak')}</span>
              <span className="site-foot-small">
                {t('Built for NeuonAI and Sarawak Forestry Corporation')} &middot; {t('Photos under Creative Commons, credited on each plant')}
              </span>
            </div>
            <nav className="site-foot-links" aria-label={t('Footer')}>
              <Link to="/browse">{t('Plants')}</Link>
              <Link to="/species">{t('Species')}</Link>
              <Link to="/connect">{t('Open on phone')}</Link>
              <Link to="/login">{t('Staff sign in')}</Link>
            </nav>
          </div>
        </footer>
      )}
      <BackToTop />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mobile shell                                                        */
/* ------------------------------------------------------------------ */

export function MobileShell({ children, title, back, actions, noNav }) {
  const { user, can, counts } = useApp();
  const navigate = useNavigate();
  const inSpecies = useLocation().pathname.startsWith('/species');

  const items = [
    { to: '/', label: t('Home'), icon: I.Home, end: true },
    { to: '/browse', label: t('Explore'), icon: I.Leaf },
    { to: '/scan', label: t('Scan'), icon: I.Scan, mid: true },
  ];

  if (user) {
    // The fourth tab is each role's main job.
    if (can('plant.approve')) {
      items.push({ to: '/staff/review', label: t('Review'), icon: I.CheckCircle, badge: counts?.queue });
    } else if (can('plant.create')) {
      items.push({ to: '/staff/register', label: t('Register'), icon: I.Plus });
    } else if (can('sensor.view')) {
      items.push({ to: '/staff/iot', label: t('Alerts'), icon: I.Sensor });
    }
    items.push({ to: '/staff/me', label: t('Account'), icon: I.User, badge: counts?.unread_notifications });
  }

  return (
    <div className="app m-app">
      <OfflineBanner />
      <header className="m-header no-print">
        {back ? (
          <button className="btn btn-ghost btn-icon" onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))} aria-label={t('Back')}>
            <I.ArrowLeft />
          </button>
        ) : (
          <Brand />
        )}
        {title && <h1 className="truncate">{title}</h1>}
        {!title && <div className="spacer" />}
        <LanguageSwitch />
        <ThemeSwitch />
        {actions}
        <ScrollProgress />
      </header>

      <main style={{ flex: 1 }}>{children}</main>

      {!noNav && (
        <nav className="bottom-nav no-print">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) => 'bn-item' + (isActive || (it.to === '/browse' && inSpecies) ? ' active' : '') + (it.mid ? ' bn-scan' : '')}
            >
              <it.icon />
              <span>{it.label}</span>
              {!!it.badge && <span className="dot-badge">{it.badge > 9 ? '9+' : it.badge}</span>}
            </NavLink>
          ))}
        </nav>
      )}
      <BackToTop />
    </div>
  );
}
