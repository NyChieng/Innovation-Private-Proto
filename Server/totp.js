import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Two-step verification with an authenticator app - section 12 of
 * Server/schema-extensions.sql.
 *
 * TOTP (RFC 6238), the scheme Google Authenticator, Microsoft Authenticator,
 * Authy and the rest all speak: the server and the phone share a random
 * secret once, through a QR code, and each works out the same six-digit code
 * from it and the current 30-second window. Nothing is sent at sign-in, so
 * it costs nothing to run and the phone needs no signal.
 *
 * The secret is kept encrypted (AES-256-GCM) with a key that lives in .certs/
 * beside the TLS key, not in the database - a copied database alone cannot
 * make codes.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
// One window either side, so a phone clock a little off still works.
const DRIFT = 1;

/* ---------------- base32, the alphabet authenticator apps expect ---------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------------- codes ---------------- */

/** 160 random bits, the size RFC 4226 recommends. */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

const currentStep = () => Math.floor(Date.now() / 1000 / STEP_SECONDS);

/**
 * The time step a typed code belongs to, or null. A step at or before
 * `lastStep` is refused, so a code seen over someone's shoulder cannot be
 * used a second time.
 */
export function verifyCode(secret, typed, lastStep = null) {
  const code = String(typed || '').replace(/\D/g, '');
  if (code.length !== DIGITS) return null;
  const now = currentStep();
  for (let step = now - DRIFT; step <= now + DRIFT; step += 1) {
    if (lastStep !== null && step <= Number(lastStep)) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

/** What the QR code holds: the app reads the account name, issuer and secret from it. */
export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** The secret in groups of four, for typing into an app by hand. */
export const groupSecret = (secret) => secret.match(/.{1,4}/g).join(' ');

/* ---------------- encryption at rest ---------------- */

const KEY_FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.certs', 'totp.key');
let key = null;

function getKey() {
  if (key) return key;
  if (process.env.TOTP_KEY) {
    key = crypto.createHash('sha256').update(process.env.TOTP_KEY).digest();
    return key;
  }
  if (fs.existsSync(KEY_FILE)) {
    key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } else {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

/** iv.tag.ciphertext, each base64url - fits a VARCHAR(255). */
export function sealSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** Null when the value cannot be opened - a lost key file means setting it up again. */
export function openSecret(sealed) {
  try {
    const [iv, tag, body] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Exposed for the test suite, which plays the part of the phone. The offset
// picks a neighbouring 30-second window, inside the allowed drift, so a test
// can use several codes without waiting for the clock.
export const _codeAt = (secret, offset = 0) => codeAt(secret, currentStep() + offset);
