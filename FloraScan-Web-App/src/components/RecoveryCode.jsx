import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyButton } from './ui.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

const SNOOZE_KEY = 'florascan.recovery-reminder';

/**
 * Top of every staff page for someone without a way back in if they forget
 * their password. An administrator is asked for a recovery email first - they
 * have nobody above them to approve a reset; everyone else for a recovery
 * code. "Later" hides it for the rest of this browser session only.
 */
export function RecoveryReminder({ user }) {
  const [snoozed, setSnoozed] = useState(() => {
    try { return sessionStorage.getItem(SNOOZE_KEY) === String(user.id); } catch { return false; }
  });
  const admin = !!user.permissions?.includes('user.manage');
  const needsEmail = admin && !user.recovery_email;
  if (user.must_change_password || snoozed || (!needsEmail && user.has_recovery_code)) return null;

  const later = () => {
    try { sessionStorage.setItem(SNOOZE_KEY, String(user.id)); } catch { /* private mode */ }
    setSnoozed(true);
  };

  return (
    <div className="wrap no-print" style={{ paddingTop: 14 }}>
      <div className="notice notice-warn" role="status">
        {needsEmail ? <I.Mail /> : <I.Shield />}
        <div className="grow">
          <strong>{needsEmail ? t('Add a recovery email') : t('You have no recovery code yet')}</strong>
          {needsEmail
            ? t('As an administrator, nobody can approve a reset for you. Add a second email address so a code can be sent there if you forget your password.')
            : t('If you forget your password, you will have to wait for an administrator. Getting a code takes a few seconds.')}
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Link to="/staff/password" className="btn btn-sm btn-primary">
              {needsEmail ? t('Add a recovery email') : t('Get a recovery code')}
            </Link>
            <button type="button" className="btn btn-sm" onClick={later}>{t('Later')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A recovery code, shown once. The server keeps only its hash, so this is the
 * one chance to save it; the continue button stays off until the user says
 * they have.
 */
export default function RecoveryCode({ code, email, onDone, doneLabel }) {
  const [saved, setSaved] = useState(false);

  const download = () => {
    const text = `FloraScan recovery code\n\nAccount: ${email}\nCode: ${code}\n\n`
      + 'Use it on the sign-in page under "Forgot password?". It works once, then a new code is issued.\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'florascan-recovery-code.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack" style={{ '--gap': '14px' }}>
      <div className="section-title"><I.Shield /> {t('Your recovery code')}</div>
      <p className="small mute" style={{ margin: 0 }}>
        {t('If you forget your password, this code lets you choose a new one without an administrator. Keep it somewhere safe - it is shown only once.')}
      </p>
      <div
        className="mono strong"
        style={{
          fontSize: 22, letterSpacing: '0.08em', textAlign: 'center', padding: '14px 10px',
          border: '1px dashed var(--border)', borderRadius: 10, userSelect: 'all', overflowWrap: 'anywhere',
        }}
      >
        {code}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <CopyButton text={code} />
        <button type="button" className="btn btn-sm" onClick={download}><I.Download /> {t('Download')}</button>
      </div>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t('I have saved my recovery code')}
      </label>
      <button type="button" className="btn btn-primary btn-block" disabled={!saved} onClick={onDone}>
        {doneLabel || t('Continue')} <I.ChevronRight />
      </button>
    </div>
  );
}
