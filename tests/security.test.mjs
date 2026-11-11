import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { configureSecurity, RATE_LIMITS } from '../Server/security.js';
import { tlsOptions } from '../Server/certs.js';
import { securityServer } from './helpers/security-server.mjs';

async function fixture(t, options) {
  const server = await securityServer(options);
  t.after(() => server.close());
  return server;
}

function blocked(response, policy) {
  assert.equal(response.status, 429);
  assert.equal(response.json().code, 'RATE_LIMITED');
  assert.equal(response.json().policy, policy);
  assert.ok(Number(response.headers['retry-after']) > 0);
  assert.equal(response.json().retryAfter, Number(response.headers['retry-after']));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['ratelimit-policy'], new RegExp(`"${policy}"`));
  assert.match(response.headers['ratelimit'], new RegExp(`"${policy}"; r=0`));
  assert.equal(response.headers['x-frame-options'], 'DENY');
}

test('login and demo switch share 10 attempts, before JSON parsing; path variants cannot evade it', async (t) => {
  const server = await fixture(t);
  for (let n = 0; n < RATE_LIMITS.login.limit; n++) {
    const url = n % 2 ? '/api/AUTH/SWITCH/' : '/api/auth/login';
    assert.equal((await server.request(url, { method: 'POST', body: '{' })).status, 400);
  }
  blocked(await server.request('/api/auth/login/', { method: 'POST', body: '{' }), 'login');
  blocked(await server.request('/api/auth/switch', { method: 'POST', body: '{' }), 'login');
  // A login lockout does not consume the separate reset/upload allowances.
  assert.equal((await server.request('/api/users/1/reset-password', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await server.request('/api/plants', { method: 'POST', body: '{}' })).status, 401);
});

test('password resets share 5 attempts across target users; authorization remains required', async (t) => {
  const server = await fixture(t);
  for (let n = 0; n < RATE_LIMITS.passwordReset.limit; n++) {
    assert.equal((await server.request(`/api/users/${n + 1}/reset-password`, { method: 'POST', body: '{}' })).status, 401);
  }
  blocked(await server.request('/api/USERS/999/reset-password/', { method: 'POST', body: '{}' }), 'passwordReset');
});

test('upload blocks attempt 11 before decoding an invalid body; plant reads are separate', async (t) => {
  const server = await fixture(t);
  for (let n = 0; n < RATE_LIMITS.upload.limit; n++) {
    assert.equal((await server.request('/api/plants', { method: 'POST', body: '{}' })).status, 401);
  }
  blocked(await server.request('/api/PLANTS/', { method: 'POST', body: '{' }), 'upload');
  // HEAD/GET are not uploads; this unknown path can be checked without SQL.
  assert.equal((await server.request('/api/unknown')).status, 404);
});

test('all API methods and unknown endpoints share the general 300 request allowance', async (t) => {
  const server = await fixture(t);
  for (let n = 0; n < RATE_LIMITS.api.limit; n++) {
    assert.equal((await server.request(`/api/unknown-${n}`, { method: n % 2 ? 'POST' : 'GET' })).status, 404);
  }
  blocked(await server.request('/api/another'), 'api');
  // The web shell is not counted as an API request.
  assert.equal((await server.request('/')).status, 200);
});

test('production HTTP has strict CSP and clickjacking protection, without HSTS or forced upgrade', async (t) => {
  const server = await fixture(t);
  for (const url of ['/', '/api/missing', '/missing']) {
    const { headers } = await server.request(url);
    assert.match(headers['content-security-policy'], /script-src 'self';/);
    assert.match(headers['content-security-policy'], /script-src-attr 'none'/);
    assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(headers['content-security-policy'], /object-src 'none'/);
    assert.match(headers['content-security-policy'], /img-src 'self' data: blob: https:/);
    assert.doesNotMatch(headers['content-security-policy'], /unsafe-eval|upgrade-insecure-requests/);
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(headers['permissions-policy'], 'camera=(self), geolocation=(self), microphone=()');
    assert.equal(headers['strict-transport-security'], undefined);
    assert.equal(headers['x-powered-by'], undefined);
  }
});

test('real production HTTPS sends one-year HSTS; development HTTPS does not pin the host', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'florascan-security-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tls = tlsOptions(dir, []);
  const production = await fixture(t, { tls });
  const secure = await production.request('/');
  assert.equal(secure.headers['strict-transport-security'], 'max-age=31536000');
  assert.match(secure.headers['content-security-policy'], /upgrade-insecure-requests/);
  const development = await fixture(t, { tls, production: false });
  const dev = await development.request('/');
  assert.equal(dev.headers['strict-transport-security'], undefined);
  assert.match(dev.headers['content-security-policy'], /script-src 'self' 'unsafe-inline'/);
  assert.match(dev.headers['content-security-policy'], /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(dev.headers['content-security-policy'], /upgrade-insecure-requests/);
});

test('forwarded client IP and HTTPS are ignored unless the connection is from a configured proxy', async (t) => {
  const direct = await fixture(t);
  const headers = { 'x-forwarded-for': '203.0.113.10', 'x-forwarded-proto': 'https' };
  const untrusted = await direct.request('/client', { headers });
  assert.equal(untrusted.json().ip, '127.0.0.1');
  assert.equal(untrusted.json().secure, false);
  assert.equal(untrusted.headers['strict-transport-security'], undefined);
  const proxied = await fixture(t, { trustProxy: 'loopback' });
  const trusted = await proxied.request('/client', { headers });
  assert.equal(trusted.json().ip, '203.0.113.10');
  assert.equal(trusted.json().secure, true);
  assert.equal(trusted.headers['strict-transport-security'], 'max-age=31536000');
});

test('independent clients get separate allowances; IPv6 addresses within one /56 share a quota', async (t) => {
  const server = await fixture(t, { trustProxy: 'loopback' });
  const request = (ip) => server.request('/api/auth/login', {
    method: 'POST', body: '{', headers: { 'x-forwarded-for': ip },
  });
  for (let n = 0; n < RATE_LIMITS.login.limit; n++) assert.equal((await request('203.0.113.10')).status, 400);
  blocked(await request('203.0.113.10'), 'login');
  assert.equal((await request('203.0.113.11')).status, 400);
  for (let n = 0; n < RATE_LIMITS.login.limit; n++) assert.equal((await request(`2001:db8:1234:5600::${n + 1}`)).status, 400);
  blocked(await request('2001:db8:1234:56ff::ffff'), 'login');
  assert.equal((await request('2001:db8:1234:5700::1')).status, 400);
});

test('unsafe proxy configurations fail at startup', () => {
  for (const trustProxy of ['true', '1', '*', '0.0.0.0/0', '::/0']) {
    assert.throws(() => configureSecurity(express(), { trustProxy }), /TRUST_PROXY/);
  }
});

test('a concurrent login burst cannot overshoot the allowance', async (t) => {
  const server = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 20 }, () =>
    server.request('/api/auth/login', { method: 'POST', body: '{' })));
  assert.equal(responses.filter((res) => res.status === 400).length, 10);
  assert.equal(responses.filter((res) => res.status === 429).length, 10);
});

test('the login allowance recovers when its window expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const server = await fixture(t);
  const request = () => server.request('/api/auth/login', { method: 'POST', body: '{' });
  for (let n = 0; n < RATE_LIMITS.login.limit; n++) assert.equal((await request()).status, 400);
  blocked(await request(), 'login');
  t.mock.timers.tick(RATE_LIMITS.login.windowMs + 1);
  assert.equal((await request()).status, 400);
});

test('the service worker does not persist a 429 as a photograph', async () => {
  const listeners = new Map();
  const writes = [];
  const context = vm.createContext({
    URL, Response,
    self: {
      location: { origin: 'https://florascan.test' },
      addEventListener: (name, listener) => listeners.set(name, listener),
    },
    caches: {
      match: async () => undefined,
      open: async () => ({ put: async (...args) => { writes.push(args); } }),
    },
    fetch: async () => Response.json({ error: 'Too many requests' }, { status: 429 }),
  });
  vm.runInContext(fs.readFileSync(new URL('../FloraScan-Web-App/public/sw.js', import.meta.url), 'utf8'), context);
  let response;
  listeners.get('fetch')({
    request: new Request('https://florascan.test/api/photos/example.svg'),
    respondWith: (promise) => { response = promise; },
  });
  assert.equal((await response).status, 429);
  assert.equal(writes.length, 0);
});
