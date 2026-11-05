import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { securityServer } from '../tests/helpers/security-server.mjs';
import { RATE_LIMITS } from '../Server/security.js';
import { tlsOptions } from '../Server/certs.js';

console.log('\nFloraScan security demonstration (real middleware and API router)');
console.log('Isolated localhost servers; no database connection or records changed.');
console.log('Each category starts with fresh counters. The normal limits are unchanged.\n');

for (const [name, url, normalStatus, options] of [
  ['login', '/api/auth/login', 400, { method: 'POST', body: '{' }],
  ['passwordReset', '/api/users/1/reset-password', 401, { method: 'POST', body: '{}' }],
  ['upload', '/api/plants', 401, { method: 'POST', body: '{}' }],
  ['api', '/api/demo-missing', 404, {}],
]) {
  const server = await securityServer();
  try {
    const { limit, windowMs } = RATE_LIMITS[name];
    for (let n = 1; n <= limit; n++) {
      const response = await server.request(url, options);
      assert.equal(response.status, normalStatus);
    }
    const blocked = await server.request(url, options);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json().policy, name);
    console.log(`${name}: requests 1-${limit} reached API validation (${normalStatus}); request ${limit + 1} blocked (429).`);
    console.log(`  Allowance: ${limit} per ${windowMs / 60_000} minute(s), per IP.`);
    console.log(`  Retry-After: ${blocked.headers['retry-after']} seconds`);
    console.log(`  JSON: ${blocked.text}\n`);
  } finally {
    await server.close();
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'florascan-security-demo-'));
let server;
try {
  server = await securityServer({ tls: tlsOptions(dir, []) });
  const response = await server.request('/');
  console.log('Production HTTPS response headers (TLS certificate verified with a temporary local CA):');
  for (const name of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']) {
    console.log(`  ${name}: ${response.headers[name]}`);
  }
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  console.log('\nPASS: all four limits and HTTPS headers demonstrated.');
  console.log('400 = invalid JSON, 401 = sign-in required, 404 = missing endpoint; 429 = rate limiter stopped the request first.');
} finally {
  await server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
