import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store.jsx';
import { Avatar, Notice } from '../components/ui.jsx';
import { homeFor, roleLabel } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

export default function Login() {
  const { boot, signIn, verifyTotp, switchRole, toast, user } = useApp();
  const navigate = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');

  const land = (u) => navigate(loc.state?.from || homeFor(u), { replace: true });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = challenge
        ? await verifyTotp(challenge, code)
        : await signIn(email, password);
      if (result?.requires_totp) {
        setChallenge(result.challenge);
        setCode('');
        return;
      }
      const u = result;
      toast(t('Signed in as {name}', { name: u.full_name }));
      land(u);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const quick = async (account) => {
    setBusy(true); setError(null);
    try {
      const u = await switchRole(account.id);
      toast(t('Signed in as {name}', { name: u.full_name }));
      land(u);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const accounts = boot?.demo_accounts || [];
  // Grouped by role, in the order a walkthrough tells the story. A role the
  // demo does not know about still appears, at the end.
  const ORDER = ['admin', 'botanist', 'reviewer', 'ranger'];
  const byRole = [...ORDER, ...new Set(accounts.map((a) => a.role).filter((r) => !ORDER.includes(r)))];

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 940 }}>
        {user && (
          <div style={{ marginBottom: 18 }}>
            <Notice kind="ok" title={t('Already signed in as {name}', { name: user.full_name })}>
              {t('{link}, or sign in as somebody else below.', { link: <Link to={homeFor(user)}>{t('Go to your dashboard')}</Link> })}
            </Notice>
          </div>
        )}

        <div style={{ display: 'grid', gap: 26, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 310px), 1fr))', alignItems: 'start' }}>
          {/* Real login form */}
          <div className="card card-pad">
            <h1 style={{ fontSize: '1.45rem', marginBottom: 4 }}>{t('Staff sign in')}</h1>
            <div className="small mute" style={{ marginBottom: 18 }}>
              {t('Accounts are created by an administrator. Visitors do not need one.')}
            </div>

            <form onSubmit={submit} className="stack" style={{ '--gap': '14px' }}>
              {challenge ? (
                <>
                  <Notice kind="plain" title={t('Authenticator verification')}>
                    {t('Open Google Authenticator or another compatible app and enter the six-digit code for this account.')}
                  </Notice>
                  <div className="field">
                    <label htmlFor="totp-code">{t('Authenticator code')}</label>
                    <input
                      id="totp-code" className={'input' + (error ? ' input-invalid' : '')}
                      value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus
                    />
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>
                    {t('Back to password')}
                  </button>
                </>
              ) : (
                <>
              <div className="field">
                <label htmlFor="email">{t('Email address')}</label>
                <input
                  id="email" type="email" className={'input' + (error ? ' input-invalid' : '')}
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username" placeholder="name@niah.sarawak.gov.my" required
                />
              </div>
              <div className="field">
                <label htmlFor="password">{t('Password')}</label>
                <input
                  id="password" type="password" className={'input' + (error ? ' input-invalid' : '')}
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" placeholder="demo1234" required
                />
                <div className="hint">{t('Demo password for every account: {password}', { password: <span className="mono">demo1234</span> })}</div>
              </div>
                </>
              )}

              {error && <div className="err" role="alert">{error}</div>}

              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                {busy && <span className="spinner" />} {challenge ? t('Verify and sign in') : t('Sign in')}
              </button>
            </form>

            <div className="tiny faint" style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              {t('Passwords are stored as bcrypt hashes in the real system. This prototype keeps sessions in memory only, so everything resets when the server restarts.')}
            </div>
          </div>

          {/* Demo roster */}
          <div className="card">
            <div className="card-head">
              <h3 className="grow">{t('Sign in as a demo account')}</h3>
              <span className="badge badge-warn">{t('Prototype')}</span>
            </div>
            <div className="card-body" style={{ paddingTop: 12 }}>
              <div className="small mute" style={{ marginBottom: 14 }}>
                {t('One click, no password. The same list is in the floating switcher (Ctrl+K), so you can change role from any screen.')}
              </div>

              {byRole.map((role) => {
                const list = accounts.filter((a) => a.role === role);
                if (!list.length) return null;
                return (
                  <div key={role} style={{ marginBottom: 14 }}>
                    <div className="side-title" style={{ paddingLeft: 0 }}>{roleLabel(list[0].role_label)}</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {list.map((a) => (
                        <button
                          key={a.id}
                          className="rs-item"
                          style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
                          onClick={() => quick(a)}
                          disabled={busy || !a.is_active}
                          title={a.is_active ? a.email : t('Deactivated account')}
                        >
                          <Avatar name={a.full_name} role={a.role} />
                          <span className="grow" style={{ minWidth: 0 }}>
                            <span className="nm truncate">{a.full_name}</span>
                            <span className="rl truncate">{a.title}{!a.is_active && ' · ' + t('deactivated')}</span>
                          </span>
                          {a.is_active ? <I.ChevronRight style={{ width: 15, height: 15, color: 'var(--text-faint)' }} /> : <span className="tag tiny">{t('Off')}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              <div className="inset small">
                <strong>{t('Try the deactivated account.')}</strong>{' '}
                {t('It is refused at sign in, which is the same check the API applies on every request after login.')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
