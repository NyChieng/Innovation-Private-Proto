import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../lib/store.jsx';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/ui.jsx';
import RecoveryCode from '../../components/RecoveryCode.jsx';
import { PasskeyCard } from '../../components/Passkeys.jsx';
import RecoveryEmailCard from '../../components/RecoveryEmail.jsx';
import { TwoFactorCard } from '../../components/TwoFactor.jsx';
import { homeFor } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { t } from '../../lib/i18n.js';

/** The rules the server applies, shown as a checklist while typing. */
export function passwordRules(next, confirm, current) {
  return [
    [t('At least 8 characters'), next.length >= 8],
    [t('A letter and a number'), /[a-z]/i.test(next) && /\d/.test(next)],
    [t('Different from the current password'), !!next && next !== current],
    [t('Both new passwords match'), !!next && next === confirm],
  ];
}

export function RuleList({ rules }) {
  return (
    <ul className="stack" style={{ '--gap': '4px', listStyle: 'none', padding: 0, margin: 0 }}>
      {rules.map(([label, ok]) => (
        <li key={label} className={'row tiny ' + (ok ? '' : 'mute')} style={{ gap: 6, color: ok ? 'var(--ok-fg)' : undefined }}>
          {ok ? <I.CheckCircle style={{ width: 14, height: 14 }} /> : <I.Lock style={{ width: 14, height: 14 }} />}
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * A signed-in user chooses their own password. An account an administrator
 * has reset is sent here by the route guard until it does.
 *
 * Every new password comes with a new recovery code, shown once before the
 * user moves on. The rules shown are checked again by the server; the checks
 * here only save a round trip.
 */
export default function ChangePassword() {
  const { user, setUser, run, toast, can } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // A code to show, and where to go once it is saved.
  const [issued, setIssued] = useState(null);
  const [codePw, setCodePw] = useState('');
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));

  const rules = passwordRules(form.next, form.confirm, form.current);
  const ready = !!form.current && rules.every(([, ok]) => ok);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const res = await run(() => api.changePassword(form.current, form.next), { success: t('Password changed.') });
      setUser(res.user);
      setIssued({ code: res.recovery_code, leave: true });
    } catch { /* the toast says why */ }
    setBusy(false);
  };

  const makeCode = async (e) => {
    e.preventDefault();
    if (!codePw || busy) return;
    setBusy(true);
    try {
      const res = await run(() => api.newRecoveryCode(codePw));
      setUser(res.user);
      setCodePw('');
      setIssued({ code: res.recovery_code, leave: false });
    } catch { /* the toast says why */ }
    setBusy(false);
  };

  const type = show ? 'text' : 'password';

  if (issued) {
    return (
      <div className="page" style={{ paddingTop: 18 }}>
        <div className="wrap wrap-narrow">
          <div className="card card-pad">
            <RecoveryCode
              code={issued.code}
              email={user.email}
              doneLabel={issued.leave ? t('Continue to your dashboard') : t('Done')}
              onDone={() => {
                if (issued.leave) navigate(homeFor(user), { replace: true });
                else { setIssued(null); toast(t('Your old recovery code no longer works.')); }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page" style={{ paddingTop: 18 }}>
      <div className="wrap wrap-narrow">
        <h1 style={{ marginBottom: 6 }}>{t('Sign-in and security')}</h1>
        <p className="small mute" style={{ marginBottom: 18 }}>{user.email}</p>

        {user.must_change_password && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="warn" title={t('Password change required')}>
              {t('An administrator reset your password. Choose a new one before going any further.')}
            </Notice>
          </div>
        )}

        <form className="card card-pad stack" style={{ '--gap': '14px', marginBottom: 18 }} onSubmit={submit}>
          <div className="section-title"><I.Lock /> {t('Change password')}</div>
          <div className="field">
            <label htmlFor="pw-current">{t('Current password')}</label>
            <input id="pw-current" type={type} className="input" autoComplete="current-password"
              value={form.current} onChange={(e) => up({ current: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pw-next">{t('New password')}</label>
            <input id="pw-next" type={type} className="input" autoComplete="new-password" maxLength={128}
              value={form.next} onChange={(e) => up({ next: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pw-confirm">{t('Confirm new password')}</label>
            <input id="pw-confirm" type={type} className="input" autoComplete="new-password" maxLength={128}
              value={form.confirm} onChange={(e) => up({ confirm: e.target.value })} />
          </div>

          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            {t('Show passwords')}
          </label>

          <RuleList rules={rules} />

          <p className="tiny mute" style={{ margin: 0 }}>
            {t('Changing your password signs you out on every other device, and gives you a new recovery code.')}
          </p>

          <button type="submit" className="btn btn-primary btn-block" disabled={!ready || busy}>
            <I.Lock /> {busy ? t('Saving...') : t('Change password')}
          </button>
        </form>

        {!user.must_change_password && (
          <form className="card card-pad stack" style={{ '--gap': '12px' }} onSubmit={makeCode}>
            <div className="section-title"><I.Shield /> {t('Recovery code')}</div>
            <p className="small mute" style={{ margin: 0 }}>
              {user.has_recovery_code
                ? t('You have a recovery code. Make a new one if you have lost it - the old one stops working.')
                : t('You do not have a recovery code yet. Without one, a forgotten password needs an administrator.')}
            </p>
            <div className="field">
              <label htmlFor="pw-code">{t('Current password')}</label>
              <input id="pw-code" type="password" className="input" autoComplete="current-password"
                value={codePw} onChange={(e) => setCodePw(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-block" disabled={!codePw || busy}>
              <I.Shield /> {user.has_recovery_code ? t('Make a new recovery code') : t('Get a recovery code')}
            </button>
          </form>
        )}

        {!user.must_change_password && can('user.manage') && <RecoveryEmailCard />}

        {!user.must_change_password && <TwoFactorCard />}

        {!user.must_change_password && <PasskeyCard />}
      </div>
    </div>
  );
}
