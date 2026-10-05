/**
 * MySQL access layer.
 *
 * Everything the API stores lives in the plant_registry schema; this module is
 * the only place that talks to it. Queries are parameterised throughout - no
 * value is ever concatenated into SQL.
 *
 * Three conversions happen here so the rest of the code never thinks about
 * them:
 *
 *   Dates      the connection runs in UTC and DATETIME columns come back as
 *              ISO-8601 strings, which is what the API has always passed
 *              around and what the client parses.
 *   Decimals   mysql2 returns DECIMAL as a string to protect precision. A
 *              latitude of "4.1234567" would then be sent to the browser
 *              quoted and sort as text, so they come back as numbers.
 *   Booleans   TINYINT(1) stays 0/1, matching the shape the client expects.
 */

import mysql from 'mysql2/promise';

let pool = null;

export const isConnected = () => Boolean(pool);

/** Build a connection URI from either shape of configuration. */
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER) return null;
  const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}`;
  return `mysql://${auth}@${DB_HOST}:${DB_PORT || 3306}/${DB_NAME || 'defaultdb'}`;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

let warnedUnverified = false;

/**
 * Whether to speak TLS to this database, and how.
 *
 * Aiven signs its servers with its own private certificate authority, not one
 * in Node's trust store - verified without their CA the handshake fails, which
 * is checked, not assumed. So ca.pem from the service page is what makes the
 * connection genuinely verified rather than merely encrypted; without it
 * nothing proves the server answering is the one we meant to reach.
 *
 * Looked for in this order: MYSQL_SSL_CA_CERT (the certificate inline, for a
 * host where a long environment variable beats adding a file), MYSQL_SSL_CA
 * (a path to it), then ca.pem beside package.json - where Aiven's own
 * instructions tell you to put it.
 *
 * A local MySQL is the exception. XAMPP has no certificate at all and refuses
 * the handshake outright ("Server does not support secure connection"), so
 * TLS there breaks development for the sake of a hop that never leaves the
 * machine. MYSQL_SSL=off forces it off for any other awkward case.
 */

export async function tlsFor(url) {
  if (String(process.env.MYSQL_SSL || '').toLowerCase() === 'off') return undefined;

  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // A local MySQL first, before looking for any certificate. XAMPP is built
  // without TLS and refuses the handshake outright, so finding a ca.pem in the
  // project root - put there for Aiven - must not drag it into a connection
  // that never leaves the machine.
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through */ }
  if (LOCAL_HOST.test(host)) return undefined;

  // Inline, for a host where a long environment variable is easier than a file.
  if (process.env.MYSQL_SSL_CA_CERT) {
    return { ca: process.env.MYSQL_SSL_CA_CERT, rejectUnauthorized: true };
  }
  if (process.env.MYSQL_SSL_CA) {
    return { ca: fs.readFileSync(process.env.MYSQL_SSL_CA), rejectUnauthorized: true };
  }
  // ca.pem beside package.json, which is where Aiven's instructions put it,
  // and /etc/secrets/ca.pem, which is where Render mounts a Secret File. The
  // certificate is public, so either is fine - a Secret File just keeps it out
  // of the repository.
  const root = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));
  for (const candidate of [nodePath.join(root, 'ca.pem'), '/etc/secrets/ca.pem']) {
    if (fs.existsSync(candidate)) {
      return { ca: fs.readFileSync(candidate), rejectUnauthorized: true };
    }
  }

  // Remote with no certificate authority to check against. The connection is
  // still encrypted, but nothing proves the server on the other end is the one
  // we meant to reach - so say so rather than let it pass quietly.
  if (!warnedUnverified) {
    warnedUnverified = true;
    console.warn(`\n  Connecting to ${host} without verifying its certificate.`);
    console.warn('  Put ca.pem from the Aiven service page in the project root, or set');
    console.warn('  MYSQL_SSL_CA_CERT, to make this a verified connection.\n');
  }
  return { rejectUnauthorized: false };
}

export async function connect(url = databaseUrl()) {
  if (!url) return null;
  pool = mysql.createPool({
    uri: url,
    ssl: await tlsFor(url),
    connectionLimit: 8,
    connectTimeout: 15000,
    // The schema keeps every DATETIME in UTC; saying so here stops mysql2
    // reading them as local time and shifting everything by eight hours.
    timezone: 'Z',
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  });
  await pool.query('SELECT 1');
  return pool;
}

export async function close() {
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}

/* ------------------------------------------------------------------ */
/* Row conversion                                                      */
/* ------------------------------------------------------------------ */

/** DATETIME out of MySQL, ISO-8601 into the rest of the application. */
function fromDb(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/** ISO-8601 in, MySQL DATETIME out. Objects and arrays become JSON. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
export function toDb(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof value === 'string' && ISO.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  // A Buffer is an object, and stringifying one turns an uploaded photograph
  // into {"type":"Buffer","data":[...]} - which stores and reads back without
  // complaint, and is not an image. Binary goes to the driver untouched.
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** Every row the statement returns. */
export async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params.map(toDb));
  return Array.isArray(rows) ? rows.map(fromDb) : rows;
}

/** The first row, or null. */
export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

/** A single scalar from the first row, or null. */
export async function scalar(sql, params = []) {
  const row = await one(sql, params);
  return row ? Object.values(row)[0] : null;
}

/** Row count, for pagination and dashboard badges. */
export async function count(sql, params = []) {
  return Number(await scalar(sql, params)) || 0;
}

/**
 * Insert and return the stored row, so the caller sees the id the database
 * assigned and any column default it filled in.
 */
export async function insert(table, row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${placeholders})`;
  const [res] = await pool.execute(sql, keys.map((k) => toDb(row[k])));
  // settings has no auto-increment id; it is keyed by setting_key.
  if (!res.insertId) return { ...row };
  return await byId(table, res.insertId);
}

/** Update by primary key. Returns the stored row. */
export async function update(table, id, patch, key = 'id') {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return await byId(table, id, key);
  const sql = `UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE \`${key}\` = ?`;
  await pool.execute(sql, [...keys.map((k) => toDb(patch[k])), id]);
  return await byId(table, id, key);
}

export async function byId(table, id, key = 'id') {
  if (id === null || id === undefined) return null;
  return await one(`SELECT * FROM \`${table}\` WHERE \`${key}\` = ? LIMIT 1`, [id]);
}

export async function remove(table, id, key = 'id') {
  await pool.execute(`DELETE FROM \`${table}\` WHERE \`${key}\` = ?`, [id]);
}

/**
 * Run several statements as one unit. Used where a half-finished change would
 * be worse than no change - publishing a plant writes the plant, its QR code,
 * its submission and a notification, and a tag issued for a record that did
 * not publish would be a tag pointing at nothing.
 */
export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const scoped = {
      q: async (sql, params = []) => {
        const [rows] = await conn.execute(sql, params.map(toDb));
        return Array.isArray(rows) ? rows.map(fromDb) : rows;
      },
      one: async (sql, params = []) => (await scoped.q(sql, params))[0] ?? null,
      insert: async (table, row) => {
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
        const [res] = await conn.execute(sql, keys.map((k) => toDb(row[k])));
        if (!res.insertId) return { ...row };
        return await scoped.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [res.insertId]);
      },
    };
    const result = await fn(scoped);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Apply the schema to an empty database, for a fresh checkout or a test run. */
export async function applySchema(sqlText) {
  const conn = await mysql.createConnection({
    uri: databaseUrl(),
    ssl: await tlsFor(databaseUrl()),
    multipleStatements: true,
  });
  try {
    await conn.query(sqlText);
  } finally {
    await conn.end();
  }
}
