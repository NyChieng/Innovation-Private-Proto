/**
 * API test suite.
 *
 * Covers the quality targets named in the project proposal:
 *   - access control     (negative tests across the three roles + anonymous)
 *   - publication control (nothing unapproved reachable from a public URL)
 *   - input validation    (the CHECK constraints from the SQL schema)
 *   - the record lifecycle and the verification workflow
 *   - audit completeness
 *
 * Run against a server already started with `npm run dev`:
 *   npm run test:api
 */

// The dev server serves HTTPS by default, with a self-signed certificate.
// This is a local run against our own machine, so trusting it is fine.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// BASE_URL points the suite at a deployed site instead of this machine, e.g.
//   BASE_URL=https://florascan.onrender.com npm run test:api
// Mind what it is aimed at: these tests register and archive real records, so
// a run against production leaves that litter in the live database.
const ORIGIN = process.env.BASE_URL
  ? process.env.BASE_URL.replace(/\/+$/, '')
  : await detectOrigin(process.env.PORT || (await readPort()));
const BASE = `${ORIGIN}/api`;

async function readPort() {
  const fs = await import('node:fs');
  try {
    return JSON.parse(fs.readFileSync(new URL('../proto.config.json', import.meta.url), 'utf8')).port;
  } catch {
    throw new Error('No proto.config.json - start the server once with "npm run dev" first.');
  }
}

/** The server can run on either scheme; find out which, rather than assume. */
async function detectOrigin(port) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://localhost:${port}/api/bootstrap`);
      if (res.ok) return `${scheme}://localhost:${port}`;
    } catch { /* try the other scheme */ }
  }
  throw new Error(`Nothing answering on port ${port}. Start the server with "npm run dev".`);
}

/* ------------------------------------------------------------------ */
/* Tiny test harness                                                   */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let group = '';

const section = (name) => { group = name; console.log(`\n\x1b[1m${name}\x1b[0m`); };

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failures.push({ group, label, detail });
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? '\n         ' + detail : ''}`);
  }
}

const eq = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/* ------------------------------------------------------------------ */

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const get = (p, t) => call('GET', p, { token: t });
// Temporary passwords are random, so remember the one the API hands back when
// an account is created or reset, keyed by email.
const TEMP = new Map();
const EMAIL_OF = new Map();
async function post(p, body, t) {
  const r = await call('POST', p, { token: t, body });
  const pw = r.body?.temporary_password;
  if (pw && p === '/users' && body?.email) {
    TEMP.set(body.email.toLowerCase(), pw);
    if (r.body.user?.id) EMAIL_OF.set(Number(r.body.user.id), body.email.toLowerCase());
  }
  const reset = /^\/users\/(\d+)\/reset-password$/.exec(p);
  if (pw && reset && EMAIL_OF.has(Number(reset[1]))) TEMP.set(EMAIL_OF.get(Number(reset[1])), pw);
  return r;
}
const patch = (p, body, t) => call('PATCH', p, { token: t, body });

// Seeded accounts use the email's local part + 123 (Server/seed.js); an
// account an admin creates or resets uses the temporary password it was issued.
const passwordFor = (email) => (email.endsWith('@florascan.test') ? email.split('@')[0] + '123' : TEMP.get(email.toLowerCase()));

async function login(email, password = passwordFor(email)) {
  const r = await post('/auth/login', { email, password });
  return r.body?.token;
}

const ADMIN = 'farah.hamid@florascan.test';
const BOTANIST = 'grace.lim@florascan.test';
const BOTANIST_2 = 'daniel.jugah@florascan.test';
const RANGER = 'ahmad.rosli@florascan.test';
const REVIEWER = 'aisyah.rahman@florascan.test';

/* ================================================================== */

console.log(`FloraScan API tests against ${BASE}\n`);

const adminT = await login(ADMIN);
const botT = await login(BOTANIST);
const bot2T = await login(BOTANIST_2);
const rangerT = await login(RANGER);
const revT = await login(REVIEWER);

if (!adminT || !botT || !bot2T || !rangerT || !revT) {
  console.error('Could not sign in the demo accounts. Is the server running?');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
section('1. Authentication');
{
  const ok = await post('/auth/login', { email: RANGER, password: passwordFor(RANGER) });
  eq('correct credentials return 200', ok.status, 200);
  check('a session token is issued', typeof ok.body.token === 'string' && ok.body.token.length > 20);
  check('the response carries the permission list', Array.isArray(ok.body.user.permissions));

  const bad = await post('/auth/login', { email: RANGER, password: 'wrong-password' });
  eq('wrong password is refused', bad.status, 401);
  check('the error does not reveal whether the account exists', !/no account/i.test(bad.body.error || ''));

  const unknown = await post('/auth/login', { email: 'nobody@example.com', password: 'any-pass-1' });
  eq('unknown email is refused', unknown.status, 401);

  const other = await post('/auth/login', { email: RANGER, password: passwordFor(ADMIN) });
  eq("another account's password is refused", other.status, 401);

  const switcher = await post('/auth/switch', { user_id: 1 });
  check('there is no password-free way into an account', switcher.status === 404 || !switcher.body?.token, 'status ' + switcher.status);
  // A deactivated account being refused is covered in section 17.

  const empty = await post('/auth/login', { email: '', password: '' });
  eq('empty credentials are refused', empty.status, 401);

  const me = await get('/auth/me', 'not-a-real-token');
  eq('a forged token resolves to no user', me.body.user, null);

  const meAnon = await get('/auth/me');
  eq('no token resolves to no user', meAnon.body.user, null);
}

/* ------------------------------------------------------------------ */
section('2. Access control - anonymous visitors (negative tests)');
{
  const cases = [
    ['GET', '/plants'], ['GET', '/plants/counts'], ['GET', '/users'],
    ['GET', '/activity'], ['GET', '/audit'], ['GET', '/settings'],
    ['GET', '/submissions'], ['GET', '/notifications'], ['GET', '/reports'],
    ['GET', '/sensors'],
  ];
  for (const [m, p] of cases) {
    const r = await call(m, p);
    check(`anonymous ${m} ${p} is refused`, r.status === 401 || r.status === 403, 'got ' + r.status);
  }
  const create = await post('/plants', { site_name: 'x', proposed_species_name: 'y' });
  eq('anonymous cannot register a plant', create.status, 401);

  const approve = await post('/plants/1/approve', {});
  eq('anonymous cannot approve a record', approve.status, 401);
}

/* ------------------------------------------------------------------ */
section('3. Access control - a ranger handles sensor alerts, not plant records (#8)');
{
  const pending = (await get('/plants?status=pending', botT)).body.results[0];
  const cases = [
    ['POST', '/plants', { site_name: 'Ranger test plot', proposed_species_name: 'Testus rangerus' }],
    ['GET', '/plants', undefined],
    ['POST', `/plants/${pending.id}/resubmit`, {}],
    ['POST', `/plants/${pending.id}/approve`, {}],
    ['POST', `/plants/${pending.id}/reject`, { note: 'no' }],
    ['PATCH', `/plants/${pending.id}`, { site_name: 'hijacked' }],
    ['POST', `/plants/${pending.id}/archive`, {}],
    ['POST', '/species', { scientific_name: 'Testus rangerus' }],
    ['GET', '/users', undefined],
    ['POST', '/users', { full_name: 'X', email: 'x@y.com', role_id: 1 }],
    ['GET', '/activity', undefined],
    ['GET', '/audit', undefined],
    ['GET', '/settings', undefined],
    ['PATCH', '/settings/require_approval', { value: false }],
    ['GET', '/reports', undefined],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, { token: rangerT, body: b });
    eq(`ranger ${m} ${p}`, r.status, 403);
  }
  const me = (await get('/auth/me', rangerT)).body.user;
  check('a ranger holds the sensor permissions', me.permissions.includes('sensor.view') && me.permissions.includes('alert.resolve'));
  check('...and no plant permission at all', !me.permissions.some((c) => c.startsWith('plant.') || c.startsWith('qr.')),
    me.permissions.join(', '));
  const sensors = await get('/sensors', rangerT);
  eq('a ranger can open the IoT dashboard data', sensors.status, 200);
}

/* ------------------------------------------------------------------ */
section('4. Access control - a botanist registers but cannot publish, or do an admin job');
{
  const me = (await get('/auth/me', botT)).body.user;
  check('a botanist holds plant.create', me.permissions.includes('plant.create'));
  check('...but not plant.approve, so nothing they register publishes itself', !me.permissions.includes('plant.approve'));
  check('...and for plant records only registers: no view-all, edit, archive or history',
    ['plant.view_all', 'plant.edit', 'plant.archive', 'plant.history'].every((c) => !me.permissions.includes(c)));
  const pending = (await get('/plants?status=pending', revT)).body.results[0];
  eq('a botanist cannot approve a record', (await post(`/plants/${pending.id}/approve`, {}, botT)).status, 403);
  eq('...or return one', (await post(`/plants/${pending.id}/reject`, { note: 'n' }, botT)).status, 403);
  eq('...or edit one waiting for review', (await patch(`/plants/${pending.id}`, { notes: 'not allowed' }, botT)).status, 403);
  eq('...or archive one', (await post(`/plants/${pending.id}/archive`, { reason: 'not allowed' }, botT)).status, 403);

  const cases = [
    ['GET', '/users'], ['GET', '/activity'], ['GET', '/audit'], ['GET', '/settings'],
  ];
  for (const [m, p] of cases) {
    const r = await call(m, p, { token: botT });
    eq(`botanist ${m} ${p}`, r.status, 403);
  }
  const setting = await patch('/settings/require_approval', { value: false }, botT);
  eq('botanist cannot change a system setting', setting.status, 403);
}

/* ------------------------------------------------------------------ */
section('5. Access control - admin may not do botanical work');
{
  const pending = (await get('/plants?status=pending', botT)).body.results[0];
  const cases = [
    ['POST', '/plants', { site_name: 'x', proposed_species_name: 'y' }],
    ['POST', `/plants/${pending.id}/approve`, {}],
    ['POST', `/plants/${pending.id}/reject`, { note: 'n' }],
    ['PATCH', `/plants/${pending.id}`, { site_name: 'x' }],
    ['POST', '/species', { scientific_name: 'Testus adminus' }],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, { token: adminT, body: b });
    eq(`admin ${m} ${p}`, r.status, 403);
  }
}

/* ------------------------------------------------------------------ */
section('5b. Access control - the senior botanist reviews records, and nothing else (#8)');
{
  const me = (await get('/auth/me', revT)).body.user;
  eq('the senior botanist role exists (it replaced the reviewer)', me.role, 'senior_botanist');
  eq('...labelled Senior Botanist', me.role_label, 'Senior Botanist');
  check('a senior botanist holds plant.approve', me.permissions.includes('plant.approve'));
  check('...and plant.archive', me.permissions.includes('plant.archive'));
  check('...but cannot register a plant', !me.permissions.includes('plant.create'));
  eq('a senior botanist POST /plants is refused',
    (await post('/plants', { site_name: 'x', proposed_species_name: 'y' }, revT)).status, 403);
  for (const [m, p, b] of [
    ['POST', '/species', { scientific_name: 'Testus reviewerus' }],
    ['GET', '/users', undefined], ['GET', '/settings', undefined], ['GET', '/audit', undefined],
  ]) {
    eq(`reviewer ${m} ${p}`, (await call(m, p, { token: revT, body: b })).status, 403);
  }
  const queue = await get('/submissions', revT);
  eq('the reviewer reads the whole queue', queue.status, 200);
  check('...which holds the seeded botanist submissions', queue.body.results.length >= 6, 'got ' + queue.body.results.length);
  check('...all from botanists', queue.body.results.every((x) => ['Dr Grace Lim', 'Daniel Jugah'].includes(x.submitted_by_name)));
  const notes = (await get('/notifications', revT)).body.results;
  check('the reviewer was notified of the waiting submissions', notes.some((n) => n.type === 'submission.new'));
}

/* ------------------------------------------------------------------ */
section('6. Data scoping');
{
  const revList = (await get('/plants', revT)).body.results;
  const botList = (await get('/plants', botT)).body.results;
  const mine = (await get('/plants?mine=1', botT)).body.results;
  check('a botanist sees only their own records', botList.length > 0 && botList.length === mine.length
    && botList.every((p) => p.registered_by_name === 'Dr Grace Lim'), `${botList.length} listed, ${mine.length} own`);
  check('a senior botanist sees the whole register', revList.length > botList.length,
    `senior ${revList.length} vs botanist ${botList.length}`);
}

/* ------------------------------------------------------------------ */
section('7. Publication control - nothing unapproved is public');
{
  const pub = (await get('/public/plants')).body;
  check('every public record is approved', pub.results.every((p) => p.status === 'approved'));
  check('every public record has a confirmed species', pub.results.every((p) => p.species_id));
  check('no public record is still awaiting identification', pub.results.every((p) => !p.species_not_listed));

  const all = (await get('/plants', revT)).body.results;
  for (const status of ['pending', 'rejected', 'archived']) {
    const row = all.find((p) => p.status === status);
    if (!row) continue;
    const anon = await get('/public/plants/' + row.id);
    eq(`a ${status} record is not readable anonymously`, anon.status, 404);
  }

  const archived = all.find((p) => p.status === 'archived' && p.qr_token);
  if (archived) {
    const scan = await get('/public/plants/token/' + archived.qr_token);
    eq('scanning an archived tag returns 404', scan.status, 404);
    eq('...with a reason the app can act on', scan.body.reason, 'archived');
  }

  const bogus = await get('/public/plants/token/00000000-0000-0000-0000-000000000000');
  eq('an unknown token is rejected', bogus.status, 404);
  check('QR tokens are not sequential ids',
    pub.results.every((p) => !p.qr_token || !/^\d+$/.test(p.qr_token)));
}

/* ------------------------------------------------------------------ */
section('8. Input validation - plant registration');
{
  const bad = [
    [{ site_name: 'Trail A' }, 'no species and no proposed name'],
    [{ proposed_species_name: 'Hoya sp.' }, 'no site name'],
    [{ site_name: '   ', proposed_species_name: 'Hoya sp.' }, 'whitespace-only site name'],
    [{ site_name: 'T', proposed_species_name: 'H', latitude: 91, longitude: 100 }, 'latitude above 90'],
    [{ site_name: 'T', proposed_species_name: 'H', latitude: -91, longitude: 100 }, 'latitude below -90'],
    [{ site_name: 'T', proposed_species_name: 'H', latitude: 3, longitude: 181 }, 'longitude above 180'],
    [{ site_name: 'T', proposed_species_name: 'H', latitude: 3 }, 'latitude without longitude'],
    [{ site_name: 'T', proposed_species_name: 'H', height_m: -5 }, 'negative height'],
    [{ site_name: 'T', proposed_species_name: 'H', height_m: 9999 }, 'implausible height'],
    [{ site_name: 'T', proposed_species_name: 'H', trunk_diameter_cm: -1 }, 'negative trunk diameter'],
    [{ site_name: 'T', proposed_species_name: 'H', height_m: 'tall' }, 'non-numeric height'],
    [{ site_name: 'T', proposed_species_name: 'H', health_status: 'sideways' }, 'unknown health status'],
    [{ site_name: 'T', proposed_species_name: 'H', life_stage: 'ancient' }, 'unknown life stage'],
    [{ site_name: 'x'.repeat(300), proposed_species_name: 'H' }, 'over-long site name'],
    [{ site_name: 'T', species_id: 999999 }, 'species id that does not exist'],
  ];
  for (const [body, label] of bad) {
    const r = await post('/plants', body, botT);
    eq(`rejected: ${label}`, r.status, 400);
  }

  const good = await post('/plants', {
    site_name: 'Test plot, validation suite',
    proposed_species_name: 'Hoya sp. (test record)',
    latitude: 3.8167, longitude: 113.7833,
    height_m: 2.4, health_status: 'fair', life_stage: 'sapling',
  }, botT);
  eq('a valid registration is accepted', good.status, 201);
  check('it is given a Plant ID', /^PLT-\d{4}-\d{4}$/.test(good.body.plant.plant_code || ''),
    good.body.plant?.plant_code);
}

/* ------------------------------------------------------------------ */
section('9. Input validation - review, species and users');
{
  const pending = (await get('/plants?status=pending', botT)).body.results[0];

  const noNote = await post(`/plants/${pending.id}/reject`, {}, revT);
  eq('rejecting without a note is refused', noNote.status, 400);

  const blankNote = await post(`/plants/${pending.id}/reject`, { note: '   ' }, revT);
  eq('a whitespace-only note is refused', blankNote.status, 400);

  const unidentified = (await get('/plants?status=pending', botT)).body.results
    .find((p) => p.species_not_listed);
  if (unidentified) {
    const r = await post(`/plants/${unidentified.id}/approve`, {}, revT);
    eq('a record with no species cannot be approved', r.status, 400);
  }

  const dupSpecies = await post('/species', { scientific_name: 'Rafflesia tuan-mudae' }, botT);
  eq('a duplicate scientific name is refused', dupSpecies.status, 409);

  const emptySpecies = await post('/species', { scientific_name: '  ' }, botT);
  eq('an empty scientific name is refused', emptySpecies.status, 400);

  const dupUser = await post('/users', { full_name: 'Clone', email: ADMIN, role_id: 2 }, adminT);
  eq('a duplicate email is refused', dupUser.status, 409);

  const noName = await post('/users', { full_name: '', email: 'new@niah.gov.my', role_id: 2 }, adminT);
  eq('a user with no name is refused', noName.status, 400);

  const badEmail = await post('/users', { full_name: 'Test', email: 'not-an-email', role_id: 2 }, adminT);
  eq('a malformed email is refused', badEmail.status, 400);

  const badRole = await post('/users', { full_name: 'Test', email: 'ok@niah.gov.my', role_id: 99 }, adminT);
  eq('an unknown role is refused', badRole.status, 400);

  const unknownSetting = await patch('/settings/does_not_exist', { value: 'x' }, adminT);
  eq('an unknown setting key is refused', unknownSetting.status, 404);

  const emptyReport = await post('/reports', { plant_id: 1, description: '' });
  eq('an empty visitor report is refused', emptyReport.status, 400);

  const missing = await get('/public/plants/99999999');
  eq('a missing record returns 404, not 500', missing.status, 404);

  const badEndpoint = await get('/no/such/endpoint');
  eq('an unknown endpoint returns JSON 404', badEndpoint.status, 404);
  check('...as JSON, not an HTML error page', typeof badEndpoint.body?.error === 'string');
}

/* ------------------------------------------------------------------ */
section('10. Hostile and awkward input is stored safely');
{
  const nasty = '<script>alert("xss")</script>';
  const sqlish = "Robert'); DROP TABLE plants;--";
  const unicode = 'Pokok  中文 नमस्ते 🌿 emoji';

  const r = await post('/plants', {
    site_name: nasty,
    proposed_species_name: sqlish,
    location_notes: unicode,
    morphology_notes: 'a'.repeat(1999),
  }, botT);
  eq('an awkward payload is accepted as data', r.status, 201);
  eq('the script tag is stored verbatim, not executed or stripped', r.body.plant.site_name, nasty);
  eq('the SQL-looking string is stored verbatim', r.body.plant.proposed_species_name, sqlish);
  eq('unicode and emoji survive intact', r.body.plant.location_notes, unicode);

  const stillThere = await get('/plants?status=pending', botT);
  check('the register still works after that payload', stillThere.status === 200 && stillThere.body.results.length > 0);

  const tooLong = await post('/plants', {
    site_name: 'Test', proposed_species_name: 'x', morphology_notes: 'a'.repeat(5000),
  }, botT);
  eq('an over-long note is refused', tooLong.status, 400);

  const searchInjection = await get('/public/plants?q=' + encodeURIComponent("' OR 1=1 --"));
  eq('a SQL-looking search term is handled', searchInjection.status, 200);
  eq('...and matches nothing', searchInjection.body.total, 0);
}

/* ------------------------------------------------------------------ */
section('11. The verification workflow end to end');
{
  const before = (await get('/plants/counts', revT)).body.queue;

  // A botanist registers a plant against a known species.
  const species = (await get('/species')).body.results.find((s) => s.scientific_name === 'Koompassia excelsa');
  const created = await post('/plants', {
    species_id: species.id,
    site_name: 'Workflow test, marker 1',
    latitude: 3.8, longitude: 113.78, height_m: 40,
  }, botT);
  eq('the botanist entry is created', created.status, 201);
  eq('...with the status pending', created.body.plant.status, 'pending');
  check('...and no QR tag yet', !created.body.plant.qr_token);

  const id = created.body.plant.id;

  const queueAfter = (await get('/plants/counts', revT)).body.queue;
  eq('the review queue grew by one', queueAfter, before + 1);

  const revNotes = (await get('/notifications', revT)).body.results;
  check('the reviewer was notified',
    revNotes.some((n) => n.type === 'submission.new' && (n.body || '').includes(created.body.plant.plant_code)));

  const anonBefore = await get('/public/plants/' + id);
  eq('the pending record is not public', anonBefore.status, 404);

  // The reviewer approves it.
  const approved = await post(`/plants/${id}/approve`, {}, revT);
  eq('approval succeeds', approved.status, 200);
  eq('...the status becomes approved', approved.body.plant.status, 'approved');
  check('...a QR tag is issued automatically', !!approved.body.plant.qr_token);
  check('...the verifier is recorded', approved.body.plant.verified_by_name === 'Dr Aisyah Rahman',
    approved.body.plant.verified_by_name);

  const again = await post(`/plants/${id}/approve`, {}, revT);
  eq('approving a record that is already published is refused', again.status, 409);
  const lateReturn = await post(`/plants/${id}/reject`, { note: 'too late' }, revT);
  eq('...and so is returning it', lateReturn.status, 409);

  const token = approved.body.plant.qr_token;
  const scan = await get('/public/plants/token/' + token);
  eq('scanning the new tag resolves to the record', scan.status, 200);
  eq('...and returns the right plant', scan.body.plant.id, id);

  const botNotes = (await get('/notifications', botT)).body.results;
  check('the botanist was told it was published',
    botNotes.some((n) => n.type === 'submission.approved' && (n.body || '').includes('approved')));

  // A botanist cannot change a published record; the senior botanist can.
  eq('the botanist cannot edit it once published',
    (await patch(`/plants/${id}`, { site_name: 'Workflow test, botanist edit' }, botT)).status, 403);
  // Editing must not invalidate a printed tag.
  await patch(`/plants/${id}`, { site_name: 'Workflow test, marker 2 (moved)' }, revT);
  const afterEdit = await get('/public/plants/token/' + token);
  eq('the tag still works after an edit', afterEdit.status, 200);
  eq('...and shows the edited value', afterEdit.body.plant.site_name, 'Workflow test, marker 2 (moved)');

  // Archive withdraws it; restore brings the same token back.
  await post(`/plants/${id}/archive`, { reason: 'test' }, revT);
  const reApprove = await post(`/plants/${id}/approve`, {}, revT);
  eq('approving an archived record does not republish it', reApprove.status, 409);
  const archivedScan = await get('/public/plants/token/' + token);
  eq('an archived record is withdrawn from the public site', archivedScan.status, 404);
  eq('...with the archived reason', archivedScan.body.reason, 'archived');

  eq('the botanist cannot restore it', (await post(`/plants/${id}/restore`, {}, botT)).status, 403);
  await post(`/plants/${id}/restore`, {}, revT);
  const restored = await get('/public/plants/token/' + token);
  eq('restoring makes the same printed tag valid again', restored.status, 200);
}

/* ------------------------------------------------------------------ */
section('12. Rejection path');
{
  const species = (await get('/species')).body.results[0];
  const created = await post('/plants', {
    species_id: species.id, site_name: 'Rejection test plot',
  }, botT);
  const id = created.body.plant.id;

  const note = 'Photographs do not show the diagnostic features. Please re-photograph.';
  const rejected = await post(`/plants/${id}/reject`, { note }, revT);
  eq('rejection succeeds with a note', rejected.status, 200);
  eq('...the status becomes rejected', rejected.body.plant.status, 'rejected');

  const anon = await get('/public/plants/' + id);
  eq('a rejected record is not public', anon.status, 404);

  const mine = (await get('/submissions?status=all&mine=1', botT)).body.results;
  const found = mine.find((s) => s.plant_id === id);
  check('the botanist can see it under their submissions', !!found);
  eq('...with the reviewer note attached', found?.review_comment, note);

  const notes = (await get('/notifications', botT)).body.results;
  check('the botanist was notified of the return',
    notes.some((n) => n.type === 'submission.rejected'));

  /* -------- fix and resubmit (#6) -------- */
  const fixed = await patch(`/plants/${id}`, { site_name: 'Rejection test plot (re-photographed)' }, botT);
  eq('the botanist can correct a returned record', fixed.status, 200);
  eq('a ranger cannot resubmit it', (await post(`/plants/${id}/resubmit`, {}, rangerT)).status, 403);
  eq('a reviewer cannot resubmit it either', (await post(`/plants/${id}/resubmit`, {}, revT)).status, 403);

  const reply = 'Re-photographed the fruit and the bark slash.';
  const resub = await post(`/plants/${id}/resubmit`, { note: reply }, botT);
  eq('the botanist resubmits it', resub.status, 200);
  eq('...and it is pending again', resub.body.plant.status, 'pending');
  eq('resubmitting twice is refused', (await post(`/plants/${id}/resubmit`, {}, botT)).status, 409);

  const queue = (await get('/submissions?status=pending', revT)).body.results;
  const back = queue.find((x) => x.plant_id === id);
  check('it is back in the reviewer queue', !!back);
  eq('...showing what was asked last time', back?.plant?.previous_return?.review_comment, note);
  const pc = typeof back?.proposed_changes === 'string' ? JSON.parse(back.proposed_changes) : back?.proposed_changes;
  eq("...and the botanist's reply", pc?.resubmission_note, reply);

  const ok = await post(`/plants/${id}/approve`, {}, revT);
  eq('the reviewer approves the resubmission', ok.status, 200);
  const history = (await get('/submissions?status=all&mine=1', botT)).body.results.filter((x) => x.plant_id === id);
  check('both decisions are kept, not overwritten',
    history.some((x) => x.status === 'rejected') && history.some((x) => x.status === 'approved'),
    history.map((x) => x.status).join(','));
}

/* ------------------------------------------------------------------ */
section('13. A botanist cannot publish their own record (#8)');
{
  const species = (await get('/species')).body.results[1];
  const created = await post('/plants', {
    species_id: species.id, site_name: 'Botanist direct entry test',
  }, botT);
  eq('the botanist entry is created', created.status, 201);
  eq('...and waits for a reviewer rather than publishing', created.body.plant.status, 'pending');
  check('...with no QR tag yet', !created.body.plant.qr_token);
  eq('the botanist cannot approve it', (await post(`/plants/${created.body.plant.id}/approve`, {}, botT)).status, 403);
  eq('...nor can a second botanist', (await post(`/plants/${created.body.plant.id}/approve`, {}, bot2T)).status, 403);
}

/* ------------------------------------------------------------------ */
section('14. The require_approval setting changes botanist behaviour');
{
  const species = (await get('/species')).body.results[2];

  await patch('/settings/require_approval', { value: false }, adminT);
  const direct = await post('/plants', {
    species_id: species.id, site_name: 'Approval-off test',
  }, botT);
  eq('with approval off, a botanist entry publishes immediately', direct.body.plant.status, 'approved');

  const unlisted = await post('/plants', {
    proposed_species_name: 'Unknown sp. (approval-off test)', site_name: 'Approval-off test 2',
  }, botT);
  eq('...but an unidentified record still needs a reviewer', unlisted.body.plant.status, 'pending');

  await patch('/settings/require_approval', { value: true }, adminT);
  const reviewed = await post('/plants', {
    species_id: species.id, site_name: 'Approval-on test',
  }, botT);
  eq('with approval on, a botanist entry waits for review', reviewed.body.plant.status, 'pending');
}

/* ------------------------------------------------------------------ */
section('15. Search covers the five fields in the proposal');
{
  const sample = (await get('/public/plants')).body.results[0];
  const cases = [
    ['Plant ID', sample.plant_code],
    ['scientific name', sample.scientific_name],
    ['common name', sample.common_name],
    ['family', sample.family],
    ['genus', sample.genus],
    ['location', sample.site_name],
  ];
  for (const [label, term] of cases) {
    if (!term) continue;
    const r = await get('/public/plants?q=' + encodeURIComponent(term));
    check(`search by ${label} finds the record`,
      r.body.results.some((p) => p.id === sample.id),
      `"${term}" returned ${r.body.total} results`);
  }

  const caseInsensitive = await get('/public/plants?q=' + encodeURIComponent(sample.family.toUpperCase()));
  check('search ignores case', caseInsensitive.body.total > 0);

  const nonsense = await get('/public/plants?q=zzzzqqqqxxxx');
  eq('a nonsense search returns nothing rather than everything', nonsense.body.total, 0);

  const empty = await get('/public/plants?q=');
  check('an empty search returns the whole register', empty.body.total > 0);
}

/* ------------------------------------------------------------------ */
section('16. Audit completeness');
{
  const species = (await get('/species')).body.results[3];
  const created = await post('/plants', { species_id: species.id, site_name: 'Audit test plot' }, botT);
  const id = created.body.plant.id;

  // The senior botanist corrects it during review.
  await patch(`/plants/${id}`, { site_name: 'Audit test plot (renamed)', height_m: 12.5 }, revT);

  const hist = await get(`/plants/${id}/history`, botT);
  eq('the botanist can read the history of their own record', hist.status, 200);

  const rev = hist.body.revisions.find((r) => r.field_name === 'site_name');
  check('the field change was recorded', !!rev);
  eq('...with the old value', rev?.old_value, 'Audit test plot');
  eq('...with the new value', rev?.new_value, 'Audit test plot (renamed)');
  check('...with the actor', rev?.changed_by_name === 'Dr Aisyah Rahman', rev?.changed_by_name);
  check('...with a timestamp', !!rev?.created_at);

  const audits = await get('/audit', adminT);
  const entry = audits.body.results.find((a) => a.entity_type === 'plants' && a.entity_id === id);
  check('the change reached the audit trail', !!entry);
  check('every audit entry names an actor', audits.body.results.every((a) => a.user_name));
  check('every audit entry has a timestamp', audits.body.results.every((a) => a.created_at));
}

/* ------------------------------------------------------------------ */
section('17. Admin account management');
{
  const email = `test.user.${Date.now()}@niah.sarawak.gov.my`;
  const created = await post('/users', { full_name: 'Temporary Test User', email, role_id: 2 }, adminT);
  eq('an account is created', created.status, 201);
  check('...and must change its password', created.body.user.must_change_password === true);

  const id = created.body.user.id;
  const newToken = await login(email);
  check('the new account can sign in', !!newToken);

  await patch(`/users/${id}`, { is_active: false }, adminT);
  const afterOff = await get('/plants', newToken);
  eq('deactivating revokes the live session immediately', afterOff.status, 401);

  const loginOff = await post('/auth/login', { email, password: passwordFor(email) });
  eq('...and blocks a fresh sign in', loginOff.status, 403);

  await patch(`/users/${id}`, { is_active: true }, adminT);
  const backOn = await login(email);
  check('reactivating restores access', !!backOn);

  await patch(`/users/${id}`, { role_id: 3 }, adminT);
  const asBotanist = await get('/auth/me', backOn);
  eq('a role change takes effect', asBotanist.body.user.role, 'botanist');
  check('...and brings the new permissions', asBotanist.body.user.permissions.includes('plant.create'));

  const reset = await post(`/users/${id}/reset-password`, {}, adminT);
  eq('a password reset succeeds', reset.status, 200);
  const afterReset = await get('/plants', backOn);
  eq('...and revokes the session', afterReset.status, 401);
}

/* ------------------------------------------------------------------ */
section('17b. Changing your own password');
{
  // A throwaway account, so the seeded passwords the other tests use stay put.
  const email = `test.pw.${Date.now()}@niah.sarawak.gov.my`;
  await post('/users', { full_name: 'Password Test User', email, role_id: 2 }, adminT);
  const tokenA = await login(email);
  const tokenB = await login(email);
  const change = (current_password, new_password, t = tokenA) =>
    post('/auth/password', { current_password, new_password }, t);

  eq('anonymous visitors are refused', (await post('/auth/password', { current_password: 'x', new_password: 'y' })).status, 401);
  const wrong = await change('not-it', 'fresh-pass-9');
  eq('a wrong current password is refused', wrong.status, 400);
  eq('...without signing the user out', (await get('/auth/me', tokenA)).body.user?.email, email);
  eq('a short password is refused', (await change(passwordFor(email), 'ab1')).status, 400);
  eq('a password without a number is refused', (await change(passwordFor(email), 'onlyletters')).status, 400);
  eq('reusing the temporary password is refused', (await change(passwordFor(email), passwordFor(email))).status, 400);

  const ok = await change(passwordFor(email), 'fresh-pass-9');
  eq('a valid change succeeds', ok.status, 200);
  check('...and clears must_change_password', ok.body.user?.must_change_password === false);
  eq('...keeps the session that made the change', (await get('/auth/me', tokenA)).body.user?.email, email);
  eq('...signs out the other device', (await get('/auth/me', tokenB)).body.user, null);
  eq('the old password no longer works', (await post('/auth/login', { email, password: passwordFor(email) })).status, 401);
  check('the new password works', !!await login(email, 'fresh-pass-9'));
  check('...and the change issues a recovery code', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ok.body.recovery_code || ''));
  check('...which the account now reports holding', ok.body.user?.has_recovery_code === true);
}

/* ------------------------------------------------------------------ */
section('17c. Forgotten password - recovery codes');
{
  const email = `test.recover.${Date.now()}@niah.sarawak.gov.my`;
  const made = await post('/users', { full_name: 'Recovery Test User', email, role_id: 2 }, adminT);
  const userId = made.body.user.id;
  const first = await login(email);
  const set = await post('/auth/password', { current_password: passwordFor(email), new_password: 'first-pass-1' }, first);
  const code = set.body.recovery_code;
  const other = await login(email, 'first-pass-1');
  const recover = (body) => post('/auth/recover', body);

  const unknown = await recover({ email: 'nobody@example.com', recovery_code: code, new_password: 'second-pass-2' });
  const wrong = await recover({ email, recovery_code: 'AAAA-BBBB-CCCC', new_password: 'second-pass-2' });
  eq('a wrong code is refused', wrong.status, 400);
  eq('...with the same message as an unknown email', wrong.body.error, unknown.body.error);
  eq('a weak new password is refused even with the right code', (await recover({ email, recovery_code: code, new_password: 'short' })).status, 400);

  // Typed in lower case without the dashes, as someone copying off paper might.
  const ok = await recover({ email, recovery_code: code.toLowerCase().replace(/-/g, ' '), new_password: 'second-pass-2' });
  eq('the right code resets the password', ok.status, 200);
  check('...signs the user in', !!ok.body.token && (await get('/auth/me', ok.body.token)).body.user?.email === email);
  check('...and hands over a different code', !!ok.body.recovery_code && ok.body.recovery_code !== code);
  eq('...which signs out every older session', (await get('/auth/me', other)).body.user, null);
  eq('the old password no longer works', (await post('/auth/login', { email, password: 'first-pass-1' })).status, 401);
  eq('a used code cannot be used again', (await recover({ email, recovery_code: code, new_password: 'third-pass-3' })).status, 400);

  const regen = await post('/auth/recovery-code', { current_password: 'second-pass-2' }, ok.body.token);
  eq('a signed-in user can make a new code', regen.status, 200);
  eq('...but only with their current password', (await post('/auth/recovery-code', { current_password: 'nope' }, ok.body.token)).status, 400);
  eq('...which replaces the previous one', (await recover({ email, recovery_code: ok.body.recovery_code, new_password: 'third-pass-3' })).status, 400);

  // Wrong codes share the five-attempt lockout with wrong passwords.
  // The failure above already counted once; reset the count first.
  await post(`/users/${userId}/unlock`, {}, adminT);
  let last;
  for (let i = 0; i < 5; i += 1) last = await recover({ email, recovery_code: 'ZZZZ-ZZZZ-ZZZZ', new_password: 'third-pass-3' });
  eq('five wrong codes lock the account', last.status, 423);
  eq('...and while locked even the right code is refused', (await recover({ email, recovery_code: regen.body.recovery_code, new_password: 'third-pass-3' })).status, 423);

  await post(`/users/${userId}/reset-password`, {}, adminT);
  const afterReset = (await get('/users', adminT)).body.results?.find((u) => u.id === userId);
  check('an administrator reset clears the recovery code', afterReset && afterReset.has_recovery_code === false);
}

/* ------------------------------------------------------------------ */
section('17d. Forgotten password, no recovery code - an administrator approves');
{
  const email = `test.askreset.${Date.now()}@niah.sarawak.gov.my`;
  const made = await post('/users', { full_name: 'Ask Reset Test User', email, role_id: 2 }, adminT);
  const userId = made.body.user.id;
  const unread = async () => (await get('/notifications', adminT)).body.results
    .filter((n) => n.type === 'password.reset_request' && Number(n.related_id) === userId).length;
  const status = async (token) => (await post('/auth/reset-request/status', { token })).body.status;
  const listed = async () => (await get('/users', adminT)).body.results.find((u) => u.id === userId);

  eq('an empty email is refused', (await post('/auth/reset-request', { email: '' })).status, 400);
  const unknown = await post('/auth/reset-request', { email: 'nobody@example.com' });
  const asked = await post('/auth/reset-request', { email });
  eq('a request is accepted', asked.status, 200);
  check('...and gives the screen a six-digit code and a secret', /^\d{6}$/.test(asked.body.code) && asked.body.token?.length >= 32);
  check('...shaped exactly like the answer for an unknown email',
    JSON.stringify(Object.keys(asked.body).sort()) === JSON.stringify(Object.keys(unknown.body).sort()));
  eq('the administrators are notified', await unread(), 1);
  check('...and the account shows the request', !!(await listed())?.reset_requested_at);
  eq('the screen is waiting', await status(asked.body.token), 'pending');
  eq('...and cannot set a password before approval',
    (await post('/auth/reset-request/complete', { token: asked.body.token, new_password: 'approved-pass-1' })).status, 400);

  // A second press replaces the first; only the newest screen can win.
  const second = await post('/auth/reset-request', { email });
  eq('pressing it again does not notify again', await unread(), 1);
  eq('...and the older screen stops waiting', await status(asked.body.token), 'closed');

  const wrongCode = second.body.code === '000000' ? '111111' : '000000';
  eq('only an administrator can approve', (await post(`/users/${userId}/reset-request/approve`, { code: second.body.code }, botT)).status, 403);
  const wrong = await post(`/users/${userId}/reset-request/approve`, { code: wrongCode }, adminT);
  eq('the wrong code is refused', wrong.status, 400);
  eq('...saying how many tries are left', wrong.body.attempts_left, 4);
  // Read out with a space, as it is shown on the screen.
  const code = second.body.code.slice(0, 3) + ' ' + second.body.code.slice(3);
  eq('the code from their screen approves it', (await post(`/users/${userId}/reset-request/approve`, { code }, adminT)).status, 200);
  eq('...the waiting screen sees the approval', await status(second.body.token), 'approved');
  check('...and the badge clears', (await listed())?.reset_requested_at === null);

  eq('another browser cannot use the approval', (await post('/auth/reset-request/complete', { token: asked.body.token, new_password: 'approved-pass-1' })).status, 400);
  eq('a weak new password is still refused', (await post('/auth/reset-request/complete', { token: second.body.token, new_password: 'weak' })).status, 400);
  const done = await post('/auth/reset-request/complete', { token: second.body.token, new_password: 'approved-pass-1' });
  eq('the approved screen sets the new password', done.status, 200);
  check('...signs the user in', (await get('/auth/me', done.body.token)).body.user?.email === email);
  check('...and hands over a recovery code', !!done.body.recovery_code);
  check('the new password works', !!await login(email, 'approved-pass-1'));
  eq('the approval cannot be used twice', (await post('/auth/reset-request/complete', { token: second.body.token, new_password: 'another-pass-2' })).status, 400);

  // Refusing, and refusing itself after too many wrong codes.
  const third = await post('/auth/reset-request', { email });
  eq('an administrator can refuse a request', (await post(`/users/${userId}/reset-request/deny`, {}, adminT)).status, 200);
  eq('...and the screen is told', await status(third.body.token), 'denied');
  const fourth = await post('/auth/reset-request', { email });
  const bad = fourth.body.code === '000000' ? '111111' : '000000';
  let last;
  for (let i = 0; i < 5; i += 1) last = await post(`/users/${userId}/reset-request/approve`, { code: bad }, adminT);
  check('five wrong codes refuse the request', last.status === 400 && (await status(fourth.body.token)) === 'denied');

  // Leaving the screen after approval - a refresh - throws the approval away.
  await post(`/users/${userId}/unlock`, {}, adminT);
  const left = await post('/auth/reset-request', { email });
  await post(`/users/${userId}/reset-request/approve`, { code: left.body.code }, adminT);
  eq('an approved screen that is refreshed or closed is cancelled', (await post('/auth/reset-request/cancel', { token: left.body.token })).status, 200);
  eq('...the request is closed', await status(left.body.token), 'closed');
  eq('...and the approval can no longer set a password',
    (await post('/auth/reset-request/complete', { token: left.body.token, new_password: 'left-pass-1' })).status, 400);

  // The old way still works as a fallback, and closes anything waiting.
  const fifth = await post('/auth/reset-request', { email });
  await post(`/users/${userId}/reset-password`, {}, adminT);
  eq('an administrator reset closes a waiting request', await status(fifth.body.token), 'closed');
  check('...and the temporary password then works', !!await login(email, passwordFor(email)));
}

/* ------------------------------------------------------------------ */
section("17e. An administrator's recovery email");
{
  // Codes are read from the outbox the server writes when no mail account is
  // set up. With real email configured there is no outbox, so this is skipped.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const outbox = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.outbox.log');
  const lastCodeTo = (address) => {
    const lines = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n') : [];
    const mail = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.to === address).pop();
    const m = mail?.text.match(/(\d{3}) (\d{3})/);
    return m ? m[1] + m[2] : null;
  };

  const ts = Date.now();
  const email = `test.admin.${ts}@niah.sarawak.gov.my`;
  const backup = `test.admin.backup.${ts}@example.com`;
  const made = await post('/users', { full_name: 'Recovery Email Admin', email, role_id: 1 }, adminT);
  const first = await login(email);
  await post('/auth/password', { current_password: passwordFor(email), new_password: 'admin-pass-1' }, first);
  const tok = await login(email, 'admin-pass-1');

  eq('a non-administrator cannot add one', (await post('/auth/recovery-email', { email: backup, current_password: passwordFor(BOTANIST) }, botT)).status, 403);
  eq('the current password is required', (await post('/auth/recovery-email', { email: backup, current_password: 'nope' }, tok)).status, 400);
  eq('the sign-in address cannot be its own backup', (await post('/auth/recovery-email', { email, current_password: 'admin-pass-1' }, tok)).status, 400);
  const start = await post('/auth/recovery-email', { email: backup, current_password: 'admin-pass-1' }, tok);
  eq('a code is sent to the new address', start.status, 200);

  if (start.body.delivery !== 'terminal') {
    check('(skipped: real email is configured, so codes cannot be read here)', true);
  } else {
    eq('asking again at once is refused', (await post('/auth/recovery-email', { email: backup, current_password: 'admin-pass-1' }, tok)).status, 429);
    check('...and nothing is saved until the code comes back', (await get('/auth/me', tok)).body.user.recovery_email === null);
    eq('a wrong code does not confirm it', (await post('/auth/recovery-email/confirm', { code: '000000' }, tok)).status === 400
      && lastCodeTo(backup) !== '000000', true);
    const confirmed = await post('/auth/recovery-email/confirm', { code: lastCodeTo(backup) }, tok);
    eq('the emailed code confirms it', confirmed.status, 200);
    check('...and it is shown masked', /^te\*\*\*@example\.com$/.test(confirmed.body.user?.recovery_email || ''), confirmed.body.user?.recovery_email);

    const unknown = await post('/auth/email-reset', { email: 'nobody@example.com' });
    const asked = await post('/auth/email-reset', { email });
    eq('a forgotten password sends a reset code', asked.status, 200);
    check('...with the same answer as an unknown email', JSON.stringify(asked.body) === JSON.stringify(unknown.body));
    const resetCode = lastCodeTo(backup);
    check('...to the recovery address', !!resetCode);

    const complete = (code, pw) => post('/auth/email-reset/complete', { email, code, new_password: pw });
    eq('a weak password is refused without spending the code', (await complete(resetCode, 'weak')).status, 400);
    const wrong = resetCode === '000000' ? '111111' : '000000';
    eq('a wrong code is refused', (await complete(wrong, 'admin-pass-2')).status, 400);
    const done = await complete(resetCode, 'admin-pass-2');
    eq('the right code sets the new password', done.status, 200);
    check('...signs the administrator in', (await get('/auth/me', done.body.token)).body.user?.email === email);
    eq('...and signs out the old sessions', (await get('/auth/me', tok)).body.user, null);
    check('the new password works', !!await login(email, 'admin-pass-2'));
    eq('the code cannot be used twice', (await complete(resetCode, 'admin-pass-3')).status, 400);

    // Rangers and the rest use recovery codes or approval, not email.
    const ranger = await post('/auth/email-reset', { email: RANGER });
    check('a non-administrator gets the same answer, and no email', ranger.status === 200 && lastCodeTo(RANGER) === null);
  }
  await patch(`/users/${made.body.user.id}`, { is_active: false }, adminT);
}

/* ------------------------------------------------------------------ */
section('17f. Two-step verification with an authenticator app');
{
  // The test plays the phone: it works codes out from the secret the same way the app does.
  const { _codeAt } = await import(new URL('../Server/totp.js', import.meta.url));
  const email = `test.twofa.${Date.now()}@niah.sarawak.gov.my`;
  const made = await post('/users', { full_name: 'Two Step Test User', email, role_id: 2 }, adminT);
  const userId = made.body.user.id;
  const first = await login(email);
  const changed = await post('/auth/password', { current_password: passwordFor(email), new_password: 'twofa-pass-1' }, first);
  const recoveryCode = changed.body.recovery_code;
  const tok = await login(email, 'twofa-pass-1');

  eq('setting up needs the current password', (await post('/auth/2fa/setup', { current_password: 'nope' }, tok)).status, 400);
  const setup = await post('/auth/2fa/setup', { current_password: 'twofa-pass-1' }, tok);
  eq('setup gives a QR code', setup.status, 200);
  check('...as an image, with the key to type by hand', /^data:image\/png/.test(setup.body.qr) && /^[A-Z2-7 ]{32,}$/.test(setup.body.secret));
  check('...encoding an authenticator link for FloraScan', /^otpauth:\/\/totp\/FloraScan/.test(setup.body.uri));
  const secret = setup.body.secret.replace(/ /g, '');

  eq('a wrong code does not turn it on', (await post('/auth/2fa/enable', { code: '000000' }, tok)).status === 400
    || _codeAt(secret, -1) === '000000', true);
  check('...so it is still off', (await get('/auth/me', tok)).body.user.two_factor === false);
  const on = await post('/auth/2fa/enable', { code: _codeAt(secret, -1) }, tok);
  eq('the code from the app turns it on', on.status, 200);
  check('...and the account says so', on.body.user?.two_factor === true);

  const step1 = await post('/auth/login', { email, password: 'twofa-pass-1' });
  check('now the right password alone does not sign in', step1.status === 200 && step1.body.two_factor === true && !step1.body.token);
  const wrong = await post('/auth/login/2fa', { ticket: step1.body.ticket, code: _codeAt(secret, 0) === '000000' ? '111111' : '000000' });
  eq('a wrong code is refused', wrong.status, 400);
  eq('...saying how many tries are left', wrong.body.attempts_left, 4);
  const code = _codeAt(secret, 0);
  const step2 = await post('/auth/login/2fa', { ticket: step1.body.ticket, code });
  eq('password and the current code sign in', step2.status, 200);
  check('...as the right person', (await get('/auth/me', step2.body.token)).body.user?.email === email);
  const again = await post('/auth/login', { email, password: 'twofa-pass-1' });
  eq('the same code cannot be used twice', (await post('/auth/login/2fa', { ticket: again.body.ticket, code })).status, 400);
  eq('a made-up ticket is refused', (await post('/auth/login/2fa', { ticket: 'nope', code })).status, 400);

  const recovered = await post('/auth/recover', { email, recovery_code: recoveryCode, new_password: 'twofa-pass-2' });
  check('a password reset does not get round it - no session, sign in again',
    recovered.status === 200 && !recovered.body.token && recovered.body.sign_in_again === true);

  const fresh = (await post('/auth/login/2fa', {
    ticket: (await post('/auth/login', { email, password: 'twofa-pass-2' })).body.ticket, code: _codeAt(secret, 1),
  })).body.token;
  eq('turning it off needs a current code too', (await post('/auth/2fa/disable', { current_password: 'twofa-pass-2', code: '000000' }, fresh)).status, 400);
  // Turned off by an administrator's reset instead - the lost-phone route.
  await post(`/users/${userId}/reset-password`, {}, adminT);
  const listed = (await get('/users', adminT)).body.results.find((u) => u.id === userId);
  check('an administrator reset turns it off, for a lost phone', listed && listed.two_factor === false);
  check('...and the temporary password then signs in directly', !!await login(email, passwordFor(email)));

  // The audit trail: values as objects (not text), and who it came from.
  const entry = (await get('/audit?action=two_factor_enabled', adminT)).body.results.find((r) => r.entity_id === userId);
  check('the audit trail records turning it on', !!entry);
  check('...with its values as data, not text', entry && typeof entry.new_values === 'object' && entry.new_values.two_factor === 1,
    JSON.stringify(entry?.new_values));
  check('...and the real caller, not a placeholder', entry && entry.user_agent !== 'Prototype X demo' && !!entry.ip_address,
    `${entry?.ip_address} / ${entry?.user_agent}`);
  await patch(`/users/${userId}`, { is_active: false }, adminT);
}

/* ------------------------------------------------------------------ */
section('18. QR codes');
{
  const plant = (await get('/public/plants')).body.results[0];
  // Staff only: the reply names the plant even before it is published.
  eq('signed out, nobody can fetch a QR code', (await get(`/qr/${plant.id}`)).status, 401);
  eq('a ranger (no plant permission) cannot', (await get(`/qr/${plant.id}`, rangerT)).status, 403);
  eq('an administrator (no plant permission) cannot', (await get(`/qr/${plant.id}`, adminT)).status, 403);
  const qr = await get(`/qr/${plant.id}`, botT);
  eq('a QR payload is returned', qr.status, 200);
  check('...as a PNG data URL', (qr.body.png || '').startsWith('data:image/png;base64,'));
  check('...and as SVG', (qr.body.svg || '').includes('<svg'));
  check('the target URL contains the opaque token', (qr.body.target_url || '').includes(qr.body.qr_token));
  check('the token is a UUID, not a database id',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(qr.body.qr_token || ''));

  const again = await get(`/qr/${plant.id}`, botT);
  eq('the token is stable across requests', again.body.qr_token, qr.body.qr_token);

  // A botanist only registers plant records, but still prints tags: the tag
  // sheet lists every published plant, and nothing unpublished of others.
  const sheetBot = (await get('/plants?status=approved', botT)).body.results;
  const sheetAll = (await get('/plants?status=approved', revT)).body.results;
  eq('the tag sheet lists every published plant for a botanist', sheetBot.length, sheetAll.length);
  const othersPending = (await get('/plants?status=pending', revT)).body.results
    .find((p) => p.registered_by_name !== 'Dr Grace Lim');
  if (othersPending) {
    eq("...but a botanist cannot fetch the tag of someone else's unpublished record",
      (await get(`/qr/${othersPending.id}`, botT)).status, 403);
  }
}

/* ------------------------------------------------------------------ */
section('19. Connect endpoint');
{
  // Generated stand-in drawings were removed: a plant with no photo gets none.
  const res = await fetch(`${ORIGIN}/api/photos/test-species--leaf--1.svg`);
  eq('no generated drawing is served', res.status, 404);

  const conn = await get('/connect');
  eq('the connect endpoint answers', conn.status, 200);
  check('...with a LAN URL', /^https?:\/\/[\d.]+:\d+$/.test(conn.body.url || ''), conn.body.url);
  check('...and a scannable QR', (conn.body.png || '').startsWith('data:image/png'));
}

/* ------------------------------------------------------------------ */
section('20. IoT monitoring');
{
  const r = await get('/sensors', botT);
  eq('the sensors endpoint answers', r.status, 200);
  eq('...and reports the feature as live', r.body.status, 'live');
  check('...listing the seeded real-kit node', r.body.devices.some((d) => d.device_code === 'SN-001'));
  // The kit may be switched on and publishing during the run, so readings can
  // exist; each one must come from a registered device.
  const ids = new Set(r.body.devices.map((d) => d.id));
  check('...with no readings from unknown devices', r.body.readings.every((x) => ids.has(x.device_id)));

  // The same permissions as the IoT page: sensor.view to read, alert.resolve to resolve.
  eq('a ranger can read the sensors', (await get('/sensors', rangerT)).status, 200);
  eq('a reviewer, who has no sensor.view, cannot', (await get('/sensors', revT)).status, 403);
  eq('signed out, nobody can', (await get('/sensors')).status, 401);
  eq('a botanist cannot resolve an alert (no alert.resolve)',
    (await post('/sensors/alerts/999999/resolve', { note: 'x' }, botT)).status, 403);
  eq('a ranger can, and gets a 404 for an alert that does not exist',
    (await post('/sensors/alerts/999999/resolve', { note: 'x' }, rangerT)).status, 404);
}

/* ------------------------------------------------------------------ */
section('20b. AI camera alerts reach the rangers, with the snapshot');
{
  // A real (1 x 1) JPEG; the server checks the JPEG signature.
  const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const camera = (headers, body) => fetch(ORIGIN + '/api/camera/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  // The key Server/seed.js gave CAM-001: FLORAGUARD_CAMERA_KEY from the
  // environment or .env (as the seed read it), else the demo default.
  const cameraKey = process.env.FLORAGUARD_CAMERA_KEY || await (async () => {
    const fs = await import('node:fs');
    try {
      const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split(/\r?\n/).find((l) => /^\s*FLORAGUARD_CAMERA_KEY\s*=/.test(l));
      return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    } catch { return ''; }
  })() || 'demo-camera-key-change-me';
  const signed = { 'X-Camera-Code': 'CAM-001', 'X-Camera-Key': cameraKey };
  const event = { tier: 'ALERT', track_id: 7, detail: 'touch 0.91 (test)', photo: JPEG };

  eq('no camera key: refused', (await camera({}, event)).status, 401);
  eq('a wrong key: refused', (await camera({ ...signed, 'X-Camera-Key': 'guess' }, event)).status, 401);
  eq('an unknown camera: the same answer', (await camera({ ...signed, 'X-Camera-Code': 'CAM-999' }, event)).status, 401);
  eq('a staff session is not a camera key', (await call('POST', '/camera/alerts', { token: rangerT, body: event })).status, 401);
  eq('a warning tier (no picture) is refused', (await camera(signed, { ...event, tier: 'WARNING' })).status, 400);
  eq('a picture that is not a JPEG is refused',
    (await camera(signed, { ...event, photo: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400);
  eq('no picture is refused', (await camera(signed, { ...event, photo: '' })).status, 400);
  const big = Buffer.alloc(950 * 1024, 0); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  eq('a snapshot over 900 KB is refused', (await camera(signed, { ...event, photo: big.toString('base64') })).status, 413);

  const made = await camera(signed, event);
  eq('the camera reports an alert with its snapshot', made.status, 201);
  const id = made.body?.id;
  check('...and gets the alert id back', Number.isInteger(id), JSON.stringify(made.body));

  const told = (notes) => (notes.body?.results || []).find((n) => n.related_type === 'camera_alert' && n.related_id === id);
  const forRanger = told(await get('/notifications', rangerT));
  check('the ranger is notified', !!forRanger);
  eq('...as a camera alert', forRanger?.type, 'camera.alert');
  check('...titled with the camera', /^Camera alert: CAM-001$/.test(forRanger?.title || ''), forRanger?.title);
  check('the botanist is not notified', !told(await get('/notifications', botT)));
  check('the administrator is not notified', !told(await get('/notifications', adminT)));
  check('the reviewer is not notified', !told(await get('/notifications', revT)));

  const photo = (t) => fetch(`${ORIGIN}/api/sensors/camera-alerts/${id}/photo`, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  const asRanger = await photo(rangerT);
  eq('the ranger can open the snapshot', asRanger.status, 200);
  eq('...served as a JPEG', asRanger.headers.get('content-type'), 'image/jpeg');
  check('...never kept by a shared cache', /no-store/.test(asRanger.headers.get('cache-control') || ''), asRanger.headers.get('cache-control'));
  eq('...byte for byte what the camera sent',
    Buffer.from(await asRanger.arrayBuffer()).toString('base64'), Buffer.from(JPEG, 'base64').toString('base64'));
  eq('signed out, nobody can open it', (await photo()).status, 401);
  eq('a reviewer (no sensor.view) cannot', (await photo(revT)).status, 403);
  eq('an administrator (no sensor.view) cannot', (await photo(adminT)).status, 403);

  const dash = await get('/sensors', rangerT);
  const listed = dash.body?.camera_alerts?.find((a) => a.id === id);
  check('the IoT dashboard lists it as open', listed?.status === 'open', JSON.stringify(listed));
  check('...without the picture bytes in the list', listed && !('photo' in listed));
  eq('...pointing at the protected picture', listed?.photo_url, `/api/sensors/camera-alerts/${id}/photo`);

  eq('a botanist cannot resolve a camera alert', (await post(`/sensors/camera-alerts/${id}/resolve`, {}, botT)).status, 403);
  const done = await post(`/sensors/camera-alerts/${id}/resolve`, { note: 'Visitor reminded not to touch' }, rangerT);
  eq('the ranger resolves it', done.status, 200);
  eq('...with the note', done.body?.alert?.resolution_note, 'Visitor reminded not to touch');
  eq('resolving it twice is refused', (await post(`/sensors/camera-alerts/${id}/resolve`, {}, rangerT)).status, 409);

  // With no mail account configured the server writes each email to the outbox.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const outbox = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.outbox.log');
  if (fs.existsSync(outbox)) {
    let mails = [];
    for (let i = 0; i < 30 && !mails.length; i++) {
      mails = fs.readFileSync(outbox, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((m) => m && /camera alert/i.test(m.subject) && (m.attachments || []).some((a) => a.filename === `camera-alert-${id}.jpg`));
      if (!mails.length) await new Promise((r) => setTimeout(r, 100));
    }
    check('the ranger is emailed, with the snapshot attached', mails.some((m) => m.to === RANGER && m.attachments[0].bytes > 0), JSON.stringify(mails.map((m) => m.to)));
    check('...and nobody without alert.resolve is', !mails.some((m) => [ADMIN, BOTANIST, BOTANIST_2, REVIEWER].includes(m.to)));
  }
}

/* ------------------------------------------------------------------ */
section('21. Threatened species locations are withheld from the public');
{
  const setting = (await get('/settings', adminT)).body.results.find((s) => s.setting_key === 'protect_locations');
  check('the protect_locations setting exists', !!setting);
  eq('...and defaults to CR', setting?.setting_value, 'CR');

  const pub = (await get('/public/plants?conservation=CR')).body.results;
  check('there are critically endangered records to check', pub.length > 0, pub.length + ' found');

  for (const p of pub) {
    check(`${p.plant_code} is flagged as protected`, p.location_protected === true);
    eq(`${p.plant_code} latitude withheld`, p.latitude, null);
    eq(`${p.plant_code} longitude withheld`, p.longitude, null);
    eq(`${p.plant_code} gps accuracy withheld`, p.gps_accuracy_m, null);
    eq(`${p.plant_code} finding notes withheld`, p.location_notes, null);
    check(`${p.plant_code} site name replaced`, p.site_name === 'Location withheld', p.site_name);
  }

  // The detail endpoint and the QR path must apply the same rule.
  const one = pub[0];
  const detail = await get('/public/plants/' + one.id);
  eq('the detail endpoint withholds the coordinates too', detail.body.plant.latitude, null);
  check('...and explains why', !!detail.body.plant.location_withheld_reason);

  if (one.qr_token) {
    const scan = await get('/public/plants/token/' + one.qr_token);
    eq('scanning the tag also withholds the location', scan.body.plant.latitude, null);
  }

  // Staff must still be able to find the plant.
  const staffView = (await get('/plants?conservation=CR', botT)).body.results;
  check('a botanist still sees real coordinates', staffView.some((p) => p.latitude !== null));
  check('...and the real site name', staffView.every((p) => p.site_name !== 'Location withheld'));

  // Non-threatened records are unaffected.
  const lc = (await get('/public/plants?conservation=LC')).body.results;
  check('least-concern records keep their location', lc.some((p) => p.latitude !== null));
  check('...and are not flagged as protected', lc.every((p) => !p.location_protected));
}

/* ------------------------------------------------------------------ */
section('22. The protection does not leak through search or filters');
{
  // Find a protected plant and the real site it stands on.
  const staffCR = (await get('/plants?conservation=CR', botT)).body.results;
  // Must be a published record, or it would be absent from the public
  // register for an entirely different reason and prove nothing.
  const publicIds = new Set((await get('/public/plants?conservation=CR')).body.results.map((p) => p.id));
  const target = staffCR.find((p) => publicIds.has(p.id) && p.site_name && p.latitude !== null);
  check('a protected plant with a known site was found', !!target);

  if (target) {
    const bySite = await get('/public/plants?q=' + encodeURIComponent(target.site_name));
    check('searching its trail name does not return it',
      !bySite.body.results.some((p) => p.id === target.id),
      'leaked via free-text search');

    const byFilter = await get('/public/plants?site=' + encodeURIComponent(target.site_name));
    check('filtering by that site does not return it',
      !byFilter.body.results.some((p) => p.id === target.id),
      'leaked via the site filter');

    const byCode = await get('/public/plants?q=' + encodeURIComponent(target.plant_code));
    const found = byCode.body.results.find((p) => p.id === target.id);
    check('it is still findable by Plant ID', !!found, 'should remain searchable by its own code');
    eq('...but still without a location', found?.latitude, null);

    // Staff searching the same site do get it.
    const staffSearch = await get('/plants?q=' + encodeURIComponent(target.site_name), botT);
    check('a botanist searching that site does find it',
      staffSearch.body.results.some((p) => p.id === target.id));
  }
}

/* ------------------------------------------------------------------ */
section('23. The protection threshold is configurable');
{
  const crPlant = (await get('/public/plants?conservation=CR')).body.results[0];

  await patch('/settings/protect_locations', { value: 'off' }, adminT);
  const off = (await get('/public/plants/' + crPlant.id)).body.plant;
  check('with protection off the location is published', off.latitude !== null);
  check('...and the flag is gone', !off.location_protected);

  await patch('/settings/protect_locations', { value: 'VU' }, adminT);
  const vu = (await get('/public/plants?conservation=VU')).body.results;
  if (vu.length) {
    check('raising it to VU protects vulnerable species too', vu.every((p) => p.location_protected));
  }
  const stillCr = (await get('/public/plants/' + crPlant.id)).body.plant;
  check('...and critically endangered stays protected', stillCr.location_protected === true);

  const lcAtVu = (await get('/public/plants?conservation=LC')).body.results;
  check('...while least concern is still published', lcAtVu.some((p) => p.latitude !== null));

  // Put it back the way the demo expects.
  await patch('/settings/protect_locations', { value: 'CR' }, adminT);
  const restored = (await get('/public/plants/' + crPlant.id)).body.plant;
  eq('the setting is restored to CR', restored.location_protected, true);
}

/* ------------------------------------------------------------------ */
section('24. Imported species data and photographs');
{
  const boot = (await get('/bootstrap')).body;
  check('the register reports where its data came from', !!boot.data);
  check('...naming GBIF, iNaturalist and Wikipedia',
    (boot.data.sources || []).length >= 3 || boot.data.source === 'curated',
    JSON.stringify(boot.data.sources));

  const sp = (await get('/species')).body.results;
  check('the species list is substantial', sp.length >= 20, sp.length + ' species');
  check('every species has a family', sp.every((s) => s.family));
  check('every species has a conservation code', sp.every((s) => s.conservation_code));

  if (boot.data.source === 'imported') {
    check('conservation categories cite their source',
      sp.some((s) => (s.conservation_source || '').includes('IUCN')));

    const withPhotos = (await get('/public/plants')).body.results.filter((p) => p.photo);
    check('published records carry photographs', withPhotos.length > 0, withPhotos.length + ' with photos');

    const real = withPhotos.filter((p) => p.photo.includes('/api/photos/file/') || p.photo.startsWith('http'));
    check('...and they are real photographs, not only illustrations', real.length > 0);
    check('real photographs are credited', real.some((p) => p.photo_credit));

    const detail = (await get('/public/plants/' + real[0].id)).body.plant;
    const credited = detail.photos.filter((ph) => ph.credit);
    check('each credited photograph names a licence', credited.every((ph) => ph.license));
    check('...and links back to its source', credited.every((ph) => ph.source_url));
  }
}

/* ------------------------------------------------------------------ */
section('25. Photo serving');
{
  const plants = (await get('/public/plants')).body.results;
  const local = plants.find((p) => p.photo && p.photo.includes('/api/photos/file/'));

  if (local) {
    const name = local.photo.split('/').pop();
    const res = await fetch(`${BASE}/photos/file/${name}`);
    eq('a cached photograph is served', res.status, 200);
    check('...as a JPEG', (res.headers.get('content-type') || '').includes('jpeg'));
    check('...and is cacheable', (res.headers.get('cache-control') || '').includes('max-age'));
  }

  const missing = await fetch(`${BASE}/photos/file/definitely-not-here.jpg`);
  eq('a missing photograph returns 404', missing.status, 404);

  // Path traversal must not reach outside the photo directory.
  for (const evil of ['..%2F..%2Fpackage.json', '..%5C..%5Cpackage.json', '%2Fetc%2Fpasswd']) {
    const res = await fetch(`${BASE}/photos/file/${evil}`);
    check(`traversal attempt "${decodeURIComponent(evil)}" is refused`,
      res.status === 404 || res.status === 400, 'got ' + res.status);
  }

  const svg = await fetch(`${BASE}/photos/some-species--leaf--1.svg`);
  eq('generated stand-in drawings are no longer served', svg.status, 404);
}

/* ------------------------------------------------------------------ */
section('26. Installable web app');
{
  const origin = `${ORIGIN}`;

  const manifestRes = await fetch(`${origin}/manifest.webmanifest`);
  eq('the manifest is served', manifestRes.status, 200);
  const manifest = await manifestRes.json();
  check('it has a name', !!manifest.name);
  check('it has a short name for the home screen', !!manifest.short_name);
  eq('it opens standalone', manifest.display, 'standalone');
  check('it declares a start URL', !!manifest.start_url);
  check('it has a 192px icon', manifest.icons.some((i) => i.sizes === '192x192'));
  check('it has a 512px icon', manifest.icons.some((i) => i.sizes === '512x512'));
  check('it has a maskable icon for Android', manifest.icons.some((i) => i.purpose === 'maskable'));

  for (const icon of manifest.icons) {
    const r = await fetch(origin + icon.src);
    check(`icon ${icon.src} exists`, r.status === 200, 'got ' + r.status);
  }

  const apple = await fetch(`${origin}/icons/apple-touch-icon.png`);
  eq('the iOS touch icon exists', apple.status, 200);

  const sw = await fetch(`${origin}/sw.js`);
  eq('the service worker is served', sw.status, 200);
  const swText = await sw.text();
  check('...and never caches write requests', swText.includes("request.method !== 'GET'"));

  const html = await (await fetch(origin + '/')).text();
  check('the page links the manifest', html.includes('manifest.webmanifest'));
  check('...declares an apple touch icon', html.includes('apple-touch-icon'));
  check('...and sets apple-mobile-web-app-capable', html.includes('apple-mobile-web-app-capable'));
}

/* ------------------------------------------------------------------ */
section('27. A phone can trust the local certificate');
if (!ORIGIN.startsWith('https:')) {
  console.log('  (skipped: the server is on plain HTTP)');
} else {
  const { X509Certificate } = await import('node:crypto');
  const tls = await import('node:tls');
  const https = await import('node:https');

  const conn = await get('/connect');
  eq('the connect screen is told where the certificate is', conn.body.ca_url, '/florascan-ca.crt');

  const res = await fetch(ORIGIN + '/florascan-ca.crt');
  eq('the CA certificate downloads', res.status, 200);
  eq('...with the type iOS installs as a profile', res.headers.get('content-type'), 'application/x-x509-ca-cert');
  const der = Buffer.from(await res.arrayBuffer());
  check('...and never the private key', !der.toString('latin1').includes('PRIVATE KEY'));

  let ca = null;
  try { ca = new X509Certificate(der); } catch { /* reported below */ }
  check('it is a certificate authority', !!ca?.ca, ca ? ca.subject : 'not a certificate');

  const port = new URL(ORIGIN).port;
  const peer = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: 'localhost', port, rejectUnauthorized: false, servername: 'localhost' }, () => {
      resolve(new X509Certificate(s.getPeerCertificate().raw)); s.end();
    });
    s.on('error', reject);
  });
  check('the server certificate is signed by it', !!ca && peer.checkIssued(ca) && peer.verify(ca.publicKey));
  check('...is for TLS servers', (peer.keyUsage || []).includes('1.3.6.1.5.5.7.3.1'), String(peer.keyUsage));
  const days = (new Date(peer.validTo) - new Date(peer.validFrom)) / 86400000;
  check('...and lives under the 825 days iOS allows', days <= 825, Math.round(days) + ' days');

  // What the phone does: reach the LAN address and verify strictly against the CA alone.
  const lanHost = new URL(conn.body.url).hostname;
  const strict = (host) => new Promise((resolve) => {
    https.get({ host, port, path: '/api/bootstrap', ca: ca?.toString(), rejectUnauthorized: true, agent: false }, (r) => {
      r.resume(); resolve(r.statusCode);
    }).on('error', (e) => resolve(e.code || e.message));
  });
  eq(`a client trusting only the CA reaches ${lanHost}`, await strict(lanHost), 200);
  eq('...and localhost', await strict('localhost'), 200);
}

/* ------------------------------------------------------------------ */
section('28. A printed tag points somewhere a phone can reach');
{
  const plant = (await get('/public/plants?limit=1')).body.results[0];

  // The address must never come from the browser that asked for the code: a
  // botanist printing tags is on localhost, and a tag encoding localhost sends
  // every phone that scans it to its own device.
  const spoofed = await get(`/qr/${plant.id}?origin=${encodeURIComponent('https://localhost:9999')}`, botT);
  eq('a QR code is produced', spoofed.status, 200);
  check('the caller cannot dictate the address', !spoofed.body.target_url.includes('localhost:9999'),
    spoofed.body.target_url);

  const url = new URL(spoofed.body.target_url);
  check('the tag never encodes a loopback address',
    !/^(localhost|127\.|::1)/.test(url.hostname), url.hostname);
  check('...and it carries the opaque token', url.pathname.includes(spoofed.body.qr_token));

  const plain = await get(`/qr/${plant.id}`, botT);
  eq('the address is the same with no origin given', plain.body.target_url, spoofed.body.target_url);

  // Following the encoded URL has to land on that plant.
  const token = url.pathname.split('/p/')[1];
  const scan = await get('/public/plants/token/' + token);
  eq('following the tag resolves the record', scan.status, 200);
  eq('...and it is the right plant', scan.body.plant.plant_code, plant.plant_code);

  // A park with a real domain configures it, and tags then carry that instead.
  await patch('/settings/public_base_url', { value: 'https://florascan.example.gov.my' }, adminT);
  const configured = await get(`/qr/${plant.id}`, botT);
  check('a configured public address wins',
    configured.body.target_url.startsWith('https://florascan.example.gov.my/p/'),
    configured.body.target_url);

  await patch('/settings/public_base_url', { value: 'https://florascan.example.gov.my/' }, adminT);
  const trailing = await get(`/qr/${plant.id}`, botT);
  check('a trailing slash does not double up',
    !trailing.body.target_url.includes('//p/'), trailing.body.target_url);

  await patch('/settings/public_base_url', { value: '' }, adminT);
  const back = await get(`/qr/${plant.id}`, botT);
  check('clearing it falls back to the network address',
    !back.body.target_url.includes('example.gov.my'), back.body.target_url);
}

/* ------------------------------------------------------------------ */
section('29. Apple touch icons');
{
  const html = await (await fetch(ORIGIN + '/')).text();

  // iOS picks by `sizes`; a single un-sized link is the usual reason a home
  // screen ends up with a screenshot of the page instead of the logo.
  const links = [...html.matchAll(/<link[^>]*rel="apple-touch-icon"[^>]*>/g)].map((m) => m[0]);
  check('apple-touch-icon links are present', links.length >= 2, links.length + ' found');
  check('...and at least one declares a size', links.some((l) => /sizes="\d+x\d+"/.test(l)));
  check('...including 180x180, what a modern iPhone asks for',
    links.some((l) => l.includes('180x180')));

  for (const m of links) {
    const href = m.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const res = await fetch(ORIGIN + href);
    check(`${href} is served`, res.status === 200, 'got ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    // Colour type 6 is RGBA, 4 is grey+alpha. iOS fills alpha with black.
    check(`${href} is opaque`, buf[25] !== 6 && buf[25] !== 4, 'colour type ' + buf[25]);
  }

  // iOS probes these paths when no link tag suits.
  for (const p of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    const r = await fetch(ORIGIN + p);
    check(`root fallback ${p} exists`, r.status === 200, 'got ' + r.status);
  }

  check('the web app title is set for iOS', /apple-mobile-web-app-title/.test(html));
}

/* ------------------------------------------------------------------ */
section('30. Photo tints for smoother loading');
{
  const plants = (await get('/public/plants?limit=12')).body.results;
  const withPhoto = plants.filter((p) => p.photo);

  if (withPhoto.length) {
    const tinted = withPhoto.filter((p) => p.photo_tint);
    check('cards carry a placeholder colour', tinted.length > 0,
      `${tinted.length} of ${withPhoto.length} — run "npm run import:tints"`);
    check('...and it is a hex colour',
      tinted.every((p) => /^#[0-9a-f]{6}$/i.test(p.photo_tint)),
      tinted[0]?.photo_tint);

    const detail = (await get('/public/plants/' + withPhoto[0].id)).body.plant;
    check('each cached photograph on the record carries one too',
      detail.photos.every((ph) => !ph.file || ph.tint));
  }
}

/* ------------------------------------------------------------------ */
section('31. Archiving a record that was still awaiting review');
{
  const made = await post('/plants', {
    site_name: 'Debug plot, archive-while-pending',
    proposed_species_name: 'Unknown archive case',
    species_not_listed: true,
  }, botT);
  eq('a botanist submits a record', made.status, 201);
  const id = made.body.plant.id;

  const queued = await get('/submissions?status=pending', revT);
  check('it shows in the review queue', queued.body.results.some((s) => s.plant.id === id));

  eq('the botanist cannot archive it', (await post(`/plants/${id}/archive`, { reason: 'Withdrawn, wrong tree' }, botT)).status, 403);
  const arch = await post(`/plants/${id}/archive`, { reason: 'Withdrawn, wrong tree' }, revT);
  eq('the senior botanist archives it before reviewing', arch.status, 200);

  const after = await get('/submissions?status=pending', revT);
  check('it no longer sits in the queue', !after.body.results.some((s) => s.plant.id === id),
    'an archived record left in the queue could be approved and published');

  const closed = (await get('/submissions?status=all', revT)).body.results.find((s) => s.plant.id === id);
  check('the submission is closed, not just hidden', closed && closed.status !== 'pending');
  check('...and says why', !!closed?.review_comment);
}

/* ------------------------------------------------------------------ */
section('32. Uploading a photograph');
{
  // A photograph used to be written straight into plant_photos.file_path,
  // which is VARCHAR(255). MariaDB truncated a 400KB image to 255 characters
  // and stored the wreckage; MySQL 8 in strict mode refused the row and the
  // registration failed with a 500. Neither was noticed because nothing tested
  // it end to end.
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const dir = new URL('../Server/data/photos/', import.meta.url);
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.jpg')) : null;

  if (!name) {
    check('a cached photograph is available to upload', false,
      'Server/data/photos is empty - run "npm run import:species"');
  } else {
    const original = fs.readFileSync(new URL(name, dir));
    const dataUrl = 'data:image/jpeg;base64,' + original.toString('base64');
    const species = (await get('/species')).body.results[0];

    const made = await post('/plants', {
      site_name: 'Debug plot, photo upload',
      species_id: species.id,
      photos: [{ data_url: dataUrl, file_name: name, caption: 'Round trip' }],
    }, botT);
    eq('a plant with a photograph is accepted', made.status, 201);
    check('the photograph is served from a path, not stored as a data URL',
      /^\/api\/photos\/upload\/\d+(\?exp=\d+&sig=[\w-]+)?$/.test(made.body.plant.photo || ''), made.body.plant.photo);

    // A botanist's record waits for review, so its photograph is only visible
    // to the uploader (and staff) until it is approved - fetch it as them.
    const served = await fetch(ORIGIN + made.body.plant.photo, {
      headers: { Authorization: 'Bearer ' + botT },
    });
    eq('...and it can be fetched back', served.status, 200);
    check('...as an image', (served.headers.get('content-type') || '').startsWith('image/'));

    const back = Buffer.from(await served.arrayBuffer());
    const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
    check('...byte for byte identical to what was uploaded', hash(back) === hash(original),
      `sent ${original.length} bytes, got ${back.length}`);

    // Refusals, each with a reason the person can act on.
    const tooBig = await post('/plants', {
      site_name: 'Debug plot, oversized', species_id: species.id,
      photos: [{ data_url: 'data:image/jpeg;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64') }],
    }, botT);
    eq('an oversized photograph is refused, not truncated', tooBig.status, 400);
    check('...and the message says what the limit is', /MB/.test(tooBig.body.error || ''), tooBig.body.error);

    const wrongType = await post('/plants', {
      site_name: 'Debug plot, wrong type', species_id: species.id,
      photos: [{ data_url: 'data:application/pdf;base64,JVBERi0=' }],
    }, botT);
    eq('a file that is not an image is refused', wrongType.status, 400);

    const notADataUrl = await post('/plants', {
      site_name: 'Debug plot, bad url', species_id: species.id,
      photos: [{ data_url: 'https://example.org/photo.jpg' }],
    }, botT);
    eq('something that is not a data URL is refused', notADataUrl.status, 400);

    // A pending record's photograph must not be public, or the publication
    // rule leaks through the image addresses.
    const pending = await post('/plants', {
      site_name: 'Debug plot, pending photo',
      proposed_species_name: 'Unconfirmed', species_not_listed: true,
      photos: [{ data_url: dataUrl }],
    }, botT);
    eq('a botanist entry with a photograph is accepted', pending.status, 201);
    const plainPath = pending.body.plant.photo.split('?')[0];
    const anon = await fetch(ORIGIN + plainPath);
    eq('its photograph is not public while the record is pending', anon.status, 404);
    const asStaff = await fetch(ORIGIN + plainPath, {
      headers: { Authorization: 'Bearer ' + revT },
    });
    eq('...but the reviewer checking it can see it', asStaff.status, 200);
    check('...kept out of shared caches', /private/.test(asStaff.headers.get('cache-control') || ''), asStaff.headers.get('cache-control'));

    // The app shows photographs with <img>, which cannot send the session
    // token, so the reviewer's copy of the record carries a signed address.
    const forReviewer = await get(`/public/plants/${pending.body.plant.id}`, revT);
    const signedPath = forReviewer.body?.plant?.photo || '';
    check('the reviewer is given a signed address for it', /\?exp=\d+&sig=/.test(signedPath), signedPath);
    eq('...which an <img> (no token) can load', (await fetch(ORIGIN + signedPath)).status, 200);
    eq('...but not with the signature altered', (await fetch(ORIGIN + signedPath.replace(/sig=./, 'sig=Z'))).status, 404);
    eq('...nor for another photograph', (await fetch(ORIGIN + signedPath.replace(/upload\/\d+/, 'upload/1'))).status, 404);
    const forRanger = await get(`/public/plants/${pending.body.plant.id}`, rangerT);
    check('a ranger, who cannot open the record, gets no signed address',
      forRanger.status !== 200 || !/sig=/.test(forRanger.body?.plant?.photo || ''), `${forRanger.status} ${forRanger.body?.plant?.photo}`);
  }
}

/* ------------------------------------------------------------------ */
section('33. Locking an account after five wrong passwords');
{
  // A throwaway account, so the run never locks somebody real out.
  const email = `lock.test.${Date.now()}@example.com`;
  const made = await post('/users', { full_name: 'Lockout Test User', email, role_id: 2 }, adminT);
  eq('a throwaway account is created', made.status, 201);
  const id = made.body.user.id;
  const wrong = () => post('/auth/login', { email, password: 'not-the-password' });

  const left = [];
  for (let i = 0; i < 4; i++) left.push((await wrong()).body.attempts_left);
  eq('each wrong password says how many attempts are left', left.join(','), '4,3,2,1');

  const fifth = await wrong();
  eq('the fifth wrong password locks the account', fifth.status, 423);
  check('...and says for how long', fifth.body.minutes === 15 && !!fifth.body.locked_until, JSON.stringify(fifth.body));

  const right = await post('/auth/login', { email, password: passwordFor(email) });
  eq('while locked, even the right password is refused', right.status, 423);

  const listed = (await get('/users', adminT)).body.results.find((u) => u.id === id);
  check('an administrator can see the lock', !!listed?.locked_until);

  const notAdmin = await post(`/users/${id}/unlock`, {}, rangerT);
  eq('a ranger cannot unlock an account', notAdmin.status, 403);

  const unlocked = await post(`/users/${id}/unlock`, {}, adminT);
  eq('an administrator can unlock it', unlocked.status, 200);
  check('...which clears the lock', unlocked.body.user.locked_until === null);
  eq('...and sign in works again', (await post('/auth/login', { email, password: passwordFor(email) })).status, 200);

  // A correct sign in wipes the slate, so mistakes do not pile up for weeks.
  for (let i = 0; i < 4; i++) await wrong();
  await post('/auth/login', { email, password: passwordFor(email) });
  eq('a correct sign in resets the count', (await wrong()).body.attempts_left, 4);

  const audits = (await get('/audit', adminT)).body.results;
  check('the lock reached the audit trail',
    audits.some((a) => a.action === 'account_locked' && a.entity_id === id));

  await patch(`/users/${id}`, { is_active: false }, adminT);
}

/* ------------------------------------------------------------------ */
section('34. Tidying up after the run');
{
  // These suites create records to exercise the workflow. Left behind, they
  // sit at the top of the public register and make a demo look broken, so
  // archive them: the same soft-delete a senior botanist would use, which keeps the
  // audit trail intact rather than pretending they never happened.
  const all = (await get('/plants', revT)).body.results;
  // Section 10's awkward payload hides its markers in the species name and the
  // notes rather than the site, so match across every field a suite writes to -
  // otherwise that record sits in the review queue for the next demo.
  const MARKERS = /test plot|test, marker|Bypass test|Approval-o|Botanist direct entry|Workflow test|Rejection test|Audit test|DROP TABLE|Debug plot|<script>|a{200,}/i;
  const litter = all.filter((p) =>
    p.status !== 'archived'
    && MARKERS.test([p.site_name, p.proposed_species_name, p.location_notes, p.morphology_notes].join(' ')));

  let archived = 0;
  for (const p of litter) {
    const r = await post(`/plants/${p.id}/archive`, { reason: 'Created by the automated test suite' }, revT);
    if (r.status === 200) archived++;
  }
  check(`archived ${archived} of ${litter.length} test records`, archived === litter.length,
    `${litter.length - archived} could not be archived`);

  const stillPublic = (await get('/public/plants?limit=100')).body.results
    .filter((p) => MARKERS.test([p.site_name, p.scientific_name, p.common_name].join(' ')));
  check('no test records remain in the public register', stillPublic.length === 0,
    stillPublic.map((p) => p.plant_code + ' @ ' + p.site_name).join(', '));
}

/* ================================================================== */

console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
  console.log(`\x1b[32mAll ${passed} checks passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m${failures.length} of ${passed + failures.length} checks failed:\x1b[0m`);
  failures.forEach((f) => console.log(`  - [${f.group}] ${f.label}${f.detail ? '\n      ' + f.detail : ''}`));
  process.exitCode = 1;
}
