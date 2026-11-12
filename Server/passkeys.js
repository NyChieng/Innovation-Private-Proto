import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { getSetting } from './db.js';

/*
 * Passkeys: sign in with Face ID, a fingerprint, or the phone's own screen
 * lock (pattern, PIN, passcode). See section 11 of Server/schema-extensions.sql.
 *
 * The browser's WebAuthn API does the hard part. The phone makes a key pair,
 * keeps the private key behind its screen lock, and hands FloraScan the public
 * key. Signing in, the phone signs a one-off challenge once the user has
 * unlocked it; the server checks the signature. Nothing biometric is ever sent.
 *
 * Two rules from the standard shape everything here:
 *   - A passkey belongs to a host name (the "relying party ID"). An IP address
 *     is not allowed, so a phone uses the computer's .local name rather than
 *     https://192.168.x.x. A passkey made on one name does not work on another.
 *   - The page must be a secure context with a certificate the device trusts.
 */

const RP_NAME = 'FloraScan';
const CHALLENGE_MS = 5 * 60 * 1000;

/** One-off challenges, by flow. Kept in memory: a restart only means "try again". */
const challenges = new Map();

function remember(key, entry) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  challenges.set(key, { ...entry, expires: now + CHALLENGE_MS });
}

/** Each challenge answers exactly one attempt, right or wrong. */
function take(key) {
  const entry = challenges.get(key);
  challenges.delete(key);
  return entry && entry.expires > Date.now() ? entry : null;
}

const hostOf = (url) => { try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return null; } };

/**
 * The relying party for this request: the host name the page was opened on,
 * and the origin the browser will report. Null on an IP address, and on any
 * name this server has no business answering for - the Host header comes from
 * the client, so it is checked rather than trusted.
 */
export function relyingParty(req) {
  const host = String(req.get('host') || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return null;

  const proxied = !!req.app.get('trust proxy');
  const configured = [getSetting('public_base_url'), process.env.PUBLIC_BASE_URL].map(hostOf).filter(Boolean);
  const allowed = hostname === 'localhost' || hostname.endsWith('.local') || configured.includes(hostname) || proxied;
  if (!allowed) return null;

  const scheme = proxied
    ? (String(req.get('x-forwarded-proto') || '').split(',')[0].trim() || 'https')
    : (req.app.get('protoScheme') || req.protocol);
  return { rpID: hostname, origin: `${scheme}://${host}` };
}

/**
 * A name for the passkey list. A phone linked by QR code reports the "hybrid"
 * transport; otherwise the passkey lives on the device doing the browsing.
 */
export function deviceLabel(ua = '', transports = '') {
  if (String(transports).split(',').includes('hybrid')) return 'Phone linked by QR code';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/Windows/i.test(ua)) return 'Windows computer';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  return 'This device';
}

const toB64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));
const transportsOf = (row) => (row.transports ? String(row.transports).split(',') : undefined);

/* ------------------------------------------------------------------ */
/* Adding a passkey to a signed-in account                             */
/* ------------------------------------------------------------------ */

export async function registrationOptions(user, existing, rp) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.full_name,
    // Opaque to the phone; the account is found by credential id, not this.
    userID: crypto.createHash('sha256').update('florascan-user:' + user.id).digest().subarray(0, 16),
    attestationType: 'none',
    // One passkey per device: the phone says so if it already holds one.
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    // Each device uses only its own sensor: Windows Hello on a PC, Face ID or
    // the fingerprint on a phone. No phone-by-QR-code and no USB keys - one
    // device, one passkey, and nothing to explain about scanning.
    preferredAuthenticatorType: 'localDevice',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      // Stored on the device, so no email is typed to sign in.
      residentKey: 'required',
      // Biometric or the device's own pattern / PIN, never just a tap.
      userVerification: 'required',
    },
  });
  remember('reg:' + user.id, { challenge: options.challenge, ...rp });
  return options;
}

/** Returns the row to store, or throws when the response does not check out. */
export async function verifyRegistration(user, response) {
  const pending = take('reg:' + user.id);
  if (!pending) throw new Error('expired');
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: pending.origin,
    expectedRPID: pending.rpID,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) throw new Error('not verified');
  const { credential } = result.registrationInfo;
  return {
    credential_id: credential.id,
    public_key: toB64(credential.publicKey),
    counter: credential.counter || 0,
    transports: credential.transports?.length ? credential.transports.join(',') : null,
    rp_id: pending.rpID,
  };
}

/* ------------------------------------------------------------------ */
/* Signing in                                                          */
/* ------------------------------------------------------------------ */

/** No email asked: the phone offers whichever FloraScan passkeys it holds. */
export async function authenticationOptions(rp) {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    allowCredentials: [],
  });
  const flow = crypto.randomBytes(16).toString('hex');
  remember('auth:' + flow, { challenge: options.challenge, ...rp });
  return { flow, options };
}

/** Returns the new signature counter, or throws. */
export async function verifyAuthentication(flow, response, row) {
  const pending = take('auth:' + flow);
  if (!pending) throw new Error('expired');
  if (row.rp_id !== pending.rpID) throw new Error('wrong address');
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: pending.origin,
    expectedRPID: pending.rpID,
    credential: {
      id: row.credential_id,
      publicKey: fromB64(row.public_key),
      counter: Number(row.counter) || 0,
      transports: transportsOf(row),
    },
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error('not verified');
  return result.authenticationInfo.newCounter;
}
