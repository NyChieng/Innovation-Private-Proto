/**
 * Passkey sign-in (Face ID / fingerprint), end to end in headless Chrome.
 *
 * Chrome's DevTools protocol can stand in a virtual authenticator - a pretend
 * fingerprint reader that always says "yes, it is them" - so the real
 * WebAuthn ceremony runs: the browser makes the key pair, the server checks
 * the signatures. Nothing here is mocked on the server side.
 *
 *   npm run test:passkey      (server running)
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

// Our own server's local certificate, on our own machine.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = process.env.PORT
  || JSON.parse(fs.readFileSync(new URL('../proto.config.json', import.meta.url), 'utf8')).port;
const BASE = `https://localhost:${PORT}`;

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => { try { return p && fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('No Chrome or Edge found. Set CHROME_PATH.'); process.exit(1); }

let passed = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  \x1b[32mok\x1b[0m   ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? '\n         ' + detail : ''}`); }
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log(`Passkey tests against ${BASE}\n`);

/* A throwaway account that has chosen its own password. */
const admin = (await api('POST', '/auth/login', { email: 'nengyichieng@gmail.com', password: 'nengyichieng123' })).body.token;
const email = `test.passkey.${Date.now()}@niah.sarawak.gov.my`;
const made = await api('POST', '/users', { full_name: 'Passkey Test User', email, role_id: 2 }, admin);
// Temporary passwords are random: use the one the API issued.
let temp = made.body.temporary_password;
let token = (await api('POST', '/auth/login', { email, password: temp })).body.token;
await api('POST', '/auth/password', { current_password: temp, new_password: 'passkey-pass-1' }, token);

console.log('\x1b[1mServer refuses what it should\x1b[0m');
check('signed-out users cannot add a passkey', (await api('POST', '/auth/passkeys/register/options')).status === 401);
check('a made-up passkey cannot sign in', (await api('POST', '/auth/passkeys/login/verify', { flow: 'x', response: { id: 'nope' } })).status === 400);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--allow-insecure-localhost'],
});
const errors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    localStorage.setItem('florascan.token', t);
    localStorage.setItem('florascan.lang', 'en');
    localStorage.setItem('florascan.intro-seen', '1');
  }, token);

  console.log('\n\x1b[1mTurning it on\x1b[0m');
  await page.goto(BASE + '/staff/password', { waitUntil: 'networkidle0' });
  const turnOn = await page.waitForSelector('::-p-text(Turn on for this device)', { timeout: 10000 });
  await page.waitForFunction((el) => !el.disabled, {}, turnOn);
  await turnOn.click();
  await page.waitForSelector('::-p-text(Add another device)', { timeout: 10000 }).catch(() => null);

  const list = await api('GET', '/auth/passkeys', null, token);
  check('the passkey is saved for the account', list.body.results?.length === 1, JSON.stringify(list.body));
  check('...under the localhost address', list.body.results?.[0]?.rp_id === 'localhost');
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  check('...and the device holds the private key', credentials.length === 1 && credentials[0].isResidentCredential);

  /*
   * Opens the sign-in page signed out and signs in with the passkey. The
   * virtual authenticator approves at once, so the email box's autofill often
   * completes before the button can be pressed - in a real browser it waits
   * for the person to pick the suggestion. Either is a real way in.
   */
  async function passkeyFromLoginPage() {
    await page.evaluate(() => localStorage.removeItem('florascan.token'));
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    const first = await page.waitForFunction(() => {
      if (location.pathname.startsWith('/staff')) return 'autofill';
      if (document.querySelector('.signin-error')) return 'error';
      const b = [...document.querySelectorAll('button')].find((x) => /Sign in with Face ID or fingerprint/.test(x.textContent));
      return b && !b.disabled ? 'button' : false;
    }, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    if (first !== 'button') return first;
    await page.evaluate(() => [...document.querySelectorAll('button')]
      .find((x) => /Sign in with Face ID or fingerprint/.test(x.textContent)).click());
    await page.waitForFunction(() => location.pathname.startsWith('/staff') || document.querySelector('.signin-error'), { timeout: 10000 }).catch(() => null);
    return (await page.evaluate(() => location.pathname)).startsWith('/staff') ? 'button' : 'error';
  }

  console.log('\n\x1b[1mSigning in with it\x1b[0m');
  const how = await passkeyFromLoginPage();
  check('signed in from the sign-in page without typing anything', how === 'autofill' || how === 'button', 'got ' + how);

  const newToken = await page.evaluate(() => localStorage.getItem('florascan.token'));
  check('Face ID / fingerprint signs the user in', !!newToken);
  const me = await api('GET', '/auth/me', null, newToken);
  check('...as the right person', me.body.user?.email === email, JSON.stringify(me.body.user?.email));
  check('...and lands on their dashboard', (await page.evaluate(() => location.pathname)).startsWith('/staff'));
  const used = await api('GET', '/auth/passkeys', null, newToken);
  check('the passkey records when it was last used', !!used.body.results?.[0]?.last_used_at);

  console.log('\n\x1b[1mTurning it off\x1b[0m');
  const id = used.body.results[0].id;
  check('another user cannot remove it', (await api('DELETE', `/auth/passkeys/${id}`, null, admin)).status === 404);
  check('the owner can', (await api('DELETE', `/auth/passkeys/${id}`, null, newToken)).status === 200);

  // The device still holds the key; only the server has forgotten it.
  const afterRemoval = await passkeyFromLoginPage();
  check('a removed passkey no longer signs in', afterRemoval === 'error'
    && !(await page.evaluate(() => localStorage.getItem('florascan.token'))), 'got ' + afterRemoval);

  console.log('\n\x1b[1mAn administrator reset removes passkeys\x1b[0m');
  token = (await api('POST', '/auth/login', { email, password: 'passkey-pass-1' })).body.token;
  await page.evaluate((t) => localStorage.setItem('florascan.token', t), token);
  await page.goto(BASE + '/staff/password', { waitUntil: 'networkidle0' });
  // The device still holds the old (now orphaned) key; clear it so the new one is accepted.
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  const onAgain = await page.waitForSelector('::-p-text(Turn on for this device)', { timeout: 10000 });
  await page.waitForFunction((el) => !el.disabled, {}, onAgain);
  await onAgain.click();
  await page.waitForSelector('::-p-text(Add another device)', { timeout: 10000 }).catch(() => null);
  check('set up again', (await api('GET', '/auth/passkeys', null, token)).body.results?.length === 1);
  temp = (await api('POST', `/users/${made.body.user.id}/reset-password`, {}, admin)).body.temporary_password;
  const fresh = (await api('POST', '/auth/login', { email, password: temp })).body.token;
  check('after the reset the account has none', (await api('GET', '/auth/passkeys', null, fresh)).body.results?.length === 0);

  console.log('\n\x1b[1mOffered straight after a password sign-in\x1b[0m');
  const email2 = `test.passkey.offer.${Date.now()}@niah.sarawak.gov.my`;
  const temp2 = (await api('POST', '/users', { full_name: 'Passkey Offer User', email: email2, role_id: 2 }, admin)).body.temporary_password;
  const t2 = (await api('POST', '/auth/login', { email: email2, password: temp2 })).body.token;
  await api('POST', '/auth/password', { current_password: temp2, new_password: 'offer-pass-1' }, t2);
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });

  await page.evaluate(() => localStorage.removeItem('florascan.token'));
  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.type('input[type=email]', email2);
  await page.type('input[type=password]', 'offer-pass-1');
  await page.click('button.signin-submit');
  const offer = await page.waitForSelector('::-p-text(Use fingerprint or face)', { timeout: 10000 }).catch(() => null);
  check('the sign-in page offers fingerprint / face', !!offer);
  if (offer) {
    await page.waitForFunction((el) => !el.disabled, {}, offer);
    await offer.click();
    await page.waitForFunction(() => location.pathname.startsWith('/staff'), { timeout: 10000 }).catch(() => null);
    check('...one tap sets it up and carries on to the dashboard', (await page.evaluate(() => location.pathname)).startsWith('/staff'));
    check('...and the passkey is saved', (await api('GET', '/auth/passkeys', null, t2)).body.results?.length === 1);

    // Without the key on the device, so autofill cannot sign in before the
    // password is typed; the account still has its passkey on the server.
    await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    await page.evaluate(() => localStorage.removeItem('florascan.token'));
    await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
    await page.type('input[type=email]', email2);
    await page.type('input[type=password]', 'offer-pass-1');
    await page.click('button.signin-submit');
    await page.waitForFunction(() => location.pathname.startsWith('/staff'), { timeout: 10000 }).catch(() => null);
    check('...and it is not offered again on this device', (await page.evaluate(() => location.pathname)).startsWith('/staff'));
  }

  check('no uncaught errors in the page', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await api('PATCH', `/users/${made.body.user.id}`, { is_active: false }, admin);
}

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`\x1b[31m${failures.length} of ${passed + failures.length} checks failed.\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mAll ${passed} passkey checks passed.\x1b[0m`);
