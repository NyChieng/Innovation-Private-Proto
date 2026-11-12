import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/*
 * Two-step verification with an authenticator app (Google Authenticator,
 * Microsoft Authenticator, Authy...). The server side is Server/totp.js.
 */

const digits = (s) => s.replace(/\D/g, '');

/** The six-digit box both screens use. */
function CodeInput({ value, onChange, autoFocus, id, className = 'input mono' }) {
  return (
    <input
      id={id} className={className} inputMode="numeric" autoComplete="one-time-code" maxLength={7}
      placeholder="123 456" autoFocus={autoFocus} aria-label={t('Code from your authenticator app')}
      style={{ letterSpacing: '0.15em', fontSize: 18 }}
      value={value} onChange={(e) => onChange(e.target.value)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Sign-in, second step                                                */
/* ------------------------------------------------------------------ */

export function TwoFactorStep({ ticket, email, onSignedIn, onBack }) {
  const { applySession } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (digits(code).length !== 6 || busy) return;
    setBusy(true); setError(null);
    try {
      const u = await applySession(await api.login2fa(ticket, code));
      await onSignedIn(u);
      return;
    } catch (err) {
      setCode('');
      if (err.status === 423) {
        setError(t('Too many wrong attempts. This account is locked for {minutes} min. Try again later, or ask an administrator to unlock it.', { minutes: err.body?.minutes ?? 15 }));
      } else if (err.body?.attempts_left) {
        setError(t('That code is not right. {count} attempts left before the account is locked.', { count: err.body.attempts_left }));
      } else {
        setError(err.message);
      }
    }
    setBusy(false);
  };

  return (
    <>
      <div className="signin-eyebrow"><I.Shield /> {t('Two-step verification')}</div>
      <h1>{t('Enter the code from your authenticator app')}</h1>
      <p className="signin-lead">
        {t('Open the app on your phone and type the six-digit code shown for FloraScan ({email}). It changes every 30 seconds.', { email })}
      </p>
      <form onSubmit={submit} noValidate>
        <div className={'signin-fields' + (error ? ' is-error' : '')}>
          <label className="signin-field">
            <span className="signin-label">{t('Code')}</span>
            <span className="signin-control">
              <I.Lock />
              <CodeInput value={code} onChange={setCode} autoFocus className="mono" />
            </span>
          </label>
        </div>
        {error && <div className="signin-error" role="alert"><I.Alert /> {error}</div>}
        <button className="btn btn-primary btn-lg btn-block signin-submit" disabled={busy || digits(code).length !== 6}>
          {busy ? <><span className="spinner" /> {t('Checking...')}</> : <>{t('Verify and sign in')} <I.ChevronRight /></>}
        </button>
      </form>
      <p className="signin-help">{t('Lost your phone? Ask an administrator to reset your password - that also turns two-step verification off.')}</p>
      <button type="button" className="btn btn-lg btn-block signin-secondary" onClick={onBack}>
        <I.ArrowLeft /> {t('Back to sign in')}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Turning it on and off - Sign-in and security                        */
/* ------------------------------------------------------------------ */

export function TwoFactorCard() {
  const { user, setUser, run, toast } = useApp();
  // null: idle; 'start': asking for the password; { qr, secret }: scanning.
  const [stage, setStage] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setStage(null); setPassword(''); setCode(''); };

  const begin = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try { setStage(await run(() => api.twoFactorSetup(password))); setPassword(''); } catch { /* the toast says why */ }
    setBusy(false);
  };

  const enable = async (e) => {
    e.preventDefault();
    if (busy || digits(code).length !== 6) return;
    setBusy(true);
    try {
      const r = await run(() => api.twoFactorEnable(code));
      setUser(r.user);
      toast(t('Two-step verification is on.'), 'ok');
      reset();
    } catch { setCode(''); }
    setBusy(false);
  };

  const disable = async (e) => {
    e.preventDefault();
    if (busy || !password || digits(code).length !== 6) return;
    setBusy(true);
    try {
      const r = await run(() => api.twoFactorDisable(password, code));
      setUser(r.user);
      toast(t('Two-step verification is off.'));
      reset();
    } catch { setCode(''); }
    setBusy(false);
  };

  return (
    <div className="card card-pad stack" style={{ '--gap': '12px', marginTop: 18 }}>
      <div className="section-title"><I.Phone /> {t('Two-step verification')}</div>
      <p className="small mute" style={{ margin: 0 }}>
        {t('After your password, sign-in also asks for a six-digit code from an authenticator app on your phone - Google Authenticator, Microsoft Authenticator or similar. Someone who learns your password still cannot get in.')}
      </p>

      {user.two_factor ? (
        stage !== 'off' ? (
          <div className="row" style={{ gap: 10 }}>
            <I.CheckCircle style={{ width: 16, height: 16, color: 'var(--ok-fg)', flex: 'none' }} />
            <span className="grow small strong">{t('On')}</span>
            <button type="button" className="btn btn-sm" onClick={() => setStage('off')}>{t('Turn off')}</button>
          </div>
        ) : (
          <form className="stack" style={{ '--gap': '10px' }} onSubmit={disable}>
            <div className="field">
              <label htmlFor="tf-off-pw">{t('Current password')}</label>
              <input id="tf-off-pw" type="password" className="input" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="tf-off-code">{t('Code from your authenticator app')}</label>
              <CodeInput id="tf-off-code" value={code} onChange={setCode} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button type="submit" className="btn btn-danger grow" disabled={busy || !password || digits(code).length !== 6}>
                {t('Turn off two-step verification')}
              </button>
              <button type="button" className="btn" onClick={reset}>{t('Cancel')}</button>
            </div>
          </form>
        )
      ) : stage && typeof stage === 'object' ? (
        <form className="stack" style={{ '--gap': '12px' }} onSubmit={enable}>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>{t('Install an authenticator app on your phone if you do not have one - Google Authenticator or Microsoft Authenticator are free.')}</li>
            <li>{t('In the app, add an account and scan this QR code. It appears as FloraScan.')}</li>
            <li>{t('Type the six-digit code the app shows.')}</li>
          </ol>
          <img
            src={stage.qr} alt={t('QR code for your authenticator app')} width="200" height="200"
            style={{ display: 'block', margin: '0 auto', borderRadius: 8, background: '#fff', padding: 6 }}
          />
          <details className="small">
            <summary style={{ cursor: 'pointer' }}>{t('Cannot scan? Type this key into the app instead')}</summary>
            <div className="mono strong" style={{ marginTop: 8, overflowWrap: 'anywhere', userSelect: 'all' }}>{stage.secret}</div>
          </details>
          <div className="field">
            <label htmlFor="tf-code">{t('Code from your authenticator app')}</label>
            <CodeInput id="tf-code" value={code} onChange={setCode} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary grow" disabled={busy || digits(code).length !== 6}>
              <I.CheckCircle /> {t('Turn on')}
            </button>
            <button type="button" className="btn" onClick={reset}>{t('Cancel')}</button>
          </div>
        </form>
      ) : stage === 'start' ? (
        <form className="stack" style={{ '--gap': '10px' }} onSubmit={begin}>
          <div className="field">
            <label htmlFor="tf-pw">{t('Current password')}</label>
            <input id="tf-pw" type="password" className="input" autoComplete="current-password" autoFocus
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary grow" disabled={busy || !password}>{t('Continue')}</button>
            <button type="button" className="btn" onClick={reset}>{t('Cancel')}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-block" onClick={() => setStage('start')}>
          <I.Phone /> {t('Set up two-step verification')}
        </button>
      )}
    </div>
  );
}
