import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import RecoveryCode from '../components/RecoveryCode.jsx';
import AdminApproval from './AdminApproval.jsx';
import EmailReset from './EmailReset.jsx';
import { RuleList, passwordRules } from './staff/ChangePassword.jsx';
import { homeFor } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/**
 * "Forgot password?" inside the sign-in card: email, recovery code and a new
 * password. Success signs the user straight in, then shows the replacement
 * code - the one just typed no longer works.
 *
 * Without a code, the same card asks an administrator to approve the reset
 * instead (AdminApproval.jsx): the person reads a code off this screen to
 * them, and once approved chooses their own new password right here.
 */
export default function Recover({ onBack, initialEmail = '' }) {
  const { applySession, toast } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: initialEmail, code: '', next: '', confirm: '' });
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  // A request waiting for an administrator - picked up again after a refresh.
  // A request waiting for an administrator. Held only here: a refresh ends it.
  const [waiting, setWaiting] = useState(null);
  // An administrator having a code emailed to their recovery address.
  const [emailing, setEmailing] = useState(false);
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));

  /** No code: ask the administrators, who are notified inside FloraScan. */
  const askAdmin = async (email = form.email.trim()) => {
    if (!email) { setError(t('Type your email address first.')); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.resetRequest(email);
      const request = { token: r.token, code: r.code, email, until: Date.now() + r.expires_in_minutes * 60000 };
      setWaiting(request);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  /** Approved and a new password chosen: signed in, then the new recovery code. */
  /**
   * A new password is set, by any of the three routes. Signed straight in -
   * unless two-step verification is on, which a password reset does not get
   * round: then the new recovery code is shown and they sign in normally.
   */
  const approvedSignIn = async (res) => {
    const later = !!res.sign_in_again;
    const u = later ? res.user : await applySession(res);
    toast(later ? t('Password changed. Now sign in with it and your authenticator code.') : t('Password changed.'), 'ok');
    setWaiting(null);
    setEmailing(false);
    setDone({ code: res.recovery_code, user: u, later });
  };

  // Nothing to compare against, so the "different from current" rule is left out.
  const rules = passwordRules(form.next, form.confirm, null).filter((_, i) => i !== 2);
  const ready = !!form.email && !!form.code && rules.every(([, ok]) => ok);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      await approvedSignIn(await api.recover(form.email, form.code, form.next));
    } catch (err) {
      setError(err.status === 423
        ? t('Too many wrong attempts. This account is locked for {minutes} min. Try again later, or ask an administrator to unlock it.', { minutes: err.body?.minutes ?? 15 })
        : err.message);
    }
    setBusy(false);
  };

  if (done) {
    return (
      <RecoveryCode
        code={done.code}
        email={done.user.email}
        doneLabel={done.later ? t('Back to sign in') : t('Continue to your dashboard')}
        onDone={() => (done.later ? onBack() : navigate(homeFor(done.user), { replace: true }))}
      />
    );
  }

  if (emailing) {
    return <EmailReset email={form.email.trim()} onBack={() => setEmailing(false)} onSignedIn={approvedSignIn} />;
  }

  if (waiting) {
    return (
      <AdminApproval
        key={waiting.token}
        request={waiting}
        onBack={() => setWaiting(null)}
        onAskAgain={() => askAdmin(waiting.email)}
        onSignedIn={approvedSignIn}
      />
    );
  }

  const type = reveal ? 'text' : 'password';

  return (
    <>
      <h1>{t('Forgot your password?')}</h1>
      <p className="signin-lead">{t('Enter your email address and the recovery code you saved, then choose a new password.')}</p>

      <form onSubmit={submit} noValidate>
        <div className={'signin-fields' + (error ? ' is-error' : '')}>
          <label className="signin-field">
            <span className="signin-label">{t('Email address')}</span>
            <span className="signin-control">
              <I.Mail />
              <input type="email" inputMode="email" autoComplete="username" placeholder="name@florascan.test"
                value={form.email} onChange={(e) => up({ email: e.target.value })} aria-invalid={!!error} />
            </span>
          </label>
          <label className="signin-field">
            <span className="signin-label">{t('Recovery code')}</span>
            <span className="signin-control">
              <I.Shield />
              <input autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX"
                className="mono" value={form.code} onChange={(e) => up({ code: e.target.value })} aria-invalid={!!error} />
            </span>
          </label>
          <label className="signin-field">
            <span className="signin-label">{t('New password')}</span>
            <span className="signin-control">
              <I.Lock />
              <input type={type} autoComplete="new-password" maxLength={128}
                value={form.next} onChange={(e) => up({ next: e.target.value })} />
              <button
                type="button" className="signin-reveal" onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? t('Hide password') : t('Show password')}
                title={reveal ? t('Hide password') : t('Show password')}
              >
                {reveal ? <I.EyeOff /> : <I.Eye />}
              </button>
            </span>
          </label>
          <label className="signin-field">
            <span className="signin-label">{t('Confirm new password')}</span>
            <span className="signin-control">
              <I.Lock />
              <input type={type} autoComplete="new-password" maxLength={128}
                value={form.confirm} onChange={(e) => up({ confirm: e.target.value })} />
            </span>
          </label>
        </div>

        <div style={{ margin: '12px 0' }}><RuleList rules={rules} /></div>

        {error && <div className="signin-error" role="alert"><I.Alert /> {error}</div>}

        <button className="btn btn-primary btn-lg btn-block signin-submit" disabled={!ready || busy}>
          {busy ? <><span className="spinner" /> {t('Saving...')}</> : <>{t('Set new password')} <I.ChevronRight /></>}
        </button>
      </form>

      <div className="signin-help">
        <p style={{ margin: '0 0 10px' }}>{t('Never saved a recovery code? Ask an administrator to approve a reset.')}</p>
        <button type="button" className="btn btn-block" onClick={() => askAdmin()} disabled={busy}>
          <I.Bell /> {t('Ask an administrator')}
        </button>
        <p style={{ margin: '14px 0 10px' }}>{t('Are you an administrator? Get a code sent to your recovery email.')}</p>
        <button
          type="button" className="btn btn-block" disabled={busy}
          onClick={() => { if (!form.email.trim()) setError(t('Type your email address first.')); else { setError(null); setEmailing(true); } }}
        >
          <I.Mail /> {t('Email a code to my recovery address')}
        </button>
      </div>
      <button type="button" className="btn btn-lg btn-block signin-secondary" onClick={onBack}>
        <I.ArrowLeft /> {t('Back to sign in')}
      </button>
    </>
  );
}
