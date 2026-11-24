import crypto from 'node:crypto';
import { getSetting, q, one, nowIso, activity, audit } from './db.js';

/*
 * Brute-force lockout. See section 16 of Server/schema-extensions.sql.
 *
 * An administrator chooses what a run of wrong guesses locks, in any
 * combination:
 *   - the account   (lockout_account) - whoever guesses, the account closes.
 *                    Administrator accounts are locked like any other.
 *   - the IP address (lockout_ip)     - one network stops, other people carry on.
 *   - the device     (lockout_device) - one browser stops, by the random id it
 *                    keeps (X-Device-Id). A determined attacker can clear it,
 *                    which is why it is one layer among three, not the only one.
 * lockout_max_attempts and lockout_minutes apply to all three.
 *
 * Account counts live on users (failed_login_count, locked_until), as before.
 * IP and device counts live in login_lockouts - in the database, never in
 * server memory, so a restart or a reseed cannot wipe or confuse them.
 */

export const LIMITS = {
  attempts: { min: 3, max: 20 },
  minutes: { min: 1, max: 1440 }, // a day at most, so no one is shut out for long
};

const clamp = (n, { min, max }, fallback) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

/** The policy in force right now, read from settings with safe defaults. */
export function policy() {
  const flag = (key, fallback) => {
    const v = getSetting(key);
    return v === null || v === undefined ? fallback : !!v;
  };
  return {
    account: flag('lockout_account', true),
    ip: flag('lockout_ip', false),
    device: flag('lockout_device', false),
    attempts: clamp(getSetting('lockout_max_attempts'), LIMITS.attempts, 5),
    minutes: clamp(getSetting('lockout_minutes'), LIMITS.minutes, 15),
  };
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** The IP and device this request came from; either may be missing. */
export function subjectsOf(req) {
  const ip = String(req.ip || '').replace(/^::ffff:/, '') || null;
  const raw = String(req.get('x-device-id') || '').trim();
  // A real id from the app is 32 hex characters; anything else is ignored.
  const device = /^[a-f0-9]{32}$/i.test(raw) ? raw.toLowerCase() : null;
  const ua = String(req.get('user-agent') || '').slice(0, 190);
  return { ip, device, ua };
}

/** The rows this request is answerable to, for the scopes switched on. */
function keysFor(req, p) {
  const s = subjectsOf(req);
  const keys = [];
  if (p.ip && s.ip) keys.push({ scope: 'ip', key: hash('ip:' + s.ip), label: s.ip });
  if (p.device && s.device) keys.push({ scope: 'device', key: hash('device:' + s.device), label: deviceLabel(s.ua) });
  return keys;
}

function deviceLabel(ua) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}

const minutesUntil = (iso) => Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));

const MESSAGES = {
  ip: 'Too many failed sign-ins from this network. Try again later, or ask an administrator.',
  device: 'Too many failed sign-ins from this device. Try again later, or ask an administrator.',
};

/**
 * Whether this request's IP or device is locked. Returns the 423 body to send,
 * or null. Checked before the email is even looked up, so a locked network
 * learns nothing more, whichever account it tries next.
 */
export async function blocked(req) {
  const p = policy();
  for (const k of keysFor(req, p)) {
    const row = await one('SELECT locked_until FROM login_lockouts WHERE scope = ? AND subject_hash = ?', [k.scope, k.key]);
    if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      return { error: MESSAGES[k.scope], scope: k.scope, locked_until: row.locked_until, minutes: minutesUntil(row.locked_until) };
    }
  }
  return null;
}

/**
 * Counts one wrong guess against this request's IP and device (whichever are
 * switched on). A count older than the lock window starts again from one.
 * Returns { left, lock } - guesses left before the nearest lock, and the
 * 423 body when this guess was the one that locked something.
 */
export async function recordSubjectFailure(req, what, userId = null) {
  const p = policy();
  let left = Infinity;
  let lock = null;
  const staleBefore = new Date(Date.now() - p.minutes * 60000).toISOString();
  for (const k of keysFor(req, p)) {
    // One statement, so two guesses racing each other both count.
    await q(
      `INSERT INTO login_lockouts (scope, subject_hash, label, failed_count, last_failed_at)
            VALUES (?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
            failed_count   = IF(last_failed_at < ? OR (locked_until IS NOT NULL AND locked_until < ?), 1, failed_count + 1),
            locked_until   = IF(locked_until IS NOT NULL AND locked_until < ?, NULL, locked_until),
            label          = VALUES(label),
            last_failed_at = VALUES(last_failed_at)`,
      [k.scope, k.key, k.label, nowIso(), staleBefore, nowIso(), nowIso()],
    );
    const row = await one('SELECT id, failed_count FROM login_lockouts WHERE scope = ? AND subject_hash = ?', [k.scope, k.key]);
    const failed = Number(row.failed_count);
    if (failed >= p.attempts) {
      const until = new Date(Date.now() + p.minutes * 60000).toISOString();
      await q('UPDATE login_lockouts SET locked_until = ?, failed_count = 0 WHERE id = ?', [until, row.id]);
      activity({ user_id: userId, action: `${k.scope}_locked`, detail: `${k.scope === 'ip' ? 'Network' : 'Device'} ${k.label} locked for ${p.minutes} minutes after ${p.attempts} wrong attempts (${what})` });
      audit({ user_id: userId, action: `${k.scope}_locked`, entity_type: 'login_lockouts', entity_id: row.id, new_values: { label: k.label, locked_until: until } });
      lock ||= { error: MESSAGES[k.scope], scope: k.scope, locked_until: until, minutes: p.minutes };
    } else {
      left = Math.min(left, p.attempts - failed);
    }
  }
  return { left, lock };
}

/** Active IP and device locks, for the administrators' list. */
export async function activeLocks() {
  return q(
    `SELECT id, scope, label, locked_until, last_failed_at FROM login_lockouts
      WHERE locked_until IS NOT NULL AND locked_until > ? ORDER BY locked_until DESC`,
    [nowIso()],
  );
}

/** An administrator lifts one early. Returns the row, or null when none. */
export async function unlock(id) {
  const row = await one('SELECT * FROM login_lockouts WHERE id = ?', [id]);
  if (!row) return null;
  await q('UPDATE login_lockouts SET locked_until = NULL, failed_count = 0 WHERE id = ?', [id]);
  return row;
}
