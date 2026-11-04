import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Avatar, Empty, LoadingBlock, Notice, PageHead } from '../../components/ui.jsx';
import { formatDateTime, relativeTime, roleLabel, titleCase } from '../../lib/format.js';
import { useApp } from '../../lib/store.jsx';
import * as I from '../../lib/icons.jsx';
import { msg, t } from '../../lib/i18n.js';

const ACTION_STYLE = {
  create: 'badge-ok', approve: 'badge-ok', update: 'badge-info',
  reject: 'badge-danger', archive: 'badge-neutral',
  role_change: 'badge-warn', password_reset: 'badge-warn', password_changed: 'badge-warn',
  account_locked: 'badge-danger', account_unlocked: 'badge-warn',
  password_recovered: 'badge-warn', reset_approved: 'badge-ok', reset_denied: 'badge-danger',
  passkey_added: 'badge-info', passkey_removed: 'badge-neutral', recovery_email_set: 'badge-info',
  two_factor_enabled: 'badge-ok', two_factor_disabled: 'badge-warn',
};

/** Plain names for the codes the API writes, so an entry reads as a sentence. */
const ACTION_LABEL = {
  create: msg('Added'), update: msg('Edited'), approve: msg('Approved'),
  reject: msg('Returned'), archive: msg('Archived'), role_change: msg('Role changed'),
  password_reset: msg('Password reset'), password_changed: msg('Password changed'),
  account_locked: msg('Account locked'), account_unlocked: msg('Account unlocked'),
  password_recovered: msg('Password recovered'), reset_approved: msg('Reset approved'),
  reset_denied: msg('Reset refused'), passkey_added: msg('Face ID / fingerprint turned on'),
  passkey_removed: msg('Face ID / fingerprint turned off'), recovery_email_set: msg('Recovery email set'),
  two_factor_enabled: msg('Two-step verification on'), two_factor_disabled: msg('Two-step verification off'),
};

/** Plain names for the fields the API records, in place of column names. */
const FIELD_LABEL = {
  must_change_password: msg('Must change password'), is_active: msg('Active'), role_id: msg('Role'),
  full_name: msg('Name'), email: msg('Email address'), status: msg('Status'), device: msg('Device'),
  rp_id: msg('Address'), recovery_email: msg('Recovery email'), locked_until: msg('Locked until'),
  via: msg('How'), reason: msg('Reason'), request_id: msg('Request'), approved_by: msg('Approved by'),
  two_factor: msg('Two-step verification'),
};
const YES_NO = new Set(['must_change_password', 'is_active', 'two_factor']);

const ENTITY_LABEL = {
  plants: msg('Plant'), species: msg('Species'), users: msg('Staff account'),
  settings: msg('System setting'), plant_reports: msg('Visitor report'),
};

const actionLabel = (a) => (ACTION_LABEL[a] ? t(ACTION_LABEL[a]) : titleCase(a));
const entityLabel = (e) => (ENTITY_LABEL[e] ? t(ENTITY_LABEL[e]) : titleCase(e));

/** The questions an administrator actually comes here to answer, each one a filter. */
const QUESTIONS = [
  { label: msg('Who approved a plant?'), entity: 'plants', action: 'approve' },
  { label: msg('Who returned a plant?'), entity: 'plants', action: 'reject' },
  { label: msg('Who edited a plant?'), entity: 'plants', action: 'update' },
  { label: msg('Who archived a plant?'), entity: 'plants', action: 'archive' },
  { label: msg("Who changed a staff member's role?"), entity: 'users', action: 'role_change' },
  { label: msg('Who changed a system setting?'), entity: 'settings', action: 'update' },
];

/** Only plain objects have fields; anything else is shown as one value. */
const asFields = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : (v == null ? {} : { value: v }));

/** Renders the old -> new value pairs the API stores as JSON. */
function Diff({ oldValues, newValues, roles }) {
  const before = asFields(oldValues);
  const after = asFields(newValues);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => String(before[k] ?? '') !== String(after[k] ?? ''));
  if (!keys.length) return <span className="tiny faint">{t('No details recorded')}</span>;

  const show = (k, v) => {
    if (v === null || v === undefined || v === '') return t('empty');
    if (YES_NO.has(k)) return [1, '1', true, 'true'].includes(v) ? t('Yes') : t('No');
    if (k === 'role_id') {
      const role = roles.find((r) => r.id === Number(v));
      if (role) return roleLabel(role.label);
    }
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return formatDateTime(v);
    return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 40);
  };

  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {keys.slice(0, 5).map((k) => (
        <div key={k} className="tl-diff" style={{ marginTop: 0 }}>
          <span className="tiny faint" style={{ minWidth: 92 }}>{FIELD_LABEL[k] ? t(FIELD_LABEL[k]) : titleCase(k)}</span>
          <span className="tl-old tiny">{show(k, before[k])}</span>
          <I.ChevronRight style={{ width: 11, height: 11, color: 'var(--text-faint)' }} />
          <span className="tl-new tiny">{show(k, after[k])}</span>
        </div>
      ))}
      {keys.length > 5 && <span className="tiny faint">{t('+{n} more fields', { n: keys.length - 5 })}</span>}
    </div>
  );
}

function RecordCell({ entry }) {
  const label = entityLabel(entry.entity_type);
  if (entry.entity_type === 'plants' && entry.entity_id) {
    return <Link to={'/staff/plants/' + entry.entity_id}>{label} <span className="mono tiny">#{entry.entity_id}</span></Link>;
  }
  return <>{label}{entry.entity_id && <span className="mono tiny faint"> #{entry.entity_id}</span>}</>;
}

export default function Audit() {
  const { boot } = useApp();
  const [data, setData] = useState(null);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');

  useEffect(() => {
    api.audit({ entity_type: entity, action }).then(setData).catch(() => setData({ results: [] }));
  }, [entity, action]);

  if (!data) return <LoadingBlock label={t('Loading the audit trail')} />;

  const ask = (q) => { setEntity(q.entity); setAction(q.action); };

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 1060 }}>
        <PageHead
          title={t('Audit trail')}
          sub={t('A record of every change to plants, species, staff accounts and settings: who made it, when, and what it was before.')}
        />

        <div style={{ marginBottom: 18 }}>
          <Notice kind="plain" title={t('Use this page to:')}>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>{t('Check who approved a plant before it went public.')}</li>
              <li>{t('See what a field said before someone edited it, so a mistake can be put back.')}</li>
              <li>{t("Find out who changed a staff member's role or a system setting.")}</li>
            </ul>
            <div className="small mute" style={{ marginTop: 8 }}>
              {t('Entries are added automatically. Nobody can edit or delete them.')}
            </div>
          </Notice>
        </div>

        <div className="small strong" style={{ marginBottom: 8 }}>{t('Quick questions')}</div>
        <div className="row row-wrap" style={{ gap: 8, marginBottom: 16 }}>
          <button type="button" className="chip" aria-pressed={!entity && !action} onClick={() => ask({ entity: '', action: '' })}>
            {t('Show everything')}
          </button>
          {QUESTIONS.map((q) => (
            <button
              key={q.label}
              type="button"
              className="chip"
              aria-pressed={entity === q.entity && action === q.action}
              onClick={() => ask(q)}
            >
              {t(q.label)}
            </button>
          ))}
        </div>

        <div className="row row-wrap" style={{ gap: 10, marginBottom: 16 }}>
          <select className="select" style={{ width: 'auto' }} value={entity} onChange={(e) => setEntity(e.target.value)} aria-label={t('Filter by record type')}>
            <option value="">{t('All record types')}</option>
            {(data.entity_types || []).map((v) => <option key={v} value={v}>{entityLabel(v)}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)} aria-label={t('Filter by action')}>
            <option value="">{t('All actions')}</option>
            {(data.actions || []).map((v) => <option key={v} value={v}>{actionLabel(v)}</option>)}
          </select>
          <span className="spacer" />
          <span className="small mute">
            {data.results.length < data.total
              ? t('Showing the latest {shown} of {total} entries', { shown: data.results.length, total: data.total })
              : t('{total} entries', { total: data.total ?? 0 })}
          </span>
        </div>

        {data.results.length === 0 ? (
          <Empty icon={I.Shield} title={t('No audit entries match')} />
        ) : (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr><th></th><th>{t('Who')}</th><th>{t('Did what')}</th><th>{t('To which record')}</th><th>{t('Before → after')}</th><th>{t('When')}</th></tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={r.id}>
                    <td style={{ width: 40 }}><Avatar name={r.user_name} size="sm" /></td>
                    <td className="small strong nowrap">{r.user_name}</td>
                    <td>
                      <span className={'badge ' + (ACTION_STYLE[r.action] || 'badge-neutral')}>
                        <span className="dot" />{actionLabel(r.action)}
                      </span>
                    </td>
                    <td className="small"><RecordCell entry={r} /></td>
                    <td style={{ maxWidth: 380 }}><Diff oldValues={r.old_values} newValues={r.new_values} roles={boot?.roles || []} /></td>
                    <td className="small nowrap">
                      {relativeTime(r.created_at)}
                      <div className="tiny faint">{formatDateTime(r.created_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
