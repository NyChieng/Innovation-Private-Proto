/**
 * Snapshot persistence, so a restart does not wipe the demo.
 *
 * The store in Server/db.js is plain arrays that the API mutates in place -
 * 75 call sites of `db.plants.filter(...)` and `plant.status = 'approved'`.
 * Rewriting every one of those as async SQL is the proper port and is under
 * way; until it lands, the whole store is written to a single JSON row after
 * each change and read back at boot. The data survives a restart and a
 * redeploy, but MySQL holds one document rather than the relational schema in
 * plant_registry_schema.sql.
 *
 * Set DATABASE_URL to switch it on:
 *   mysql://user:password@host:3306/defaultdb
 * Without it the prototype behaves exactly as it always has - in memory, reset
 * on every restart - so none of this is in the way of a plain local demo.
 */

import zlib from 'node:zlib';

import { db, loadSnapshot } from './db.js';
// One copy of the connection logic, shared with the SQL layer.
import { databaseUrl, tlsFor } from './sql.js';

const TABLE = 'proto_state';
const ROW_ID = 'florascan';

/** Wait this long after the last change before writing. */
const QUIET_MS = 2000;
/** ...but never hold a change longer than this, however busy the server is. */
const MAX_WAIT_MS = 10000;

let pool = null;
let dirty = false;
let quietTimer = null;
let maxTimer = null;
let writing = null;
let failures = 0;

export const persistenceEnabled = () => Boolean(pool);

export async function initPersistence() {
  // The test suites register and archive real records to exercise the
  // workflow. Pointed at the live database they would leave that litter there
  // for good, so a test run uses "npm run dev:memory" and keeps out of it.
  if (process.argv.includes('--no-db')) return null;

  const url = databaseUrl();
  if (!url) return null;

  const mysql = (await import('mysql2/promise')).default;
  pool = mysql.createPool({
    uri: url,
    ssl: await tlsFor(url),
    connectionLimit: 4,
    connectTimeout: 15000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id          VARCHAR(64) NOT NULL,
      data        LONGBLOB    NOT NULL,
      updated_at  DATETIME    NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // An earlier version of this file made the column LONGTEXT, which cannot
  // hold gzip output. Harmless to repeat once it is already a blob.
  await pool.query(`ALTER TABLE ${TABLE} MODIFY data LONGBLOB NOT NULL`).catch(() => {});

  const [rows] = await pool.query(`SELECT data, updated_at FROM ${TABLE} WHERE id = ?`, [ROW_ID]);
  if (!rows.length) {
    // First run against an empty database: keep the seeded demo data and
    // write it down, so the next boot has something to come back to.
    await save();
    return 'Connected. No snapshot yet, so the seeded data was saved as the first one.';
  }

  const counts = loadSnapshot(decode(rows[0].data));
  const when = new Date(rows[0].updated_at).toISOString();
  return `Restored ${counts.plants} plants and ${counts.species} species saved ${when}.`;
}

/** Note that something changed. The write itself is debounced. */
export function markDirty() {
  if (!pool) return;
  dirty = true;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(flush, QUIET_MS);
  // A steady stream of requests would otherwise keep pushing the quiet timer
  // back and nothing would ever be written.
  if (!maxTimer) maxTimer = setTimeout(flush, MAX_WAIT_MS);
}

/** Write now, and wait for it. Safe to call when there is nothing to do. */
export async function flush() {
  clearTimeout(quietTimer);
  clearTimeout(maxTimer);
  quietTimer = null;
  maxTimer = null;
  if (!pool || !dirty) return;
  // A write already in flight may have started before the latest change, so
  // let it finish and then write again rather than racing it.
  if (writing) { await writing.catch(() => {}); }
  dirty = false;
  writing = save().catch((err) => {
    dirty = true;
    failures += 1;
    // A prototype that cannot reach its database should still run the demo,
    // so this is reported and shrugged off rather than thrown.
    if (failures <= 3) console.error(`  Could not save state: ${err.message}`);
    if (failures === 3) console.error('  Further save failures will be quiet.');
  });
  await writing;
  writing = null;
}

async function save() {
  const data = {};
  for (const [table, rows] of Object.entries(db)) {
    if (Array.isArray(rows)) data[table] = rows;
  }
  // The whole store crosses the wire in one statement, so it has to fit inside
  // the server's max_allowed_packet - 1 MB by default, against a snapshot of
  // about 1.7 MB. Gzip takes it to roughly 0.3 MB, which fits any default and
  // costs a fifth of the bandwidth on every save. When the register grows far
  // enough that even this does not fit, the answer is the relational port, not
  // a bigger packet.
  await pool.query(
    `INSERT INTO ${TABLE} (id, data, updated_at) VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = UTC_TIMESTAMP()`,
    [ROW_ID, zlib.gzipSync(JSON.stringify(data), { level: 6 })],
  );
  failures = 0;
}

/** Snapshots are gzipped; older rows may be plain JSON, so detect which. */
function decode(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const gzipped = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
  return JSON.parse(gzipped ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
}

/** Flush and disconnect, so a redeploy does not drop the last few changes. */
export async function closePersistence() {
  if (!pool) return;
  await flush().catch(() => {});
  await pool.end().catch(() => {});
  pool = null;
}

/**
 * Express middleware: anything that answered successfully may have changed
 * the store. GETs are included because a few of them do write - a scan bumps
 * view_count and records a qr_scans row - and the debounce makes the extra
 * marking free.
 */
export function persistenceMiddleware(req, res, next) {
  if (!pool) return next();
  res.on('finish', () => { if (res.statusCode < 400) markDirty(); });
  next();
}
