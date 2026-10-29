import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Notice } from './ui.jsx';
import { t } from '../lib/i18n.js';

export default function TwoFactorSettings() {
  const { user, setUser, toast } = useApp();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const setCodeValue = (event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6));

  const setupTotp = async () => {
    setBusy(true);
    try { setSetup(await api.setupTotp()); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const enableTotp = async () => {
    setBusy(true);
    try {
      const result = await api.enableTotp(code);
      setUser(result.user); setSetup(null); setCode('');
      toast(t('Two-step verification enabled.'));
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const disableTotp = async () => {
    setBusy(true);
    try {
      const result = await api.disableTotp(code);
      setUser(result.user); setCode('');
      toast(t('Two-step verification disabled.'));
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card card-pad stack" style={{ '--gap': '12px' }}>
      <div>
        <div className="strong">{t('Two-step verification')}</div>
        <div className="small mute">{t('Use Google Authenticator or another TOTP-compatible app to protect this account.')}</div>
      </div>
      {user.totp_enabled ? (
        <>
          <Notice kind="ok">{t('Authenticator verification is enabled for your account.')}</Notice>
          <div className="field">
            <label htmlFor="disable-totp-code">{t('Current authenticator code')}</label>
            <input id="disable-totp-code" className="input" inputMode="numeric" value={code} onChange={setCodeValue} />
          </div>
          <button className="btn btn-danger" disabled={busy || code.length !== 6} onClick={disableTotp}>
            {t('Disable two-step verification')}
          </button>
        </>
      ) : !setup ? (
        <button className="btn btn-primary" disabled={busy} onClick={setupTotp}>{t('Set up authenticator')}</button>
      ) : (
        <>
          <div className="small">{t('Scan this QR code in Google Authenticator, then enter the code it generates.')}</div>
          <img src={setup.qr} alt={t('Authenticator setup QR code')} style={{ width: 220, height: 220, alignSelf: 'center' }} />
          <div className="inset">
            <div className="tiny mute">{t('If you cannot scan the code, enter this setup key manually:')}</div>
            <code className="mono small">{setup.secret}</code>
          </div>
          <div className="field">
            <label htmlFor="enable-totp-code">{t('Authenticator code')}</label>
            <input id="enable-totp-code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={setCodeValue} />
          </div>
          <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={enableTotp}>{t('Confirm and enable')}</button>
        </>
      )}
    </div>
  );
}
