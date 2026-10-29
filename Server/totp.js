import crypto from 'node:crypto';

const PERIOD = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KEY = crypto.createHash('sha256')
  .update(process.env.TOTP_ENCRYPTION_KEY || 'florascan-development-totp-key')
  .digest();

function base32Decode(value) {
  const clean = String(value).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function generateSecret() {
  let value = '';
  const bytes = crypto.randomBytes(20);
  let buffer = 0;
  let available = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    available += 8;
    while (available >= 5) {
      available -= 5;
      value += ALPHABET[(buffer >> available) & 31];
    }
  }
  if (available) value += ALPHABET[(buffer << (5 - available)) & 31];
  return value;
}

export function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decryptSecret(value) {
  try {
    const packed = Buffer.from(value, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function codeFor(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(value).padStart(DIGITS, '0');
}

export function verifyCode(secret, input, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(input || ''))) return false;
  const counter = Math.floor(now / 1000 / PERIOD);
  const supplied = Buffer.from(String(input));
  return [-1, 0, 1].filter((skew) => counter + skew >= 0).some((skew) => {
    const expected = Buffer.from(codeFor(secret, counter + skew));
    return crypto.timingSafeEqual(expected, supplied);
  });
}

export function otpauthUri(secret, email, issuer = 'FloraScan') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}
