import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import { LoadingBlock, Notice, PageHead } from '../../components/ui.jsx';
import { formatDateTime } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { t } from '../../lib/i18n.js';

const LOCK_SWITCHES = [
  ['lockout_account', () => t('Lock the account'), () => t('Whoever is guessing, the account closes until the lock runs out or an administrator unlocks it. Administrator accounts are locked too.')],
  ['lockout_ip', () => t('Lock the IP address'), () => t('The network the guesses come from is paused, for every account it tries. People on the same Wi-Fi share one IP address.')],
  ['lockout_device', () => t('Lock the device'), () => t('The browser the guesses come from is paused, for every account it tries. Someone determined can clear their browser to get around it, so use it with another lock.')],
];

/** What a run of wrong passwords locks, how soon, and for how long. */
function LockoutCard({ rows, busy, save }) {
  const { toast, can } = useApp();
  const value = (key) => rows.find((r) => r.setting_key === key)?.setting_value;
  const [attempts, setAttempts] = useState(value('lockout_max_attempts') ?? '5');
  const [minutes, setMinutes] = useState(value('lockout_minutes') ?? '15');
  const [locks, setLocks] = useState(null);
  const canManage = can('user.manage');

  const loadLocks = () => api.lockouts().then((r) => setLocks(r.results)).catch(() => setLocks([]));
  useEffect(() => { if (canManage) loadLocks(); }, [canManage]);

  const lift = async (row) => {
    try {
      await api.liftLockout(row.id);
      toast(t('Lock lifted.'));
      loadLocks();
    } catch (e) { toast(e.message, 'err'); }
  };

  const noneOn = LOCK_SWITCHES.every(([key]) => value(key) !== 'true');
  const limitsDirty = String(attempts) !== String(value('lockout_max_attempts')) || String(minutes) !== String(value('lockout_minutes'));
  const saveLimits = async () => {
    if (String(attempts) !== String(value('lockout_max_attempts'))) await save('lockout_max_attempts', attempts);
    if (String(minutes) !== String(value('lockout_minutes'))) await save('lockout_minutes', minutes);
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head"><h3 className="grow"><I.Lock style={{ width: 16, height: 16, verticalAlign: '-2px', display: 'inline-block' }} /> {t('Sign-in protection')}</h3></div>
      <div className="card-body stack" style={{ '--gap': '16px' }}>
        <p className="small mute" style={{ margin: 0 }}>
          {t('Choose what is locked after too many wrong passwords or codes in a row. Any combination can be on.')}
        </p>

        {LOCK_SWITCHES.map(([key, label, help]) => (
          <label key={key} className="switch" style={{ alignItems: 'flex-start', gap: 14 }}>
            <input
              type="checkbox" checked={value(key) === 'true'} disabled={busy === key}
              onChange={(e) => save(key, e.target.checked)}
            />
            <span className="switch-track" />
            <span style={{ flex: 1 }}>
              <span className="strong" style={{ display: 'block' }}>{label()}</span>
              <span className="small mute">{help()}</span>
            </span>
          </label>
        ))}

        {noneOn && (
          <Notice kind="warn" title={t('No lock is switched on')}>
            {t('Passwords can then be guessed until the request limit slows them down. Switch on at least one lock.')}
          </Notice>
        )}

        <div className="grid grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="lk-attempts">{t('Wrong attempts before a lock')}</label>
            <input id="lk-attempts" className="input" type="number" min={3} max={20} value={attempts} onChange={(e) => setAttempts(e.target.value)} />
            <div className="hint">{t('3 to 20')}</div>
          </div>
          <div className="field">
            <label htmlFor="lk-minutes">{t('Lock length (minutes)')}</label>
            <input id="lk-minutes" className="input" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <div className="hint">{t('1 to 1440 (a day)')}</div>
          </div>
        </div>
        {limitsDirty && (
          <div>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={saveLimits}><I.Check /> {t('Save')}</button>
          </div>
        )}

        {canManage && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>{t('Networks and devices locked now')}</div>
            {!locks ? (
              <span className="small mute">{t('Loading')}...</span>
            ) : locks.length === 0 ? (
              <span className="small mute">{t('None.')}</span>
            ) : (
              <ul className="stack" style={{ '--gap': '8px', listStyle: 'none', padding: 0, margin: 0 }}>
                {locks.map((row) => (
                  <li key={row.id} className="row" style={{ gap: 10 }}>
                    <span className="tag">{row.scope === 'ip' ? t('Network') : t('Device')}</span>
                    <span className="grow small mono" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{row.label}</span>
                    <span className="tiny mute">{t('until {time}', { time: formatDateTime(row.locked_until) })}</span>
                    <button type="button" className="btn btn-sm" onClick={() => lift(row)}>{t('Unlock')}</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="hint" style={{ marginTop: 6 }}>{t('Locked accounts are unlocked from Staff accounts.')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SettingsScreen() {
  const { toast, setBoot } = useApp();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.settings().then((r) => setRows(r.results)).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  const save = async (key, value) => {
    setBusy(key);
    try {
      await api.updateSetting(key, value);
      await load();
      // require_approval changes what the register screens say, so refresh boot.
      try { setBoot(await api.bootstrap()); } catch { /* non-fatal */ }
      toast(t('Setting saved.'));
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  if (!rows) return <LoadingBlock label={t('Loading settings')} />;

  const approval = rows.find((r) => r.setting_key === 'require_approval');
  const hasLockout = rows.some((r) => r.setting_key === 'lockout_account');

  return (
    <div className="page">
      <div className="wrap wrap-narrow">
        <PageHead
          title={t('System settings')}
          sub={t('Behaviour that the park can change without a developer. Every change is written to the audit trail.')}
        />

        {/* The headline switch */}
        {approval && (
          <div className="card" style={{ marginBottom: 20, borderColor: 'var(--accent-border)' }}>
            <div className="card-head">
              <h3 className="grow">{t('Verification workflow')}</h3>
              <span className="mono tiny faint">require_approval</span>
            </div>
            <div className="card-body">
              <label className="switch" style={{ alignItems: 'flex-start', gap: 14 }}>
                <input
                  type="checkbox"
                  checked={approval.setting_value === 'true'}
                  disabled={busy === 'require_approval'}
                  onChange={(e) => save('require_approval', e.target.checked)}
                />
                <span className="switch-track" />
                <span style={{ flex: 1 }}>
                  <span className="strong" style={{ display: 'block' }}>
                    {t('Botanist entries must be checked by a senior botanist')}
                  </span>
                  <span className="small mute">
                    {approval.setting_value === 'true'
                      ? t('On. A botanist’s new record goes to the review queue and stays off the public site until a senior botanist approves it.')
                      : t('Off. A botanist’s new record is published immediately, so the system behaves as a straightforward register.')}
                  </span>
                </span>
              </label>

              <div style={{ marginTop: 16 }}>
                <Notice kind="plain">
                  {t('A record with no confirmed species always goes to a senior botanist, whichever way this is set, because the API refuses to approve one without a species. Nobody can approve a record they registered themselves. A small site with no separate senior botanist may prefer this off.')}
                </Notice>
              </div>
            </div>
            {approval.updated_by_name && (
              <div className="card-foot tiny mute">
                {t('Last changed by {name} on {when}', { name: approval.updated_by_name, when: formatDateTime(approval.updated_at) })}
              </div>
            )}
          </div>
        )}

        {hasLockout ? (
          <LockoutCard rows={rows} busy={busy} save={save} />
        ) : (
          <Notice kind="warn" title={t('Sign-in protection is not set up on this database yet')}>
            {t('Run npm run db:setup on the server, then reload this page.')}
          </Notice>
        )}
      </div>
    </div>
  );
}
