/**
 * Data access for the plant_registry schema.
 *
 * Every record lives in MySQL. What stays in memory is reference data only -
 * roles, permissions, role_permissions and settings - because the API checks a
 * permission code on every single request and reads settings nearly as often.
 * Against a database in Singapore that is a 30 ms round trip each time, on a
 * few dozen rows that change about twice a year. They are loaded once at boot
 * and refreshed whenever they are written, so the cache cannot go stale behind
 * an administrator's back.
 *
 * Everything else - plants, species, photographs, submissions, tags, scans,
 * audit, notifications - is read and written with real SQL, one row at a time,
 * through Server/sql.js.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as sql from './sql.js';

export const nowIso = () => new Date().toISOString();

/**
 * The request an audit or activity row is written during, so each row records
 * the real address and browser rather than placeholders. Set once per request
 * by the API (Server/api.js); null outside a request, e.g. while seeding.
 */
export const requestContext = new AsyncLocalStorage();

function origin() {
  const ctx = requestContext.getStore();
  return {
    // "::ffff:192.168.0.20" is how Node reports an IPv4 caller on a dual-stack socket.
    ip_address: ctx?.ip ? String(ctx.ip).replace(/^::ffff:/, '').slice(0, 45) : null,
    user_agent: ctx?.userAgent ? String(ctx.userAgent).slice(0, 255) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reference cache                                                     */
/* ------------------------------------------------------------------ */

const ref = {
  roles: [],
  permissions: [],
  role_permissions: [],
  settings: [],
};

/** Read the reference tables into memory. Called at boot and after a write. */
export async function loadReference() {
  ref.roles = await sql.q('SELECT * FROM roles ORDER BY id');
  ref.permissions = await sql.q('SELECT * FROM permissions ORDER BY id');
  ref.role_permissions = await sql.q('SELECT * FROM role_permissions');
  ref.settings = await sql.q('SELECT * FROM settings ORDER BY setting_key');
  return ref;
}

export const roles = () => ref.roles;
export const permissions = () => ref.permissions;
export const roleById = (id) => ref.roles.find((r) => r.id === Number(id)) || null;

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

export const insert = (table, row) => sql.insert(table, row);
export const update = (table, id, patch) => sql.update(table, id, patch);
export const byId = (table, id) => sql.byId(table, id);
export const q = sql.q;
export const one = sql.one;
export const count = sql.count;
export const tx = sql.tx;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Typed read from the cache. Synchronous, because callers are everywhere. */
export function getSetting(key) {
  const row = ref.settings.find((s) => s.setting_key === key);
  if (!row) return null;
  if (row.value_type === 'bool') return row.setting_value === 'true';
  if (row.value_type === 'int') return Number(row.setting_value);
  if (row.value_type === 'json') {
    try { return JSON.parse(row.setting_value); } catch { return null; }
  }
  return row.setting_value;
}

export const allSettings = () => ref.settings;

export async function setSetting(key, value, userId) {
  const existing = ref.settings.find((s) => s.setting_key === key);
  if (!existing) return null;
  await sql.update('settings', key, {
    setting_value: String(value),
    updated_by: userId ?? null,
    updated_at: nowIso(),
  }, 'setting_key');
  // Refresh rather than patch the cached copy, so what callers read next is
  // what the database actually stored.
  ref.settings = await sql.q('SELECT * FROM settings ORDER BY setting_key');
  return ref.settings.find((s) => s.setting_key === key) || null;
}

/* ------------------------------------------------------------------ */
/* Permissions - the API checks codes, never role names (schema ss.8)  */
/* ------------------------------------------------------------------ */

export function permissionsForRole(roleId) {
  const ids = ref.role_permissions
    .filter((rp) => rp.role_id === Number(roleId))
    .map((rp) => rp.permission_id);
  return ref.permissions.filter((p) => ids.includes(p.id)).map((p) => p.code);
}

export function userCan(user, code) {
  if (!user) return false;
  return permissionsForRole(user.role_id).includes(code);
}

/* ------------------------------------------------------------------ */
/* Audit + activity + notifications                                    */
/* ------------------------------------------------------------------ */

/**
 * These are written alongside the thing they describe and most callers do not
 * await them. A failed audit write must not take the request down with it, so
 * each one swallows and reports its own error; awaiting still works for the
 * places that want to be sure the row landed.
 */
const fireAndForget = (promise, what) =>
  promise.catch((err) => {
    console.error(`Could not write ${what}: ${err.message}`);
    return null;
  });

export function audit({ user_id, action, entity_type, entity_id, old_values = null, new_values = null }) {
  return fireAndForget(sql.insert('audit_logs', {
    user_id: user_id ?? null,
    action,
    entity_type,
    entity_id: entity_id ?? null,
    old_values: old_values === null ? null : JSON.stringify(old_values),
    new_values: new_values === null ? null : JSON.stringify(new_values),
    ...origin(),
  }), 'an audit row');
}

export function activity({ user_id, action, detail = null }) {
  return fireAndForget(sql.insert('user_activity_logs', {
    user_id: user_id ?? null,
    action,
    detail,
    ...origin(),
  }), 'an activity row');
}

export function notify({ user_id, type, title, body = null, related_type = null, related_id = null }) {
  return fireAndForget(sql.insert('notifications', {
    user_id, type, title, body, related_type, related_id,
    is_read: 0, read_at: null,
  }), 'a notification');
}

/** Notify every active user holding a permission - e.g. all botanists. */
export async function notifyPermission(code, payload) {
  const users = await sql.q(
    'SELECT id, role_id FROM users WHERE is_active = 1 AND deleted_at IS NULL',
  );
  for (const u of users) {
    if (permissionsForRole(u.role_id).includes(code)) {
      await notify({ ...payload, user_id: u.id });
    }
  }
}

/** Field-level history, shown on a plant's history tab. */
export async function recordRevisions(plantId, userId, before, after, reason = null) {
  const skip = new Set(['id', 'created_at', 'updated_at', 'view_count']);
  const out = [];
  for (const key of Object.keys(after)) {
    if (skip.has(key)) continue;
    const a = before?.[key] ?? null;
    const b = after[key] ?? null;
    if (String(a ?? '') === String(b ?? '')) continue;
    out.push(await sql.insert('plant_revisions', {
      plant_id: plantId,
      changed_by: userId ?? null,
      source_table: 'plants',
      field_name: key,
      old_value: a === null ? null : String(a),
      new_value: b === null ? null : String(b),
      change_reason: reason,
    }));
  }
  return out;
}
