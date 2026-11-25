import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import {
  q, one, count, insert, update, byId, tx, nowIso,
  getSetting, setSetting, allSettings, permissionsForRole, userCan,
  roles as cachedRoles, roleById,
  audit, activity, notify, notifyPermission, recordRevisions, requestContext,
} from './db.js';
import path from 'node:path';
import { photoExists, PHOTO_DIR, SPECIES_DATA, hasRealPhotos } from './species-data.js';
import { lanAddresses, localHostName } from './net.js';
import { hashPassword, verifyPassword, temporaryPassword } from './passwords.js';
import { createApiRateLimits } from './security.js';
import * as passkeys from './passkeys.js';
import * as lockout from './lockout.js';
import { sendMail, maskEmail } from './mailer.js';
import * as totp from './totp.js';

/**
 * An async handler that rejects does not reach Express 4's error middleware on
 * its own - the request simply hangs. Everything below is wrapped in this.
 */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Placeholders for an IN clause; mysql2's execute() will not expand an array. */
const placeholders = (list) => list.map(() => '?').join(', ');

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tokens are opaque random strings. The hash of each one is stored in
 * refresh_tokens, exactly as the schema specifies - the token itself is never
 * written down. The Map in front of it is a cache, not the record: a restart
 * empties it and the next request falls back to the table, so a signed-in
 * ranger stays signed in across a redeploy.
 */
const sessions = new Map(); // token -> user_id

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  await insert('refresh_tokens', {
    user_id: userId,
    token_hash: hashToken(token),
    device_info: 'Prototype browser session',
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    revoked_at: null,
  });
  return token;
}

async function revokeToken(token) {
  sessions.delete(token);
  await q('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [nowIso(), hashToken(token)]);
}

async function revokeAllFor(userId) {
  for (const [token, uid] of sessions) if (uid === userId) sessions.delete(token);
  await q('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [nowIso(), userId]);
}

/** Every session but the one in use - a password change signs out the other devices. */
async function revokeOthersFor(userId, keepToken) {
  for (const [token, uid] of sessions) if (uid === userId && token !== keepToken) sessions.delete(token);
  await q('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL',
    [nowIso(), userId, hashToken(keepToken)]);
}

async function currentUser(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  let id = sessions.get(token);
  if (!id) {
    const row = await one(
      `SELECT user_id FROM refresh_tokens
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
      [hashToken(token), nowIso()],
    );
    if (!row) return null;
    id = row.user_id;
    sessions.set(token, id);
  }

  // Re-read on every request, so deactivating an account takes effect at once
  // rather than when the token happens to expire.
  const user = await byId('users', id);
  if (!user || !user.is_active || user.deleted_at) return null;
  return user;
}

/*
 * Wrong-password lockout. What it locks - the account, the IP address, the
 * device, or any mix - and how many guesses and for how long are settings an
 * administrator chooses: see Server/lockout.js and section 16 of
 * Server/schema-extensions.sql. Administrator accounts are locked like any other.
 */
const LOCKED_MESSAGE = 'This account is locked after too many wrong passwords.';

/** The 423 body for a locked account. */
const accountLockBody = (until) => ({
  error: LOCKED_MESSAGE, scope: 'account', locked_until: until,
  minutes: Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000)),
});

/**
 * Whether this attempt is refused before anything is checked: this IP or
 * device is locked, or (when there is one) the account is. The 423 body, or null.
 */
async function lockedOut(req, user) {
  const subject = await lockout.blocked(req);
  if (subject) return subject;
  if (user && isLocked(user)) return accountLockBody(user.locked_until);
  return null;
}

/**
 * Counts one wrong guess - a password, a recovery code, an authenticator code -
 * against everything the administrators chose to lock: the account (when
 * there is one), this IP address and this device. Returns `lock`, the 423 body
 * when this guess locked something, and `left`, the guesses left before the
 * nearest lock (null when nothing is counting).
 */
async function recordFailedAttempt(req, user, what) {
  const p = lockout.policy();
  const subjects = await lockout.recordSubjectFailure(req, what, user?.id ?? null);
  let left = subjects.left;
  let lock = subjects.lock;

  if (user && p.account) {
    // Incremented in SQL, so two attempts racing each other both count.
    await q('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ?', [user.id]);
    const failed = Number((await one('SELECT failed_login_count FROM users WHERE id = ?', [user.id])).failed_login_count);
    if (failed < p.attempts) {
      activity({ user_id: user.id, action: 'login_failed', detail: `Wrong ${what} (${failed} of ${p.attempts})` });
      left = Math.min(left, p.attempts - failed);
    } else {
      const until = new Date(Date.now() + p.minutes * 60000).toISOString();
      await update('users', user.id, { failed_login_count: 0, locked_until: until });
      // Any session already open stays a risk while someone guesses at the account.
      await revokeAllFor(user.id);
      activity({ user_id: user.id, action: 'account_locked', detail: `Locked for ${p.minutes} minutes after ${p.attempts} wrong attempts` });
      // Whoever was guessing is unknown, so the entry is filed under the account.
      audit({ user_id: user.id, action: 'account_locked', entity_type: 'users', entity_id: user.id, new_values: { locked_until: until } });
      lock = accountLockBody(until);
    }
  } else if (user) {
    activity({ user_id: user.id, action: 'login_failed', detail: `Wrong ${what}` });
  }
  return { lock, left: Number.isFinite(left) ? left : null };
}

/* Password rules, shared by changing a password and recovering one. */
const MIN_PASSWORD = 8;

function newPasswordProblem(pw, current) {
  pw = String(pw || '');
  // Fixed wording rather than templates, so the browser can translate them.
  if (pw.length < MIN_PASSWORD) return 'The new password must be at least 8 characters.';
  if (pw.length > 128) return 'The new password is too long (maximum 128 characters).';
  if (current && pw === String(current)) {
    return 'Choose a password you have not used here before.';
  }
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'The new password needs at least one letter and one number.';
  return null;
}

/*
 * Recovery codes - see section 10 of Server/schema-extensions.sql.
 *
 * Twelve characters from an alphabet with no 0/O, 1/I/L or 5/S to confuse
 * when copied off paper: about 58 bits, so a plain SHA-256 is enough to store
 * it. Unlike a password it is never chosen by a person, and the lockout caps
 * guessing at five tries per fifteen minutes.
 */
const CODE_ALPHABET = '2346789ABCDEFGHJKMNPQRTUVWXYZ';

function newRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

// Case, spaces and dashes do not matter when the code is typed back in.
const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '')).digest('hex');

function recoveryCodeMatches(code, storedHash) {
  if (!code || String(storedHash || '').length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(hashRecoveryCode(code)), Buffer.from(String(storedHash)));
}

/**
 * An audit row as the screens expect it, with the before and after values as
 * objects. MariaDB (XAMPP's "MySQL") stores a JSON column as text and the
 * driver hands it back as a string; the audit screen then listed it one
 * character at a time. MySQL proper returns an object, which passes through.
 */
function auditRow(row) {
  const parse = (v) => {
    if (typeof v !== 'string') return v ?? null;
    try {
      const out = JSON.parse(v);
      // A value double-encoded somewhere upstream is a string of JSON; unwrap once more.
      return typeof out === 'string' ? JSON.parse(out) : out;
    } catch {
      return { value: v };
    }
  };
  return { ...row, old_values: parse(row.old_values), new_values: parse(row.new_values) };
}

/*
 * Two-step verification - section 14 of Server/schema-extensions.sql. A right
 * password on an account with it on earns a short-lived ticket, not a session;
 * the ticket plus the authenticator's current code earns the session.
 */
const TICKET_MS = 5 * 60 * 1000;
const tickets = new Map(); // ticket -> { userId, expires }

function issueTicket(userId) {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId, expires: now + TICKET_MS });
  return ticket;
}

/**
 * After a self-service password reset (recovery code, approval, email): signed
 * straight in - unless two-step verification is on, which a new password does
 * not get round. Then they sign in normally, password and authenticator code.
 */
async function finishReset(after, freshCode) {
  if (after.totp_enabled_at) return { user: shapeUser(after), recovery_code: freshCode, sign_in_again: true };
  return { token: await issueToken(after.id), user: shapeUser(after), recovery_code: freshCode };
}

/* Administrators' recovery email - section 13 of Server/schema-extensions.sql. */
const EMAIL_CODE_MINUTES = 15;
const MAX_EMAIL_CODE_TRIES = 5;
const emailSentAt = new Map(); // "user:purpose" -> when a code last went out
const isAdmin = (u) => permissionsForRole(u.role_id).includes('user.manage');

/*
 * Super admin - section 17 of Server/schema-extensions.sql. It holds every
 * permission, so ordinary permission checks already let it in everywhere.
 * What it adds is a ceiling for everyone else: only a super admin may touch a
 * super admin account or hand the role out, so a breached administrator
 * cannot lock the super admin out or make themselves one.
 */
const isSuperAdmin = (u) => roleById(u?.role_id)?.name === 'superadmin';
const SUPER_ONLY = 'Only a super admin can change a super admin account.';
const SUPER_GRANT = 'Only a super admin can give the super admin role.';

/** Why `actor` may not act on `target` (or give it `roleId`), or null when they may. */
function superAdminBlock(actor, target, roleId) {
  if (isSuperAdmin(actor)) return null;
  if (target && isSuperAdmin(target)) return SUPER_ONLY;
  if (roleId != null && roleById(roleId)?.name === 'superadmin') return SUPER_GRANT;
  return null;
}
const hashEmailCode = (code) => crypto.createHash('sha256').update(String(code || '').replace(/\D/g, '')).digest('hex');

/** At most one code a minute per account and purpose, so nobody can flood an inbox. */
function emailThrottled(userId, purpose) {
  const key = userId + ':' + purpose;
  if (Date.now() - (emailSentAt.get(key) || 0) < 60000) return true;
  emailSentAt.set(key, Date.now());
  return false;
}

/** A new six-digit code; any older one for the same purpose stops working. */
async function issueEmailCode(user, purpose, email) {
  await q('UPDATE email_codes SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [nowIso(), user.id, purpose]);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await insert('email_codes', {
    user_id: user.id, purpose, email, code_hash: hashEmailCode(code),
    expires_at: new Date(Date.now() + EMAIL_CODE_MINUTES * 60000).toISOString(), created_at: nowIso(),
  });
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  const text = purpose === 'verify'
    ? `Hello ${user.full_name},\n\nYour code to confirm this as your FloraScan recovery email is:\n\n    ${spaced}\n\nIt works for ${EMAIL_CODE_MINUTES} minutes. If you did not ask for this, ignore this email.`
    : `Hello ${user.full_name},\n\nSomeone asked to reset the FloraScan password for ${user.email}. Your code is:\n\n    ${spaced}\n\nIt works for ${EMAIL_CODE_MINUTES} minutes. If this was not you, ignore this email - your password stays as it is.`;
  return sendMail({
    to: email,
    subject: purpose === 'verify' ? 'Confirm your FloraScan recovery email' : 'Your FloraScan password reset code',
    text,
  });
}

/** Checks a typed code against the newest live one; counts and retires wrong guesses. */
async function checkEmailCode(userId, purpose, typed) {
  const row = await one(
    'SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1',
    [userId, purpose],
  );
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return { ok: false, row: null };
  if (hashEmailCode(typed) !== row.code_hash) {
    const attempts = row.attempts + 1;
    await update('email_codes', row.id, attempts >= MAX_EMAIL_CODE_TRIES ? { attempts, used_at: nowIso() } : { attempts });
    return { ok: false, row };
  }
  await update('email_codes', row.id, { used_at: nowIso() });
  return { ok: true, row };
}

/* Asking an administrator to approve a reset - section 12 of Server/schema-extensions.sql. */
const RESET_REQUEST_MINUTES = 30;
// Once approved, the new password has to be chosen promptly: an approval left
// open is an open door for whoever reaches that screen next.
const APPROVAL_MINUTES = 5;
const MAX_WRONG_CHECK_CODES = 5;
const requestExpired = (row) => new Date(row.expires_at).getTime() < Date.now()
  || (row.status === 'approved' && row.decided_at
    && Date.now() - new Date(row.decided_at).getTime() > APPROVAL_MINUTES * 60000);

/** The request waiting on an account, if there is one still in time. */
async function pendingResetRequest(userId) {
  const row = await one(
    "SELECT * FROM password_reset_requests WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [userId],
  );
  return row && !requestExpired(row) ? row : null;
}

const isLocked = (u) => !!u?.locked_until && new Date(u.locked_until).getTime() > Date.now();
const minutesLeft = (u) => Math.max(1, Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000));

function shapeUser(u) {
  if (!u) return null;
  const role = roleById(u.role_id);
  return {
    id: u.id, full_name: u.full_name, email: u.email, title: u.title,
    phone: u.phone, role: role?.name, role_label: role?.label, role_id: u.role_id,
    is_active: !!u.is_active, must_change_password: !!u.must_change_password,
    has_recovery_code: !!u.recovery_code_hash,
    // Masked even to the owner and other admins: a personal address, shown only enough to recognise.
    recovery_email: u.recovery_email_verified_at ? maskEmail(u.recovery_email) : null,
    two_factor: !!u.totp_enabled_at,
    // A request runs out after half an hour, and so does the badge.
    reset_requested_at: u.reset_requested_at
      && Date.now() - new Date(u.reset_requested_at).getTime() < RESET_REQUEST_MINUTES * 60000
      ? u.reset_requested_at : null,
    last_login_at: u.last_login_at, created_at: u.created_at,
    // Only while the lock is still running; an expired lock is no lock.
    locked_until: isLocked(u) ? u.locked_until : null,
    permissions: permissionsForRole(u.role_id),
  };
}

/* ------------------------------------------------------------------ */
/* Location protection for threatened species                          */
/* ------------------------------------------------------------------ */

/**
 * Publishing a precise coordinate for a critically endangered plant tells
 * collectors exactly where to go. The schema anticipated this; here it is
 * enforced in the API so it cannot be bypassed by calling the endpoint
 * directly, and the `protect_locations` setting decides how far up the Red
 * List the rule reaches.
 *
 * Park staff still see the real location - they have to be able to find it.
 */
const THREAT_ORDER = ['NE', 'DD', 'LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX'];

function protectedCodes() {
  const from = getSetting('protect_locations') || 'off';
  if (from === 'off') return new Set();
  const start = THREAT_ORDER.indexOf(from);
  if (start < 0) return new Set();
  // Everything at or above the chosen category, excluding the two extinct
  // categories, where there is no living plant left to protect.
  return new Set(THREAT_ORDER.slice(start).filter((c) => c !== 'EW' && c !== 'EX'));
}

export function isLocationProtected(conservationCode) {
  return !!conservationCode && protectedCodes().has(conservationCode);
}

/** Strips every locating field from an already-shaped plant. */
function withheldLocation(shaped) {
  return {
    ...shaped,
    location_protected: true,
    latitude: null,
    longitude: null,
    altitude_m: null,
    gps_accuracy_m: null,
    location_notes: null,
    site_name: 'Location withheld',
    location_withheld_reason:
      'The exact location of this species is not published, to protect it from collection.',
  };
}

/* ------------------------------------------------------------------ */
/* Reading plants                                                      */
/* ------------------------------------------------------------------ */

/**
 * Plants always come back joined to their species and conservation status,
 * which is what every caller needs and what v_public_plants does for the
 * public half. One query rather than one per row.
 */
const PLANT_SELECT = `
  SELECT p.*,
         s.scientific_name, s.common_name, s.local_name, s.family, s.genus,
         s.growth_form, s.conservation_status_id,
         cs.code  AS conservation_code,
         cs.label AS conservation_label
    FROM plants p
    LEFT JOIN species s  ON s.id = p.species_id
    LEFT JOIN conservation_statuses cs ON cs.id = s.conservation_status_id
`;

const plantsWhere = (clause, params = []) => q(`${PLANT_SELECT} WHERE ${clause}`, params);

/**
 * Everything shapePlant needs that is not on the joined row, fetched for a
 * whole page at once.
 *
 * Doing this per plant is what makes a list page slow: six lookups each, which
 * on a 130-row register is close to eight hundred round trips. Against a
 * database in Singapore that is half a minute. Five queries instead.
 */
async function plantExtras(rows) {
  const ids = rows.map((r) => r.id);
  const empty = { photos: new Map(), qr: new Map(), users: new Map(), subs: new Map(), scans: new Map(), reports: new Map(), species: new Map() };
  if (!ids.length) return empty;

  const userIds = [...new Set(rows.flatMap((r) => [r.registered_by, r.verified_by]).filter(Boolean))];
  const speciesIds = [...new Set(rows.map((r) => r.species_id).filter(Boolean))];
  const ph = placeholders(ids);

  const [photos, codes, users, subs, scans, reports, species] = await Promise.all([
    q(`SELECT * FROM plant_photos WHERE plant_id IN (${ph}) AND deleted_at IS NULL
        ORDER BY is_primary DESC, id ASC`, ids),
    q(`SELECT * FROM qr_codes WHERE plant_id IN (${ph})
        ORDER BY (status = 'active') DESC, id ASC`, ids),
    userIds.length
      ? q(`SELECT id, full_name FROM users WHERE id IN (${placeholders(userIds)})`, userIds)
      : [],
    // id breaks the tie: DATETIME keeps whole seconds, and a record returned
    // and resubmitted within one second has two rows with the same time.
    q(`SELECT * FROM plant_submissions WHERE plant_id IN (${ph}) ORDER BY submitted_at DESC, id DESC`, ids),
    q(`SELECT plant_id, COUNT(*) n FROM qr_scans WHERE plant_id IN (${ph}) GROUP BY plant_id`, ids),
    q(`SELECT plant_id, COUNT(*) n FROM plant_reports WHERE plant_id IN (${ph}) GROUP BY plant_id`, ids),
    // The whole species row, not just the columns joined onto the plant: a
    // detail page shows the description, characteristics and the leaf, flower
    // and fruit sections.
    speciesIds.length
      ? q(`SELECT * FROM species WHERE id IN (${placeholders(speciesIds)})`, speciesIds)
      : [],
  ]);

  const group = (list, key) => {
    const m = new Map();
    for (const row of list) {
      if (!m.has(row[key])) m.set(row[key], []);
      m.get(row[key]).push(row);
    }
    return m;
  };

  return {
    photos: group(photos, 'plant_id'),
    qr: group(codes, 'plant_id'),
    users: new Map(users.map((u) => [u.id, u])),
    subs: group(subs, 'plant_id'),
    scans: new Map(scans.map((r) => [r.plant_id, Number(r.n)])),
    reports: new Map(reports.map((r) => [r.plant_id, Number(r.n)])),
    species: new Map(species.map((s) => [s.id, s])),
  };
}

/*
 * Photographs of a record that is not published yet are served only to staff
 * who may see it (GET /photos/upload/:id). The app shows them with a plain
 * <img>, which cannot send the session token, so a reviewer saw a broken image
 * for every uploaded photograph in the review queue. Instead, the addresses
 * handed to such a viewer carry a short-lived signature. It is keyed per server
 * process, names one photograph, and runs out within 12 hours; published
 * photographs keep their plain, cacheable address.
 */
const PHOTO_SIG_KEY = crypto.randomBytes(32);
const PHOTO_SIG_HOURS = 12;
const UPLOAD_PATH = /^\/api\/photos\/upload\/(\d+)$/;
const photoSig = (photoId, exp) =>
  crypto.createHmac('sha256', PHOTO_SIG_KEY).update(`${photoId}.${exp}`).digest('base64url');

function signedPhotoPath(file) {
  const m = UPLOAD_PATH.exec(file || '');
  if (!m) return file;
  // Whole hours, so the address - and the browser's copy - is stable for an hour.
  const exp = (Math.floor(Date.now() / 3600000) + PHOTO_SIG_HOURS) * 3600;
  return `${file}?exp=${exp}&sig=${photoSig(m[1], exp)}`;
}

function validPhotoSig(photoId, exp, sig) {
  const e = Number(exp);
  if (!Number.isInteger(e) || e * 1000 < Date.now() || typeof sig !== 'string') return false;
  const want = Buffer.from(photoSig(String(photoId), e));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function shapePlant(p, ex, { full = false, viewer = null } = {}) {
  if (!p) return null;
  const mayOpen = viewer && p.status !== 'approved'
    && (userCan(viewer, 'plant.view_all') || p.registered_by === viewer.id);
  const photos = (ex.photos.get(p.id) || []).map((ph) => (mayOpen
    ? { ...ph, file_path: signedPhotoPath(ph.file_path), thumbnail_path: signedPhotoPath(ph.thumbnail_path) }
    : ph));
  const qr = (ex.qr.get(p.id) || [])[0] || null;
  const sub = (ex.subs.get(p.id) || [])[0] || null;

  const base = {
    id: p.id,
    plant_code: p.plant_code,
    status: p.status,
    species_id: p.species_id,
    proposed_species_name: p.proposed_species_name,
    species_not_listed: !p.species_id,
    scientific_name: p.scientific_name ?? null,
    common_name: p.common_name ?? null,
    local_name: p.local_name ?? null,
    family: p.family ?? null,
    genus: p.genus ?? null,
    growth_form: p.growth_form ?? null,
    conservation_code: p.conservation_code ?? null,
    conservation_label: p.conservation_label ?? null,
    latitude: p.latitude, longitude: p.longitude,
    altitude_m: p.altitude_m, gps_accuracy_m: p.gps_accuracy_m,
    site_name: p.site_name, location_notes: p.location_notes,
    height_m: p.height_m, trunk_diameter_cm: p.trunk_diameter_cm,
    health_status: p.health_status, life_stage: p.life_stage,
    morphology_notes: p.morphology_notes, notes: p.notes,
    view_count: p.view_count,
    registered_at: p.registered_at, verified_at: p.verified_at,
    registered_by: p.registered_by,
    registered_by_name: ex.users.get(p.registered_by)?.full_name ?? null,
    verified_by_name: ex.users.get(p.verified_by)?.full_name ?? null,
    qr_token: qr?.qr_token ?? null,
    photo: photos[0]?.file_path ?? null,
    photo_remote: photos[0]?.remote_url ?? null,
    photo_credit: photos[0]?.credit ?? null,
    photo_tint: photos[0]?.tint ?? null,
    photo_count: photos.length,
    review_comment: sub?.status === 'rejected' ? sub.review_comment : null,
    submission_id: sub?.id ?? null,
  };

  // Anyone not signed in as staff gets the protected view.
  const protect = !viewer && isLocationProtected(base.conservation_code);
  if (!full) return protect ? withheldLocation(base) : base;

  const detail = {
    ...base,
    species: p.species_id && ex.species.get(p.species_id) ? {
      ...ex.species.get(p.species_id),
      conservation_code: p.conservation_code ?? 'NE',
      conservation_label: p.conservation_label ?? 'Not evaluated',
    } : null,
    photos,
    submission: sub,
    // On a resubmitted record the reviewer needs what was asked last time,
    // and the botanist's reply, side by side.
    previous_return: (ex.subs.get(p.id) || []).find((x) => x !== sub && x.status === 'rejected') || null,
    scan_count: ex.scans.get(p.id) || 0,
    reports: ex.reports.get(p.id) || 0,
  };
  return protect ? withheldLocation(detail) : detail;
}

/** Fetch, then shape, a set of plants - the pairing every endpoint needs. */
async function shapeMany(rows, opts) {
  const ex = await plantExtras(rows);
  return rows.map((r) => shapePlant(r, ex, opts));
}

async function shapeOne(row, opts) {
  if (!row) return null;
  const ex = await plantExtras([row]);
  return shapePlant(row, ex, opts);
}

/** The species row plus its status and how many plants reference it. */
async function shapeSpecies(s) {
  if (!s) return null;
  const cs = s.conservation_status_id ? await byId('conservation_statuses', s.conservation_status_id) : null;
  return {
    ...s,
    conservation_code: cs?.code ?? 'NE',
    conservation_label: cs?.label ?? 'Not evaluated',
    conservation_source: s.conservation_source ?? null,
    plant_count: await count('SELECT COUNT(*) FROM plants WHERE species_id = ? AND deleted_at IS NULL', [s.id]),
  };
}

/* ------------------------------------------------------------------ */
/* Where a printed tag should point                                    */
/* ------------------------------------------------------------------ */

/**
 * The address a QR tag encodes.
 *
 * A tag is printed once and then screwed to a post for years, so it must not
 * carry an address that only works on the machine that generated it. A
 * botanist printing tags from a laptop is browsing `localhost`, and a tag
 * encoding `localhost` sends every phone that scans it to its own device.
 *
 * Order of preference:
 *   1. `public_base_url`, which the park sets to its real domain before
 *      printing anything for real
 *   2. PUBLIC_BASE_URL from the environment, which is how a deployment sets it
 *   3. the forwarded host, when running behind a platform's proxy
 *   4. the LAN address, reachable from a phone on the same Wi-Fi, which is
 *      what makes the prototype demonstrable
 */
export function publicOrigin(req) {
  const configured = String(getSetting('public_base_url') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;

  // Deployed behind a host's proxy. The app itself speaks plain HTTP while the
  // public address is HTTPS, so the forwarded header is the only honest source
  // of the scheme, and the Host header is the real domain. The machine's own
  // addresses are a private container IP here and must not be used.
  if (req.app.get('trust proxy')) {
    const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const host = req.get('host');
    if (host) return `${proto || req.protocol || 'https'}://${host}`;
  }

  const scheme = req.app.get('protoScheme') || req.protocol || 'https';
  const port = req.app.get('protoPort');
  const lan = lanAddresses()[0]?.address;
  if (lan) return `${scheme}://${lan}${port ? ':' + port : ''}`;

  return `${scheme}://${req.get('host')}`;
}

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mirrors the CHECK constraints in plant_registry_schema.sql, so the API
 * refuses the same values MySQL would refuse - and says why, which a database
 * error would not. Returns an error string, or null when acceptable.
 */
const LIMITS = {
  latitude: [-90, 90],
  longitude: [-180, 180],
  altitude_m: [-500, 9000],
  gps_accuracy_m: [0, 10000],
  height_m: [0, 150],
  trunk_diameter_cm: [0, 1200],
};

const TEXT_LIMITS = {
  site_name: 150,
  proposed_species_name: 180,
  location_notes: 2000,
  morphology_notes: 2000,
  notes: 2000,
};

const ENUMS = {
  health_status: ['healthy', 'fair', 'poor', 'dead'],
  life_stage: ['seedling', 'sapling', 'mature'],
};

function validatePlant(body) {
  for (const [field, [min, max]] of Object.entries(LIMITS)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return `${field} must be a number.`;
    if (n < min || n > max) return `${field} must be between ${min} and ${max}.`;
  }
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const v = body[field];
    if (typeof v === 'string' && v.length > max) {
      return `${field} is too long (${v.length} characters, maximum ${max}).`;
    }
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (!allowed.includes(v)) return `${field} must be one of: ${allowed.join(', ')}.`;
  }
  // Latitude and longitude only mean something together.
  const hasLat = body.latitude !== undefined && body.latitude !== null && body.latitude !== '';
  const hasLon = body.longitude !== undefined && body.longitude !== null && body.longitude !== '';
  if (hasLat !== hasLon) return 'Give both latitude and longitude, or neither.';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------ */
/* Uploaded photographs                                                */
/* ------------------------------------------------------------------ */

/**
 * A photograph arrives from the camera or the file picker as a data URL.
 *
 * It used to be written straight into plant_photos.file_path, which is
 * VARCHAR(255) - a 400KB photograph is about 409,000 characters. MariaDB
 * truncated it silently and stored a corrupt image; MySQL 8 in strict mode
 * refuses the row outright and the registration fails with a 500. Either way
 * the upload never worked.
 *
 * So the bytes are decoded here, checked against max_upload_mb and
 * allowed_image_types - two settings the schema defines and nothing was
 * reading - and stored in plant_photo_data, with file_path holding the address
 * they are served from, as the schema intends.
 */
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i;

function decodeUpload(photo, index) {
  const raw = typeof photo?.data_url === 'string' ? photo.data_url : '';
  if (!raw) return { skip: true };

  const match = DATA_URL.exec(raw.trim());
  if (!match) {
    return { error: `Photograph ${index + 1} is not an image the app can read.` };
  }
  const [, mime, base64] = match;

  const allowed = getSetting('allowed_image_types') || ['image/jpeg', 'image/png', 'image/webp'];
  if (Array.isArray(allowed) && !allowed.includes(mime.toLowerCase())) {
    return { error: `Photograph ${index + 1} is a ${mime} file. Accepted types: ${allowed.join(', ')}.` };
  }

  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { error: `Photograph ${index + 1} could not be decoded.` };
  }
  if (!bytes.length) return { error: `Photograph ${index + 1} is empty.` };

  const maxMb = Number(getSetting('max_upload_mb')) || 8;
  if (bytes.length > maxMb * 1024 * 1024) {
    const mb = (bytes.length / 1048576).toFixed(1);
    return { error: `Photograph ${index + 1} is ${mb} MB. The limit is ${maxMb} MB.` };
  }
  return { mime, bytes };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * The five search fields from the proposal: common name, scientific name,
 * Plant ID, family or genus, and location.
 *
 * Applied to joined rows after they are fetched rather than as SQL. The
 * register is small, and the rule that makes this awkward in SQL - that a
 * withheld location must not be searchable either - is the same rule applied
 * when shaping, so keeping them together keeps them consistent.
 */
function matchesQuery(p, needleRaw, { viewer = null } = {}) {
  if (!needleRaw) return true;
  const needle = String(needleRaw).trim().toLowerCase();
  if (!needle) return true;

  // Searching a trail name must not surface a plant whose location is
  // withheld, or the protection leaks straight back out through the search box.
  const hideLocation = !viewer && isLocationProtected(p.conservation_code);

  const hay = [
    p.plant_code, p.proposed_species_name,
    hideLocation ? null : p.site_name,
    hideLocation ? null : p.location_notes,
    p.scientific_name, p.common_name, p.local_name, p.family, p.genus,
  ].filter(Boolean).join(' ').toLowerCase();
  return needle.split(/\s+/).every((t) => hay.includes(t));
}

/* ------------------------------------------------------------------ */

export function createApi() {
  const api = express.Router();
  // Reject excess traffic before JSON decoding, session SQL, or bcrypt work.
  api.use(createApiRateLimits());

  // Every audit and activity row written while handling this request records
  // who it came from - the caller's address and browser - not placeholders.
  api.use((req, res, next) => requestContext.run({ ip: req.ip, userAgent: req.get('user-agent') }, next));
  api.use(express.json({ limit: '12mb' }));

  /* -------- auth context on every request -------- */
  api.use(route(async (req, res, next) => {
    req.user = await currentUser(req);
    req.can = (code) => userCan(req.user, code);
    next();
  }));

  const need = (code) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!req.can(code)) {
      return res.status(403).json({ error: 'Your role does not have permission: ' + code });
    }
    next();
  };

  /*
   * The audit trail is for administrators only - by role, not just by
   * permission - so granting system.audit to another role later still does
   * not open it up.
   */
  const adminOnly = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!['admin', 'superadmin'].includes(roleById(req.user.role_id)?.name)) {
      return res.status(403).json({ error: 'Only an administrator can open the audit trail.' });
    }
    next();
  };

  /* ================================================================ */
  /* Bootstrap                                                        */
  /* ================================================================ */

  api.get('/bootstrap', route(async (req, res) => {
    const [statuses, facets] = await Promise.all([
      q('SELECT * FROM conservation_statuses ORDER BY sort_order'),
      Promise.all([
        q('SELECT DISTINCT family FROM species WHERE family IS NOT NULL AND deleted_at IS NULL ORDER BY family'),
        q('SELECT DISTINCT genus FROM species WHERE genus IS NOT NULL AND deleted_at IS NULL ORDER BY genus'),
        q('SELECT DISTINCT site_name FROM plants WHERE site_name IS NOT NULL AND deleted_at IS NULL ORDER BY site_name'),
        q('SELECT DISTINCT growth_form FROM species WHERE growth_form IS NOT NULL AND deleted_at IS NULL ORDER BY growth_form'),
      ]),
    ]);
    const [families, genera, sites, growthForms] = facets;

    res.json({
      site_name: getSetting('site_name'),
      park_name: getSetting('park_name'),
      require_approval: getSetting('require_approval'),
      conservation_statuses: statuses,
      roles: cachedRoles().map((r) => ({ ...r, permissions: permissionsForRole(r.id) })),
      families: families.map((r) => r.family),
      genera: genera.map((r) => r.genus),
      sites: sites.map((r) => r.site_name),
      growth_forms: growthForms.map((r) => r.growth_form),
      data: {
        source: SPECIES_DATA.source,
        generated_at: SPECIES_DATA.generated_at,
        sources: SPECIES_DATA.sources,
        real_photos: hasRealPhotos,
      },
    });
  }));

  api.get('/auth/me', (req, res) => res.json({ user: shapeUser(req.user) }));

  api.post('/auth/login', route(async (req, res) => {
    const { email, password } = req.body || {};
    // A locked IP or device is refused before the email is even looked up.
    const early = await lockedOut(req, null);
    if (early) return res.status(423).json(early);
    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1',
      [String(email || '').toLowerCase().trim()]);
    if (!user) {
      activity({ user_id: null, action: 'login_failed', detail: 'Unknown email: ' + email });
      // Guessing at addresses counts against the IP and device too.
      const { lock } = await recordFailedAttempt(req, null, 'email');
      if (lock) return res.status(423).json(lock);
      return res.status(401).json({ error: 'No account with that email address.' });
    }
    // A locked account is refused before the password is even checked, so
    // guessing on stops being worth anything until the lock runs out.
    if (isLocked(user)) {
      activity({ user_id: user.id, action: 'login_failed', detail: 'Account locked' });
      return res.status(423).json(accountLockBody(user.locked_until));
    }
    if (!await verifyPassword(password, user.password_hash)) {
      const { lock, left } = await recordFailedAttempt(req, user, 'password');
      if (lock) return res.status(423).json(lock);
      return res.status(401).json({ error: 'Incorrect password.', attempts_left: left });
    }
    if (!user.is_active) {
      activity({ user_id: user.id, action: 'login_failed', detail: 'Account deactivated' });
      return res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
    }
    // Two-step verification on: the password alone is not enough. The lockout
    // count is left alone until the code is right too.
    if (user.totp_enabled_at) {
      return res.json({ two_factor: true, ticket: issueTicket(user.id) });
    }
    await update('users', user.id, { last_login_at: nowIso(), failed_login_count: 0, locked_until: null });
    activity({ user_id: user.id, action: 'login', detail: 'Signed in' });
    res.json({ token: await issueToken(user.id), user: shapeUser(user) });
  }));

  /** Second step: the ticket from a right password, plus the authenticator's code. */
  api.post('/auth/login/2fa', route(async (req, res) => {
    const { ticket, code } = req.body || {};
    const held = tickets.get(String(ticket || ''));
    if (!held || held.expires < Date.now()) {
      tickets.delete(String(ticket || ''));
      return res.status(400).json({ error: 'Sign-in timed out. Enter your password again.' });
    }
    const user = await byId('users', held.userId);
    if (!user || !user.is_active || user.deleted_at || !user.totp_enabled_at) {
      tickets.delete(ticket);
      return res.status(400).json({ error: 'Sign-in timed out. Enter your password again.' });
    }
    const refused = await lockedOut(req, user);
    if (refused) {
      tickets.delete(ticket);
      return res.status(423).json(refused);
    }
    const secret = totp.openSecret(user.totp_secret);
    const step = secret ? totp.verifyCode(secret, code, user.totp_last_step) : null;
    if (step === null) {
      // Shares the lockout with passwords.
      const { lock, left } = await recordFailedAttempt(req, user, 'authenticator code');
      if (lock) {
        tickets.delete(ticket);
        return res.status(423).json(lock);
      }
      return res.status(400).json({ error: 'That code is not right.', attempts_left: left });
    }
    tickets.delete(ticket);
    const after = await update('users', user.id, {
      totp_last_step: step, last_login_at: nowIso(), failed_login_count: 0, locked_until: null,
    });
    activity({ user_id: user.id, action: 'login', detail: 'Signed in with password and authenticator code' });
    res.json({ token: await issueToken(user.id), user: shapeUser(after) });
  }));

  /* -------- setting up two-step verification -------- */

  /** Step 1: a new secret, held as pending, shown as a QR code for the app to scan. */
  api.post('/auth/2fa/setup', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!await verifyPassword(req.body?.current_password, req.user.password_hash)) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const secret = totp.newSecret();
    await update('users', req.user.id, { totp_pending: totp.sealSecret(secret), updated_at: nowIso() });
    const uri = totp.otpauthUri({ issuer: 'FloraScan', account: req.user.email, secret });
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    res.json({ qr, secret: totp.groupSecret(secret), uri });
  }));

  /** Step 2: a code from the app proves it holds the secret. Only now is it switched on. */
  api.post('/auth/2fa/enable', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const secret = req.user.totp_pending ? totp.openSecret(req.user.totp_pending) : null;
    if (!secret) return res.status(400).json({ error: 'Start the setup again - scan a new QR code.' });
    const step = totp.verifyCode(secret, req.body?.code);
    if (step === null) return res.status(400).json({ error: 'That code is not right. Check the app shows FloraScan and try the current code.' });
    const after = await update('users', req.user.id, {
      totp_secret: req.user.totp_pending, totp_pending: null, totp_enabled_at: nowIso(),
      totp_last_step: step, updated_at: nowIso(),
    });
    audit({ user_id: req.user.id, action: 'two_factor_enabled', entity_type: 'users', entity_id: req.user.id, new_values: { two_factor: 1 } });
    activity({ user_id: req.user.id, action: 'two_factor_enabled', detail: 'Turned on two-step verification' });
    res.json({ user: shapeUser(after) });
  }));

  /** Turning it off takes the password and a current code, so a borrowed session cannot. */
  api.post('/auth/2fa/disable', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!req.user.totp_enabled_at) return res.json({ user: shapeUser(req.user) });
    if (!await verifyPassword(req.body?.current_password, req.user.password_hash)) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const secret = totp.openSecret(req.user.totp_secret);
    const step = secret ? totp.verifyCode(secret, req.body?.code, req.user.totp_last_step) : null;
    if (step === null) return res.status(400).json({ error: 'That code is not right.' });
    const after = await update('users', req.user.id, {
      totp_secret: null, totp_pending: null, totp_enabled_at: null, totp_last_step: null, updated_at: nowIso(),
    });
    audit({ user_id: req.user.id, action: 'two_factor_disabled', entity_type: 'users', entity_id: req.user.id, old_values: { two_factor: 1 }, new_values: { two_factor: 0 } });
    activity({ user_id: req.user.id, action: 'two_factor_disabled', detail: 'Turned off two-step verification' });
    res.json({ user: shapeUser(after) });
  }));

  /**
   * A signed-in user chooses their own password. A wrong current password is
   * a 400, not a 401: the browser drops its token on a 401, and a typo here
   * should not sign anybody out.
   */
  api.post('/auth/password', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const { current_password: current, new_password: next } = req.body || {};
    if (!await verifyPassword(current, req.user.password_hash)) {
      activity({ user_id: req.user.id, action: 'password_change_failed', detail: 'Wrong current password' });
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const problem = newPasswordProblem(next, current);
    if (problem) return res.status(400).json({ error: problem });

    // Every new password comes with a fresh recovery code; the old one stops working.
    const code = newRecoveryCode();
    const after = await update('users', req.user.id, {
      password_hash: hashPassword(next), recovery_code_hash: hashRecoveryCode(code),
      must_change_password: 0, updated_at: nowIso(),
    });
    await revokeOthersFor(req.user.id, req.get('authorization').slice(7));
    audit({ user_id: req.user.id, action: 'password_changed', entity_type: 'users', entity_id: req.user.id, new_values: { must_change_password: 0 } });
    activity({ user_id: req.user.id, action: 'password_changed', detail: 'Changed their own password' });
    res.json({ user: shapeUser(after), recovery_code: code });
  }));

  /** A replacement recovery code, for a user who lost theirs but still knows the password. */
  api.post('/auth/recovery-code', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!await verifyPassword(req.body?.current_password, req.user.password_hash)) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const code = newRecoveryCode();
    const after = await update('users', req.user.id, { recovery_code_hash: hashRecoveryCode(code), updated_at: nowIso() });
    activity({ user_id: req.user.id, action: 'recovery_code_issued', detail: 'Made a new recovery code' });
    res.json({ user: shapeUser(after), recovery_code: code });
  }));

  /**
   * Forgotten password: email + recovery code + new password, no administrator.
   *
   * One message for an unknown email, a closed account and a wrong code, so
   * the form cannot be used to find out which addresses have accounts. A
   * wrong code counts towards the same lockout as a wrong password.
   */
  api.post('/auth/recover', route(async (req, res) => {
    const { email, recovery_code: code, new_password: next } = req.body || {};
    const NO_MATCH = 'That email address and recovery code do not match.';
    const early = await lockedOut(req, null);
    if (early) return res.status(423).json(early);
    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1',
      [String(email || '').toLowerCase().trim()]);
    if (!user || !user.is_active || user.deleted_at) {
      activity({ user_id: user?.id ?? null, action: 'recovery_failed', detail: 'No usable account for ' + email });
      const { lock } = await recordFailedAttempt(req, null, 'recovery code');
      if (lock) return res.status(423).json(lock);
      return res.status(400).json({ error: NO_MATCH });
    }
    if (isLocked(user)) return res.status(423).json(accountLockBody(user.locked_until));
    if (!recoveryCodeMatches(code, user.recovery_code_hash)) {
      const { lock } = await recordFailedAttempt(req, user, 'recovery code');
      if (lock) return res.status(423).json(lock);
      return res.status(400).json({ error: NO_MATCH });
    }
    // Checked after the code, so the rules are not a free hint to a stranger.
    const problem = newPasswordProblem(next, null);
    if (problem) return res.status(400).json({ error: problem });

    // The code is single use: it is replaced here, and the new one is shown once.
    const fresh = newRecoveryCode();
    const after = await update('users', user.id, {
      password_hash: hashPassword(next), recovery_code_hash: hashRecoveryCode(fresh),
      must_change_password: 0, failed_login_count: 0, locked_until: null,
      // Sorted it themselves, so a request still waiting with the admins is moot.
      reset_requested_at: null,
      last_login_at: nowIso(), updated_at: nowIso(),
    });
    // Whoever had the old password is signed out everywhere.
    await revokeAllFor(user.id);
    await q("UPDATE password_reset_requests SET status = 'closed' WHERE user_id = ? AND status IN ('pending', 'approved')", [user.id]);
    audit({ user_id: user.id, action: 'password_recovered', entity_type: 'users', entity_id: user.id, new_values: { must_change_password: 0 } });
    activity({ user_id: user.id, action: 'password_changed', detail: 'Reset their password with a recovery code' });
    res.json(await finishReset(after, fresh));
  }));

  /**
   * Forgot the password and never saved a recovery code: ask the
   * administrators. They are notified inside FloraScan, check it is really
   * the person, and reset the password from Staff accounts.
   *
   * The answer is the same whether or not the email has an account, so this
   * cannot be used to find out who works here.
   */
  api.post('/auth/reset-request', route(async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email address is required.' });

    // The secret stays in the asking browser; the code is read out to an admin.
    const token = crypto.randomBytes(24).toString('hex');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const reply = { token, code, expires_in_minutes: RESET_REQUEST_MINUTES };

    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (!user || !user.is_active || user.deleted_at) {
      // A code and token like any other, which simply never get approved.
      activity({ user_id: null, action: 'reset_requested', detail: 'Reset asked for an unknown or closed account: ' + email });
      return res.json(reply);
    }

    // A newer request replaces one still waiting, so only the latest screen can win.
    await q("UPDATE password_reset_requests SET status = 'closed' WHERE user_id = ? AND status IN ('pending', 'approved')", [user.id]);
    await insert('password_reset_requests', {
      user_id: user.id, token_hash: hashToken(token), check_code: code, status: 'pending',
      created_at: nowIso(), expires_at: new Date(Date.now() + RESET_REQUEST_MINUTES * 60000).toISOString(),
    });
    await update('users', user.id, { reset_requested_at: nowIso() });

    // Once per quarter hour, so the button cannot bury the administrators.
    // `user` was read before the update above, so this is the previous
    // request. Kept in the database rather than in memory: a remembered user
    // id outlived a reseed, and a new account given the same id was never
    // announced.
    const last = user.reset_requested_at ? new Date(user.reset_requested_at).getTime() : 0;
    if (Date.now() - last > 15 * 60000) {
      await notifyPermission('user.manage', {
        type: 'password.reset_request',
        title: `${user.full_name} forgot their password`,
        body: `${user.email} is waiting for approval to choose a new password. Ask them for the six-digit code on their screen - in person or by phone - and enter it on their account.`,
        related_type: 'user', related_id: user.id,
      });
    }
    activity({ user_id: user.id, action: 'reset_requested', detail: 'Asked an administrator to approve a password reset' });
    res.json(reply);
  }));

  /* -------- administrators' recovery email -------- */

  const emailDelivery = () => (process.env.SMTP_USER && process.env.SMTP_PASS ? 'email' : 'terminal');

  /** Step 1 of adding one: send a code to the new address. */
  api.post('/auth/recovery-email', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'A recovery email is for administrators.' });
    const { email, current_password: current } = req.body || {};
    if (!await verifyPassword(current, req.user.password_hash)) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const address = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(address) || address.length > 190) return res.status(400).json({ error: 'That does not look like an email address.' });
    if (address === String(req.user.email).toLowerCase()) {
      return res.status(400).json({ error: 'Use a different address from the one you sign in with.' });
    }
    if (emailThrottled(req.user.id, 'verify')) {
      return res.status(429).json({ error: 'A code was sent a moment ago. Wait a minute before asking again.' });
    }
    await issueEmailCode(req.user, 'verify', address);
    activity({ user_id: req.user.id, action: 'recovery_email_code', detail: 'Sent a code to confirm a recovery email' });
    res.json({ sent_to: maskEmail(address), delivery: emailDelivery() });
  }));

  /** Step 2: the code typed back proves the address is real and theirs. Only now is it saved. */
  api.post('/auth/recovery-email/confirm', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'A recovery email is for administrators.' });
    const { ok, row } = await checkEmailCode(req.user.id, 'verify', req.body?.code);
    if (!ok) {
      return res.status(400).json({ error: row ? 'That code is not right.' : 'No code is waiting, or it ran out. Send a new one.' });
    }
    const after = await update('users', req.user.id, { recovery_email: row.email, recovery_email_verified_at: nowIso(), updated_at: nowIso() });
    audit({ user_id: req.user.id, action: 'recovery_email_set', entity_type: 'users', entity_id: req.user.id, new_values: { recovery_email: maskEmail(row.email) } });
    activity({ user_id: req.user.id, action: 'recovery_email_set', detail: 'Confirmed a recovery email' });
    res.json({ user: shapeUser(after) });
  }));

  /**
   * Forgotten password, administrator: email a code to the recovery address.
   * The answer never says whether the account exists or has an address.
   */
  api.post('/auth/email-reset', route(async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email address is required.' });
    const reply = { ok: true, delivery: emailDelivery() };
    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (!user || !user.is_active || user.deleted_at || !isAdmin(user) || !user.recovery_email_verified_at) {
      activity({ user_id: user?.id ?? null, action: 'email_reset_requested', detail: 'No recovery email to send to for ' + email });
      return res.json(reply);
    }
    if (!emailThrottled(user.id, 'reset')) {
      await issueEmailCode(user, 'reset', user.recovery_email);
      activity({ user_id: user.id, action: 'email_reset_requested', detail: 'Sent a reset code to the recovery email' });
    }
    res.json(reply);
  }));

  api.post('/auth/email-reset/complete', route(async (req, res) => {
    const { email, code, new_password: next } = req.body || {};
    const NO_MATCH = 'That email address and code do not match.';
    const early = await lockedOut(req, null);
    if (early) return res.status(423).json(early);
    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [String(email || '').toLowerCase().trim()]);
    if (!user || !user.is_active || user.deleted_at || !isAdmin(user)) {
      const { lock } = await recordFailedAttempt(req, null, 'emailed code');
      if (lock) return res.status(423).json(lock);
      return res.status(400).json({ error: NO_MATCH });
    }
    if (isLocked(user)) return res.status(423).json(accountLockBody(user.locked_until));
    // Checked before the code is spent, so a weak password does not waste it.
    const problem = newPasswordProblem(next, null);
    if (problem) return res.status(400).json({ error: problem });
    const { ok } = await checkEmailCode(user.id, 'reset', code);
    if (!ok) {
      // Shares the lockout with passwords, so the code cannot be guessed faster.
      const { lock } = await recordFailedAttempt(req, user, 'emailed code');
      if (lock) return res.status(423).json(lock);
      return res.status(400).json({ error: NO_MATCH });
    }

    const fresh = newRecoveryCode();
    const after = await update('users', user.id, {
      password_hash: hashPassword(next), recovery_code_hash: hashRecoveryCode(fresh),
      must_change_password: 0, failed_login_count: 0, locked_until: null, reset_requested_at: null,
      last_login_at: nowIso(), updated_at: nowIso(),
    });
    await revokeAllFor(user.id);
    await q("UPDATE password_reset_requests SET status = 'closed' WHERE user_id = ? AND status IN ('pending', 'approved')", [user.id]);
    audit({ user_id: user.id, action: 'password_recovered', entity_type: 'users', entity_id: user.id, new_values: { via: 'recovery email' } });
    activity({ user_id: user.id, action: 'password_changed', detail: 'Reset their password with a code sent to the recovery email' });
    res.json(await finishReset(after, fresh));
  }));

  /** The waiting screen asks every few seconds whether it has been approved. */
  api.post('/auth/reset-request/status', route(async (req, res) => {
    const row = await one('SELECT * FROM password_reset_requests WHERE token_hash = ? LIMIT 1', [hashToken(String(req.body?.token || ''))]);
    // No row: an unknown email's pretend request, which just keeps waiting.
    if (!row) return res.json({ status: 'pending' });
    res.json({ status: requestExpired(row) ? 'expired' : row.status });
  }));

  /**
   * The waiting screen was left - refreshed, closed, or "cancel" pressed. The
   * request dies with it, approved or not, so nobody coming to that browser
   * afterwards can finish it. Sent with navigator.sendBeacon as the page goes.
   */
  api.post('/auth/reset-request/cancel', route(async (req, res) => {
    const row = await one('SELECT * FROM password_reset_requests WHERE token_hash = ? LIMIT 1', [hashToken(String(req.body?.token || ''))]);
    if (row && ['pending', 'approved'].includes(row.status)) {
      await update('password_reset_requests', row.id, { status: 'closed' });
      await update('users', row.user_id, { reset_requested_at: null });
      activity({ user_id: row.user_id, action: 'reset_cancelled', detail: `Left the reset screen; the ${row.status} request was closed` });
    }
    res.json({ ok: true });
  }));

  /** Approved: the waiting screen - and only it - chooses the new password. */
  api.post('/auth/reset-request/complete', route(async (req, res) => {
    const { token, new_password: next } = req.body || {};
    const row = await one('SELECT * FROM password_reset_requests WHERE token_hash = ? LIMIT 1', [hashToken(String(token || ''))]);
    if (!row || row.status !== 'approved' || requestExpired(row)) {
      return res.status(400).json({ error: 'This request has not been approved, or it has run out. Ask again.' });
    }
    const user = await byId('users', row.user_id);
    if (!user || !user.is_active || user.deleted_at) {
      return res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
    }
    const problem = newPasswordProblem(next, null);
    if (problem) return res.status(400).json({ error: problem });

    const fresh = newRecoveryCode();
    const after = await update('users', user.id, {
      password_hash: hashPassword(next), recovery_code_hash: hashRecoveryCode(fresh),
      must_change_password: 0, failed_login_count: 0, locked_until: null, reset_requested_at: null,
      last_login_at: nowIso(), updated_at: nowIso(),
    });
    await update('password_reset_requests', row.id, { status: 'used' });
    await revokeAllFor(user.id);
    audit({ user_id: user.id, action: 'password_recovered', entity_type: 'users', entity_id: user.id, new_values: { approved_by: row.decided_by } });
    activity({ user_id: user.id, action: 'password_changed', detail: 'Chose a new password after an administrator approved it' });
    res.json(await finishReset(after, fresh));
  }));

  /* -------- passkeys: Face ID, fingerprint, the phone's pattern / PIN -------- */

  /**
   * Where passkeys work. On an IP address they cannot, so the page is told
   * the named address to switch to instead.
   */
  const passkeyHome = (req) => {
    const name = localHostName();
    const port = req.app.get('protoPort');
    return name && req.app.get('protoScheme') === 'https' && !req.app.get('trust proxy')
      ? `https://${name}${port ? ':' + port : ''}` : null;
  };
  const PASSKEY_NO_ADDRESS = 'Face ID and fingerprint sign-in need the named address, not a number.';
  const PASSKEY_FAILED = 'Face ID or fingerprint sign-in could not be confirmed. Try again, or use your password.';
  const PASSKEY_EXPIRED = 'That took too long. Tap again to use Face ID or your fingerprint.';
  const PASSKEY_EXTERNAL = "Use this device's own Face ID or fingerprint. Another phone, a QR code or a security key is not accepted.";
  // A code the page acts on: only PASSKEY_UNKNOWN means "forget this device".
  const passkeyFailure = (err) => (
    err instanceof passkeys.ChallengeExpiredError ? { error: PASSKEY_EXPIRED, code: 'PASSKEY_EXPIRED' }
      : err instanceof passkeys.ExternalAuthenticatorError ? { error: PASSKEY_EXTERNAL, code: 'PASSKEY_EXTERNAL' }
        : { error: PASSKEY_FAILED, code: 'PASSKEY_FAILED' });

  api.get('/auth/passkeys', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const rows = await q(
      'SELECT id, device_label, rp_id, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id',
      [req.user.id],
    );
    const rp = passkeys.relyingParty(req);
    res.json({ results: rows, rp_id: rp?.rpID ?? null, named_url: rp ? null : passkeyHome(req) });
  }));

  api.post('/auth/passkeys/register/options', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const rp = passkeys.relyingParty(req);
    if (!rp) return res.status(400).json({ error: PASSKEY_NO_ADDRESS, named_url: passkeyHome(req) });
    const existing = await q('SELECT credential_id, transports FROM passkeys WHERE user_id = ? AND rp_id = ?', [req.user.id, rp.rpID]);
    res.json({ options: await passkeys.registrationOptions(req.user, existing, rp) });
  }));

  api.post('/auth/passkeys/register/verify', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    let row;
    try {
      row = await passkeys.verifyRegistration(req.user, req.body?.response);
    } catch (err) {
      return res.status(400).json(passkeyFailure(err));
    }
    const label = passkeys.deviceLabel(req.get('user-agent'), row.transports);
    const saved = await insert('passkeys', { ...row, user_id: req.user.id, device_label: label, created_at: nowIso() });
    audit({ user_id: req.user.id, action: 'passkey_added', entity_type: 'users', entity_id: req.user.id, new_values: { device: label, rp_id: row.rp_id } });
    activity({ user_id: req.user.id, action: 'passkey_added', detail: `Turned on Face ID / fingerprint sign-in (${label})` });
    res.status(201).json({ passkey: { id: saved.id, device_label: label, rp_id: row.rp_id, created_at: saved.created_at, last_used_at: null } });
  }));

  api.delete('/auth/passkeys/:id', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    // Scoped to the signed-in user, so nobody can remove someone else's.
    const row = await one('SELECT * FROM passkeys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await q('DELETE FROM passkeys WHERE id = ?', [row.id]);
    audit({ user_id: req.user.id, action: 'passkey_removed', entity_type: 'users', entity_id: req.user.id, old_values: { device: row.device_label, rp_id: row.rp_id } });
    activity({ user_id: req.user.id, action: 'passkey_removed', detail: `Turned off Face ID / fingerprint sign-in (${row.device_label})` });
    res.json({ ok: true });
  }));

  api.post('/auth/passkeys/login/options', route(async (req, res) => {
    const rp = passkeys.relyingParty(req);
    if (!rp) return res.status(400).json({ error: PASSKEY_NO_ADDRESS, named_url: passkeyHome(req) });
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your email address first.', code: 'EMAIL_REQUIRED' });
    // A closed account is treated like no account: same answer, nothing to unlock.
    const owner = await one('SELECT id FROM users WHERE LOWER(email) = ? AND is_active = 1 AND deleted_at IS NULL LIMIT 1', [email]);
    const rows = owner
      ? await q('SELECT credential_id, transports FROM passkeys WHERE user_id = ? AND rp_id = ?', [owner.id, rp.rpID])
      : [];
    res.json(await passkeys.authenticationOptions(rp, { email, owner: owner?.id ?? null, rows }));
  }));

  api.post('/auth/passkeys/login/verify', route(async (req, res) => {
    const { flow, response } = req.body || {};
    const row = response?.id
      ? await one('SELECT * FROM passkeys WHERE credential_id = ? LIMIT 1', [String(response.id)])
      : null;
    if (!row) {
      activity({ user_id: null, action: 'login_failed', detail: 'Unknown passkey' });
      return res.status(400).json({
        error: 'Face ID / fingerprint sign-in is no longer set up for this device. Sign in with your password.',
        code: 'PASSKEY_UNKNOWN',
      });
    }
    const user = await byId('users', row.user_id);
    if (!user || !user.is_active || user.deleted_at) {
      return res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
    }
    // The lock is about the account, not the method: a stolen phone does not get around it.
    if (isLocked(user)) {
      return res.status(423).json({ error: LOCKED_MESSAGE, locked_until: user.locked_until, minutes: minutesLeft(user) });
    }
    let counter;
    try {
      counter = await passkeys.verifyAuthentication(flow, response, row);
    } catch (err) {
      const failure = passkeyFailure(err);
      if (failure.code !== 'PASSKEY_EXPIRED') {
        activity({ user_id: user.id, action: 'login_failed', detail: `Passkey not confirmed (${failure.code})` });
      }
      return res.status(400).json(failure);
    }
    await q('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', [counter, nowIso(), row.id]);
    const after = await update('users', user.id, { last_login_at: nowIso(), failed_login_count: 0, locked_until: null });
    activity({ user_id: user.id, action: 'login', detail: `Signed in with Face ID / fingerprint (${row.device_label})` });
    res.json({ token: await issueToken(user.id), user: shapeUser(after) });
  }));

  api.post('/auth/logout', route(async (req, res) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      if (req.user) activity({ user_id: req.user.id, action: 'logout', detail: 'Signed out' });
      await revokeToken(token);
    }
    res.json({ ok: true });
  }));

  /* ================================================================ */
  /* Public register                                                  */
  /* ================================================================ */

  api.get('/public/plants', route(async (req, res) => {
    const {
      q: search = '', family = '', genus = '', conservation = '', site = '', growth_form = '',
      sort = 'recent', limit = '24', offset = '0',
    } = req.query;

    // Mirrors v_public_plants: approved, not deleted, species resolved.
    const where = ["p.status = 'approved'", 'p.deleted_at IS NULL', 'p.species_id IS NOT NULL'];
    const params = [];
    if (family) { where.push('s.family = ?'); params.push(family); }
    if (genus) { where.push('s.genus = ?'); params.push(genus); }
    if (growth_form) { where.push('s.growth_form = ?'); params.push(growth_form); }
    if (conservation) { where.push('cs.code = ?'); params.push(conservation); }
    if (site) { where.push('p.site_name = ?'); params.push(site); }

    let rows = await plantsWhere(where.join(' AND '), params);
    rows = rows.filter((p) => matchesQuery(p, search, { viewer: req.user }));

    // Filtering by site must not confirm that a protected plant is on a given
    // trail - that is the withheld location arriving by another route.
    if (site && !req.user) rows = rows.filter((p) => !isLocationProtected(p.conservation_code));

    const sorters = {
      recent: (a, b) => new Date(b.registered_at) - new Date(a.registered_at),
      name: (a, b) => (a.scientific_name || '').localeCompare(b.scientific_name || ''),
      code: (a, b) => a.plant_code.localeCompare(b.plant_code),
      popular: (a, b) => b.view_count - a.view_count,
      // By trail and marker, so a list can be grouped by where plants stand.
      // Withheld locations go last and in name order: sorting them by their
      // real site would let the order give the location away.
      place: (a, b) => {
        const pa = !req.user && isLocationProtected(a.conservation_code);
        const pb = !req.user && isLocationProtected(b.conservation_code);
        if (pa !== pb) return pa ? 1 : -1;
        if (pa) return (a.scientific_name || '').localeCompare(b.scientific_name || '');
        return (a.site_name || '').localeCompare(b.site_name || '', 'en', { numeric: true })
          || (a.scientific_name || '').localeCompare(b.scientific_name || '');
      },
    };
    rows.sort(sorters[sort] || sorters.recent);

    // Paged: the register is big enough now that returning every record would
    // mean a phone downloading a hundred-odd photographs to show the first screen.
    const take = Math.min(100, Math.max(1, Number(limit) || 24));
    const skip = Math.max(0, Number(offset) || 0);
    const page = rows.slice(skip, skip + take);

    res.json({
      total: rows.length,
      offset: skip,
      limit: take,
      has_more: skip + page.length < rows.length,
      results: await shapeMany(page, { viewer: req.user }),
    });
  }));

  /** The QR target. Opaque token in, public record out. */
  api.get('/public/plants/token/:token', route(async (req, res) => {
    const qr = await one('SELECT * FROM qr_codes WHERE qr_token = ? LIMIT 1', [req.params.token]);
    if (!qr) return res.status(404).json({ error: 'Unknown tag', reason: 'not_found' });

    const rows = await plantsWhere('p.id = ?', [qr.plant_id]);
    const plant = rows[0];
    if (!plant || plant.deleted_at) return res.status(404).json({ error: 'Unknown tag', reason: 'not_found' });

    if (plant.status !== 'approved') {
      return res.status(404).json({
        error: 'This plant is no longer on display.',
        reason: plant.status === 'archived' ? 'archived' : 'not_published',
        plant_code: plant.plant_code,
      });
    }

    await q('UPDATE plants SET view_count = view_count + 1 WHERE id = ?', [plant.id]);
    plant.view_count += 1;
    await insert('qr_scans', {
      qr_code_id: qr.id, plant_id: plant.id,
      user_id: req.user?.id ?? null,
      device_type: /android/i.test(req.get('user-agent') || '') ? 'android'
        : /iphone|ipad/i.test(req.get('user-agent') || '') ? 'ios' : 'web',
      ip_hash: crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex'),
      scanned_at: nowIso(),
    });
    res.json({ plant: await shapeOne(plant, { full: true, viewer: req.user }) });
  }));

  api.get('/public/plants/:id', route(async (req, res) => {
    const rows = await plantsWhere('p.id = ?', [req.params.id]);
    const plant = rows[0];
    if (!plant || plant.deleted_at) return res.status(404).json({ error: 'Not found' });
    const visible = plant.status === 'approved' || req.can('plant.view_all')
      || (req.user && plant.registered_by === req.user.id);
    if (!visible) return res.status(404).json({ error: 'Not found' });
    if (plant.status === 'approved') {
      await q('UPDATE plants SET view_count = view_count + 1 WHERE id = ?', [plant.id]);
      plant.view_count += 1;
    }
    res.json({ plant: await shapeOne(plant, { full: true, viewer: req.user }) });
  }));

  api.get('/public/stats', route(async (req, res) => {
    const base = `FROM plants p JOIN species s ON s.id = p.species_id
                  LEFT JOIN conservation_statuses cs ON cs.id = s.conservation_status_id
                  WHERE p.status = 'approved' AND p.deleted_at IS NULL`;
    const [published, species, families, threatened, scans, sites] = await Promise.all([
      count(`SELECT COUNT(*) ${base}`),
      count(`SELECT COUNT(DISTINCT p.species_id) ${base}`),
      count(`SELECT COUNT(DISTINCT s.family) ${base}`),
      count(`SELECT COUNT(*) ${base} AND cs.code IN ('VU','EN','CR','EW','EX')`),
      count('SELECT COUNT(*) FROM qr_scans'),
      count(`SELECT COUNT(DISTINCT p.site_name) ${base}`),
    ]);
    res.json({ published_plants: published, species, families, threatened, scans, sites });
  }));

  /* ================================================================ */
  /* Species                                                          */
  /* ================================================================ */

  api.get('/species', route(async (req, res) => {
    const search = String(req.query.q || '').toLowerCase().trim();
    let rows = await q('SELECT * FROM species WHERE deleted_at IS NULL ORDER BY scientific_name');
    if (search) {
      rows = rows.filter((s) => [s.scientific_name, s.common_name, s.local_name, s.family, s.genus]
        .filter(Boolean).join(' ').toLowerCase().includes(search));
    }
    // Plant counts for the whole list in one query rather than one each.
    const counts = new Map((await q(
      `SELECT species_id, COUNT(*) n FROM plants
        WHERE deleted_at IS NULL AND species_id IS NOT NULL
          ${req.can('plant.view_all') ? '' : "AND status = 'approved'"} GROUP BY species_id`,
    )).map((r) => [r.species_id, Number(r.n)]));
    const statuses = new Map((await q('SELECT * FROM conservation_statuses')).map((c) => [c.id, c]));

    res.json({
      results: rows.map((s) => {
        const cs = statuses.get(s.conservation_status_id) || null;
        return {
          ...s,
          conservation_code: cs?.code ?? 'NE',
          conservation_label: cs?.label ?? 'Not evaluated',
          conservation_source: s.conservation_source ?? null,
          plant_count: counts.get(s.id) || 0,
        };
      }),
    });
  }));

  api.get('/species/:id', route(async (req, res) => {
    const s = await byId('species', req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const where = req.can('plant.view_all')
      ? 'p.species_id = ? AND p.deleted_at IS NULL'
      : "p.species_id = ? AND p.deleted_at IS NULL AND p.status = 'approved'";
    const rows = await plantsWhere(where, [s.id]);
    res.json({
      species: { ...await shapeSpecies(s), plant_count: rows.length },
      plants: await shapeMany(rows, { viewer: req.user }),
    });
  }));

  api.post('/species', need('species.manage'), route(async (req, res) => {
    const body = req.body || {};
    if (!body.scientific_name?.trim()) return res.status(400).json({ error: 'Scientific name is required.' });
    const dupe = await one('SELECT id FROM species WHERE LOWER(scientific_name) = ? LIMIT 1',
      [body.scientific_name.trim().toLowerCase()]);
    if (dupe) return res.status(409).json({ error: 'That scientific name is already in the species list.' });

    const fallbackStatus = await one('SELECT id FROM conservation_statuses ORDER BY sort_order LIMIT 1');
    const row = await insert('species', {
      scientific_name: body.scientific_name.trim(),
      common_name: body.common_name || null,
      local_name: body.local_name || null,
      family: body.family || null,
      genus: body.genus || body.scientific_name.trim().split(' ')[0],
      species_epithet: body.species_epithet || body.scientific_name.trim().split(' ')[1] || null,
      description: body.description || null,
      characteristics: body.characteristics || null,
      growth_form: body.growth_form || null,
      leaf_description: body.leaf_description || null,
      flower_description: body.flower_description || null,
      fruit_description: body.fruit_description || null,
      habitat: body.habitat || null,
      distribution: body.distribution || null,
      conservation_status_id: body.conservation_status_id || fallbackStatus?.id || null,
      created_by: req.user.id,
      updated_at: nowIso(), deleted_at: null,
    });
    audit({ user_id: req.user.id, action: 'create', entity_type: 'species', entity_id: row.id, new_values: { scientific_name: row.scientific_name } });
    res.status(201).json({ species: await shapeSpecies(row) });
  }));

  api.patch('/species/:id', need('species.manage'), route(async (req, res) => {
    const before = await byId('species', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const allowed = ['scientific_name', 'common_name', 'local_name', 'family', 'genus', 'species_epithet',
      'description', 'characteristics', 'growth_form', 'leaf_description', 'flower_description',
      'fruit_description', 'habitat', 'distribution', 'conservation_status_id'];
    const patch = {};
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });
    patch.updated_at = nowIso();
    const after = await update('species', before.id, patch);
    audit({ user_id: req.user.id, action: 'update', entity_type: 'species', entity_id: before.id, old_values: before, new_values: after });
    res.json({ species: await shapeSpecies(after) });
  }));

  /* ================================================================ */
  /* Plants - staff register                                          */
  /* ================================================================ */

  api.get('/plants', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    // The staff register is for the people who handle plant records. A ranger
    // has neither code and reads the public register like anyone else.
    if (!req.can('plant.view_all') && !req.can('plant.create')) {
      return res.status(403).json({ error: 'Your role does not have permission: plant.view_all' });
    }
    const { q: search = '', status = '', family = '', conservation = '', site = '', mine = '' } = req.query;

    const where = ['p.deleted_at IS NULL'];
    const params = [];
    // Someone who can register but not see everything sees only their own.
    if (!req.can('plant.view_all') || mine === '1') {
      where.push('p.registered_by = ?');
      params.push(req.user.id);
    }
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (family) { where.push('s.family = ?'); params.push(family); }
    if (conservation) { where.push('cs.code = ?'); params.push(conservation); }
    if (site) { where.push('p.site_name = ?'); params.push(site); }

    let rows = await plantsWhere(where.join(' AND '), params);
    rows = rows.filter((p) => matchesQuery(p, search, { viewer: req.user }));
    rows.sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));

    res.json({ total: rows.length, results: await shapeMany(rows, { viewer: req.user }) });
  }));

  api.get('/plants/counts', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const scoped = req.can('plant.view_all') ? '' : ' AND registered_by = ' + Number(req.user.id);
    const byStatus = await q(
      `SELECT status, COUNT(*) n FROM plants WHERE deleted_at IS NULL${scoped} GROUP BY status`,
    );
    const map = new Map(byStatus.map((r) => [r.status, Number(r.n)]));
    const all = [...map.values()].reduce((a, b) => a + b, 0);

    const [mine, queue, unread, openReports] = await Promise.all([
      count('SELECT COUNT(*) FROM plants WHERE deleted_at IS NULL AND registered_by = ?', [req.user.id]),
      req.can('plant.approve')
        ? count("SELECT COUNT(*) FROM plant_submissions WHERE status = 'pending'") : 0,
      count('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]),
      req.can('report.view') ? count("SELECT COUNT(*) FROM plant_reports WHERE status = 'open'") : 0,
    ]);

    res.json({
      all,
      pending: map.get('pending') || 0,
      approved: map.get('approved') || 0,
      rejected: map.get('rejected') || 0,
      archived: map.get('archived') || 0,
      mine, queue, unread_notifications: unread, open_reports: openReports,
    });
  }));

  api.post('/plants', need('plant.create'), route(async (req, res) => {
    const b = req.body || {};
    if (b.species_id && !await byId('species', b.species_id)) {
      return res.status(400).json({ error: 'No such species.' });
    }
    if (!b.species_id && !b.proposed_species_name?.trim()) {
      return res.status(400).json({ error: 'Choose a species, or type a name under "species not listed".' });
    }
    if (!b.site_name?.trim()) return res.status(400).json({ error: 'A location or site name is required.' });

    const invalid = validatePlant(b);
    if (invalid) return res.status(400).json({ error: invalid });

    // Decode and check the photographs before writing anything, so an
    // oversized one is refused with a reason rather than failing halfway
    // through creating the record.
    const incoming = Array.isArray(b.photos) ? b.photos.slice(0, 6) : [];
    const decoded = [];
    for (const [i, p] of incoming.entries()) {
      const result = decodeUpload(p, i);
      if (result.error) return res.status(400).json({ error: result.error });
      decoded.push({ source: p, ...result });
    }

    const requireApproval = getSetting('require_approval');
    const canPublish = req.can('plant.approve');
    // Entries follow the setting, but a "species not listed" entry always
    // needs review. A role that holds plant.approve as well as plant.create
    // would publish its own - none does, by design: a second person checks
    // every record a botanist registers.
    let status = 'pending';
    if (canPublish && b.species_id) status = 'approved';
    else if (!requireApproval && b.species_id) status = 'approved';

    const prefix = getSetting('plant_code_prefix') || 'PLT';
    // Continue the sequence from the highest code already issued, rather than
    // from the row count - deleting a record would otherwise reissue a code.
    const highest = await count(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(plant_code, '-', -1) AS UNSIGNED)), 0) FROM plants",
    );

    const created = await tx(async (t) => {
      const plant = await t.insert('plants', {
        plant_code: `${prefix}-2026-${String(highest + 1).padStart(4, '0')}`,
        species_id: b.species_id ? Number(b.species_id) : null,
        proposed_species_name: b.species_id ? null : (b.proposed_species_name?.trim() || null),
        status,
        latitude: b.latitude ?? null, longitude: b.longitude ?? null,
        altitude_m: b.altitude_m ?? null, gps_accuracy_m: b.gps_accuracy_m ?? null,
        site_name: b.site_name.trim(), location_notes: b.location_notes || null,
        height_m: b.height_m ?? null, trunk_diameter_cm: b.trunk_diameter_cm ?? null,
        health_status: b.health_status || null, life_stage: b.life_stage || null,
        morphology_notes: b.morphology_notes || null, notes: b.notes || null,
        view_count: 0,
        registered_by: req.user.id, registered_at: nowIso(),
        verified_by: status === 'approved' ? req.user.id : null,
        verified_at: status === 'approved' ? nowIso() : null,
        updated_at: nowIso(), deleted_at: null,
      });

      // Photographs. The row goes in first so the bytes have an id to hang
      // off, then file_path is set to the address they are served from -
      // a path, which is what plant_photos.file_path is for.
      for (const [i, p] of decoded.entries()) {
        const row = await t.insert('plant_photos', {
          plant_id: plant.id,
          file_path: p.skip ? (p.source.file_path || null) : null,
          thumbnail_path: p.skip ? (p.source.file_path || null) : null,
          file_name: p.source.file_name || 'capture-' + (i + 1) + '.jpg',
          mime_type: p.skip ? (p.source.mime_type || 'image/jpeg') : p.mime,
          size_bytes: p.skip ? (p.source.size_bytes || 0) : p.bytes.length,
          width_px: null, height_px: null,
          caption: p.source.caption || null,
          is_primary: i === 0 ? 1 : 0,
          uploaded_by: req.user.id, deleted_at: null,
        });
        if (p.skip) continue;
        await t.q('INSERT INTO plant_photo_data (photo_id, bytes, byte_length) VALUES (?, ?, ?)',
          [row.id, p.bytes, p.bytes.length]);
        const servedAt = `/api/photos/upload/${row.id}`;
        await t.q('UPDATE plant_photos SET file_path = ?, thumbnail_path = ? WHERE id = ?',
          [servedAt, servedAt, row.id]);
      }

      let submission = null;
      if (status === 'approved') {
        await t.insert('qr_codes', {
          plant_id: plant.id, qr_token: crypto.randomUUID(),
          image_path: null, target_url: null, version: 1, status: 'active',
          generated_by: req.user.id, generated_at: nowIso(),
          deactivated_at: null, deactivation_reason: null,
        });
      } else {
        submission = await t.insert('plant_submissions', {
          plant_id: plant.id, submission_type: 'new', status: 'pending',
          proposed_changes: null, submitted_by: req.user.id, submitted_at: nowIso(),
          reviewed_by: null, reviewed_at: null, review_comment: null,
        });
      }
      return { plant, submission };
    });

    if (created.submission) {
      await notifyPermission('plant.approve', {
        type: 'submission.new',
        title: 'New submission awaiting review',
        body: req.user.full_name + ' submitted ' + created.plant.plant_code + ' from ' + created.plant.site_name + '.',
        related_type: 'submission', related_id: created.submission.id,
      });
    }

    audit({
      user_id: req.user.id, action: 'create', entity_type: 'plants', entity_id: created.plant.id,
      new_values: { plant_code: created.plant.plant_code, status },
    });
    const joined = (await plantsWhere('p.id = ?', [created.plant.id]))[0];
    res.status(201).json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  api.patch('/plants/:id', need('plant.edit'), route(async (req, res) => {
    const before = await byId('plants', req.params.id);
    if (!before || before.deleted_at) return res.status(404).json({ error: 'Not found' });
    const allowed = ['species_id', 'proposed_species_name', 'site_name', 'location_notes',
      'latitude', 'longitude', 'altitude_m', 'height_m', 'trunk_diameter_cm',
      'health_status', 'life_stage', 'morphology_notes', 'notes'];
    const patch = {};
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });

    // PATCH describes only changes; paired fields and required values must
    // be checked against the complete record that would actually be saved.
    const candidate = { ...before, ...patch };
    const invalid = validatePlant(candidate);
    if (invalid) return res.status(400).json({ error: invalid });
    if (typeof candidate.site_name !== 'string' || !candidate.site_name.trim()) {
      return res.status(400).json({ error: 'A location or site name is required.' });
    }
    if (!candidate.species_id && (typeof candidate.proposed_species_name !== 'string' || !candidate.proposed_species_name.trim())) {
      return res.status(400).json({ error: 'Choose a species, or type a name under "species not listed".' });
    }
    if (before.status === 'approved' && !candidate.species_id) {
      return res.status(400).json({ error: 'A published record must have a confirmed species.' });
    }
    if ('site_name' in patch) patch.site_name = patch.site_name.trim();

    const speciesId = 'species_id' in patch ? patch.species_id : before.species_id;
    if (speciesId && !await byId('species', speciesId)) {
      return res.status(400).json({ error: 'No such species.' });
    }
    if (speciesId) patch.proposed_species_name = null;
    patch.updated_at = nowIso();

    const after = await update('plants', before.id, patch);
    await recordRevisions(before.id, req.user.id, before, after, req.body?.change_reason || null);
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'plants', entity_id: before.id,
      old_values: before, new_values: after,
    });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  /* -------- review workflow -------- */

  /**
   * Issue a tag, or bring back the one this plant already had.
   *
   * uq_qr_one_active in the schema allows at most one active code per plant,
   * so this must reactivate rather than insert a second. A printed tag stays
   * valid across archive and restore because its token never changes.
   */
  async function issueQr(plantId, userId, db = { q, one, insert }) {
    const active = await db.one("SELECT * FROM qr_codes WHERE plant_id = ? AND status = 'active' LIMIT 1", [plantId]);
    if (active) return active;

    const old = await db.one("SELECT * FROM qr_codes WHERE plant_id = ? AND status = 'inactive' LIMIT 1", [plantId]);
    if (old) {
      await db.q(
        "UPDATE qr_codes SET status = 'active', deactivated_at = NULL, deactivation_reason = NULL WHERE id = ?",
        [old.id],
      );
      return { ...old, status: 'active', deactivated_at: null, deactivation_reason: null };
    }
    return await db.insert('qr_codes', {
      plant_id: plantId, qr_token: crypto.randomUUID(),
      image_path: null, target_url: null, version: 1, status: 'active',
      generated_by: userId ?? null, generated_at: nowIso(),
      deactivated_at: null, deactivation_reason: null,
    });
  }

  const pendingSubmission = (plantId) =>
    one("SELECT * FROM plant_submissions WHERE plant_id = ? AND status = 'pending' LIMIT 1", [plantId]);

  /**
   * Approving and returning both act on a submission that is still waiting.
   *
   * Without this, Approve on a record that was already published, returned or
   * archived re-publishes it - an archived plant comes back to the public site
   * with its tag reactivated, and nobody asked for that. A reviewer may not
   * decide on their own submission either; the whole point of the second pair
   * of eyes is that it is a different person.
   *
   * Sends the refusal and returns null, or returns the plant and submission.
   */
  async function reviewable(req, res) {
    const plant = await byId('plants', req.params.id);
    if (!plant || plant.deleted_at) { res.status(404).json({ error: 'Not found' }); return null; }
    const sub = await pendingSubmission(plant.id);
    if (plant.status !== 'pending' || !sub) {
      res.status(409).json({ error: 'This record is not awaiting review (it is ' + plant.status + ').' });
      return null;
    }
    if (sub.submitted_by === req.user.id || plant.registered_by === req.user.id) {
      res.status(403).json({ error: 'You cannot review a record you submitted yourself. Another reviewer must check it.' });
      return null;
    }
    return { before: plant, sub };
  }

  api.post('/plants/:id/approve', need('plant.approve'), route(async (req, res) => {
    const found = await reviewable(req, res);
    if (!found) return;
    const { before, sub } = found;
    if (!before.species_id) {
      return res.status(400).json({
        error: 'This record has no confirmed species. Set the species first, then approve it.',
      });
    }
    const after = await update('plants', before.id, {
      status: 'approved',
      verified_by: req.user.id,
      verified_at: nowIso(),
      updated_at: nowIso(),
    });

    const qr = await issueQr(before.id, req.user.id);
    await update('plant_submissions', sub.id, {
      status: 'approved', reviewed_by: req.user.id,
      reviewed_at: nowIso(), review_comment: req.body?.note || null,
    });
    await notify({
      user_id: sub.submitted_by, type: 'submission.approved',
      title: 'Submission published: ' + after.plant_code,
      body: req.user.full_name + ' approved your record. It is now on the public site and its tag can be printed.',
      related_type: 'plant', related_id: after.id,
    });
    await recordRevisions(before.id, req.user.id, before, after, 'Approved at review');
    audit({
      user_id: req.user.id, action: 'approve', entity_type: 'plants', entity_id: before.id,
      old_values: { status: before.status }, new_values: { status: 'approved', qr_token: qr.qr_token },
    });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  api.post('/plants/:id/reject', need('plant.approve'), route(async (req, res) => {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'A note is required when returning a record, so the botanist knows what to change.' });
    if (note.length > 2000) return res.status(400).json({ error: `The note is too long (${note.length} characters, maximum 2000).` });
    const found = await reviewable(req, res);
    if (!found) return;
    const { before, sub } = found;

    const after = await update('plants', before.id, { status: 'rejected', updated_at: nowIso() });
    await update('plant_submissions', sub.id, {
      status: 'rejected', reviewed_by: req.user.id,
      reviewed_at: nowIso(), review_comment: note,
    });
    await notify({
      user_id: sub.submitted_by, type: 'submission.rejected',
      title: 'Submission returned: ' + after.plant_code,
      body: req.user.full_name + ' asked for changes. ' + note.slice(0, 120),
      related_type: 'plant', related_id: after.id,
    });
    await recordRevisions(before.id, req.user.id, before, after, note);
    audit({
      user_id: req.user.id, action: 'reject', entity_type: 'plants', entity_id: before.id,
      old_values: { status: before.status }, new_values: { status: 'rejected', note },
    });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  /**
   * Send a returned record back for review, once the botanist has made the
   * changes the reviewer asked for. A fresh submission row is opened rather
   * than the old one reopened, so the history keeps both decisions.
   */
  api.post('/plants/:id/resubmit', need('plant.create'), route(async (req, res) => {
    const before = await byId('plants', req.params.id);
    if (!before || before.deleted_at) return res.status(404).json({ error: 'Not found' });
    if (before.registered_by !== req.user.id && !req.can('plant.edit')) {
      return res.status(403).json({ error: 'Only the person who registered this record can resubmit it.' });
    }
    if (before.status !== 'rejected') {
      return res.status(409).json({ error: 'Only a returned record can be resubmitted (this one is ' + before.status + ').' });
    }
    const note = String(req.body?.note || '').trim().slice(0, 2000) || null;

    const after = await update('plants', before.id, { status: 'pending', updated_at: nowIso() });
    const sub = await insert('plant_submissions', {
      // 'new', not 'edit': the schema keeps 'edit' for proposed corrections to
      // a published record. This is the same new record, asked about again.
      plant_id: before.id, submission_type: 'new', status: 'pending',
      proposed_changes: note ? { resubmission_note: note } : null,
      submitted_by: req.user.id, submitted_at: nowIso(),
      reviewed_by: null, reviewed_at: null, review_comment: null,
    });
    await notifyPermission('plant.approve', {
      type: 'submission.new',
      title: 'Resubmitted for review',
      body: req.user.full_name + ' resubmitted ' + after.plant_code + ' after changes.' + (note ? ' ' + note.slice(0, 120) : ''),
      related_type: 'submission', related_id: sub.id,
    });
    await recordRevisions(before.id, req.user.id, before, after, note || 'Resubmitted for review');
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'plants', entity_id: before.id,
      old_values: { status: 'rejected' }, new_values: { status: 'pending', resubmitted: true },
    });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  api.post('/plants/:id/archive', need('plant.archive'), route(async (req, res) => {
    const before = await byId('plants', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const after = await update('plants', before.id, { status: 'archived', updated_at: nowIso() });

    const qr = await one("SELECT * FROM qr_codes WHERE plant_id = ? AND status = 'active' LIMIT 1", [before.id]);
    if (qr) {
      await update('qr_codes', qr.id, {
        status: 'inactive',
        deactivated_at: nowIso(),
        deactivation_reason: req.body?.reason || 'Record archived',
      });
    }

    // Archiving something that was still awaiting review has to close the
    // submission too. Left pending it stays in the review queue, where
    // approving it would publish a record somebody had already withdrawn.
    const pending = await pendingSubmission(before.id);
    if (pending) {
      const reason = req.body?.reason || 'The record was archived before review.';
      await update('plant_submissions', pending.id, {
        status: 'rejected', reviewed_by: req.user.id,
        reviewed_at: nowIso(), review_comment: reason,
      });
      await notify({
        user_id: pending.submitted_by, type: 'submission.rejected',
        title: 'Submission withdrawn: ' + after.plant_code,
        body: req.user.full_name + ' archived this record before it was reviewed. ' + reason.slice(0, 120),
        related_type: 'plant', related_id: after.id,
      });
    }

    await recordRevisions(before.id, req.user.id, before, after, req.body?.reason || null);
    audit({ user_id: req.user.id, action: 'archive', entity_type: 'plants', entity_id: before.id, old_values: { status: before.status }, new_values: { status: 'archived' } });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  /**
   * Bring an archived plant back. Shared by the Restore button and the audit
   * trail. Returns { status } on success, or { error, status: http code }.
   */
  async function restoreArchivedPlant(plantId, user, reason = null) {
    const result = await tx(async (db) => {
      const before = await db.one('SELECT * FROM plants WHERE id = ? FOR UPDATE', [plantId]);
      if (!before || before.deleted_at) return { code: 404, error: 'Not found' };
      if (before.status !== 'archived') return { code: 409, error: 'Only an archived record can be restored.' };

      // A previously unverified archive still needs review. For a published
      // record, commit restoration together with reactivation of its printed tag.
      const status = before.verified_at && before.species_id ? 'approved' : 'rejected';
      const updated_at = nowIso();
      await db.q('UPDATE plants SET status = ?, updated_at = ? WHERE id = ?', [status, updated_at, before.id]);
      if (status === 'approved') await issueQr(before.id, user.id, db);
      return { before, after: { ...before, status, updated_at }, status };
    });
    if (result.error) return { error: result.error, status: result.code };
    const { before, after, status } = result;
    await recordRevisions(before.id, user.id, before, after,
      reason || (status === 'approved' ? 'Restored to public view' : 'Restored for corrections before review'));
    return { status };
  }

  api.post('/plants/:id/restore', need('plant.archive'), route(async (req, res) => {
    const r = await restoreArchivedPlant(req.params.id, req.user);
    if (r.error) return res.status(r.status).json({ error: r.error });
    audit({ user_id: req.user.id, action: 'update', entity_type: 'plants', entity_id: Number(req.params.id), old_values: { status: 'archived' }, new_values: { status: r.status } });
    const joined = (await plantsWhere('p.id = ?', [req.params.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  api.get('/plants/:id/history', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const plant = await byId('plants', req.params.id);
    if (!plant) return res.status(404).json({ error: 'Not found' });
    const own = plant.registered_by === req.user.id;
    if (!req.can('plant.history') && !own) return res.status(403).json({ error: 'Not permitted' });

    const [revisions, audits] = await Promise.all([
      q(`SELECT r.*, COALESCE(u.full_name, 'System') AS changed_by_name
           FROM plant_revisions r LEFT JOIN users u ON u.id = r.changed_by
          WHERE r.plant_id = ? ORDER BY r.created_at DESC`, [plant.id]),
      q(`SELECT a.*, COALESCE(u.full_name, 'System') AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.entity_type = 'plants' AND a.entity_id = ? ORDER BY a.created_at DESC`, [plant.id]),
    ]);
    res.json({ revisions, audits: audits.map(auditRow) });
  }));

  /* -------- submissions -------- */

  api.get('/submissions', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const status = String(req.query.status || 'pending');
    const mine = req.query.mine === '1' || !req.can('plant.approve');

    const where = [];
    const params = [];
    if (status !== 'all') { where.push('sub.status = ?'); params.push(status); }
    if (mine) { where.push('sub.submitted_by = ?'); params.push(req.user.id); }

    const rows = await q(
      `SELECT sub.*,
              submitter.full_name AS submitted_by_name,
              reviewer.full_name  AS reviewed_by_name
         FROM plant_submissions sub
         LEFT JOIN users submitter ON submitter.id = sub.submitted_by
         LEFT JOIN users reviewer  ON reviewer.id  = sub.reviewed_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY sub.submitted_at ASC, sub.id ASC`,
      params,
    );

    const plantIds = [...new Set(rows.map((r) => r.plant_id))];
    const plants = plantIds.length
      ? await plantsWhere(`p.id IN (${placeholders(plantIds)})`, plantIds)
      : [];
    const shaped = await shapeMany(plants, { full: true, viewer: req.user });
    const byPlant = new Map(shaped.map((p) => [p.id, p]));

    res.json({
      results: rows.map((s) => ({ ...s, plant: byPlant.get(s.plant_id) ?? null })),
    });
  }));

  /* ================================================================ */
  /* QR codes                                                         */
  /* ================================================================ */

  api.get('/qr/:plantId', route(async (req, res) => {
    // Staff only, and only for records they could open: the reply names the
    // plant even while it is pending, returned or archived, and the request
    // records the tag's address. Same rule as GET /plants.
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const rows = await plantsWhere('p.id = ?', [req.params.plantId]);
    const plant = rows[0];
    if (!plant) return res.status(404).json({ error: 'Not found' });
    const own = plant.registered_by === req.user.id;
    if (!req.can('plant.view_all') && !(req.can('plant.create') && own)) {
      return res.status(403).json({ error: 'Not permitted' });
    }
    const qr = await one(
      "SELECT * FROM qr_codes WHERE plant_id = ? ORDER BY (status = 'active') DESC, id ASC LIMIT 1",
      [plant.id],
    );
    if (!qr) return res.status(404).json({ error: 'No QR code has been issued for this record yet.' });

    const target = `${publicOrigin(req)}/p/${qr.qr_token}`;
    // Recorded as printed: a tag already on a tree cannot be re-pointed, so
    // the address it carries is kept rather than recomputed later.
    await update('qr_codes', qr.id, { target_url: target });

    const [png, svg, scans] = await Promise.all([
      QRCode.toDataURL(target, { margin: 1, width: 900, errorCorrectionLevel: 'M', color: { dark: '#14281d', light: '#ffffff' } }),
      QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      count('SELECT COUNT(*) FROM qr_scans WHERE plant_id = ?', [plant.id]),
    ]);
    res.json({
      qr_token: qr.qr_token, status: qr.status, version: qr.version,
      target_url: target, png, svg,
      plant_code: plant.plant_code,
      scientific_name: plant.scientific_name || null,
      common_name: plant.common_name || null,
      scans,
    });
  }));

  /* ================================================================ */
  /* Notifications                                                    */
  /* ================================================================ */

  api.get('/notifications', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const rows = await q('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]);
    res.json({ unread: rows.filter((n) => !n.is_read).length, results: rows });
  }));

  api.post('/notifications/:id/read', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    const n = await byId('notifications', req.params.id);
    if (!n || n.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    await update('notifications', n.id, { is_read: 1, read_at: nowIso() });
    res.json({ ok: true });
  }));

  api.post('/notifications/read-all', route(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    await q('UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0',
      [nowIso(), req.user.id]);
    res.json({ ok: true });
  }));

  /* ================================================================ */
  /* Public error reports                                             */
  /* ================================================================ */

  api.post('/reports', route(async (req, res) => {
    const b = req.body || {};
    const plant = await byId('plants', b.plant_id);
    if (!plant) return res.status(404).json({ error: 'Not found' });
    if (!b.description?.trim()) return res.status(400).json({ error: 'Please describe what looks wrong.' });
    const row = await insert('plant_reports', {
      plant_id: plant.id, reported_by: req.user?.id ?? null,
      reporter_name: b.reporter_name || null, reporter_email: b.reporter_email || null,
      issue_type: b.issue_type || 'other', description: b.description.trim(),
      status: 'open', handled_by: null, handled_at: null, resolution_note: null,
    });
    await notifyPermission('report.view', {
      type: 'report.new', title: 'Visitor reported incorrect information',
      body: 'A visitor flagged ' + plant.plant_code + ': ' + b.description.trim().slice(0, 100),
      related_type: 'plant', related_id: plant.id,
    });
    res.status(201).json({ report: row });
  }));

  api.get('/reports', need('report.view'), route(async (req, res) => {
    const rows = await q(
      `SELECT r.*, handler.full_name AS handled_by_name
         FROM plant_reports r LEFT JOIN users handler ON handler.id = r.handled_by
        ORDER BY r.created_at DESC`,
    );
    const plantIds = [...new Set(rows.map((r) => r.plant_id))];
    const plants = plantIds.length
      ? await plantsWhere(`p.id IN (${placeholders(plantIds)})`, plantIds)
      : [];
    const shaped = await shapeMany(plants, { viewer: req.user });
    const byPlant = new Map(shaped.map((p) => [p.id, p]));

    res.json({
      open: rows.filter((r) => r.status === 'open').length,
      results: rows.map((r) => ({ ...r, plant: byPlant.get(r.plant_id) ?? null })),
    });
  }));

  api.post('/reports/:id/resolve', need('report.resolve'), route(async (req, res) => {
    const r = await byId('plant_reports', req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const updated = await update('plant_reports', r.id, {
      status: req.body?.dismiss ? 'dismissed' : 'resolved',
      handled_by: req.user.id,
      handled_at: nowIso(),
      resolution_note: req.body?.note || null,
    });
    audit({ user_id: req.user.id, action: 'update', entity_type: 'plant_reports', entity_id: r.id, new_values: { status: updated.status } });
    res.json({ report: updated });
  }));

  /* ================================================================ */
  /* Admin - users, activity, audit, settings                         */
  /* ================================================================ */

  api.get('/users', need('user.view'), route(async (req, res) => {
    const rows = await q(
      `SELECT u.*, creator.full_name AS created_by_name,
              (SELECT COUNT(*) FROM plants p WHERE p.registered_by = u.id) AS plants_registered,
              (SELECT COUNT(*) FROM plants p WHERE p.verified_by  = u.id) AS plants_verified
         FROM users u LEFT JOIN users creator ON creator.id = u.created_by
        WHERE u.deleted_at IS NULL ORDER BY u.id`,
    );
    res.json({
      results: rows.map((u) => ({
        ...shapeUser(u),
        created_by_name: u.created_by_name || null,
        plants_registered: Number(u.plants_registered),
        plants_verified: Number(u.plants_verified),
      })),
    });
  }));

  api.post('/users', need('user.manage'), route(async (req, res) => {
    const b = req.body || {};
    if (!b.full_name?.trim()) return res.status(400).json({ error: 'Full name is required.' });
    if (!b.email?.trim()) return res.status(400).json({ error: 'Email address is required.' });
    if (!EMAIL_RE.test(b.email.trim())) return res.status(400).json({ error: 'That does not look like an email address.' });
    const dupe = await one('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [b.email.trim().toLowerCase()]);
    if (dupe) return res.status(409).json({ error: 'An account with that email address already exists.' });
    if (!roleById(b.role_id)) return res.status(400).json({ error: 'Choose a role.' });
    const blocked = superAdminBlock(req.user, null, b.role_id);
    if (blocked) return res.status(403).json({ error: blocked });

    const temporary = temporaryPassword();
    const row = await insert('users', {
      role_id: Number(b.role_id),
      full_name: b.full_name.trim(), email: b.email.trim().toLowerCase(),
      title: b.title || null, phone: b.phone || null,
      password_hash: hashPassword(temporary),
      must_change_password: 1, is_active: 1,
      email_verified_at: null, last_login_at: null,
      created_by: req.user.id, updated_at: nowIso(), deleted_at: null,
    });
    audit({ user_id: req.user.id, action: 'create', entity_type: 'users', entity_id: row.id, new_values: { email: row.email, role_id: row.role_id } });
    res.status(201).json({ user: shapeUser(row), temporary_password: temporary });
  }));

  api.patch('/users/:id', need('user.manage'), route(async (req, res) => {
    const before = await byId('users', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const blocked = superAdminBlock(req.user, before, 'role_id' in body ? body.role_id : null);
    if (blocked) return res.status(403).json({ error: blocked });
    // The screen already greys these out for your own account; the API holds the same line.
    if (before.id === req.user.id
      && (('role_id' in body && Number(body.role_id) !== before.role_id) || ('is_active' in body && !body.is_active))) {
      return res.status(400).json({ error: 'You cannot change your own role or deactivate yourself.' });
    }
    const patch = {};

    if ('role_id' in body) {
      if (!req.can('user.assign_role')) return res.status(403).json({ error: 'Not permitted to change roles.' });
      if (!roleById(body.role_id)) return res.status(400).json({ error: 'Choose a role.' });
      patch.role_id = Number(body.role_id);
    }
    ['full_name', 'title', 'phone'].forEach((k) => { if (k in body) patch[k] = body[k]; });
    if ('full_name' in patch) {
      if (typeof patch.full_name !== 'string' || !patch.full_name.trim()) {
        return res.status(400).json({ error: 'Full name is required.' });
      }
      patch.full_name = patch.full_name.trim();
    }
    if ('is_active' in body) patch.is_active = body.is_active ? 1 : 0;
    patch.updated_at = nowIso();

    const after = await update('users', before.id, patch);
    // Revoke live sessions so a deactivated account loses access at once.
    if (patch.is_active === 0) await revokeAllFor(before.id);

    audit({
      user_id: req.user.id,
      action: before.role_id !== after.role_id ? 'role_change' : 'update',
      entity_type: 'users', entity_id: before.id,
      old_values: { role_id: before.role_id, is_active: before.is_active, full_name: before.full_name },
      new_values: { role_id: after.role_id, is_active: after.is_active, full_name: after.full_name },
    });
    res.json({ user: shapeUser(after) });
  }));

  api.post('/users/:id/reset-password', need('user.manage'), route(async (req, res) => {
    const u = await byId('users', req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (superAdminBlock(req.user, u)) return res.status(403).json({ error: SUPER_ONLY });
    const temporary = temporaryPassword();
    // This used to flag the account and report a temporary password without
    // ever setting one - the old password went on working.
    await update('users', u.id, {
      password_hash: hashPassword(temporary),
      must_change_password: 1,
      // A reset may be because the account was taken over, so a code the
      // intruder could have seen goes too; a new one comes with the new password.
      recovery_code_hash: null,
      // Usually a reset because the phone is lost too, so two-step
      // verification goes; they can turn it on again with the new phone.
      totp_secret: null, totp_pending: null, totp_enabled_at: null, totp_last_step: null,
      // A fresh password is a fresh start: a lock earned against the old one
      // goes, and so does a request for this reset.
      failed_login_count: 0, locked_until: null, reset_requested_at: null,
      updated_at: nowIso(),
    });
    await revokeAllFor(u.id);
    // Same reasoning as the recovery code: whoever took the account may have
    // added their own phone. The user turns Face ID back on afterwards.
    await q('DELETE FROM passkeys WHERE user_id = ?', [u.id]);
    // Dealt with by hand, so a request still waiting has nothing left to do.
    await q("UPDATE password_reset_requests SET status = 'closed' WHERE user_id = ? AND status IN ('pending', 'approved')", [u.id]);
    audit({ user_id: req.user.id, action: 'password_reset', entity_type: 'users', entity_id: u.id, new_values: { must_change_password: 1 } });
    activity({ user_id: req.user.id, action: 'password_changed', detail: 'Reset the password for ' + u.email });
    res.json({ ok: true, temporary_password: temporary });
  }));

  /**
   * Approve a waiting reset request. The administrator types the code the
   * person reads off their screen, which shows they are talking to whoever
   * pressed the button - not to someone who only knows the email address.
   */
  api.post('/users/:id/reset-request/approve', need('user.manage'), route(async (req, res) => {
    const u = await byId('users', req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (superAdminBlock(req.user, u)) return res.status(403).json({ error: SUPER_ONLY });
    const row = await pendingResetRequest(u.id);
    if (!row) return res.status(404).json({ error: 'There is no reset request waiting for this account.' });

    if (String(req.body?.code || '').replace(/\D/g, '') !== row.check_code) {
      const wrong = row.wrong_codes + 1;
      if (wrong >= MAX_WRONG_CHECK_CODES) {
        // Someone is guessing; the person can simply ask again.
        await update('password_reset_requests', row.id, { wrong_codes: wrong, status: 'denied', decided_by: req.user.id, decided_at: nowIso() });
        await update('users', u.id, { reset_requested_at: null });
        audit({ user_id: req.user.id, action: 'reset_denied', entity_type: 'users', entity_id: u.id, new_values: { reason: 'too many wrong codes' } });
        return res.status(400).json({ error: 'Too many wrong codes, so the request has been refused. They can ask again.' });
      }
      await update('password_reset_requests', row.id, { wrong_codes: wrong });
      return res.status(400).json({ error: 'That is not the code on their screen.', attempts_left: MAX_WRONG_CHECK_CODES - wrong });
    }

    await update('password_reset_requests', row.id, { status: 'approved', decided_by: req.user.id, decided_at: nowIso() });
    await update('users', u.id, { reset_requested_at: null });
    audit({ user_id: req.user.id, action: 'reset_approved', entity_type: 'users', entity_id: u.id, new_values: { request_id: row.id } });
    activity({ user_id: req.user.id, action: 'reset_approved', detail: 'Approved a password reset for ' + u.email });
    res.json({ ok: true });
  }));

  api.post('/users/:id/reset-request/deny', need('user.manage'), route(async (req, res) => {
    const u = await byId('users', req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (superAdminBlock(req.user, u)) return res.status(403).json({ error: SUPER_ONLY });
    const row = await pendingResetRequest(u.id);
    if (!row) return res.status(404).json({ error: 'There is no reset request waiting for this account.' });
    await update('password_reset_requests', row.id, { status: 'denied', decided_by: req.user.id, decided_at: nowIso() });
    await update('users', u.id, { reset_requested_at: null });
    audit({ user_id: req.user.id, action: 'reset_denied', entity_type: 'users', entity_id: u.id, new_values: { request_id: row.id } });
    activity({ user_id: req.user.id, action: 'reset_denied', detail: 'Refused a password reset request for ' + u.email });
    res.json({ ok: true });
  }));

  /** Lift a wrong-password lock before it runs out on its own. */
  api.post('/users/:id/unlock', need('user.manage'), route(async (req, res) => {
    const u = await byId('users', req.params.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    if (superAdminBlock(req.user, u)) return res.status(403).json({ error: SUPER_ONLY });
    const after = await update('users', u.id, { failed_login_count: 0, locked_until: null, updated_at: nowIso() });
    audit({ user_id: req.user.id, action: 'account_unlocked', entity_type: 'users', entity_id: u.id, old_values: { locked_until: u.locked_until }, new_values: { locked_until: null } });
    activity({ user_id: req.user.id, action: 'account_unlocked', detail: 'Unlocked ' + u.email });
    res.json({ user: shapeUser(after) });
  }));

  api.get('/activity', need('system.audit'), route(async (req, res) => {
    const rows = await q(
      `SELECT a.*, COALESCE(u.full_name, 'Unknown') AS user_name, u.email AS user_email
         FROM user_activity_logs a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC, a.id DESC LIMIT 300`,
    );
    res.json({ results: rows });
  }));

  api.get('/audit', need('system.audit'), adminOnly, route(async (req, res) => {
    const { entity_type = '', action = '' } = req.query;
    const where = [];
    const params = [];
    if (entity_type) { where.push('a.entity_type = ?'); params.push(entity_type); }
    if (action) { where.push('a.action = ?'); params.push(action); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows, total, types, actions] = await Promise.all([
      q(`SELECT a.*, COALESCE(u.full_name, 'System') AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
           ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT 300`, params),
      count(`SELECT COUNT(*) FROM audit_logs a ${clause}`, params),
      q('SELECT DISTINCT entity_type FROM audit_logs'),
      q('SELECT DISTINCT action FROM audit_logs'),
    ]);
    // Which of these entries a later restore has already undone.
    const ids = rows.map((r) => r.id);
    const undone = new Set(ids.length
      ? (await q(
        `SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.restored_from')) AS UNSIGNED) AS id
           FROM audit_logs WHERE action = 'restore'
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.restored_from')) AS UNSIGNED) IN (${ids.map(() => '?').join(',')})`,
        ids,
      )).map((r) => Number(r.id))
      : []);
    res.json({
      total,
      entity_types: types.map((r) => r.entity_type),
      actions: actions.map((r) => r.action),
      results: rows.map((r) => {
        const entry = auditRow(r);
        const plan = restorePlan(entry);
        return { ...entry, restorable: !!plan.ok, restore_note: plan.ok ? null : plan.why, restored: undone.has(Number(r.id)) };
      }),
    });
  }));

  /* -------- restoring from the audit trail -------- */

  // The fields a restore may write back, per record type: the ones staff can
  // edit, never ids, codes, hashes or workflow status.
  const RESTORE_FIELDS = {
    plants: ['species_id', 'proposed_species_name', 'site_name', 'location_notes', 'latitude', 'longitude',
      'altitude_m', 'height_m', 'trunk_diameter_cm', 'health_status', 'life_stage', 'morphology_notes', 'notes'],
    species: ['scientific_name', 'common_name', 'local_name', 'family', 'genus', 'species_epithet', 'description',
      'characteristics', 'growth_form', 'leaf_description', 'flower_description', 'fruit_description',
      'habitat', 'distribution', 'conservation_status_id'],
    users: ['role_id', 'is_active', 'full_name'],
  };
  const NOT_RESTORABLE = {
    create: 'A record being added is not undone here. Archive or deactivate it instead.',
    approve: 'A review decision is not undone here. Archive the plant or edit it instead.',
    reject: 'A review decision is not undone here.',
    security: 'Security events - passwords, two-step verification, Face ID / fingerprint, locks - cannot be restored.',
    other: 'This kind of entry cannot be restored.',
    nothing: 'This entry has no earlier values to put back.',
  };

  /** One comparable form for a value, whether it came from MySQL or from stored JSON. */
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (v === true) return '1';
    if (v === false) return '0';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };

  /** The editable fields an entry changed, with their earlier and later values. */
  function changedFields(entry, allowed) {
    const before = entry.old_values && typeof entry.old_values === 'object' ? entry.old_values : {};
    const after = entry.new_values && typeof entry.new_values === 'object' ? entry.new_values : {};
    return allowed.filter((k) => k in before && norm(before[k]) !== norm(after[k]));
  }

  /**
   * Writes the earlier values back. Stops with `conflict` when the record has
   * moved on since the entry, unless forced.
   */
  async function revertFields(table, entry, fields, { force, check, afterWrite, user }) {
    const current = await byId(table, entry.entity_id);
    if (!current || current.deleted_at) return { error: 'This record no longer exists.', status: 404 };
    const conflict = fields.filter((k) => norm(current[k]) !== norm(entry.new_values[k]));
    if (conflict.length && !force) return { conflict };
    const patch = Object.fromEntries(fields.map((k) => [k, entry.old_values[k] ?? null]));
    const problem = check ? await check({ ...current, ...patch }, current, user) : null;
    if (problem) return { error: problem };
    if ('updated_at' in current) patch.updated_at = nowIso();
    const saved = await update(table, current.id, patch);
    if (afterWrite) await afterWrite(current, saved);
    const pick = (o) => Object.fromEntries(fields.map((k) => [k, o[k] ?? null]));
    return { before: pick(current), after: pick(saved) };
  }

  /** What restoring this entry would do, or why it cannot be done. */
  function restorePlan(entry) {
    const { entity_type: type, action } = entry;
    if (['create', 'approve', 'reject'].includes(action)) return { ok: false, why: NOT_RESTORABLE[action] };
    if (/password|two_factor|passkey|locked|unlocked|recovery|reset/.test(action) || type === 'login_lockouts') {
      return { ok: false, why: NOT_RESTORABLE.security };
    }

    // An archived plant brought back - by the same rules as the Restore button.
    if (type === 'plants' && action === 'archive') {
      return {
        ok: true,
        run: async (user) => {
          const r = await restoreArchivedPlant(entry.entity_id, user, 'Restored from the audit trail');
          return r.error ? r : { before: { status: 'archived' }, after: { status: r.status } };
        },
      };
    }

    if (type === 'settings' && ['update', 'restore'].includes(action)) {
      const key = Object.keys(entry.old_values || {}).find((k) => k !== 'restored_from');
      if (!key || !allSettings().some((s) => s.setting_key === key)) return { ok: false, why: NOT_RESTORABLE.nothing };
      return {
        ok: true,
        run: async (user, { force }) => {
          const current = allSettings().find((s) => s.setting_key === key);
          if (norm(current.setting_value) !== norm(entry.new_values?.[key]) && !force) return { conflict: [key] };
          const saved = await setSetting(key, entry.old_values[key], user.id);
          return { before: { [key]: current.setting_value }, after: { [key]: saved.setting_value } };
        },
      };
    }

    const allowed = RESTORE_FIELDS[type];
    if (!allowed || !['update', 'role_change', 'restore'].includes(action)) return { ok: false, why: NOT_RESTORABLE.other };
    const fields = changedFields(entry, allowed);
    if (!fields.length) return { ok: false, why: NOT_RESTORABLE.nothing };

    if (type === 'plants') {
      return {
        ok: true,
        run: (user, { force }) => revertFields('plants', entry, fields, {
          force, user,
          check: async (candidate, current) => {
            const invalid = validatePlant(candidate);
            if (invalid) return invalid;
            if (candidate.species_id && !await byId('species', candidate.species_id)) return 'The earlier species no longer exists.';
            if (current.status === 'approved' && !candidate.species_id) return 'A published record must have a confirmed species.';
            return null;
          },
          afterWrite: (before, after) => recordRevisions(before.id, user.id, before, after, 'Restored from the audit trail'),
        }),
      };
    }
    if (type === 'species') {
      return { ok: true, run: (user, { force }) => revertFields('species', entry, fields, { force, user }) };
    }
    // users
    return {
      ok: true,
      run: (user, { force }) => revertFields('users', entry, fields, {
        force, user,
        check: async (candidate, current) => {
          if (current.id === user.id && (norm(candidate.role_id) !== norm(current.role_id) || norm(candidate.is_active) !== norm(current.is_active))) {
            return 'You cannot change your own role or deactivate yourself.';
          }
          if (!roleById(candidate.role_id)) return 'The earlier role no longer exists.';
          // Same ceiling as the Staff accounts screen: restoring is no way round it.
          return superAdminBlock(user, current, candidate.role_id);
        },
        // Deactivated again: their open sessions end at once, as with the Deactivate button.
        afterWrite: async (before, after) => { if (Number(after.is_active) === 0) await revokeAllFor(after.id); },
      }),
    };
  }

  /**
   * Put a record back the way it was before an audit entry: an edit undone, an
   * archived plant brought back, a deactivated account reactivated, a setting
   * changed back. Administrators only.
   *
   * If the record has been changed again since, the restore stops and says
   * so (409) rather than silently throwing the later change away; sending
   * { force: true } restores anyway. The restore is itself an audit entry,
   * pointing back at the one it undid, so it can be undone in turn.
   */
  api.post('/audit/:id/restore', need('system.audit'), adminOnly, route(async (req, res) => {
    const row = await one('SELECT * FROM audit_logs WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const entry = auditRow(row);
    const plan = restorePlan(entry);
    if (!plan.ok) return res.status(400).json({ error: plan.why });

    const result = await plan.run(req.user, { force: req.body?.force === true });
    if (result.conflict) {
      return res.status(409).json({ error: 'This record has been changed again since. Restoring would undo those later changes too.', code: 'CHANGED_SINCE', fields: result.conflict });
    }
    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    audit({
      user_id: req.user.id, action: 'restore', entity_type: entry.entity_type, entity_id: entry.entity_id,
      old_values: result.before, new_values: { ...result.after, restored_from: entry.id },
    });
    activity({ user_id: req.user.id, action: 'restore', detail: `Restored ${entry.entity_type} #${entry.entity_id ?? ''} to before audit entry ${entry.id}` });
    res.json({ ok: true });
  }));

  api.get('/admin/stats', need('user.view'), route(async (req, res) => {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const [users, active, byRole, logins7d, failed, auditEntries] = await Promise.all([
      count('SELECT COUNT(*) FROM users WHERE deleted_at IS NULL'),
      count('SELECT COUNT(*) FROM users WHERE is_active = 1 AND deleted_at IS NULL'),
      q('SELECT role_id, COUNT(*) n FROM users WHERE deleted_at IS NULL GROUP BY role_id'),
      count("SELECT COUNT(*) FROM user_activity_logs WHERE action = 'login' AND created_at >= ?", [weekAgo]),
      count("SELECT COUNT(*) FROM user_activity_logs WHERE action = 'login_failed'"),
      count('SELECT COUNT(*) FROM audit_logs'),
    ]);
    const perRole = new Map(byRole.map((r) => [r.role_id, Number(r.n)]));
    res.json({
      users, active_users: active,
      by_role: cachedRoles().map((r) => ({ role: r.name, label: r.label, count: perRole.get(r.id) || 0 })),
      logins_7d: logins7d, failed_logins: failed, audit_entries: auditEntries,
    });
  }));

  api.get('/settings', need('system.settings'), route(async (req, res) => {
    const rows = await q(
      `SELECT s.*, u.full_name AS updated_by_name
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
        ORDER BY s.setting_key`,
    );
    res.json({ results: rows });
  }));

  api.patch('/settings/:key', need('system.settings'), route(async (req, res) => {
    const existing = allSettings().find((s) => s.setting_key === req.params.key);
    if (!existing) return res.status(404).json({ error: 'Unknown setting' });
    let value = req.body?.value;
    // The lockout limits have a sensible range; outside it, say so rather than store it.
    const range = { lockout_max_attempts: lockout.LIMITS.attempts, lockout_minutes: lockout.LIMITS.minutes }[req.params.key];
    if (range) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < range.min || n > range.max) {
        return res.status(400).json({ error: `Enter a whole number from ${range.min} to ${range.max}.` });
      }
      value = n;
    }
    if (existing.value_type === 'bool') value = value === true || value === 'true';
    const before = existing.setting_value;
    const row = await setSetting(req.params.key, value, req.user.id);
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'settings', entity_id: null,
      old_values: { [req.params.key]: before }, new_values: { [req.params.key]: row.setting_value },
    });
    res.json({ setting: row });
  }));

  /* -------- brute-force locks on an IP address or a device -------- */
  // Account locks are lifted from Staff accounts; these have no account to sit on.

  api.get('/security/lockouts', need('user.manage'), route(async (req, res) => {
    res.json({ results: await lockout.activeLocks(), policy: lockout.policy() });
  }));

  api.delete('/security/lockouts/:id', need('user.manage'), route(async (req, res) => {
    const row = await lockout.unlock(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });
    audit({
      user_id: req.user.id, action: `${row.scope}_unlocked`, entity_type: 'login_lockouts', entity_id: row.id,
      old_values: { label: row.label, locked_until: row.locked_until }, new_values: { locked_until: null },
    });
    activity({ user_id: req.user.id, action: `${row.scope}_unlocked`, detail: `Lifted the lock on ${row.scope === 'ip' ? 'network' : 'device'} ${row.label}` });
    res.json({ ok: true });
  }));

  /* ================================================================ */
  /* IoT sensors                                                      */
  /* ================================================================ */

  /**
   * Readings arrive over MQTT and are saved by mqtt.js; these routes only
   * read them back for the dashboard.
   *
   * mysql2 returns DECIMAL columns as strings ("46.40"), so every measurement
   * and limit goes through num() before it reaches the client.
   */
  const num = (v) => (v === null || v === undefined ? null : Number(v));

  const shapeReading = (r) => r && ({
    id: r.id,
    device_id: r.device_id,
    plant_id: r.plant_id,
    recorded_at: r.recorded_at,
    soil_moisture_pct: num(r.soil_moisture_pct),
    temperature_c: num(r.temperature_c),
    humidity_pct: num(r.humidity_pct),
    // From the rest of the kit (sections 7 and 8 of schema-extensions.sql). A
    // database set up before those columns existed has none of them, so they
    // come back undefined and are sent as null.
    rain_pct: num(r.rain_pct),
    is_raining: r.is_raining === null || r.is_raining === undefined ? null : !!r.is_raining,
    motion_events: num(r.motion_events),
    sound_peak_pct: num(r.sound_peak_pct),
    distance_cm: num(r.distance_cm),
    wifi_rssi_dbm: num(r.wifi_rssi_dbm),
  });

  /**
   * Everything the IoT dashboard needs in one request: each device with its
   * latest reading and whether it is online, recent readings for charts, and
   * the alerts list (open ones first).
   *
   * Query options:
   *   ?hours=2       how far back `readings` goes (1-48)
   *   ?device_id=1   limit `readings` to one device
   */
  api.get('/sensors', need('sensor.view'), route(async (req, res) => {

    // Both are whole numbers by construction, so they are safe to put in the
    // SQL text; MySQL does not accept a placeholder inside every INTERVAL.
    const offlineMinutes = Math.max(1, Math.floor(Number(getSetting('sensor_offline_minutes')) || 15));
    const hours = Math.min(48, Math.max(1, Math.floor(Number(req.query.hours) || 2)));
    const deviceId = req.query.device_id ? Number(req.query.device_id) : null;

    const [devices, latest, readings, alerts, cameraAlerts] = await Promise.all([
      // Every DATETIME in the schema is UTC, hence UTC_TIMESTAMP() not NOW().
      q(`SELECT d.id, d.device_code, d.label, d.plant_id, d.is_simulated, d.is_active,
                d.soil_moisture_min, d.soil_moisture_max,
                d.temperature_min, d.temperature_max,
                d.humidity_min, d.humidity_max,
                d.last_seen_at,
                (d.last_seen_at IS NOT NULL
                  AND d.last_seen_at >= UTC_TIMESTAMP() - INTERVAL ${offlineMinutes} MINUTE) AS online,
                p.plant_code, p.site_name, s.scientific_name, s.common_name
           FROM sensor_devices d
           LEFT JOIN plants p  ON p.id = d.plant_id
           LEFT JOIN species s ON s.id = p.species_id
          WHERE d.deleted_at IS NULL
          ORDER BY d.device_code`),

      // The newest reading per device.
      q(`SELECT r.*
           FROM sensor_readings r
           JOIN (SELECT device_id, MAX(id) AS id FROM sensor_readings GROUP BY device_id) m
             ON m.id = r.id`),

      // Recent history for the charts. At one reading every 10 s that is 720
      // rows an hour per device, so it is capped. SELECT * rather than a
      // column list, so a database without the newer columns still works.
      q(`SELECT *
           FROM sensor_readings
          WHERE recorded_at >= UTC_TIMESTAMP() - INTERVAL ${hours} HOUR
            ${deviceId ? 'AND device_id = ?' : ''}
          ORDER BY id DESC
          LIMIT 2000`, deviceId ? [deviceId] : []),

      q(`SELECT a.*, d.device_code, d.label AS device_label, p.plant_code,
                u.full_name AS resolved_by_name
           FROM sensor_alerts a
           JOIN sensor_devices d ON d.id = a.device_id
           LEFT JOIN plants p    ON p.id = a.plant_id
           LEFT JOIN users u     ON u.id = a.resolved_by
          ORDER BY (a.status = 'open') DESC, a.triggered_at DESC
          LIMIT 50`),

      // AI camera alerts, without the pictures (fetched one by one).
      q(`SELECT a.id, a.camera_id, a.plant_id, a.tier, a.track_id, a.detail,
                a.photo_mime, a.photo_bytes, a.status, a.triggered_at, a.resolved_by, a.resolved_at,
                a.resolution_note, c.device_code, c.label AS camera_label, p.plant_code,
                u.full_name AS resolved_by_name
           FROM camera_alerts a
           JOIN camera_devices c ON c.id = a.camera_id
           LEFT JOIN plants p    ON p.id = a.plant_id
           LEFT JOIN users u     ON u.id = a.resolved_by
          ORDER BY (a.status = 'open') DESC, a.triggered_at DESC
          LIMIT 50`).catch((err) => {
        // A database set up before section 15 has no camera tables yet.
        if (err?.code === 'ER_NO_SUCH_TABLE') return [];
        throw err;
      }),
    ]);

    const latestByDevice = new Map(latest.map((r) => [r.device_id, shapeReading(r)]));
    const shapedAlerts = alerts.map((a) => ({
      ...a,
      reading_value: num(a.reading_value),
      limit_value: num(a.limit_value),
    }));

    res.json({
      status: 'live',
      offline_minutes: offlineMinutes,
      hours,
      devices: devices.map((d) => ({
        id: d.id,
        device_code: d.device_code,
        label: d.label,
        is_simulated: !!d.is_simulated,
        is_active: !!d.is_active,
        online: !!d.online,
        last_seen_at: d.last_seen_at,
        plant: d.plant_id ? {
          id: d.plant_id, plant_code: d.plant_code, site_name: d.site_name,
          scientific_name: d.scientific_name, common_name: d.common_name,
        } : null,
        limits: {
          soil_moisture: { min: num(d.soil_moisture_min), max: num(d.soil_moisture_max) },
          temperature: { min: num(d.temperature_min), max: num(d.temperature_max) },
          humidity: { min: num(d.humidity_min), max: num(d.humidity_max) },
        },
        latest: latestByDevice.get(d.id) || null,
        open_alerts: shapedAlerts.filter((a) => a.device_id === d.id && a.status === 'open').length,
      })),
      // Oldest first, which is the order a chart draws in.
      readings: readings.reverse().map(shapeReading),
      alerts: shapedAlerts,
      open_alerts: shapedAlerts.filter((a) => a.status === 'open').length,
      camera_alerts: cameraAlerts.map((a) => ({ ...a, photo_url: `/api/sensors/camera-alerts/${a.id}/photo` })),
      open_camera_alerts: cameraAlerts.filter((a) => a.status === 'open').length,
    });
  }));

  /** Mark an alert as dealt with, with an optional note. */
  api.post('/sensors/alerts/:id/resolve', need('alert.resolve'), route(async (req, res) => {
    const alert = await byId('sensor_alerts', req.params.id);
    if (!alert) return res.status(404).json({ error: 'No such alert' });
    if (alert.status !== 'open') return res.status(409).json({ error: 'This alert is already resolved.' });

    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    const after = await update('sensor_alerts', alert.id, {
      status: 'resolved',
      resolved_by: req.user.id,
      resolved_at: nowIso(),
      resolution_note: note,
    });
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'sensor_alerts', entity_id: alert.id,
      old_values: { status: 'open' }, new_values: { status: 'resolved', note },
    });
    res.json({
      alert: { ...after, reading_value: num(after.reading_value), limit_value: num(after.limit_value) },
    });
  }));

  /* ================================================================ */
  /* AI camera alerts (section 15 of Server/schema-extensions.sql)    */
  /* ================================================================ */

  // Everything but the picture, which is fetched on its own and only by roles
  // with sensor.view.
  const CAMERA_ALERT_COLUMNS = `a.id, a.camera_id, a.plant_id, a.tier, a.track_id, a.detail,
    a.photo_mime, a.photo_bytes, a.status, a.triggered_at, a.resolved_by, a.resolved_at,
    a.resolution_note`;
  const shapeCameraAlert = (a) => ({ ...a, photo_url: `/api/sensors/camera-alerts/${a.id}/photo` });
  const CAMERA_TIERS = new Set(['ALERT', 'AFTER-HOURS']);
  // Under a stock XAMPP MariaDB's 1 MB max_allowed_packet. The camera sends a
  // 1280-pixel JPEG, typically 100-300 KB.
  const MAX_SNAPSHOT_BYTES = 900 * 1024;

  /** Same check as the sensor nodes: SHA-256 of the key, compared in constant time. */
  const cameraKeyMatches = (key, expectedHex) => {
    if (typeof key !== 'string' || !key || !/^[0-9a-f]{64}$/i.test(expectedHex || '')) return false;
    const got = crypto.createHash('sha256').update(key).digest();
    return crypto.timingSafeEqual(got, Buffer.from(expectedHex, 'hex'));
  };

  /**
   * The AI camera reports an alert with the snapshot that shows why.
   * Not a user request: the camera signs it with X-Camera-Code / X-Camera-Key.
   *
   * Body: { tier: 'ALERT' | 'AFTER-HOURS', photo: base64 JPEG (or a data URL),
   *         track_id?: number, detail?: string }
   */
  api.post('/camera/alerts', route(async (req, res) => {
    const code = String(req.get('x-camera-code') || '').trim();
    const key = req.get('x-camera-key') || '';
    const camera = code ? await one(
      'SELECT * FROM camera_devices WHERE device_code = ? AND deleted_at IS NULL LIMIT 1', [code],
    ) : null;
    // One answer for an unknown camera, a wrong key and a switched-off camera,
    // so the endpoint does not reveal which camera codes exist.
    if (!camera || !camera.is_active || !cameraKeyMatches(key, camera.device_key_hash)) {
      return res.status(401).json({ error: 'Unknown camera or wrong key' });
    }

    const b = req.body || {};
    const tier = String(b.tier || '');
    if (!CAMERA_TIERS.has(tier)) {
      return res.status(400).json({ error: 'tier must be ALERT or AFTER-HOURS' });
    }
    const raw = String(b.photo || '').replace(/^data:image\/jpeg;base64,/i, '');
    if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
      return res.status(400).json({ error: 'photo must be a base64 JPEG' });
    }
    const photo = Buffer.from(raw, 'base64');
    // JPEG files start FF D8 FF; anything else is refused rather than served
    // back to a ranger's browser later.
    if (photo.length < 4 || photo[0] !== 0xff || photo[1] !== 0xd8 || photo[2] !== 0xff) {
      return res.status(400).json({ error: 'photo must be a base64 JPEG' });
    }
    if (photo.length > MAX_SNAPSHOT_BYTES) {
      return res.status(413).json({ error: 'The snapshot is larger than 900 KB' });
    }
    const trackId = Number.isInteger(b.track_id) && b.track_id >= 0 && b.track_id <= 0xFFFFFFFF ? b.track_id : null;
    const detail = typeof b.detail === 'string' ? b.detail.trim().slice(0, 255) || null : null;

    const now = nowIso();
    // q, not insert(): insert() reads the row back, picture and all.
    const result = await q(
      `INSERT INTO camera_alerts (camera_id, plant_id, tier, track_id, detail, photo, photo_mime, photo_bytes, status, triggered_at)
       VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', ?, 'open', ?)`,
      [camera.id, camera.plant_id, tier, trackId, detail, photo, photo.length, now],
    );
    const alertId = result.insertId;
    await q('UPDATE camera_devices SET last_seen_at = ? WHERE id = ?', [now, camera.id]);

    // Only the people who respond to alerts are told - the Ranger role - in the
    // app, and by email with the snapshot attached.
    const what = tier === 'ALERT' ? 'Someone is touching the plant' : 'Someone is at the plant after hours';
    await notifyPermission('alert.resolve', {
      type: 'camera.alert',
      title: `Camera alert: ${camera.device_code}`,
      body: `${what}${camera.label ? ` (${camera.label})` : ''}.${detail ? ` ${detail}` : ''}`,
      related_type: 'camera_alert', related_id: alertId,
    });
    emailCameraAlert({ camera, tier, what, detail, photo, alertId, when: now, origin: publicOrigin(req) })
      .catch((err) => console.warn(`[camera] Alert email failed: ${err.message}`));

    console.log(`[camera] ${tier} from ${camera.device_code} (alert ${alertId}, ${photo.length} bytes)`);
    res.status(201).json({ id: alertId });
  }));

  async function emailCameraAlert({ camera, tier, what, detail, photo, alertId, when, origin }) {
    const recipients = (await q(
      'SELECT email, role_id FROM users WHERE is_active = 1 AND deleted_at IS NULL',
    )).filter((u) => permissionsForRole(u.role_id).includes('alert.resolve') && u.email);
    for (const u of recipients) {
      await sendMail({
        to: u.email,
        subject: `FloraScan camera alert (${tier}): ${camera.device_code}`,
        text: [
          `${what}.`,
          camera.label ? `Camera: ${camera.device_code} - ${camera.label}` : `Camera: ${camera.device_code}`,
          detail ? `Detail: ${detail}` : null,
          `Time (UTC): ${when.slice(0, 19).replace('T', ' ')}`,
          '',
          'The snapshot is attached. Open the IoT page to resolve the alert:',
          `${origin}/staff/iot`,
        ].filter((l) => l !== null).join('\n'),
        attachments: [{ filename: `camera-alert-${alertId}.jpg`, content: photo, contentType: 'image/jpeg' }],
      });
    }
  }

  /** The snapshot for one camera alert. Staff with sensor.view only, never cached by a proxy. */
  api.get('/sensors/camera-alerts/:id/photo', need('sensor.view'), route(async (req, res) => {
    const row = await one('SELECT photo, photo_mime FROM camera_alerts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'No such alert' });
    res.set('Cache-Control', 'private, no-store');
    res.type(row.photo_mime || 'image/jpeg');
    res.send(row.photo);
  }));

  /** Mark a camera alert as dealt with, with an optional note. */
  api.post('/sensors/camera-alerts/:id/resolve', need('alert.resolve'), route(async (req, res) => {
    const alert = await one('SELECT id, status FROM camera_alerts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!alert) return res.status(404).json({ error: 'No such alert' });
    if (alert.status !== 'open') return res.status(409).json({ error: 'This alert is already resolved.' });

    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    await q(
      "UPDATE camera_alerts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?",
      [req.user.id, nowIso(), note, alert.id],
    );
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'camera_alerts', entity_id: alert.id,
      old_values: { status: 'open' }, new_values: { status: 'resolved', note },
    });
    const after = await one(`SELECT ${CAMERA_ALERT_COLUMNS} FROM camera_alerts a WHERE a.id = ?`, [alert.id]);
    res.json({ alert: shapeCameraAlert(after) });
  }));

  /* ================================================================ */
  /* Photos + connect                                                 */
  /* ================================================================ */

  /** Photographs cached by scripts/import-species.mjs. */
  api.get('/photos/file/:name', (req, res) => {
    const name = req.params.name;
    if (!photoExists(name)) return res.status(404).json({ error: 'No such photograph' });
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.type('image/jpeg');
    res.sendFile(path.join(PHOTO_DIR, name));
  });

  /**
   * A photograph somebody uploaded in the field.
   *
   * Public, like the record it belongs to - a visitor scanning a tag has to be
   * able to see it - but only for a record that is actually published. An
   * unapproved or archived plant's photographs stay out of sight, or the
   * publication rule leaks through the image URLs.
   */
  api.get('/photos/upload/:id', route(async (req, res) => {
    const row = await one(
      `SELECT d.bytes, d.byte_length, ph.mime_type, p.status, p.deleted_at, p.registered_by
         FROM plant_photo_data d
         JOIN plant_photos ph ON ph.id = d.photo_id
         JOIN plants p        ON p.id  = ph.plant_id
        WHERE d.photo_id = ? AND ph.deleted_at IS NULL
        LIMIT 1`,
      [req.params.id],
    );
    if (!row || row.deleted_at) return res.status(404).json({ error: 'No such photograph' });

    const published = row.status === 'approved';
    const visible = published || req.can('plant.view_all')
      || (req.user && row.registered_by === req.user.id)
      || validPhotoSig(req.params.id, req.query.exp, req.query.sig);
    if (!visible) return res.status(404).json({ error: 'No such photograph' });

    // Only a published photograph may sit in a shared cache; an unpublished
    // one stays in the viewer's own browser.
    res.set('Cache-Control', published ? 'public, max-age=604800, immutable' : 'private, max-age=3600');
    res.type(row.mime_type || 'image/jpeg');
    res.send(row.bytes);
  }));

  /** Everything the "open on your phone" screen needs. */
  api.get('/connect', route(async (req, res) => {
    const port = req.app.get('protoPort');
    const addrs = lanAddresses();
    const url = publicOrigin(req);
    const scheme = url.startsWith('https') ? 'https' : 'http';

    // Hosted on a real domain with a real certificate: there is no local
    // network worth enumerating and nothing for the phone to trust, so the
    // certificate dance has to disappear rather than confuse people.
    const hosted = !addrs.some((a) => url.includes(a.address));

    const png = await QRCode.toDataURL(url, {
      margin: 1, width: 900, errorCorrectionLevel: 'M',
      color: { dark: '#14281d', light: '#ffffff' },
    });
    res.json({
      url, png, port, scheme, hosted,
      addresses: hosted ? [] : addrs.map((a) => ({ ...a, url: `${scheme}://${a.address}:${port}` })),
      secure: scheme === 'https',
      ca_url: hosted ? null : (req.app.get('protoCaPath') || null),
      passkey_url: hosted ? null : passkeyHome(req),
      note: hosted
        ? 'Open this address on your phone, or scan the code. The site has a real certificate, so there is nothing to accept and the camera scanner works straight away.'
        : scheme === 'https'
          ? 'Your phone will warn about the local certificate. Accept it once and the in-app camera scanner will work; trust it (below) to remove the warning for good.'
          : 'Browsers only allow camera access over HTTPS or localhost, so the in-app scanner cannot open the camera on this plain-HTTP address. Run "npm run https" if you need the live camera on your phone.',
    });
  }));

  api.use((req, res) => res.status(404).json({ error: 'No such endpoint: ' + req.path }));

  // Always answer the client in JSON - an HTML error page would surface in the
  // UI as an unhelpful parse failure.
  api.use((err, req, res, _next) => {
    // A photograph larger than the body limit is refused by the JSON parser
    // before any handler sees it. That is the caller's mistake, not the
    // server's, so it gets a 400 saying what the limit is rather than a 500
    // saying "request entity too large".
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      const maxMb = Number(getSetting('max_upload_mb')) || 8;
      return res.status(400).json({
        error: `That is too much data to send at once. Photographs are limited to ${maxMb} MB each, and a few at a time.`,
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body was not valid JSON.' });
    }
    // The database refused a value bigger than its max_allowed_packet (1 MB on
    // a stock XAMPP MariaDB). Say so, instead of a bare 500.
    if (err?.code === 'ER_NET_PACKET_TOO_LARGE') {
      console.error('API error on ' + req.method + ' ' + req.path + ': value larger than max_allowed_packet');
      return res.status(413).json({
        error: 'That photograph is too large for the database. Use a smaller picture, or raise max_allowed_packet in MySQL (see README).',
      });
    }
    console.error('API error on ' + req.method + ' ' + req.path + ':', err);
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  });

  return api;
}
