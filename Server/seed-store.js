/**
 * Fixture store for the demo dataset.
 *
 * seed.js builds a full park's worth of plausible records - species, plants,
 * photographs, submissions, tags, scans, audit trail - and this is where it
 * assembles them. These arrays are a staging area for `npm run seed`, not the
 * database: the running API reads and writes MySQL through Server/sql.js and
 * never touches anything here.
 *
 * It mirrors the helpers db.js used to export, so seed.js did not have to be
 * rewritten to generate the same data.
 */

export const store = {
  roles: [],
  permissions: [],
  role_permissions: [],
  users: [],
  password_resets: [],
  refresh_tokens: [],
  user_activity_logs: [],
  conservation_statuses: [],
  species: [],
  plants: [],
  plant_photos: [],
  plant_submissions: [],
  plant_revisions: [],
  plant_reports: [],
  qr_codes: [],
  qr_scans: [],
  notifications: [],
  audit_logs: [],
  settings: [],
  sensor_devices: [],  // IoT: the real-kit node, added in seed.js
  sensor_readings: [],
  sensor_alerts: [],
  camera_devices: [],  // AI camera (ai-vision-node), added in seed.js
  camera_alerts: [],
};

/** Alias kept so seed.js reads the same as it always did. */
export const db = store;

const counters = {};

export const nowIso = () => new Date().toISOString();

export function insert(table, row) {
  counters[table] = (counters[table] || 0) + 1;
  const rec = { id: counters[table], created_at: nowIso(), ...row };
  store[table].push(rec);
  return rec;
}

export function reset() {
  for (const key of Object.keys(store)) store[key].length = 0;
  for (const key of Object.keys(counters)) delete counters[key];
}

/* The same shapes db.js writes, so the fixtures match the schema. */

export function audit({ user_id, action, entity_type, entity_id, old_values = null, new_values = null }) {
  return insert('audit_logs', {
    user_id: user_id ?? null, action, entity_type, entity_id: entity_id ?? null,
    old_values, new_values,
    ip_address: '127.0.0.1', user_agent: 'Prototype X demo',
  });
}

export function activity({ user_id, action, detail = null }) {
  return insert('user_activity_logs', {
    user_id: user_id ?? null, action, detail,
    ip_address: '127.0.0.1', user_agent: 'Prototype X demo',
  });
}

export function notify({ user_id, type, title, body = null, related_type = null, related_id = null }) {
  return insert('notifications', {
    user_id, type, title, body, related_type, related_id, is_read: 0, read_at: null,
  });
}

export function permissionsForRole(roleId) {
  const ids = store.role_permissions.filter((rp) => rp.role_id === roleId).map((rp) => rp.permission_id);
  return store.permissions.filter((p) => ids.includes(p.id)).map((p) => p.code);
}

export function notifyPermission(code, payload) {
  for (const u of store.users) {
    if (!u.is_active || u.deleted_at) continue;
    if (permissionsForRole(u.role_id).includes(code)) notify({ ...payload, user_id: u.id });
  }
}

export function getSetting(key) {
  const row = store.settings.find((s) => s.setting_key === key);
  if (!row) return null;
  if (row.value_type === 'bool') return row.setting_value === 'true';
  if (row.value_type === 'int') return Number(row.setting_value);
  if (row.value_type === 'json') {
    try { return JSON.parse(row.setting_value); } catch { return null; }
  }
  return row.setting_value;
}
