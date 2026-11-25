/**
 * Make a super admin from the server itself.
 *
 *   npm run superadmin -- someone@example.com             promote an existing account
 *   npm run superadmin -- someone@example.com "Full Name"  or create one if there is none
 *
 * Inside the app only a super admin can give the super admin role, so a
 * breached administrator account cannot make itself one. That leaves this
 * command as the way to create the first super admin, or a new one when
 * every super admin account is lost: it needs access to the server and its
 * database, which an intruder who only has an administrator's password does
 * not have.
 *
 * A new account gets a temporary password, shown once, that must be changed
 * at the first sign in. The change is written to the audit trail.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as sql from '../Server/sql.js';
import { hashPassword, temporaryPassword } from '../Server/passwords.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const [emailArg, ...nameParts] = process.argv.slice(2);
const email = String(emailArg || '').trim().toLowerCase();
const fullName = nameParts.join(' ').trim();

function fail(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  fail('Usage: npm run superadmin -- <email> ["Full Name"]');
}

if (!await sql.connect().catch((err) => fail('Could not reach the database: ' + err.message))) {
  fail('No database configured. Set DATABASE_URL (or DB_HOST and DB_USER) in .env.');
}

try {
  const role = await sql.one("SELECT id FROM roles WHERE name = 'superadmin'");
  if (!role) fail('The super admin role is not in this database yet. Run "npm run db:setup" first.');

  const now = new Date().toISOString();
  const user = await sql.one('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);

  if (user) {
    if (user.role_id === role.id && user.is_active) {
      console.log(`\n  ${user.full_name} <${email}> is already a super admin.\n`);
    } else {
      await sql.update('users', user.id, { role_id: role.id, is_active: 1, deleted_at: null, updated_at: now });
      await sql.insert('audit_logs', {
        user_id: null, action: 'role_change', entity_type: 'users', entity_id: user.id,
        old_values: JSON.stringify({ role_id: user.role_id, is_active: user.is_active, full_name: user.full_name }),
        new_values: JSON.stringify({ role_id: role.id, is_active: 1, full_name: user.full_name, via: 'npm run superadmin' }),
        ip_address: null, user_agent: null,
      });
      console.log(`\n  ${user.full_name} <${email}> is now a super admin.`);
      console.log('  If they are signed in, they see the change on their next page load.\n');
    }
  } else {
    if (!fullName) fail(`No account uses ${email}. To create one, add the name: npm run superadmin -- ${email} "Full Name"`);
    const temporary = temporaryPassword();
    const row = await sql.insert('users', {
      role_id: role.id, full_name: fullName, email, title: 'Super Administrator', phone: null,
      password_hash: hashPassword(temporary), must_change_password: 1, is_active: 1,
      email_verified_at: null, last_login_at: null, created_by: null, updated_at: now, deleted_at: null,
    });
    await sql.insert('audit_logs', {
      user_id: null, action: 'create', entity_type: 'users', entity_id: row.id,
      old_values: null,
      new_values: JSON.stringify({ email, role_id: role.id, via: 'npm run superadmin' }),
      ip_address: null, user_agent: null,
    });
    console.log(`\n  Created super admin ${fullName} <${email}>.`);
    console.log(`  Temporary password: ${temporary}`);
    console.log('  It is shown only now, and must be changed at the first sign in.\n');
  }
} finally {
  await sql.close();
}
