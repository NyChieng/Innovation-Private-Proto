/**
 * Prepare the database for a test run.
 *
 * The suites register plants, approve them, reject them and archive them. That
 * was harmless while the store was rebuilt in memory on every restart, but the
 * register is in MySQL now and the changes stay. Two consequences:
 *
 *   - a run has to start from the seeded dataset, or the second run finds the
 *     pending submissions the first one approved and fails on state, not on
 *     behaviour
 *   - it must never be pointed at the shared database, where that litter would
 *     be somebody else's problem
 *
 * So this reseeds, and refuses outright to touch a database that is not on this
 * machine. Set ALLOW_REMOTE_TESTS=1 to override, and be sure you mean it.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function target() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (url) {
    const u = new URL(url);
    return { host: u.hostname, name: u.pathname.slice(1) };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    name: process.env.DB_NAME || 'plant_registry',
  };
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
const { host, name } = target();

if (!LOCAL.test(host) && process.env.ALLOW_REMOTE_TESTS !== '1') {
  console.error(`\n  Refusing to run the tests against ${name} on ${host}.`);
  console.error('');
  console.error('  These suites create, approve, reject and archive real records. Against a');
  console.error('  shared database they leave that behind for everyone else, and a second run');
  console.error('  fails because the first one consumed the submissions it expected.');
  console.error('');
  console.error('  Point .env at a local MySQL and start the server against it:');
  console.error('      DATABASE_URL=mysql://root@127.0.0.1:3306/plant_registry');
  console.error('');
  console.error('  Set ALLOW_REMOTE_TESTS=1 only if you genuinely mean to.\n');
  process.exit(1);
}

console.log(`Reseeding ${name} on ${host} for a clean test run...`);
const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'seed-mysql.mjs'), '--reset'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});
if (res.status !== 0) {
  console.error('Reseeding failed - the suites would report state errors, so stopping here.');
  process.exit(1);
}
const loaded = (res.stdout || '').split('\n').find((l) => /rows loaded into/.test(l));
console.log(loaded ? loaded.trim() : 'Reseeded.');
console.log('Restart the server if it is running, so it reads the fresh data.\n');
