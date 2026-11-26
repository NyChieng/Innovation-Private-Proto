import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { once } from 'node:events';
import express from 'express';
import { reset, state } from './helpers/staff-memory-db.mjs';

// Replace only the persistence boundary; exercise the real API and middleware.
// Fail closed if anything attempts to load the real SQL adapter.
register('./helpers/staff-db-loader.mjs', import.meta.url);
const { createApi } = await import('../Server/api.js');
let server, origin;
before(async () => {
  const app = express();
  app.use('/api', createApi());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => reset());
async function call(path, { role = 3, method = 'POST', body = {} } = {}) {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer staff-${role}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('restore rejects records that are not archived without changing publication', async () => {
  const result = await call('/plants/10/restore', { role: 4 });
  assert.equal(result.status, 409);
  assert.equal(state.plants[0].status, 'pending');
  assert.equal(state.qr_codes.length, 0);
});
test('restoring an unverified archive returns it to private corrections', async () => {
  reset({ status: 'archived' });
  state.plant_submissions[0].status = 'rejected';
  const result = await call('/plants/10/restore', { role: 4 });
  assert.equal(result.status, 200);
  assert.equal(result.body.plant.status, 'rejected');
  assert.equal(state.qr_codes.length, 0);
});
test('restoring a verified archive reuses its tag', async () => {
  reset({ status: 'archived', verified_at: '2026-11-01T00:00:00Z', verified_by: 4 });
  state.qr_codes.push({ id: 40, plant_id: 10, status: 'inactive', qr_token: 'printed-token' });
  const result = await call('/plants/10/restore', { role: 4 });
  assert.equal(result.status, 200);
  assert.equal(result.body.plant.status, 'approved');
  assert.equal(state.qr_codes.length, 1);
  assert.equal(state.qr_codes[0].status, 'active');
  assert.equal(state.qr_codes[0].qr_token, 'printed-token');
});
test('restore keeps the plant archived if QR reactivation fails', async () => {
  reset({ status: 'archived', verified_at: '2026-11-01T00:00:00Z', verified_by: 4 });
  state.qr_codes.push({ id: 40, plant_id: 10, status: 'inactive', qr_token: 'printed-token' });
  state.failQrWrite = true;
  const result = await call('/plants/10/restore', { role: 4 });
  assert.equal(result.status, 500);
  assert.equal(state.plants[0].status, 'archived');
  assert.equal(state.qr_codes[0].status, 'inactive');
});
test('editing requires a nonempty site', async () => {
  const result = await call('/plants/10', { role: 4, method: 'PATCH', body: { site_name: '  ' } });
  assert.equal(result.status, 400);
  assert.equal(state.plants[0].site_name, 'Test trail');
});
test('editing requires a confirmed or proposed species', async () => {
  const result = await call('/plants/10', { role: 4, method: 'PATCH', body: { species_id: null, proposed_species_name: '' } });
  assert.equal(result.status, 400);
  assert.equal(state.plants[0].species_id, 1);
});
test('editing a published record cannot remove its confirmed species', async () => {
  reset({ status: 'approved' });
  const result = await call('/plants/10', { role: 4, method: 'PATCH', body: { species_id: null, proposed_species_name: 'Unknown tree' } });
  assert.equal(result.status, 400);
  assert.equal(state.plants[0].species_id, 1);
});
test('a single coordinate correction validates the resulting coordinate pair', async () => {
  const result = await call('/plants/10', { role: 4, method: 'PATCH', body: { latitude: 5 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.plant.latitude, 5);
  assert.equal(result.body.plant.longitude, 113);
});
test('one coordinate cannot be cleared while the other remains', async () => {
  const result = await call('/plants/10', { role: 4, method: 'PATCH', body: { latitude: null } });
  assert.equal(result.status, 400);
  assert.equal(state.plants[0].latitude, 4);
});

// For plant records a botanist only registers; a senior botanist does the rest.
test('a botanist cannot edit a record waiting for review, even their own', async () => {
  const result = await call('/plants/10', { method: 'PATCH', body: { site_name: 'Moved trail' } });
  assert.equal(result.status, 403);
  assert.equal(state.plants[0].site_name, 'Test trail');
});
test('a botanist corrects their own record once it is returned', async () => {
  reset({ status: 'rejected' });
  const result = await call('/plants/10', { method: 'PATCH', body: { site_name: 'Test trail, marker 3' } });
  assert.equal(result.status, 200);
  assert.equal(state.plants[0].site_name, 'Test trail, marker 3');
});
test("a botanist cannot correct someone else's returned record", async () => {
  reset({ status: 'rejected', registered_by: 4 });
  const result = await call('/plants/10', { method: 'PATCH', body: { site_name: 'Other trail' } });
  assert.equal(result.status, 403);
  assert.equal(state.plants[0].site_name, 'Test trail');
});
test('a botanist cannot archive or restore records', async () => {
  assert.equal((await call('/plants/10/archive', { body: { reason: 'Gone' } })).status, 403);
  reset({ status: 'archived' });
  assert.equal((await call('/plants/10/restore')).status, 403);
  assert.equal(state.plants[0].status, 'archived');
});

test('administrator role changes reject unknown roles', async () => {
  const result = await call('/users/3', { role: 1, method: 'PATCH', body: { role_id: 999 } });
  assert.equal(result.status, 400);
  assert.equal(state.users.find((u) => u.id === 3).role_id, 3);
});
test('administrator edits reject blank staff names', async () => {
  const result = await call('/users/3', { role: 1, method: 'PATCH', body: { full_name: '  ' } });
  assert.equal(result.status, 400);
  assert.equal(state.users.find((u) => u.id === 3).full_name, 'Staff 3');
});
test('normal botanist submission, return, correction, resubmission and approval lifecycle', async () => {
  const created = await call('/plants', { body: { species_id: 1, site_name: 'North trail' } });
  assert.equal(created.status, 201);
  const id = created.body.plant.id;
  assert.equal(created.body.plant.status, 'pending');
  assert.equal(state.qr_codes.length, 0);
  const returned = await call(`/plants/${id}/reject`, { role: 4, body: { note: 'Clarify the site' } });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.plant.status, 'rejected');
  assert.equal((await call(`/plants/${id}`, { method: 'PATCH', body: { site_name: 'North trail, marker 2' } })).status, 200);
  assert.equal((await call(`/plants/${id}/resubmit`, { body: { note: 'Added marker' } })).status, 200);
  const approved = await call(`/plants/${id}/approve`, { role: 4 });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.plant.status, 'approved');
  assert.equal(state.qr_codes.filter((r) => r.plant_id === id).length, 1);
  assert.deepEqual(state.plant_submissions.filter((r) => r.plant_id === id).map((r) => r.status), ['rejected', 'approved']);
});
test('a senior botanist cannot decide their own submission', async () => {
  reset({ registered_by: 4 });
  state.plant_submissions[0].submitted_by = 4;
  for (const action of ['approve', 'reject']) {
    const result = await call(`/plants/10/${action}`, { role: 4, body: { note: 'Review' } });
    assert.equal(result.status, 403);
  }
  assert.equal(state.plants[0].status, 'pending');
});
test('rangers resolve IoT alerts but cannot change plant or staff records', async () => {
  const resolved = await call('/sensors/alerts/30/resolve', { role: 2, body: { note: 'Inspected sensor' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.alert.status, 'resolved');
  assert.equal(resolved.body.alert.resolved_by, 2);
  assert.equal((await call('/sensors/alerts/30/resolve', { role: 2 })).status, 409);
  assert.equal((await call('/plants/10', { role: 2, method: 'PATCH', body: { site_name: 'Other trail' } })).status, 403);
  assert.equal((await call('/users/3', { role: 2, method: 'PATCH', body: { role_id: 1 } })).status, 403);
});
test('administrator account management does not imply review or IoT permissions', async () => {
  assert.equal((await call('/plants/10/approve', { role: 1 })).status, 403);
  assert.equal((await call('/sensors/alerts/30/resolve', { role: 1 })).status, 403);
  assert.equal((await call('/users/3', { role: 1, method: 'PATCH', body: { role_id: 4 } })).status, 200);
});
test('an administrator cannot touch a super admin account or hand out the role', async () => {
  assert.equal((await call('/users/5', { role: 1, method: 'PATCH', body: { is_active: false } })).status, 403);
  assert.equal((await call('/users/5', { role: 1, method: 'PATCH', body: { role_id: 1 } })).status, 403);
  assert.equal((await call('/users/5/reset-password', { role: 1 })).status, 403);
  assert.equal((await call('/users/2', { role: 1, method: 'PATCH', body: { role_id: 5 } })).status, 403);
  assert.equal(state.users[4].is_active, 1);
  assert.equal(state.users[1].role_id, 2);
});
test('any administrator can unlock a super admin locked by wrong passwords', async () => {
  state.users[4].locked_until = new Date(Date.now() + 15 * 60000).toISOString();
  assert.equal((await call('/users/5/unlock', { role: 1 })).status, 200);
  assert.equal(state.users[4].locked_until, null);
});
test('a super admin holds every permission and can manage administrators, but not demote itself', async () => {
  assert.equal((await call('/plants/10/approve', { role: 5 })).status, 200);
  assert.equal((await call('/users/1', { role: 5, method: 'PATCH', body: { full_name: 'Admin renamed' } })).status, 200);
  assert.equal((await call('/users/5', { role: 5, method: 'PATCH', body: { role_id: 1 } })).status, 400);
  assert.equal(state.users[4].role_id, 5);
});
