import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import {
  Avatar, ConfirmButton, Empty, LoadingBlock, Modal, Notice, PageHead, SearchInput, Stat,
} from '../../components/ui.jsx';
import { formatDateTime, relativeTime, roleLabel } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { t } from '../../lib/i18n.js';

function NewUserDialog({ roles, onClose, onDone }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ full_name: '', email: '', title: '', phone: '', role_id: 2 });
  const [busy, setBusy] = useState(false);
  const up = (p) => setForm((f) => ({ ...f, ...p }));

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.createUser(form);
      toast(t('{name} created. Temporary password: {password}', { name: r.user.full_name, password: r.temporary_password }));
      onDone(); onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={t('Create a staff account')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy && <span className="spinner" />}Create account</button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' }}>
        <Notice kind="plain">
          {t('There is no public sign-up. Every account is created here, starts with a temporary password, and is forced to change it at first sign in.')}
        </Notice>
        <div className="field">
          <label htmlFor="u-name">{t('Full name')} <span className="req">*</span></label>
          <input id="u-name" className="input" value={form.full_name} onChange={(e) => up({ full_name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="u-email">{t('Email address')} <span className="req">*</span></label>
          <input id="u-email" type="email" className="input" value={form.email} onChange={(e) => up({ email: e.target.value })} placeholder="name@niah.sarawak.gov.my" />
        </div>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="u-role">{t('Role')} <span className="req">*</span></label>
            <select id="u-role" className="select" value={form.role_id} onChange={(e) => up({ role_id: Number(e.target.value) })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{roleLabel(r.label)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="u-title">{t('Job title')}</label>
            <input id="u-title" className="input" value={form.title} onChange={(e) => up({ title: e.target.value })} placeholder={t('Senior Botanist')} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="u-phone">{t('Phone')}</label>
          <input id="u-phone" className="input" value={form.phone} onChange={(e) => up({ phone: e.target.value })} />
        </div>
        {form.role_id && (
          <div className="inset">
            <div className="label" style={{ marginBottom: 5 }}>{t('This role can')}</div>
            <div className="row row-wrap" style={{ gap: 5 }}>
              {(roles.find((r) => r.id === Number(form.role_id))?.permissions || []).map((p) => (
                <span key={p} className="tag mono">{p}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function UserDrawer({ user, roles, onClose, onDone }) {
  const { toast, user: me } = useApp();
  const [busy, setBusy] = useState(false);
  const isMe = me?.id === user.id;

  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); toast(msg); onDone(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={user.full_name} onClose={onClose}>
      <div className="stack" style={{ '--gap': '16px' }}>
        <div className="row" style={{ gap: 12 }}>
          <Avatar name={user.full_name} role={user.role} size="lg" />
          <div>
            <div className="strong">{user.full_name}</div>
            <div className="small mute">{user.email}</div>
            <div className="row" style={{ gap: 6, marginTop: 5 }}>
              <span className="tag">{roleLabel(user.role_label)}</span>
              {user.is_active ? <span className="badge badge-ok">{t('Active')}</span> : <span className="badge badge-danger">{t('Deactivated')}</span>}
              {user.must_change_password ? <span className="badge badge-warn">{t('Must change password')}</span> : null}
            </div>
          </div>
        </div>

        <dl className="dl small">
          <dt>{t('Job title')}</dt><dd>{user.title || '--'}</dd>
          <dt>{t('Phone')}</dt><dd>{user.phone || '--'}</dd>
          <dt>{t('Created')}</dt><dd>{formatDateTime(user.created_at)}{user.created_by_name && <span className="mute"> {t('by {name}', { name: user.created_by_name })}</span>}</dd>
          <dt>{t('Last sign in')}</dt><dd>{user.last_login_at ? relativeTime(user.last_login_at) : t('Never')}</dd>
          <dt>{t('Plants registered')}</dt><dd>{user.plants_registered}</dd>
          <dt>{t('Plants verified')}</dt><dd>{user.plants_verified}</dd>
        </dl>

        <div className="field">
          <label htmlFor="d-role">{t('Role')}</label>
          <select
            id="d-role" className="select" value={user.role_id} disabled={busy || isMe}
            onChange={(e) => act(() => api.updateUser(user.id, { role_id: Number(e.target.value) }), t('Role updated.'))}
          >
            {roles.map((r) => <option key={r.id} value={r.id}>{roleLabel(r.label)}</option>)}
          </select>
          {isMe && <div className="hint">{t('You cannot change your own role.')}</div>}
        </div>

        <div className="inset">
          <div className="label" style={{ marginBottom: 5 }}>{t('Permissions held')}</div>
          <div className="row row-wrap" style={{ gap: 5 }}>
            {user.permissions.map((p) => <span key={p} className="tag mono">{p}</span>)}
          </div>
        </div>

        <div className="row row-wrap" style={{ gap: 9 }}>
          <ConfirmButton
            className="btn btn-sm"
            icon={I.Refresh}
            label={t('Reset password')}
            title={t('Reset the password for {name}?', { name: user.full_name })}
            confirmLabel={t('Reset password')}
            body={
              <Notice kind="warn" title={t('This signs them out everywhere')}>
                {t('A temporary password is issued and they must change it at the next sign in. Any active session is revoked immediately.')}
              </Notice>
            }
            onConfirm={() => act(() => api.resetPassword(user.id), t('Password reset. Temporary password: {password}', { password: 'demo1234' }))}
          />
          {!isMe && (
            user.is_active ? (
              <ConfirmButton
                className="btn btn-sm btn-danger"
                icon={I.X}
                label={t('Deactivate')}
                title={t('Deactivate {name}?', { name: user.full_name })}
                confirmLabel={t('Deactivate account')}
                body={
                  <Notice kind="warn" title={t('Access stops at once')}>
                    {t('Their live sessions are revoked and sign in is refused. Their records and audit history stay exactly as they are. You can reactivate the account at any time.')}
                  </Notice>
                }
                onConfirm={() => act(() => api.updateUser(user.id, { is_active: false }), t('{name} deactivated.', { name: user.full_name }))}
              />
            ) : (
              <button
                className="btn btn-sm btn-primary" disabled={busy}
                onClick={() => act(() => api.updateUser(user.id, { is_active: true }), t('{name} reactivated.', { name: user.full_name }))}
              >
                <I.Check /> {t('Reactivate')}
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function Users() {
  const { boot, can } = useApp();
  const [rows, setRows] = useState(null);
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    api.users().then((r) => setRows(r.results)).catch(() => setRows([]));
    api.adminStats().then(setStats).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  if (!rows) return <LoadingBlock label={t('Loading staff accounts')} />;

  const roles = boot?.roles || [];
  const filtered = q.trim()
    ? rows.filter((u) => [u.full_name, u.email, u.title, u.role_label].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()))
    : rows;

  return (
    <div className="page">
      <div className="wrap wrap-wide">
        <PageHead
          title={t('Staff accounts')}
          sub={t('Create accounts, set roles, reset passwords, and activate or deactivate staff. Visitors never have an account.')}
        >
          {can('user.manage') && <button className="btn btn-primary" onClick={() => setCreating(true)}><I.Plus /> {t('New account')}</button>}
        </PageHead>

        {stats && (
          <div className="grid grid-4" style={{ marginBottom: 20 }}>
            <Stat label={t('Accounts')} value={stats.users} detail={`${stats.active_users} active`} />
            {stats.by_role.map((r) => <Stat key={r.role} label={roleLabel(r.label)} value={r.count} />)}
          </div>
        )}

        <div style={{ maxWidth: 380, marginBottom: 16 }}>
          <SearchInput value={q} onChange={setQ} placeholder={t('Search name, email or role')} />
        </div>

        {filtered.length === 0 ? (
          <Empty icon={I.Users} title={t('No accounts match')} />
        ) : (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr><th></th><th>{t('Name')}</th><th>{t('Role')}</th><th>{t('Last sign in')}</th><th className="num">{t('Registered')}</th><th className="num">{t('Verified')}</th><th>{t('Status')}</th><th></th></tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} onClick={() => setOpen(u)} style={{ cursor: 'pointer' }}>
                    <td style={{ width: 44 }}><Avatar name={u.full_name} role={u.role} size="sm" /></td>
                    <td>
                      <div className="strong">{u.full_name}</div>
                      <div className="tiny mute">{u.email}</div>
                    </td>
                    <td><span className="tag">{roleLabel(u.role_label)}</span><div className="tiny mute" style={{ marginTop: 2 }}>{u.title}</div></td>
                    <td className="small mute">{u.last_login_at ? relativeTime(u.last_login_at) : t('Never')}</td>
                    <td className="num">{u.plants_registered}</td>
                    <td className="num">{u.plants_verified}</td>
                    <td>
                      {u.is_active ? <span className="badge badge-ok"><span className="dot" />{t('Active')}</span> : <span className="badge badge-danger"><span className="dot" />{t('Off')}</span>}
                    </td>
                    <td className="num"><I.ChevronRight style={{ width: 16, height: 16, color: 'var(--text-faint)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <Notice kind="plain" title={t('Roles are permission sets, not hard-coded names')}>
            {t('The API checks permission codes such as {code}, never the role name. That is how the Reviewer role was added: one more set of permissions, with no new tables and no change to the API.', { code: <span className="mono">plant.approve</span> })}
          </Notice>
        </div>
      </div>

      {creating && <NewUserDialog roles={roles} onClose={() => setCreating(false)} onDone={load} />}
      {open && <UserDrawer user={open} roles={roles} onClose={() => setOpen(null)} onDone={() => { load(); setOpen(null); }} />}
    </div>
  );
}
