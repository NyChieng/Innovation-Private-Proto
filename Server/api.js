import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import {
  q, one, count, insert, update, byId, tx, nowIso,
  getSetting, setSetting, allSettings, permissionsForRole, userCan,
  roles as cachedRoles, roleById,
  audit, activity, notify, notifyPermission, recordRevisions,
} from './db.js';
import path from 'node:path';
import { renderPhoto } from './images.js';
import { photoExists, PHOTO_DIR, SPECIES_DATA, hasRealPhotos } from './species-data.js';
import { lanAddresses } from './net.js';
import { hashPassword, verifyPassword, DEMO_PASSWORD } from './passwords.js';

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

function shapeUser(u) {
  if (!u) return null;
  const role = roleById(u.role_id);
  return {
    id: u.id, full_name: u.full_name, email: u.email, title: u.title,
    phone: u.phone, role: role?.name, role_label: role?.label, role_id: u.role_id,
    is_active: !!u.is_active, must_change_password: !!u.must_change_password,
    last_login_at: u.last_login_at, created_at: u.created_at,
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
    q(`SELECT * FROM plant_submissions WHERE plant_id IN (${ph}) ORDER BY submitted_at DESC`, ids),
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

function shapePlant(p, ex, { full = false, viewer = null } = {}) {
  if (!p) return null;
  const photos = ex.photos.get(p.id) || [];
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

  /* ================================================================ */
  /* Bootstrap                                                        */
  /* ================================================================ */

  api.get('/bootstrap', route(async (req, res) => {
    const [statuses, users, facets] = await Promise.all([
      q('SELECT * FROM conservation_statuses ORDER BY sort_order'),
      q('SELECT id, full_name, email, title, role_id, is_active FROM users WHERE deleted_at IS NULL ORDER BY id'),
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
      // Prototype convenience: the role switcher needs the demo roster.
      demo_accounts: users.map((u) => ({
        id: u.id, full_name: u.full_name, email: u.email, title: u.title,
        role: roleById(u.role_id)?.name,
        role_label: roleById(u.role_id)?.label,
        is_active: !!u.is_active,
      })),
      demo_password: DEMO_PASSWORD,
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
    const user = await one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1',
      [String(email || '').toLowerCase().trim()]);
    if (!user) {
      activity({ user_id: null, action: 'login_failed', detail: 'Unknown email: ' + email });
      return res.status(401).json({ error: 'No account with that email address.' });
    }
    if (!await verifyPassword(password, user.password_hash)) {
      activity({ user_id: user.id, action: 'login_failed', detail: 'Wrong password' });
      return res.status(401).json({ error: 'Incorrect password. The demo password is demo1234.' });
    }
    if (!user.is_active) {
      activity({ user_id: user.id, action: 'login_failed', detail: 'Account deactivated' });
      return res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
    }
    await update('users', user.id, { last_login_at: nowIso() });
    activity({ user_id: user.id, action: 'login', detail: 'Signed in' });
    res.json({ token: await issueToken(user.id), user: shapeUser(user) });
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

  /**
   * Prototype-only: jump straight into any demo account.
   * This is what the floating role switcher calls. It exists so the team and
   * the client can compare roles quickly; it is NOT part of the real design
   * and must not ship to production.
   */
  api.post('/auth/switch', route(async (req, res) => {
    const user = await byId('users', req.body?.user_id);
    if (!user) return res.status(404).json({ error: 'No such demo account' });
    if (!user.is_active) return res.status(403).json({ error: 'That account is deactivated - reactivate it from the Admin dashboard first.' });
    await update('users', user.id, { last_login_at: nowIso() });
    activity({ user_id: user.id, action: 'login', detail: 'Switched role (prototype switcher)' });
    res.json({ token: await issueToken(user.id), user: shapeUser(user) });
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
        WHERE deleted_at IS NULL AND species_id IS NOT NULL GROUP BY species_id`,
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
      species: await shapeSpecies(s),
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
    const { q: search = '', status = '', family = '', conservation = '', site = '', mine = '' } = req.query;

    const where = ['p.deleted_at IS NULL'];
    const params = [];
    // A ranger without plant.view_all sees only their own records.
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
    // Botanist entries publish immediately. Ranger entries follow the setting,
    // but a "species not listed" entry always needs review.
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
    const invalid = validatePlant(req.body || {});
    if (invalid) return res.status(400).json({ error: invalid });

    const allowed = ['species_id', 'proposed_species_name', 'site_name', 'location_notes',
      'latitude', 'longitude', 'altitude_m', 'height_m', 'trunk_diameter_cm',
      'health_status', 'life_stage', 'morphology_notes', 'notes'];
    const patch = {};
    allowed.forEach((k) => { if (k in (req.body || {})) patch[k] = req.body[k]; });

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
  async function issueQr(plantId, userId) {
    const active = await one("SELECT * FROM qr_codes WHERE plant_id = ? AND status = 'active' LIMIT 1", [plantId]);
    if (active) return active;

    const old = await one("SELECT * FROM qr_codes WHERE plant_id = ? AND status = 'inactive' LIMIT 1", [plantId]);
    if (old) {
      return await update('qr_codes', old.id, {
        status: 'active', deactivated_at: null, deactivation_reason: null,
      });
    }
    return await insert('qr_codes', {
      plant_id: plantId, qr_token: crypto.randomUUID(),
      image_path: null, target_url: null, version: 1, status: 'active',
      generated_by: userId ?? null, generated_at: nowIso(),
      deactivated_at: null, deactivation_reason: null,
    });
  }

  const pendingSubmission = (plantId) =>
    one("SELECT * FROM plant_submissions WHERE plant_id = ? AND status = 'pending' LIMIT 1", [plantId]);

  api.post('/plants/:id/approve', need('plant.approve'), route(async (req, res) => {
    const before = await byId('plants', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
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
    const sub = await pendingSubmission(before.id);
    if (sub) {
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
    }
    await recordRevisions(before.id, req.user.id, before, after, 'Approved by botanist');
    audit({
      user_id: req.user.id, action: 'approve', entity_type: 'plants', entity_id: before.id,
      old_values: { status: before.status }, new_values: { status: 'approved', qr_token: qr.qr_token },
    });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
    res.json({ plant: await shapeOne(joined, { full: true, viewer: req.user }) });
  }));

  api.post('/plants/:id/reject', need('plant.approve'), route(async (req, res) => {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'A note is required when rejecting, so the ranger knows what to change.' });
    const before = await byId('plants', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const after = await update('plants', before.id, { status: 'rejected', updated_at: nowIso() });
    const sub = await pendingSubmission(before.id);
    if (sub) {
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
    }
    await recordRevisions(before.id, req.user.id, before, after, note);
    audit({
      user_id: req.user.id, action: 'reject', entity_type: 'plants', entity_id: before.id,
      old_values: { status: before.status }, new_values: { status: 'rejected', note },
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
    // submission too. Left pending it stays in the botanist queue, where
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

  api.post('/plants/:id/restore', need('plant.archive'), route(async (req, res) => {
    const before = await byId('plants', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const after = await update('plants', before.id, { status: 'approved', updated_at: nowIso() });
    await issueQr(before.id, req.user.id);
    await recordRevisions(before.id, req.user.id, before, after, 'Restored to public view');
    audit({ user_id: req.user.id, action: 'update', entity_type: 'plants', entity_id: before.id, old_values: { status: 'archived' }, new_values: { status: 'approved' } });
    const joined = (await plantsWhere('p.id = ?', [before.id]))[0];
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
    res.json({ revisions, audits });
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
        ORDER BY sub.submitted_at ASC`,
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
    const rows = await plantsWhere('p.id = ?', [req.params.plantId]);
    const plant = rows[0];
    if (!plant) return res.status(404).json({ error: 'Not found' });
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

    const row = await insert('users', {
      role_id: Number(b.role_id),
      full_name: b.full_name.trim(), email: b.email.trim().toLowerCase(),
      title: b.title || null, phone: b.phone || null,
      password_hash: hashPassword(DEMO_PASSWORD),
      must_change_password: 1, is_active: 1,
      email_verified_at: null, last_login_at: null,
      created_by: req.user.id, updated_at: nowIso(), deleted_at: null,
    });
    audit({ user_id: req.user.id, action: 'create', entity_type: 'users', entity_id: row.id, new_values: { email: row.email, role_id: row.role_id } });
    res.status(201).json({ user: shapeUser(row), temporary_password: DEMO_PASSWORD });
  }));

  api.patch('/users/:id', need('user.manage'), route(async (req, res) => {
    const before = await byId('users', req.params.id);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const patch = {};

    if ('role_id' in body) {
      if (!req.can('user.assign_role')) return res.status(403).json({ error: 'Not permitted to change roles.' });
      patch.role_id = Number(body.role_id);
    }
    ['full_name', 'title', 'phone'].forEach((k) => { if (k in body) patch[k] = body[k]; });
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
    // This used to flag the account and report a temporary password without
    // ever setting one - the old password went on working.
    await update('users', u.id, {
      password_hash: hashPassword(DEMO_PASSWORD),
      must_change_password: 1,
      updated_at: nowIso(),
    });
    await revokeAllFor(u.id);
    audit({ user_id: req.user.id, action: 'password_reset', entity_type: 'users', entity_id: u.id, new_values: { must_change_password: 1 } });
    activity({ user_id: req.user.id, action: 'password_changed', detail: 'Reset the password for ' + u.email });
    res.json({ ok: true, temporary_password: DEMO_PASSWORD });
  }));

  api.get('/activity', need('system.audit'), route(async (req, res) => {
    const rows = await q(
      `SELECT a.*, COALESCE(u.full_name, 'Unknown') AS user_name, u.email AS user_email
         FROM user_activity_logs a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT 300`,
    );
    res.json({ results: rows });
  }));

  api.get('/audit', need('system.audit'), route(async (req, res) => {
    const { entity_type = '', action = '' } = req.query;
    const where = [];
    const params = [];
    if (entity_type) { where.push('a.entity_type = ?'); params.push(entity_type); }
    if (action) { where.push('a.action = ?'); params.push(action); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows, total, types, actions] = await Promise.all([
      q(`SELECT a.*, COALESCE(u.full_name, 'System') AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
           ${clause} ORDER BY a.created_at DESC LIMIT 300`, params),
      count(`SELECT COUNT(*) FROM audit_logs a ${clause}`, params),
      q('SELECT DISTINCT entity_type FROM audit_logs'),
      q('SELECT DISTINCT action FROM audit_logs'),
    ]);
    res.json({
      total,
      entity_types: types.map((r) => r.entity_type),
      actions: actions.map((r) => r.action),
      results: rows,
    });
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
    const before = existing.setting_value;
    const row = await setSetting(req.params.key, req.body?.value, req.user.id);
    audit({
      user_id: req.user.id, action: 'update', entity_type: 'settings', entity_id: null,
      old_values: { [req.params.key]: before }, new_values: { [req.params.key]: row.setting_value },
    });
    res.json({ setting: row });
  }));

  /* ================================================================ */
  /* IoT - hardware not received yet                                  */
  /* ================================================================ */

  api.get('/sensors', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    res.json({
      status: 'coming_soon',
      message: 'Sensor hardware has not been received yet. The IoT dashboard is scheduled for a later sprint.',
      devices: [], readings: [], alerts: [],
      offline_minutes: getSetting('sensor_offline_minutes'),
    });
  });

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

    const visible = row.status === 'approved' || req.can('plant.view_all')
      || (req.user && row.registered_by === req.user.id);
    if (!visible) return res.status(404).json({ error: 'No such photograph' });

    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.type(row.mime_type || 'image/jpeg');
    res.send(row.bytes);
  }));

  api.get('/photos/:name', (req, res) => {
    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(renderPhoto(req.params.name));
  });

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
    console.error('API error on ' + req.method + ' ' + req.path + ':', err);
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  });

  return api;
}
