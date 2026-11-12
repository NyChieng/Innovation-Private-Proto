import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { TerminalNote } from '../components/RecoveryEmail.jsx';
import { RuleList, passwordRules } from './staff/ChangePassword.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/*
 * Forgotten password, administrator: a six-digit code goes to the recovery
 * email they confirmed earlier (components/RecoveryEmail.jsx). The page never
 * says whether the account exists or has an address - it just says where a
 * code would have gone.
 */
export default function EmailReset({ email, onBack, onSignedIn }) {
  const [delivery, setDelivery] = useState(null);
  const [form, setForm] = useState({ code: '', next: '', confirm: '' });
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));

  const send = async () => {
    setError(null);
    try {
      const r = await api.emailReset(email);
      setDelivery(r.delivery);
    } catch (err) { setError(err.message); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { send(); }, []);

  const rules = passwordRules(form.next, form.confirm, null).filter((_, i) => i !== 2);
  const ready = form.code.replace(/\D/g, '').length === 6 && rules.every(([, ok]) => ok);

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      await onSignedIn(await api.emailResetComplete(email, form.code, form.next));
      return;
    } catch (err) {
      setError(err.status === 423
        ? t('Too many wrong attempts. This account is locked for {minutes} min. Try again later, or ask an administrator to unlock it.', { minutes: err.body?.minutes ?? 15 })
        : err.message);
    }
    setBusy(false);
  };

  const type = reveal ? 'text' : 'password';

  return (
    <>
      <div className="signin-eyebrow"><I.Mail /> {t('Recovery email')}</div>
      <h1>{t('Check your recovery email')}</h1>
      <p className="signin-lead">
        {t('If {email} is an administrator account with a recovery email, a six-digit code has been sent there. It works for 15 minutes.', { email: <strong>{email}</strong> })}
      </p>
      {delivery === 'terminal' && <div style={{ marginBottom: 12 }}><TerminalNote /></div>}

      <form onSubmit={submit} noValidate>
        <div className={'signin-fields' + (error ? ' is-error' : '')}>
          <label className="signin-field">
            <span className="signin-label">{t('Code from the email')}</span>
            <span className="signin-control">
              <I.Mail />
              <input className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456"
                value={form.code} onChange={(e) => up({ code: e.target.value })} aria-invalid={!!error} />
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

      <p className="signin-help">
        <button type="button" className="signin-link" onClick={send}>{t('Send the code again')}</button>
      </p>
      <button type="button" className="btn btn-lg btn-block signin-secondary" onClick={onBack}>
        <I.ArrowLeft /> {t('Back')}
      </button>
    </>
  );
}
