import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Notice } from './ui.jsx';
import { t } from '../lib/i18n.js';

export default function PasswordSettings() {
  const { user, signOut, toast } = useApp();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword, confirmation);
      await signOut();
      toast(t('Password changed. Please sign in again.'));
      navigate('/login', { replace: true });
    } catch (e) {
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="card card-pad stack" style={{ '--gap': '12px' }}>
      <div>
        <div className="strong">{t('Change password')}</div>
        <div className="small mute">{t('Choose a new password for your FloraScan account.')}</div>
      </div>
      {user.must_change_password && (
        <Notice kind="warn" title={t('Password change required')}>
          {t('An administrator gave this account a temporary password. Change it now to continue using your account securely.')}
        </Notice>
      )}
      <form className="stack" style={{ '--gap': '12px' }} onSubmit={submit}>
        <div className="field">
          <label htmlFor="current-password">{t('Current password')}</label>
          <input id="current-password" className="input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="new-password">{t('New password')}</label>
          <input id="new-password" className="input" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          <div className="hint">{t('Use at least 8 characters.')}</div>
        </div>
        <div className="field">
          <label htmlFor="confirm-password">{t('Confirm new password')}</label>
          <input id="confirm-password" className="input" type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required />
        </div>
        <button className="btn btn-primary" disabled={busy || newPassword !== confirmation}>
          {busy && <span className="spinner" />} {t('Change password')}
        </button>
      </form>
    </div>
  );
}
