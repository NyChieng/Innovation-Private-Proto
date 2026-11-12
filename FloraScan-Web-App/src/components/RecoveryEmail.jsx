import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/** Said when the server has no mail account and prints emails in its terminal instead. */
export function TerminalNote() {
  return (
    <p className="tiny mute" style={{ margin: 0 }}>
      {t('Email sending is not set up on this server yet, so the code is printed in the server terminal window instead of arriving in an inbox.')}
    </p>
  );
}

/**
 * An administrator's second email address, for a forgotten password. Saved
 * only after a code sent to it is typed back, so it is known to be real and
 * theirs - a made-up address would hand reset codes to whoever owns it.
 */
export default function RecoveryEmailCard() {
  const { user, setUser, run, toast } = useApp();
  const [editing, setEditing] = useState(!user.recovery_email);
  const [form, setForm] = useState({ email: '', password: '', code: '' });
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));

  const send = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      setSent(await run(() => api.recoveryEmailStart(form.email, form.password)));
    } catch { /* the toast says why */ }
    setBusy(false);
  };

  const confirm = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await run(() => api.recoveryEmailConfirm(form.code));
      setUser(r.user);
      toast(t('Recovery email saved.'), 'ok');
      setSent(null); setEditing(false); setForm({ email: '', password: '', code: '' });
    } catch { /* the toast says why */ }
    setBusy(false);
  };

  return (
    <div className="card card-pad stack" style={{ '--gap': '12px', marginTop: 18 }}>
      <div className="section-title"><I.Mail /> {t('Recovery email')}</div>
      <p className="small mute" style={{ margin: 0 }}>
        {t('Administrators have nobody above them to approve a reset. If you forget your password, a code is sent to this second address instead. Use a real address you can open - ideally protected with 2-step verification.')}
      </p>

      {user.recovery_email && !editing && (
        <div className="row" style={{ gap: 10 }}>
          <I.CheckCircle style={{ width: 16, height: 16, color: 'var(--ok-fg)', flex: 'none' }} />
          <span className="grow small"><strong className="mono">{user.recovery_email}</strong> · {t('confirmed')}</span>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>{t('Change')}</button>
        </div>
      )}

      {editing && !sent && (
        <form className="stack" style={{ '--gap': '10px' }} onSubmit={send}>
          <div className="field">
            <label htmlFor="re-email">{t('Second email address')}</label>
            <input id="re-email" type="email" className="input" autoComplete="email" placeholder="name.backup@gmail.com"
              value={form.email} onChange={(e) => up({ email: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="re-pw">{t('Current password')}</label>
            <input id="re-pw" type="password" className="input" autoComplete="current-password"
              value={form.password} onChange={(e) => up({ password: e.target.value })} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary grow" disabled={busy || !form.email || !form.password}>
              <I.Mail /> {t('Send a code to this address')}
            </button>
            {user.recovery_email && <button type="button" className="btn" onClick={() => setEditing(false)}>{t('Cancel')}</button>}
          </div>
        </form>
      )}

      {sent && (
        <form className="stack" style={{ '--gap': '10px' }} onSubmit={confirm}>
          <p className="small" style={{ margin: 0 }}>{t('A six-digit code was sent to {email}. Type it here to confirm the address.', { email: <strong className="mono">{sent.sent_to}</strong> })}</p>
          {sent.delivery === 'terminal' && <TerminalNote />}
          <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456"
            aria-label={t('Code')} style={{ letterSpacing: '0.15em', fontSize: 18 }}
            value={form.code} onChange={(e) => up({ code: e.target.value })} />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary grow" disabled={busy || form.code.replace(/\D/g, '').length !== 6}>
              <I.CheckCircle /> {t('Confirm')}
            </button>
            <button type="button" className="btn" onClick={() => setSent(null)}>{t('Back')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
