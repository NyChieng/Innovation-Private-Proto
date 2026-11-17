/**
 * IoT end to end over MQTT: a simulated ESP32 node -> MQTT broker ->
 * Server/mqtt.js -> MySQL -> /api/sensors -> the IoT dashboard.
 *
 * This plays the part of iot-kit/FloraScan_Node: it connects to the same broker
 * with the same device login, and publishes readings in exactly the JSON the
 * sketch builds. Then it checks what the running server did with each one:
 * saved, refused, de-duplicated, or turned into an alert.
 *
 *   1. start the server:   npm run dev:test
 *   2. in another window:  npm run test:iot
 *
 * Use your own topic prefix so the fake readings and alerts do not reach a
 * teammate's server listening on the shared one. Put this in .env (the server
 * and this test both read it), then restart the server:
 *
 *     MQTT_TOPIC_PREFIX=florascan-demo-test
 *
 * Options (environment variables):
 *   MQTT_URL, MQTT_TOPIC_PREFIX   must match the server (defaults: as Server/mqtt.js)
 *   MQTT_DEVICE_USERNAME / _PASSWORD   the node's broker login (default: as the sketch)
 *   IOT_RESULTS=path.json          also write every check and the timings as JSON
 *   IOT_SCREENSHOT=path.png        also screenshot /staff/iot as the ranger
 *
 * Like the other suites it reseeds nothing, but it adds readings, alerts and
 * one inactive test device, and refuses a database that is not on this machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import mysql from 'mysql2/promise';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the local server's own certificate
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MQTT_URL = process.env.MQTT_URL || 'mqtts://l11c8d1d.ala.asia-southeast1.emqxsl.com';
const PREFIX = process.env.MQTT_TOPIC_PREFIX || 'florascan-swinburne-demo';
const DEVICE_USER = process.env.MQTT_DEVICE_USERNAME || 'iot_service';
const DEVICE_PASS = process.env.MQTT_DEVICE_PASSWORD || 'IotTesting1234';
const DEVICE = 'SN-001';
const KEY = 'demo-key-change-me';
const TOPIC = `${PREFIX}/${DEVICE}/readings`;

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const results = { started: new Date().toISOString(), broker: MQTT_URL, prefix: PREFIX, sections: [], timings: {} };
let current;
let passed = 0;
let failed = 0;
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', d: '\x1b[2m', y: '\x1b[33m', x: '\x1b[0m' };

function section(name) {
  current = { name, checks: [] };
  results.sections.push(current);
  console.log(`\n${C.b}${name}${C.x}`);
}
function check(name, ok, detail) {
  current.checks.push({ name, ok: !!ok, detail: ok ? undefined : String(detail ?? '') });
  if (ok) { passed++; console.log(`  ${C.g}ok${C.x}   ${name}`); }
  else { failed++; console.log(`  ${C.r}FAIL${C.x} ${name}${detail !== undefined ? `\n         ${detail}` : ''}`); }
}
const eq = (name, got, want) => check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
const note = (text) => { current.checks.push({ note: text }); console.log(`  ${C.d}${text}${C.x}`); };

/* ------------------------------------------------------------------ */
/* Database, API and broker                                            */
/* ------------------------------------------------------------------ */

const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
if (!dbUrl) { console.error('No DATABASE_URL in .env'); process.exit(1); }
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(new URL(dbUrl).hostname)) {
  console.error('Refusing to add test readings to a database that is not on this machine.');
  process.exit(1);
}
// Every DATETIME in the schema is UTC.
const db = await mysql.createConnection({ uri: dbUrl, timezone: 'Z' });
const rows = async (sql, args = []) => (await db.query(sql, args))[0];

const port = process.env.PORT || JSON.parse(fs.readFileSync(path.join(root, 'proto.config.json'), 'utf8')).port;
let ORIGIN = process.env.BASE_URL?.replace(/\/+$/, '');
if (!ORIGIN) {
  for (const o of [`https://localhost:${port}`, `http://localhost:${port}`]) {
    try { await fetch(o + '/api/public/stats'); ORIGIN = o; break; } catch { /* try the next */ }
  }
}
if (!ORIGIN) { console.error(`No FloraScan server on port ${port}. Start it with "npm run dev:test".`); process.exit(1); }

async function call(method, p, { token, body } = {}) {
  const r = await fetch(`${ORIGIN}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: json };
}
const passwordFor = (email) => (email.endsWith('@gmail.com') ? email.split('@')[0] + '123' : 'demo1234');
async function login(email) {
  const r = await call('POST', '/auth/login', { body: { email, password: passwordFor(email) } });
  if (!r.body?.token) throw new Error(`Could not sign in as ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, every = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(every);
  }
}

const bootId = () => randomBytes(8).toString('hex').toUpperCase();
const [{ id: deviceId }] = await rows('SELECT id FROM sensor_devices WHERE device_code = ?', [DEVICE]);
const readingsFor = (boot) => rows('SELECT * FROM sensor_readings WHERE device_id = ? AND boot_id = ? ORDER BY id', [deviceId, boot]);
const deviceRows = async () => (await rows('SELECT COUNT(*) n FROM sensor_readings WHERE device_id = ?', [deviceId]))[0].n;

/** The JSON iot-kit/FloraScan_Node builds, field for field and in the same order. */
function sketchPayload(o = {}) {
  const v = {
    device_code: DEVICE, device_key: KEY, boot_id: o.boot_id, sequence: o.sequence ?? 1,
    soil_moisture_pct: 52.4, temperature_c: 27.9, humidity_pct: 78.0, rain_pct: 3.1, is_raining: false,
    motion_events: 0, sound_peak_pct: 12.5, distance_cm: 64.2, wifi_rssi_dbm: -61, uptime_s: 20,
    ...o,
  };
  return v;
}

const node = mqtt.connect(MQTT_URL, {
  username: DEVICE_USER, password: DEVICE_PASS,
  clientId: `florascan-${DEVICE}-test-${randomBytes(3).toString('hex')}`,
  connectTimeout: 15000, reconnectPeriod: 0,
});
const publish = (payload, { topic = TOPIC, qos = 0 } = {}) =>
  node.publishAsync(topic, typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), { qos });

/** Publish one valid reading and wait for the server to save it. Returns the row and the delay. */
async function publishAndWait(payload, opts) {
  const t0 = performance.now();
  await publish(payload, opts);
  // Polled every 10 ms, so the delay measured is the pipeline's and not the polling interval.
  const got = await waitFor(async () => (await readingsFor(payload.boot_id)).find((r) => r.sequence_no === payload.sequence), 15000, 10);
  return { row: got, ms: performance.now() - t0 };
}

/**
 * Publish messages the server should refuse, then a valid "sentinel" reading on
 * the same connection. Messages from one client on one topic arrive in order,
 * so once the sentinel is saved the others have been handled too. Returns how
 * many rows the refused messages added (should be 0).
 */
async function refusedRows(payloads, opts = {}) {
  const before = await deviceRows();
  for (const p of payloads) await publish(p.payload ?? p, { ...opts, topic: p.topic ?? opts.topic });
  const sentinel = sketchPayload({ boot_id: bootId(), sequence: 1 });
  const { row } = await publishAndWait(sentinel);
  if (!row) throw new Error('The sentinel reading was never saved: is the server listening on ' + TOPIC + '?');
  await sleep(300);
  return (await deviceRows()) - before - 1;
}

/* ------------------------------------------------------------------ */

console.log(`FloraScan IoT end-to-end test\n  broker  ${MQTT_URL}\n  topic   ${TOPIC}\n  server  ${ORIGIN}`);
if (PREFIX === 'florascan-swinburne-demo') {
  console.log(`${C.y}  Using the shared topic prefix: any teammate's server listening on it will save these test readings too.${C.x}`);
}

section('1. The node connects to the broker like the ESP32');
{
  const t0 = performance.now();
  const ok = await new Promise((resolve) => {
    node.once('connect', () => resolve(true));
    node.once('error', (e) => { console.log('   ', e.message); resolve(false); });
    setTimeout(() => resolve(false), 16000);
  });
  results.timings.connect_ms = Math.round(performance.now() - t0);
  check(`connects with the device login (${new URL(MQTT_URL).protocol.replace(':', '')}, ${results.timings.connect_ms} ms)`, ok);
  if (!ok) { console.log('\nCannot reach the broker; stopping.'); await db.end(); process.exit(1); }
  const bad = mqtt.connect(MQTT_URL, { username: DEVICE_USER, password: 'wrong-password', connectTimeout: 10000, reconnectPeriod: 0 });
  const refused = await new Promise((resolve) => {
    bad.once('connect', () => resolve(false));
    bad.once('error', () => resolve(true));
    bad.once('close', () => resolve(true));
    setTimeout(() => resolve(null), 11000);
  });
  bad.end(true);
  const localBroker = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(new URL(MQTT_URL).hostname);
  if (refused === null) note('the broker neither accepted nor refused a wrong password within 10 s');
  else if (localBroker && !refused) note('this local broker takes any password (a stand-in for the cloud broker, not a FloraScan setting)');
  else check('the broker refuses a wrong broker password', refused);
}

section('2. A reading in the sketch\'s format is saved');
const boot = bootId();
{
  const p = sketchPayload({ boot_id: boot, sequence: 1 });
  const { row, ms } = await publishAndWait(p);
  results.timings.first_reading_ms = Math.round(ms);
  check(`the reading reaches MySQL (${Math.round(ms)} ms after publishing)`, !!row);
  if (row) {
    eq('soil moisture', Number(row.soil_moisture_pct), 52.4);
    eq('temperature', Number(row.temperature_c), 27.9);
    eq('humidity', Number(row.humidity_pct), 78);
    eq('rain', Number(row.rain_pct), 3.1);
    eq('is_raining stored as 0', row.is_raining, 0);
    eq('motion events', row.motion_events, 0);
    eq('sound peak', Number(row.sound_peak_pct), 12.5);
    eq('distance', Number(row.distance_cm), 64.2);
    eq('Wi-Fi signal', row.wifi_rssi_dbm, -61);
    eq('uptime', row.uptime_s, 20);
    eq('boot id kept', row.boot_id, boot);
    eq('sequence kept', row.sequence_no, 1);
    check('time is the server\'s clock in UTC (within 60 s of now)',
      Math.abs(new Date(row.recorded_at).getTime() - Date.now()) < 60000, String(row.recorded_at));
  }
  const [dev] = await rows('SELECT last_seen_at FROM sensor_devices WHERE id = ?', [deviceId]);
  check('the device\'s last_seen_at is updated', !!dev.last_seen_at);
}

section('3. Sequence protection: retries, restarts and replays (newest commit)');
{
  const p = sketchPayload({ boot_id: boot, sequence: 1 });
  eq('the same reading sent again 3 times (QoS 1 retries) adds no rows',
    await refusedRows([p, p, { payload: p }], { qos: 1 }), 0);
  eq('...so the boot still has exactly one row', (await readingsFor(boot)).length, 1);

  const lower = sketchPayload({ boot_id: boot.toLowerCase(), sequence: 1 });
  eq('the same boot id in lower case is still a duplicate', await refusedRows([lower]), 0);

  const next = await publishAndWait(sketchPayload({ boot_id: boot, sequence: 2, uptime_s: 40 }));
  check('the next sequence number in the same boot is saved', !!next.row);

  const restart = bootId();
  const r1 = await publishAndWait(sketchPayload({ boot_id: restart, sequence: 1, uptime_s: 1 }));
  check('after a restart (new boot id) sequence 1 is accepted again', !!r1.row);

  const ooo = await publishAndWait(sketchPayload({ boot_id: boot, sequence: 10 }));
  const back = await publishAndWait(sketchPayload({ boot_id: boot, sequence: 5 }));
  check('an out-of-order sequence in the same boot is saved (only exact repeats are refused)', !!ooo.row && !!back.row);

  const top = await publishAndWait(sketchPayload({ boot_id: bootId(), sequence: 4294967295 }));
  check('the largest sequence (2^32 - 1) is accepted', !!top.row);
}

section('4. Messages the server must refuse');
{
  const b = () => bootId();
  const cases = [
    ['wrong device key', sketchPayload({ boot_id: b(), device_key: 'not-the-key' })],
    ['no device key', (() => { const p = sketchPayload({ boot_id: b() }); delete p.device_key; return p; })()],
    ['unknown device', { topic: `${PREFIX}/SN-999/readings`, payload: sketchPayload({ boot_id: b(), device_code: 'SN-999' }) }],
    ['device_code does not match the topic', { topic: `${PREFIX}/SN-002/readings`, payload: sketchPayload({ boot_id: b() }) }],
    ['SQL in the device code', { topic: `${PREFIX}/SN-001' OR '1'='1/readings`, payload: sketchPayload({ boot_id: b(), device_code: "SN-001' OR '1'='1" }) }],
    ['script tag and emoji in the device code', { topic: `${PREFIX}/<script>🌿/readings`, payload: sketchPayload({ boot_id: b(), device_code: '<script>🌿' }) }],
    ['missing boot_id (the sketch before the newest commit)', (() => { const p = sketchPayload({ boot_id: b() }); delete p.boot_id; return p; })()],
    ['missing sequence', (() => { const p = sketchPayload({ boot_id: b() }); delete p.sequence; return p; })()],
    ['boot_id 15 characters', sketchPayload({ boot_id: b().slice(1) })],
    ['boot_id not hexadecimal', sketchPayload({ boot_id: 'ZZZZZZZZZZZZZZZZ' })],
    ['sequence 0', sketchPayload({ boot_id: b(), sequence: 0 })],
    ['sequence negative', sketchPayload({ boot_id: b(), sequence: -1 })],
    ['sequence 1.5', sketchPayload({ boot_id: b(), sequence: 1.5 })],
    ['sequence as text "5"', sketchPayload({ boot_id: b(), sequence: '5' })],
    ['sequence 2^32 (too big for the column)', sketchPayload({ boot_id: b(), sequence: 4294967296 })],
    ['soil moisture 101 %', sketchPayload({ boot_id: b(), soil_moisture_pct: 101 })],
    ['temperature -41 °C', sketchPayload({ boot_id: b(), temperature_c: -41 })],
    ['humidity -1 %', sketchPayload({ boot_id: b(), humidity_pct: -1 })],
    ['distance 501 cm', sketchPayload({ boot_id: b(), distance_cm: 501 })],
    ['motion events 1.5 (whole numbers only)', sketchPayload({ boot_id: b(), motion_events: 1.5 })],
    ['Wi-Fi signal +5 dBm', sketchPayload({ boot_id: b(), wifi_rssi_dbm: 5 })],
    ['soil moisture as text "50"', sketchPayload({ boot_id: b(), soil_moisture_pct: '50' })],
    ['is_raining as "yes"', sketchPayload({ boot_id: b(), is_raining: 'yes' })],
    ['only rain / motion / sound, no soil, temperature or humidity',
      sketchPayload({ boot_id: b(), soil_moisture_pct: null, temperature_c: null, humidity_pct: null })],
    ['not JSON', 'soil=52&temp=27'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['an empty message', ''],
    ['over 2 KB', sketchPayload({ boot_id: b(), padding: 'x'.repeat(2100) })],
  ];
  for (const [name, p] of cases) eq(`refused: ${name}`, await refusedRows([p]), 0);

  const ok = await publishAndWait(sketchPayload({ boot_id: bootId(), padding: 'x'.repeat(1500) }));
  check('an unknown extra field under the 2 KB limit is ignored and the reading saved', !!ok.row);

  const dht = await publishAndWait(sketchPayload({ boot_id: bootId(), temperature_c: null, humidity_pct: null, distance_cm: null }));
  check('a failed DHT11 and no HC-SR04 echo (the sketch sends null) still saves the soil reading', !!dht.row);
  if (dht.row) check('...with temperature, humidity and distance left empty',
    dht.row.temperature_c === null && dht.row.humidity_pct === null && dht.row.distance_cm === null);

  // An inactive device with a valid key.
  await db.query("DELETE FROM sensor_devices WHERE device_code = 'SN-T01'");
  await db.query("INSERT INTO sensor_devices (device_code, device_key_hash, label, is_active) VALUES ('SN-T01', SHA2('t01-key', 256), 'iot-mqtt test (inactive)', 0)");
  const inactive = sketchPayload({ boot_id: bootId(), device_code: 'SN-T01', device_key: 't01-key' });
  await publish(inactive, { topic: `${PREFIX}/SN-T01/readings` });
  await refusedRows([]);
  const [{ n }] = await rows("SELECT COUNT(*) n FROM sensor_readings r JOIN sensor_devices d ON d.id = r.device_id WHERE d.device_code = 'SN-T01'");
  eq('refused: a switched-off device, even with the right key', n, 0);
  await db.query("DELETE FROM sensor_devices WHERE device_code = 'SN-T01'");

  const health = await fetch(ORIGIN + '/api/public/stats').then((r) => r.status).catch(() => 0);
  eq('the server is still up after all of that', health, 200);
}

section('5. Alerts when a reading leaves the botanist\'s limits');
const rangerT = await login('edmundguoqianyu@gmail.com');
{
  await db.query("UPDATE sensor_alerts SET status = 'resolved', resolved_at = UTC_TIMESTAMP() WHERE device_id = ? AND status = 'open'", [deviceId]);
  const openAlerts = () => rows("SELECT * FROM sensor_alerts WHERE device_id = ? AND status = 'open' ORDER BY id", [deviceId]);
  const [lim] = await rows('SELECT * FROM sensor_devices WHERE id = ?', [deviceId]);
  note(`limits: soil ${Number(lim.soil_moisture_min)}-${Number(lim.soil_moisture_max)} %, temperature ${Number(lim.temperature_min)}-${Number(lim.temperature_max)} °C, humidity ${Number(lim.humidity_min)}-${Number(lim.humidity_max)} %`);
  const ab = bootId();
  let seq = 1;
  const send = (o) => publishAndWait(sketchPayload({ boot_id: ab, sequence: seq++, ...o }));

  await send({ soil_moisture_pct: Number(lim.soil_moisture_min), temperature_c: Number(lim.temperature_max), humidity_pct: Number(lim.humidity_max) });
  await sleep(300);
  eq('readings exactly on the limits raise no alert', (await openAlerts()).length, 0);

  const t0 = performance.now();
  await send({ soil_moisture_pct: 10 });
  const a = await waitFor(async () => (await openAlerts()).find((x) => x.alert_type === 'soil_moisture'), 8000, 10);
  results.timings.alert_ms = Math.round(performance.now() - t0);
  check(`dry soil (10 %) opens a soil-moisture alert (${results.timings.alert_ms} ms)`, !!a);
  if (a) {
    eq('...marked as below the minimum', a.limit_crossed, 'min');
    eq('...with the reading', Number(a.reading_value), 10);
    eq('...and the limit', Number(a.limit_value), Number(lim.soil_moisture_min));
    check('...linked to the reading that caused it', !!a.reading_id);
    // Only roles that can resolve an alert (rangers) are told about it.
    const told = await rows(
      `SELECT r.name AS role FROM notifications n JOIN users u ON u.id = n.user_id JOIN roles r ON r.id = u.role_id
        WHERE n.type = 'sensor.alert' AND n.related_type = 'sensor_alert' AND n.related_id = ?`, [a.id]);
    check('...every ranger gets a notification', told.length > 0 && told.every((x) => x.role === 'ranger'), JSON.stringify(told));
    const [rc] = await rows("SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'ranger' AND u.is_active = 1 AND u.deleted_at IS NULL");
    eq('...one per active ranger, and nobody else', told.length, Number(rc.n));
  }
  await send({ soil_moisture_pct: 12 });
  await sleep(300);
  eq('a second dry reading does not open a second alert', (await openAlerts()).filter((x) => x.alert_type === 'soil_moisture').length, 1);

  await send({ temperature_c: 40 });
  const hot = await waitFor(async () => (await openAlerts()).find((x) => x.alert_type === 'temperature'), 8000);
  check('40 °C opens a temperature alert marked above the maximum', hot?.limit_crossed === 'max', JSON.stringify(hot));

  const dash = await call('GET', '/sensors', { token: rangerT });
  eq('the ranger\'s dashboard API answers', dash.status, 200);
  const d = dash.body?.devices?.find((x) => x.device_code === DEVICE);
  check('...shows SN-001 online', d?.online === true, JSON.stringify(d?.online));
  eq('...with the newest temperature', d?.latest?.temperature_c, 40);
  eq('...and 2 open alerts', d?.open_alerts, 2);
  check('...readings come back as numbers, not strings', typeof d?.latest?.soil_moisture_pct === 'number');

  const noteText = '<script>alert(1)</script> soil watered 水分 🌧️';
  const res = await call('POST', `/sensors/alerts/${a?.id}/resolve`, { token: rangerT, body: { note: noteText } });
  eq('the ranger resolves the soil alert', res.status, 200);
  eq('...and the note is stored as typed', res.body?.alert?.resolution_note, noteText);
  eq('resolving it twice is refused', (await call('POST', `/sensors/alerts/${a?.id}/resolve`, { token: rangerT, body: {} })).status, 409);
  const [aud] = await rows("SELECT * FROM audit_logs WHERE entity_type = 'sensor_alerts' AND entity_id = ? ORDER BY id DESC LIMIT 1", [a?.id]);
  check('the resolution is in the audit log', !!aud);

  await send({ soil_moisture_pct: 11 });
  const again = await waitFor(async () => (await openAlerts()).find((x) => x.alert_type === 'soil_moisture' && x.id !== a?.id), 8000);
  check('the next dry reading after resolving opens a new alert', !!again);
}

section('6. Who may see sensors and resolve alerts');
{
  const [botT, revT, adminT] = await Promise.all([
    login('drsuehanlee@gmail.com'), login('drmeilingwong@gmail.com'), login('nengyichieng@gmail.com'),
  ]);
  const [open] = await rows("SELECT id FROM sensor_alerts WHERE device_id = ? AND status = 'open' ORDER BY id LIMIT 1", [deviceId]);
  eq('anonymous GET /sensors is refused', (await call('GET', '/sensors')).status, 401);
  eq('a botanist (sensor.view) can open the dashboard', (await call('GET', '/sensors', { token: botT })).status, 200);
  eq('a reviewer (no sensor permission) cannot open the dashboard', (await call('GET', '/sensors', { token: revT })).status, 403);
  eq('an administrator (no sensor permission) cannot open the dashboard', (await call('GET', '/sensors', { token: adminT })).status, 403);
  eq('a botanist (no alert.resolve) cannot resolve an alert', (await call('POST', `/sensors/alerts/${open?.id}/resolve`, { token: botT, body: {} })).status, 403);
  eq('a reviewer cannot resolve an alert', (await call('POST', `/sensors/alerts/${open?.id}/resolve`, { token: revT, body: {} })).status, 403);
  eq('anonymous cannot resolve an alert', (await call('POST', `/sensors/alerts/${open?.id}/resolve`, { body: {} })).status, 401);
}

section('7. Speed and load');
{
  const lat = [];
  const lb = bootId();
  for (let i = 1; i <= 10; i++) {
    const { row, ms } = await publishAndWait(sketchPayload({ boot_id: lb, sequence: i }));
    if (row) lat.push(ms);
  }
  lat.sort((x, y) => x - y);
  results.timings.latency_ms = { samples: lat.map(Math.round), median: Math.round(lat[Math.floor(lat.length / 2)]), max: Math.round(lat.at(-1)) };
  check(`10 readings one after another all saved; publish -> MySQL median ${results.timings.latency_ms.median} ms, worst ${results.timings.latency_ms.max} ms`, lat.length === 10);

  const bb = bootId();
  const N = 50;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: N }, (_, i) => publish(sketchPayload({ boot_id: bb, sequence: i + 1 }), { qos: 1 })));
  const all = await waitFor(async () => ((await readingsFor(bb)).length >= N ? true : null), 30000, 200);
  const got = await readingsFor(bb);
  results.timings.burst = { messages: N, saved: got.length, ms: Math.round(performance.now() - t0) };
  check(`a burst of ${N} readings at once (like ${N} nodes reporting together) is all saved in ${results.timings.burst.ms} ms`, !!all && got.length === N, `${got.length} saved`);
  eq('...with no duplicates', new Set(got.map((r) => r.sequence_no)).size, got.length);
}

/* ------------------------------------------------------------------ */
/* Optional: screenshot the dashboard                                  */
/* ------------------------------------------------------------------ */

if (process.env.IOT_SCREENSHOT) {
  section('8. The IoT dashboard shows it');
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, acceptInsecureCerts: true, args: ['--ignore-certificate-errors'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|429/.test(m.text())) errors.push(m.text()); });
    await page.setViewport({ width: 1440, height: 2300 });
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { localStorage.setItem('florascan.token', t); localStorage.setItem('florascan.intro-seen', '1'); }, rangerT);
    await page.goto(ORIGIN + '/staff/iot', { waitUntil: 'networkidle0' });
    // Let the page's fade-in finish (but not the endless "Live" pulse), or the picture is washed out.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, 3000)),
    ]));
    await sleep(500);
    const text = await page.evaluate(() => document.body.innerText);
    check('the dashboard names SN-001', text.includes('SN-001'));
    check('...shows the 40 °C reading', /40(\.0)?\s*°C/.test(text), text.slice(0, 300));
    check('...shows the open alerts', /alert/i.test(text));
    check('...with no browser errors', errors.length === 0, errors.join(' | '));
    fs.mkdirSync(path.dirname(process.env.IOT_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.IOT_SCREENSHOT });
    note(`screenshot: ${process.env.IOT_SCREENSHOT}`);
    await browser.close();
  } catch (e) {
    check('the dashboard screenshot could be taken', false, e.message);
  }
}

/* ------------------------------------------------------------------ */

node.end();
await db.end();
results.passed = passed;
results.failed = failed;
results.finished = new Date().toISOString();
if (process.env.IOT_RESULTS) {
  fs.mkdirSync(path.dirname(process.env.IOT_RESULTS), { recursive: true });
  fs.writeFileSync(process.env.IOT_RESULTS, JSON.stringify(results, null, 2));
}
console.log(`\n${failed ? C.r : C.g}${passed} passed, ${failed} failed${C.x}`);
process.exit(failed ? 1 : 0);
