/**
 * Snapshot persistence, so a restart does not wipe the demo.
 *
 * The store in db.js is plain arrays that the API mutates in place - 75 call
 * sites of `db.plants.filter(...)` and `plant.status = 'approved'`. Rewriting
 * every one of those as async SQL is a day's work; writing the whole store to
 * a single JSONB row after each change is about a hundred lines and leaves the
 * API untouched. That is the trade made here: the data survives a restart and
 * a redeploy, but Postgres holds one document rather than a relational schema.
 *
 * Set DATABASE_URL to switch it on. Without it the prototype behaves exactly
 * as it always has - in memory, reset on every restart - so none of this is in
 * the way of a plain local demo.
 */

import { db, loadSnapshot } from './db.js';

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

/**
 * Connect, make sure the table exists, and restore any saved snapshot.
 * Returns a short line about what happened, for the startup banner, or null
 * when persistence is switched off.
 */
export async function initPersistence() {
  // The test suites register and archive real records to exercise the
  // workflow. Pointed at the live database they would leave that litter there
  // for good, so a test run uses "npm run dev:memory" and keeps out of it.
  if (process.argv.includes('--no-db')) return null;

  const url = process.env.DATABASE_URL;
  if (!url) return null;

  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    connectionString: url,
    // Supabase terminates TLS at the pooler with its own chain; this is the
    // connection every Supabase client example uses.
    ssl: { rejectUnauthorized: false },
    max: 4,
    connectionTimeoutMillis: 10000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id          text PRIMARY KEY,
      data        jsonb NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Every save rewrites the one row, and Postgres keeps the previous version
  // until autovacuum collects it. The default threshold is a share of the row
  // count, which on a single-row table never trips, so the dead versions pile
  // up - half a megabyte each. Collect on a flat count instead.
  await pool.query(`
    ALTER TABLE ${TABLE} SET (
      autovacuum_vacuum_scale_factor = 0,
      autovacuum_vacuum_threshold = 20,
      autovacuum_analyze_scale_factor = 0,
      autovacuum_analyze_threshold = 50
    )
  `);

  const { rows } = await pool.query(`SELECT data, updated_at FROM ${TABLE} WHERE id = $1`, [ROW_ID]);
  if (!rows.length) {
    // First run against an empty database: keep the seeded demo data and
    // write it down, so the next boot has something to come back to.
    await save();
    return 'Connected. No snapshot yet, so the seeded data was saved as the first one.';
  }

  const counts = loadSnapshot(rows[0].data);
  return `Restored ${counts.plants} plants and ${counts.species} species saved ${rows[0].updated_at.toISOString()}.`;
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
  await pool.query(
    `INSERT INTO ${TABLE} (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [ROW_ID, JSON.stringify(data)],
  );
  failures = 0;
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
