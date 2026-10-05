/**
 * Load the seeded demo data into MySQL.
 *
 *   node scripts/seed-mysql.mjs            # fill empty tables, refuse otherwise
 *   node scripts/seed-mysql.mjs --reset    # empty every table first
 *
 * The in-memory store in Server/db.js is the shape the API has always used, and
 * Server/schema.sql is its relational form. Rather than hand-write an INSERT per
 * table and let the two drift, this reads the live column list out of
 * information_schema and copies across whatever matches by name - so a column
 * added to the schema but not the seed, or the other way round, shows up as a
 * reported difference instead of a silent omission.
 *
 * Connection comes from MYSQL_URL, e.g.
 *   mysql://root@127.0.0.1:3306/florascan
 */

import process from 'node:process';
import mysql from 'mysql2/promise';
import { URL as URL_PARSE } from 'node:url';
import { seed } from '../Server/seed.js';
import { store as db } from '../Server/seed-store.js';

// The connection lives in .env, the same file the server reads. Without this
// the DB_* variables are simply absent and the fallback quietly targets
// localhost - which looks like a successful run against the wrong database.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

function connectionUri() {
  if (process.env.MYSQL_URL) return process.env.MYSQL_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER) return 'mysql://root@127.0.0.1:3306/plant_registry';
  const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}`;
  return `mysql://${auth}@${DB_HOST}:${DB_PORT || 3306}/${DB_NAME || 'defaultdb'}`;
}
const URL = connectionUri();
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
// Aiven and every managed MySQL require TLS; a local server usually has no
// certificate at all and refuses the handshake.
const SSL = process.env.MYSQL_SSL_CA
  ? { ca: (await import('node:fs')).default.readFileSync(process.env.MYSQL_SSL_CA), rejectUnauthorized: true }
  : (LOCAL.test(new URL_PARSE(URL).hostname) ? undefined : { rejectUnauthorized: false });
const RESET = process.argv.includes('--reset');

/** Parents before children, so the foreign keys hold at every step. */
const ORDER = [
  'roles', 'permissions', 'role_permissions', 'users', 'password_resets',
  'refresh_tokens', 'user_activity_logs', 'conservation_statuses', 'species',
  // plant_photo_data holds uploaded image bytes and is never seeded, but it
  // has to be listed so a reset empties it. Truncating plant_photos with the
  // foreign key checks off does not cascade, so its rows would survive as
  // orphans and then collide with the reset auto-increment.
  'plants', 'plant_photos', 'plant_photo_data', 'plant_submissions', 'plant_revisions',
  'plant_reports', 'qr_codes', 'qr_scans', 'notifications', 'audit_logs',
  'settings', 'sensor_devices', 'sensor_readings', 'sensor_alerts',
];

/** ISO-8601 in, MySQL DATETIME out. Anything unparseable becomes NULL. */
function toDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function coerce(value, type) {
  if (value === undefined) return null;
  if (type === 'datetime' || type === 'timestamp' || type === 'date') return toDateTime(value);
  if (type === 'json') return value === null ? null : JSON.stringify(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const conn = await mysql.createConnection({ uri: URL, ssl: SSL, multipleStatements: false });
const dbName = conn.config.database;

seed();

// What the database actually has, rather than what this script assumes.
const [cols] = await conn.query(
  `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?`,
  [dbName],
);
const schema = new Map();
for (const c of cols) {
  if (!schema.has(c.TABLE_NAME)) schema.set(c.TABLE_NAME, new Map());
  schema.get(c.TABLE_NAME).set(c.COLUMN_NAME, c.DATA_TYPE);
}
if (!schema.size) {
  console.error(`No tables in "${dbName}". Apply Server/schema.sql first.`);
  process.exit(1);
}

if (RESET) {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...ORDER].reverse()) if (schema.has(t)) await conn.query(`TRUNCATE TABLE \`${t}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('Emptied every table.\n');
} else {
  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM plants');
  if (n > 0) {
    console.error(`plants already holds ${n} rows. Re-run with --reset to replace them.`);
    await conn.end();
    process.exit(1);
  }
}

// users.created_by points at users, and audit rows can mention a row written
// later in the same pass, so the constraints are checked at the end instead of
// row by row.
await conn.query('SET FOREIGN_KEY_CHECKS = 0');

let total = 0;
const notes = [];

for (const table of ORDER) {
  const columns = schema.get(table);
  const rows = db[table];
  if (!columns) { notes.push(`${table}: in the seed but not in the database`); continue; }
  if (!Array.isArray(rows) || rows.length === 0) { console.log(`${table.padEnd(24)} 0`); continue; }

  const present = [...columns.keys()].filter((c) => rows.some((r) => r[c] !== undefined));
  const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !columns.has(k));
  if (unknown.length) notes.push(`${table}: the seed writes ${unknown.join(', ')}, which the schema has no column for`);

  const sql = `INSERT INTO \`${table}\` (${present.map((c) => `\`${c}\``).join(', ')}) VALUES ?`;
  const values = rows.map((r) => present.map((c) => coerce(r[c], columns.get(c))));

  // One multi-row INSERT per 500 rows: qr_scans alone is several thousand.
  for (let i = 0; i < values.length; i += 500) {
    await conn.query(sql, [values.slice(i, i + 500)]);
  }
  total += rows.length;
  console.log(`${table.padEnd(24)} ${rows.length}`);
}

await conn.query('SET FOREIGN_KEY_CHECKS = 1');

// Prove the foreign keys actually hold, rather than trusting that they do.
const [[check]] = await conn.query(`
  SELECT
    (SELECT COUNT(*) FROM plants p LEFT JOIN users u ON u.id = p.registered_by WHERE u.id IS NULL) AS orphan_plants,
    (SELECT COUNT(*) FROM plant_photos ph LEFT JOIN plants p ON p.id = ph.plant_id WHERE p.id IS NULL) AS orphan_photos,
    (SELECT COUNT(*) FROM qr_scans s LEFT JOIN qr_codes q ON q.id = s.qr_code_id WHERE q.id IS NULL) AS orphan_scans
`);

console.log(`\n${total} rows loaded into ${dbName}.`);
console.log('orphaned rows:', Object.entries(check).map(([k, v]) => `${k}=${v}`).join('  '));
if (notes.length) {
  console.log('\nDifferences between the seed and the schema:');
  notes.forEach((n) => console.log('  - ' + n));
}

await conn.end();
