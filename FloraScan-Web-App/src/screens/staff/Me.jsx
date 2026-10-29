import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../../lib/store.jsx';
import { Avatar, Notice } from '../../components/ui.jsx';
import TwoFactorSettings from '../../components/TwoFactorSettings.jsx';
import PasswordSettings from '../../components/PasswordSettings.jsx';
import { staffNav } from '../../components/Shell.jsx';
import { relativeTime, roleLabel } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { LANGUAGES, t } from '../../lib/i18n.js';

/**
 * Phone "Account" tab. On a narrow screen there is no sidebar, so this is
 * where the rest of the staff navigation lives.
 */
export default function Me() {
  const { user, can, counts, signOut, theme, setTheme, viewPref, setView, lang, setLang } = useApp();
  const navigate = useNavigate();
  const groups = staffNav(can, counts);

  return (
    <div className="page" style={{ paddingTop: 18 }}>
      <div className="wrap wrap-narrow">
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

        <Link className="card card-pad row" to="/staff/notifications" style={{ gap: 12, marginBottom: 18, color: 'inherit', textDecoration: 'none' }}>
          <span className="avatar"><I.Bell style={{ width: 15, height: 15 }} /></span>
          <span className="grow">
            <span className="strong small" style={{ display: 'block' }}>{t('Notifications')}</span>
            <span className="tiny mute">
              {counts?.unread_notifications ? t('{n} unread', { n: counts.unread_notifications }) : t('Nothing new')}
            </span>
          </span>
          {!!counts?.unread_notifications && <span className="badge badge-danger">{counts.unread_notifications}</span>}
          <I.ChevronRight style={{ width: 16, height: 16, color: 'var(--text-faint)' }} />
        </Link>

        <div style={{ marginBottom: 18 }}><TwoFactorSettings /></div>
        <div style={{ marginBottom: 18 }}><PasswordSettings /></div>

        {groups.map((g) => (
          <div className="card" key={g.title} style={{ marginBottom: 14 }}>
            <div className="card-head"><h3>{g.title}</h3></div>
            <div style={{ padding: 6 }}>
              {g.items.map((it) => (
                <Link key={it.to} className="side-link" to={it.to}>
                  <it.icon />
                  <span className="grow">{it.label}</span>
                  {it.soon && <span className="tag tiny">{t('Soon')}</span>}
                  {it.count > 0 && <span className={'count' + (it.alert ? ' alert' : '')}>{it.count}</span>}
                  <I.ChevronRight style={{ width: 15, height: 15, color: 'var(--text-faint)' }} />
                </Link>
              ))}
            </div>
          </div>
        ))}

        <div className="card card-pad stack" style={{ '--gap': '14px', marginBottom: 18 }}>
          <div className="row row-between">
            <span className="small">{t('Theme')}</span>
            <div className="segmented">
              {[['system', t('Auto')], ['light', t('Light')], ['dark', t('Dark')]].map(([v, l]) => (
                <button key={v} className={theme === v ? 'active' : ''} onClick={() => setTheme(v)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="row row-between">
            <span className="small">{t('Layout')}</span>
            <div className="segmented">
              {[['auto', t('Auto')], ['web', t('Web')], ['mobile', t('App')]].map(([v, l]) => (
                <button key={v} className={viewPref === v ? 'active' : ''} onClick={() => setView(v)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="row row-between">
            <span className="small">{t('Language')}</span>
            <div className="segmented">
              {LANGUAGES.map((l) => (
                <button key={l.code} lang={l.html} className={lang === l.code ? 'active' : ''} onClick={() => setLang(l.code)}>{l.short}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="small mute" style={{ marginBottom: 14 }}>
          {t('Last signed in {when}.', { when: user.last_login_at ? relativeTime(user.last_login_at) : t('just now') })}
        </div>

        {user.must_change_password && (
          <div style={{ marginBottom: 14 }}>
            <Notice kind="warn" title={t('Password change required')}>
              {t('An administrator reset your password. In the finished system you would be asked to choose a new one before going any further.')}
            </Notice>
          </div>
        )}

        <button className="btn btn-danger btn-block" onClick={async () => { await signOut(); navigate('/'); }}>
          <I.Logout /> {t('Sign out')}
        </button>
      </div>
    </div>
  );
}
