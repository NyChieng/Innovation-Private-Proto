import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store.jsx';
import { Avatar } from './ui.jsx';
import { homeFor, roleLabel } from '../lib/format.js';
import { LANGUAGES, t } from '../lib/i18n.js';
import { resetIntro } from '../lib/intro.js';
import * as I from '../lib/icons.jsx';

/**
 * Prototype-only demo control.
 *
 * Shows who is signed in and carries the theme, language and web/phone layout
 * toggles, which keeps the demo controls in one place instead of cluttering
 * the real UI. Changing account goes through the sign-in page like it will in
 * the real system - there is no password-free jump into another account.
 *
 * Shortcut: Ctrl/Cmd+K opens it. This whole component comes out before
 * anything ships.
 */
export default function RoleSwitcher() {
  const { user, signOut, toast, theme, setTheme, viewPref, setView, lang, setLang } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const panelRef = useRef(null);

  const leave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
      toast(t('Signed out'));
      setOpen(false);
      navigate('/');
    } finally {
      setBusy(false);
    }
  };

  const toLogin = () => { setOpen(false); navigate('/login'); };

  /* Keyboard shortcuts */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open && e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  /* Click outside to close */
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest('.rs-fab')) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button
        className="rs-fab no-print"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t('Prototype controls')}
        title={t('Prototype controls (Ctrl+K)')}
      >
        {user
          ? <Avatar name={user.full_name} role={user.role} />
          : <span className="avatar" style={{ background: 'rgba(255,255,255,0.14)', color: '#dfeadf', borderColor: 'transparent' }}><I.Eye style={{ width: 15, height: 15 }} /></span>}
        <span>{user ? roleLabel(user.role_label) : t('Visitor')}</span>
        <span className="kbd">^K</span>
      </button>

      {open && (
        <div className="rs-panel no-print" ref={panelRef}>
          <div className="rs-head">
            <div className="row row-between">
              <strong style={{ fontSize: '0.88rem' }}>{t('Prototype controls')}</strong>
              <span className="badge badge-warn" title={t('Not part of the real system')}>{t('Prototype')}</span>
            </div>
          </div>

          <div className="rs-list">
            {user ? (
              <div className="rs-item active">
                <Avatar name={user.full_name} role={user.role} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="nm truncate">{user.full_name}</span>
                  <span className="rl truncate">{roleLabel(user.role_label)}{user.title ? ' · ' + user.title : ''}</span>
                </span>
              </div>
            ) : (
              <div className="rs-item active">
                <span className="avatar" style={{ background: 'var(--surface-3)', color: 'var(--text-mute)', borderColor: 'var(--border)' }}>
                  <I.Eye style={{ width: 15, height: 15 }} />
                </span>
                <span className="grow">
                  <span className="nm">{t('Public visitor')}</span>
                  <span className="rl">{t('Not signed in · sees published records only')}</span>
                </span>
              </div>
            )}
            <div className="row" style={{ gap: 7, padding: '6px 4px 4px' }}>
              {user ? (
                <>
                  <button className="btn btn-sm grow" onClick={() => { setOpen(false); navigate(homeFor(user)); }}>
                    {t('Go to your dashboard')}
                  </button>
                  <button className="btn btn-sm" onClick={leave} disabled={busy}>
                    <I.Logout /> {t('Sign out')}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary btn-sm grow" onClick={toLogin}>
                  <I.Lock /> {t('Staff sign in')}
                </button>
              )}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'grid', gap: 10 }}>
            <div className="row row-between">
              <span className="tiny mute">{t('Layout')}</span>
              <div className="segmented">
                {[['auto', t('Auto')], ['web', t('Website')], ['mobile', t('Phone app')]].map(([v, l]) => (
                  <button key={v} className={viewPref === v ? 'active' : ''} onClick={() => setView(v)}>{l}</button>
                ))}
              </div>
            </div>
            {/* Between layout and theme: the theme row stays last. */}
            <div className="row row-between">
              <span className="tiny mute">{t('Language')}</span>
              <div className="segmented">
                {LANGUAGES.map((l) => (
                  <button key={l.code} lang={l.html} className={lang === l.code ? 'active' : ''} onClick={() => setLang(l.code)}>{l.short}</button>
                ))}
              </div>
            </div>
            <div className="row row-between">
              <span className="tiny mute">{t('Theme')}</span>
              <div className="segmented">
                {[['system', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]].map(([v, l]) => (
                  <button key={v} className={theme === v ? 'active' : ''} onClick={() => setTheme(v)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="row" style={{ gap: 7 }}>
              <button className="btn btn-sm grow" onClick={() => { setOpen(false); navigate('/connect'); }}>
                <I.Phone /> {t('Open on my phone')}
              </button>
              {/* Replaying the welcome screen matters during a walkthrough:
                  it only ever appears once per browser otherwise. */}
              <button
                className="btn btn-sm"
                title={t('Show the welcome screen again')}
                onClick={() => { resetIntro(); setOpen(false); navigate('/'); }}
              >
                <I.Refresh /> {t('Intro')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
