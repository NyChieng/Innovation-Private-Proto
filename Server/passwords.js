/**
 * Password hashing.
 *
 * plant_registry_schema.sql specifies users.password_hash as "bcrypt/argon2
 * output, never plaintext", and until now the API ignored it and compared the
 * typed password against a hard-coded string. This is that gap closed: every
 * account carries a real bcrypt hash with its own salt, and signing in is a
 * hash comparison like anywhere else.
 *
 * bcryptjs rather than bcrypt: the native build needs Visual Studio build
 * tools on Windows, which is a poor thing to require of a team mate cloning
 * the repo. It produces ordinary $2b$ hashes, so moving to native bcrypt
 * later is a dependency swap with no migration.
 *
 * Cost 10 is about 70 ms a hash on this machine - slow enough to be worth
 * attacking through, fast enough that a demo login feels instant.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const COST = 10;

/**
 * A new random temporary password, issued when an administrator creates or
 * resets an account and shown to them once. The account must change it at the
 * next sign in. Seeded accounts have their own passwords (see seed.js).
 */
export function temporaryPassword() {
  // Three groups of four from an alphabet without look-alikes (no 0/o, 1/l/i),
  // so it can be read out or copied by hand: about 59 bits, different every time.
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  let pw;
  do pw = [group(), group(), group()].join('-');
  while (!/[a-z]/.test(pw) || !/\d/.test(pw)); // meets the password rules itself
  return pw;
}

export const hashPassword = (plain) => bcrypt.hashSync(String(plain), COST);

/**
 * Async so a sign-in does not block the event loop for everybody else.
 * Returns false rather than throwing on a malformed or missing hash: a
 * corrupt record should refuse the login, not crash the request.
 */
export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(String(plain), String(hash));
  } catch {
    return false;
  }
}
