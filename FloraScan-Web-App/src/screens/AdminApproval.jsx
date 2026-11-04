import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { RuleList, passwordRules } from './staff/ChangePassword.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/*
 * Waiting for an administrator to approve a password reset.
 *
 * The screen shows a six-digit code and quietly holds a secret token. The
 * person reads the code to an administrator - in person or by phone - who
 * types it in to approve. This screen notices within a few seconds and turns
 * into "choose a new password". Only the browser holding the token can do
 * that, so an approval cannot be used from anywhere else.
 *
 * Deliberately not kept anywhere: the token lives only in this page. A
 * refresh, a closed tab or going back throws it away and tells the server to
 * close the request, so an approved screen left open cannot be picked up by
 * whoever reaches the browser next. The person asks again for a new code.
 */

const POLL_MS = 4000;
const pendingCancel = new Map(); // token -> timer, see the unmount effect below

/** Close the request on the server. sendBeacon still gets through as the page unloads. */
function cancelOnServer(token) {
  const body = JSON.stringify({ token });
  try {
    if (navigator.sendBeacon?.('/api/auth/reset-request/cancel', new Blob([body], { type: 'application/json' }))) return;
  } catch { /* fall through to fetch */ }
  fetch('/api/auth/reset-request/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

export default function AdminApproval({ request, onBack, onAskAgain, onSignedIn }) {
  const [status, setStatus] = useState('pending');
  const [form, setForm] = useState({ next: '', confirm: '' });
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (status !== 'pending') return undefined;
    const check = async () => {
      if (Date.now() > request.until) { setStatus('expired'); return; }
      try {
        const r = await api.resetRequestStatus(request.token);
        if (r.status !== 'pending') setStatus(r.status === 'used' || r.status === 'closed' ? 'expired' : r.status);
      } catch { /* a dropped connection just means try again next time */ }
    };
    check();
    const timer = setInterval(check, POLL_MS);
    return () => clearInterval(timer);
  }, [status, request]);

  // Leaving - refresh, close, or moving to another screen - ends the request for
  // good. The unmount cancel waits a moment: React's StrictMode unmounts and
  // remounts at once in development, and the remount calls it off.
  useEffect(() => {
    clearTimeout(pendingCancel.get(request.token));
    const leave = () => cancelOnServer(request.token);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      pendingCancel.set(request.token, setTimeout(leave, 300));
    };
  }, [request.token]);

  const rules = passwordRules(form.next, form.confirm, null).filter((_, i) => i !== 2);
  const ready = rules.every(([, ok]) => ok);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.resetRequestComplete(request.token, form.next);
      await onSignedIn(res);
      return;
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const back = () => onBack();

  if (status === 'approved') {
    const type = reveal ? 'text' : 'password';
    return (
      <>
        <div className="signin-eyebrow"><I.CheckCircle /> {t('Approved')}</div>
        <h1>{t('Choose a new password')}</h1>
        <p className="signin-lead">{t('An administrator approved your request for {email}.', { email: <strong>{request.email}</strong> })}</p>
        <p className="tiny mute" style={{ marginTop: -6 }}>
          {t('Choose it within 5 minutes. Refreshing or leaving this page cancels the approval, and you would have to ask again.')}
        </p>
        <form onSubmit={submit} noValidate>
          <div className={'signin-fields' + (error ? ' is-error' : '')}>
            <label className="signin-field">
              <span className="signin-label">{t('New password')}</span>
              <span className="signin-control">
                <I.Lock />
                <input type={type} autoComplete="new-password" maxLength={128} autoFocus
                  value={form.next} onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))} />
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
                  value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} />
              </span>
            </label>
          </div>
          <div style={{ margin: '12px 0' }}><RuleList rules={rules} /></div>
          {error && <div className="signin-error" role="alert"><I.Alert /> {error}</div>}
          <button className="btn btn-primary btn-lg btn-block signin-submit" disabled={!ready || busy}>
            {busy ? <><span className="spinner" /> {t('Saving...')}</> : <>{t('Set new password')} <I.ChevronRight /></>}
          </button>
        </form>
      </>
    );
  }

  if (status === 'denied' || status === 'expired') {
    return (
      <>
        <h1>{status === 'denied' ? t('Request refused') : t('Request ran out')}</h1>
        <p className="signin-lead">
          {status === 'denied'
            ? t('An administrator refused this request. Speak to them, or ask again.')
            : t('Requests last 30 minutes. Ask again when an administrator is available.')}
        </p>
        <button className="btn btn-primary btn-lg btn-block signin-submit" onClick={onAskAgain}>
          <I.Bell /> {t('Ask again')}
        </button>
        <button type="button" className="btn btn-lg btn-block signin-secondary" onClick={back}>
          <I.ArrowLeft /> {t('Back to sign in')}
        </button>
      </>
    );
  }

  return (
    <>
      <div className="signin-eyebrow"><I.Bell /> {t('Waiting for approval')}</div>
      <h1>{t('Tell an administrator this code')}</h1>
      <p className="signin-lead">
        {t('In person or by phone. They enter it on your account to approve the reset, and this page then lets you choose a new password.')}
      </p>
      <div
        className="mono strong" aria-live="polite"
        style={{
          fontSize: 34, letterSpacing: '0.18em', textAlign: 'center', padding: '16px 10px', margin: '6px 0 14px',
          border: '1px dashed var(--border)', borderRadius: 12,
        }}
      >
        {request.code.slice(0, 3)} {request.code.slice(3)}
      </div>
      <p className="small mute row" style={{ gap: 8, justifyContent: 'center' }}>
        <span className="spinner" /> {t('Keep this page open - refreshing it cancels the request. Waiting for {email}...', { email: request.email })}
      </p>
      <p className="tiny mute" style={{ textAlign: 'center' }}>
        {t('If {email} has no account, nobody can approve this - check the address.', { email: request.email })}
      </p>
      <button type="button" className="btn btn-lg btn-block signin-secondary" onClick={back}>
        <I.ArrowLeft /> {t('Cancel and go back')}
      </button>
    </>
  );
}
