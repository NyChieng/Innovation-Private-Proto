/**
 * Create the schema and fill it with the demo dataset.
 *
 *   npm run db:setup            # schema + extensions, then seed if empty
 *   npm run db:setup -- --reset # empty every table first, then seed
 *
 * Reads the connection from .env, the same one the server uses, so this works
 * against a local MySQL or a hosted one without changing anything but .env.
 *
 * plant_registry_schema.sql is the submitted design and begins by dropping and
 * recreating its own database, which is wrong for a managed service where the
 * database already exists and is named for you. So the statements are replayed
 * here with those three lines skipped, into whichever database the connection
 * already points at.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const RESET = process.argv.includes('--reset');

function connectionUri() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_HOST || !DB_USER) return null;
  const auth = `${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}`;
  return `mysql://${auth}@${DB_HOST}:${DB_PORT || 3306}/${DB_NAME || 'plant_registry'}`;
}

const uri = connectionUri();
if (!uri) {
  console.error('No database configured. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
const host = new URL(uri).hostname;
const ssl = process.env.MYSQL_SSL_CA
  ? { ca: fs.readFileSync(process.env.MYSQL_SSL_CA), rejectUnauthorized: true }
  : (LOCAL.test(host) ? undefined : { rejectUnauthorized: false });

const schemaFile = path.join(root, 'plant_registry_schema.sql');
const extensionsFile = path.join(root, 'Server', 'schema-extensions.sql');

if (!fs.existsSync(schemaFile)) {
  console.error(`Missing ${path.relative(root, schemaFile)}.`);
  console.error('That file is the submitted schema and belongs in the repository root.');
  process.exit(1);
}

/**
 * Split on semicolons that end a statement, ignoring the ones inside strings
 * and comments. The schema has semicolons in comment text and in default
 * values, so a plain split would cut statements in half.
 */
function statements(text) {
  const out = [];
  let buf = '';
  let quote = null;
  let lineComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) { if (ch === '\n') { lineComment = false; buf += ch; } continue; }
    if (!quote && ch === '-' && next === '-') { lineComment = true; continue; }
    if (!quote && (ch === '"' || ch === "'" || ch === '`')) quote = ch;
    else if (quote && ch === quote && text[i - 1] !== '\\') quote = null;
    if (ch === ';' && !quote) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const dbName = new URL(uri).pathname.replace(/^\//, '') || 'plant_registry';

/**
 * Create the database if it is not there yet.
 *
 * A hosted service usually hands you one already made -
 * but a teammate running XAMPP has an empty server, and connecting straight to
 * a database that does not exist fails with "Unknown database" before any of
 * the schema is read. The schema file does create it, but with a DROP in front
 * that would be wrong to run against a server that already holds data, so
 * those statements are skipped and this does the job instead.
 */
{
  const serverUri = uri.replace(/\/[^/]*$/, '/');
  const admin = await mysql.createConnection({ uri: serverUri, ssl }).catch(() => null);
  if (admin) {
    try {
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } catch (err) {
      // A managed provider usually forbids this and has made the database
      // already, so a refusal here is not a problem; a missing database is
      // reported clearly by the connection below.
      if (!/denied|not allowed/i.test(err.message)) throw err;
    }
    await admin.end();
  }
}

const conn = await mysql.createConnection({ uri, ssl, multipleStatements: false })
  .catch((err) => {
    if (err.code === 'ER_BAD_DB_ERROR') {
      console.error(`\n  The database "${dbName}" does not exist and could not be created.`);
      console.error('  Check that MySQL is running and that the user in .env may create databases.\n');
      process.exit(1);
    }
    throw err;
  });
console.log(`Target: ${dbName} on ${host}\n`);

if (RESET) {
  const [tables] = await conn.query(
    'SELECT TABLE_NAME n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE"',
    [dbName],
  );
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await conn.query(`DROP TABLE IF EXISTS \`${t.n}\``);
  const [views] = await conn.query(
    'SELECT TABLE_NAME n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?', [dbName],
  );
  for (const v of views) await conn.query(`DROP VIEW IF EXISTS \`${v.n}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log(`Dropped ${tables.length} table(s) and ${views.length} view(s).`);
}

// The managed database already exists and is named by the provider, so the
// DROP / CREATE / USE at the top of the schema file is skipped.
const skip = /^\s*(DROP\s+DATABASE|CREATE\s+DATABASE|USE)\b/i;

async function run(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  let applied = 0;
  let skipped = 0;
  for (const stmt of statements(text)) {
    if (skip.test(stmt)) { skipped += 1; continue; }
    try {
      await conn.query(stmt);
      applied += 1;
    } catch (err) {
      // Re-running setup over an existing database is normal and should not
      // be an error; anything else is. So a table, row, column, key or check
      // that is already there is skipped (MySQL 8 reports a repeated check
      // name before a repeated column), and so is a DROP of a column or
      // constraint that is already gone (section 7 of the extensions).
      if ([
        'ER_TABLE_EXISTS_ERROR', 'ER_DUP_ENTRY', 'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME',
        'ER_CHECK_CONSTRAINT_DUP_NAME',
        'ER_CANT_DROP_FIELD_OR_KEY', 'ER_CONSTRAINT_NOT_FOUND', 'ER_CHECK_CONSTRAINT_NOT_FOUND',
      ].includes(err.code)) {
        skipped += 1;
        continue;
      }
      console.error(`\n${label}: ${err.code || ''} ${err.message}`);
      console.error(stmt.slice(0, 160).replace(/\s+/g, ' ') + '...');
      process.exit(1);
    }
  }
  console.log(`${label}: ${applied} statement(s) applied, ${skipped} skipped.`);
}

await run(schemaFile, 'Schema');
if (fs.existsSync(extensionsFile)) await run(extensionsFile, 'Extensions');

const [[{ n: plants }]] = await conn.query('SELECT COUNT(*) n FROM plants');
await conn.end();

// The schema file seeds its own roles, permissions, statuses and settings, and
// the demo dataset contains all of those too - so loading one on top of the
// other collides on the primary key. The seeder empties what it is about to
// fill, which makes this one command rather than two that conflict.
if (plants > 0 && !RESET) {
  console.log(`\nSchema ready. ${plants} plants already present, so the data was left alone.`);
  console.log('Re-run with --reset to rebuild it from the demo dataset.');
  process.exit(0);
}

console.log('\nLoading the demo dataset...\n');
const seeded = spawnSync(process.execPath, [path.join(root, 'scripts', 'seed-mysql.mjs'), '--reset'], {
  cwd: root, stdio: 'inherit',
});
if (seeded.status !== 0) {
  console.error('\nThe schema is in place but the demo data did not load.');
  process.exit(1);
}
console.log('\nReady. Start the server with "npm run dev".');
