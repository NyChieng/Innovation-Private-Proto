import { useNavigate } from 'react-router-dom';
import { useApp } from '../../lib/store.jsx';
import { Avatar, PageHead } from '../../components/ui.jsx';
import TwoFactorSettings from '../../components/TwoFactorSettings.jsx';
import PasswordSettings from '../../components/PasswordSettings.jsx';
import { roleLabel } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import * as I from '../../lib/icons.jsx';

export default function Account() {
  const { user, signOut } = useApp();
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="wrap wrap-narrow">
        <PageHead title={t('My account')} sub={t('Manage your profile and account security.')} />

        <div className="card card-pad row" style={{ gap: 14, marginBottom: 18 }}>
          <Avatar name={user.full_name} role={user.role} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong truncate">{user.full_name}</div>
            <div className="small mute truncate">{user.email}</div>
            <div className="row" style={{ gap: 6, marginTop: 5 }}>
              <span className="tag">{roleLabel(user.role_label)}</span>
              {user.title && <span className="tiny mute">{user.title}</span>}
            </div>
          </div>
        </div>

        <h2 className="side-title" style={{ paddingLeft: 0 }}>{t('Account security')}</h2>
        <div style={{ marginBottom: 18 }}><PasswordSettings /></div>
        <TwoFactorSettings />

        <button className="btn btn-danger btn-block" style={{ marginTop: 18 }} onClick={async () => { await signOut(); navigate('/'); }}>
          <I.Logout /> {t('Sign out')}
        </button>
      </div>
    </div>
  );
}
