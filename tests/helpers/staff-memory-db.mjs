// Deliberately isolated persistence for workflow API tests. No SQL connection,
// environment loading, network services, or production data are used.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();
export const nowIso = () => new Date().toISOString();
export const state = {};
const grants = {
  1: ['user.view', 'user.manage', 'user.assign_role', 'system.audit', 'system.settings'],
  2: ['sensor.view', 'alert.resolve'],
  3: ['plant.view_all', 'plant.create', 'plant.edit', 'plant.archive', 'plant.history', 'sensor.view'],
  4: ['plant.view_all', 'plant.edit', 'plant.approve', 'plant.history'],
};
// The super admin holds every permission the other roles do, and more.
grants[5] = [...new Set([...Object.values(grants).flat(), 'plant.approve', 'qr.manage', 'sensor.manage'])];
export const permissionsForRole = (id) => grants[id] || [];
export const userCan = (user, code) => !!user && permissionsForRole(user.role_id).includes(code);
export const roles = () => Object.keys(grants).map((id) => ({ id: Number(id), name: Number(id) === 5 ? 'superadmin' : `role${id}` }));
export const roleById = (id) => roles().find((r) => r.id === Number(id));
export const getSetting = (key) => ({ require_approval: true, protect_locations: 'off' })[key] ?? null;
export const setSetting = async () => { throw new Error('Settings writes are outside this fixture'); };
export const allSettings = () => [];
export const audit = async (row) => state.audits.push(row);
export const activity = async () => {};
export const notify = async (row) => state.notifications.push(row);
export const notifyPermission = async () => {};
export const recordRevisions = async () => {};

export function reset(plant = {}) {
  Object.assign(state, {
    users: [1, 2, 3, 4, 5].map((id) => ({ id, role_id: id, full_name: `Staff ${id}`, is_active: 1 })),
    species: [{ id: 1, scientific_name: 'Shorea test' }],
    plants: [{ id: 10, plant_code: 'PLT-2026-0010', registered_by: 3, status: 'pending',
      species_id: 1, site_name: 'Test trail', latitude: 4, longitude: 113,
      verified_by: null, verified_at: null, ...plant }],
    plant_submissions: [{ id: 20, plant_id: 10, submitted_by: 3, status: 'pending' }],
    qr_codes: [], plant_photos: [], sensor_alerts: [{ id: 30, status: 'open', reading_value: '10.5' }],
    notifications: [], audits: [], failQrWrite: false,
  });
}
export const byId = async (table, id) => structuredClone(state[table]?.find((row) => row.id === Number(id)) || null);
export async function update(table, id, patch) {
  if (table === 'qr_codes' && state.failQrWrite) throw new Error('Test QR write failure');
  const row = state[table]?.find((item) => item.id === Number(id));
  if (!row) throw new Error(`Missing fixture row ${table}/${id}`);
  Object.assign(row, patch);
  return structuredClone(row);
}
export async function insert(table, values) {
  const rows = state[table] ||= [];
  const row = { id: Math.max(0, ...rows.map((r) => r.id)) + 1, ...values };
  rows.push(row);
  return structuredClone(row);
}
export async function tx(fn) {
  const snapshot = structuredClone(state);
  try {
    return await fn({ q, one, count, insert, update, byId });
  } catch (error) {
    Object.assign(state, snapshot);
    throw error;
  }
}
export async function count(sql) {
  if (sql.includes('MAX(CAST')) return 10;
  throw new Error(`Unimplemented fixture count: ${sql}`);
}
export async function one(sql, params = []) {
  if (sql.includes('FROM refresh_tokens')) {
    const user = state.users.find((u) => crypto.createHash('sha256').update(`staff-${u.id}`).digest('hex') === params[0]);
    return user ? { user_id: user.id } : null;
  }
  return (await q(sql, params))[0] || null;
}
export async function q(sql, params = []) {
  const compact = sql.replace(/\s+/g, ' ').trim();
  if (compact === 'SELECT * FROM plants WHERE id = ? FOR UPDATE') {
    const row = await byId('plants', params[0]);
    return row ? [row] : [];
  }
  if (compact.startsWith('UPDATE plants SET status = ?, updated_at = ?')) {
    return update('plants', params[2], { status: params[0], updated_at: params[1] });
  }
  if (compact.startsWith("UPDATE qr_codes SET status = 'active'")) {
    return update('qr_codes', params[0], { status: 'active', deactivated_at: null, deactivation_reason: null });
  }
  if (compact.startsWith('SELECT p.*')) {
    return structuredClone(state.plants.filter((p) => p.id === Number(params[0])).map((p) => ({ ...p, scientific_name: 'Shorea test' })));
  }
  if (/FROM (qr_scans|plant_reports)/.test(compact)) return [];
  const table = /FROM (plant_photos|qr_codes|plant_submissions|users|species)\b/.exec(compact)?.[1];
  if (!table) throw new Error(`Unimplemented fixture SQL: ${compact}`);
  let rows = state[table];
  if (compact.includes('plant_id = ?')) rows = rows.filter((r) => r.plant_id === Number(params[0]));
  if (compact.includes('plant_id IN')) rows = rows.filter((r) => params.includes(r.plant_id));
  if (compact.includes('WHERE id IN')) rows = rows.filter((r) => params.includes(r.id));
  const status = /status = '(pending|active|inactive)'/.exec(compact)?.[1];
  if (status && !compact.includes('ORDER BY (status')) rows = rows.filter((r) => r.status === status);
  if (table === 'plant_submissions' && compact.includes('ORDER BY')) rows = [...rows].sort((a, b) => b.id - a.id);
  return structuredClone(rows);
}
