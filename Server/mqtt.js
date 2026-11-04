import mqtt from 'mqtt';
import { createHash, timingSafeEqual } from 'node:crypto';
import { q, insert, update, nowIso } from './db.js';

const MQTT_URL = process.env.MQTT_URL || 'mqtts://l11c8d1d.ala.asia-southeast1.emqxsl.com';

// Must match TOPIC_PREFIX in the ESP32 sketch. The "+" matches any device
// code, so adding SN-002, SN-003... needs no change here.
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'florascan-swinburne-demo';
const MQTT_TOPIC = `${TOPIC_PREFIX}/+/readings`;

// Anyone can publish to a public broker, so ignore anything oversized.
const MAX_MESSAGE_BYTES = 2048;

// Fields saved into sensor_readings, with their allowed ranges.
// integer: the column is a whole-number type, so fractions are refused.
// To save another field the node sends, add its column to sensor_readings
// (see sections 6 and 7 of schema-extensions.sql) and list it here. Fields
// not listed here are ignored.
const FIELDS = {
  soil_moisture_pct: { range: [0, 100] },
  temperature_c: { range: [-40, 80] },
  humidity_pct: { range: [0, 100] },
  rain_pct: { range: [0, 100] },
  motion_events: { range: [0, 65535], integer: true },
  sound_peak_pct: { range: [0, 100] },
  distance_cm: { range: [0, 500] },  // HC-SR04; null when no echo came back
  wifi_rssi_dbm: { range: [-127, 0], integer: true },
  uptime_s: { range: [0, 4294967295], integer: true },
};

// Fields that are true/false in the JSON and stored as 1/0.
const FLAGS = ['is_raining'];

// The sensor readings proper. The extra fields above are context (rain,
// motion, sound, distance, Wi-Fi signal, uptime): a message carrying only
// those is not a reading worth saving.
const MEASUREMENTS = ['soil_moisture_pct', 'temperature_c', 'humidity_pct'];

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function matchesKey(providedKey, storedHash) {
  if (typeof providedKey !== 'string' || !storedHash) return false;

  const providedHash = sha256(providedKey);
  const expectedHash = Buffer.from(storedHash, 'hex');

  return (
    expectedHash.length === providedHash.length &&
    timingSafeEqual(providedHash, expectedHash)
  );
}

function validNumber(value, min, max) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

// "florascan-swinburne-demo/SN-001/readings" -> "SN-001"
function deviceCodeFromTopic(topic) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== TOPIC_PREFIX || parts[2] !== 'readings') {
    return null;
  }
  return parts[1];
}

async function handleMessage(topic, message) {
  const topicDevice = deviceCodeFromTopic(topic);
  if (!topicDevice) return;

  if (message.length > MAX_MESSAGE_BYTES) {
    console.warn(`[MQTT] Ignored message on ${topic}: too large`);
    return;
  }

  let data;
  try {
    data = JSON.parse(message.toString());
  } catch {
    console.warn(`[MQTT] Ignored message on ${topic}: not valid JSON`);
    return;
  }

  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.device_code !== 'string' ||
    typeof data.device_key !== 'string'
  ) {
    console.warn('[MQTT] Ignored message: missing device credentials');
    return;
  }

  if (data.device_code !== topicDevice) {
    console.warn('[MQTT] Ignored message: device_code does not match the topic');
    return;
  }

  const devices = await q(
    `SELECT id, device_code, device_key_hash, plant_id,
            soil_moisture_min, soil_moisture_max,
            temperature_min, temperature_max,
            humidity_min, humidity_max
     FROM sensor_devices
     WHERE device_code = ?
       AND is_active = 1
       AND deleted_at IS NULL
     LIMIT 1`,
    [data.device_code]
  );

  const device = devices[0];

  if (!device || !matchesKey(data.device_key, device.device_key_hash)) {
    console.warn(`[MQTT] Ignored message: unknown device or invalid key (${data.device_code})`);
    return;
  }

  const reading = {};

  for (const [field, { range: [min, max], integer }] of Object.entries(FIELDS)) {
    const value = data[field];

    if (value === undefined || value === null) {
      reading[field] = null;
      continue;
    }

    if (!validNumber(value, min, max) || (integer && !Number.isInteger(value))) {
      console.warn(`[MQTT] Ignored message: invalid ${field}`);
      return;
    }

    reading[field] = value;
  }

  for (const field of FLAGS) {
    const value = data[field];

    if (value === undefined || value === null) {
      reading[field] = null;
      continue;
    }

    if (typeof value !== 'boolean') {
      console.warn(`[MQTT] Ignored message: invalid ${field}`);
      return;
    }

    reading[field] = value ? 1 : 0;
  }

  if (MEASUREMENTS.every((field) => reading[field] === null)) {
    console.warn('[MQTT] Ignored message: no supported readings');
    return;
  }

  // Server time, not the ESP32's: the board has no real clock.
  const recordedAt = nowIso();

  const saved = await insert('sensor_readings', {
    device_id: device.id,
    plant_id: device.plant_id,
    recorded_at: recordedAt,
    ...reading,
  });

  await update('sensor_devices', device.id, {
    last_seen_at: recordedAt,
  });

  console.log(`[MQTT] Saved sensor reading from ${device.device_code}`);

  // The reading is already saved, so a problem raising an alert must not
  // look like the reading failed.
  try {
    await raiseAlerts(device, reading, saved?.id ?? null);
  } catch (err) {
    console.error(`[MQTT] Could not check alerts for ${device.device_code}:`, err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

// Which reading is compared with which limits in sensor_devices.
const LIMIT_CHECKS = [
  { type: 'soil_moisture', field: 'soil_moisture_pct', min: 'soil_moisture_min', max: 'soil_moisture_max', label: 'Soil moisture', unit: ' %' },
  { type: 'temperature', field: 'temperature_c', min: 'temperature_min', max: 'temperature_max', label: 'Temperature', unit: ' °C' },
  { type: 'humidity', field: 'humidity_pct', min: 'humidity_min', max: 'humidity_max', label: 'Humidity', unit: ' %' },
];

// mysql2 returns DECIMAL columns as strings, so limits are converted first.
const limitOf = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Opens an alert when a reading is outside the limits a botanist set for
 * this device. Only one alert stays open per device and problem: otherwise a
 * dry plant would raise a new alert every 10 seconds. Staff close it from the
 * dashboard, and the next out-of-range reading after that opens a new one.
 */
async function raiseAlerts(device, reading, readingId) {
  for (const check of LIMIT_CHECKS) {
    const value = reading[check.field];
    if (value === null) continue;

    const min = limitOf(device[check.min]);
    const max = limitOf(device[check.max]);
    let crossed = null;
    let limit = null;
    if (min !== null && value < min) { crossed = 'min'; limit = min; }
    else if (max !== null && value > max) { crossed = 'max'; limit = max; }
    if (!crossed) continue;

    const open = await q(
      `SELECT id FROM sensor_alerts
        WHERE device_id = ? AND alert_type = ? AND status = 'open'
        LIMIT 1`,
      [device.id, check.type]
    );
    if (open.length) continue;

    await insert('sensor_alerts', {
      device_id: device.id,
      plant_id: device.plant_id,
      reading_id: readingId,
      alert_type: check.type,
      limit_crossed: crossed,
      reading_value: value,
      limit_value: limit,
      status: 'open',
      triggered_at: nowIso(),
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
    });

    console.log(
      `[MQTT] Alert: ${device.device_code} ${check.label} ${value}${check.unit} is ` +
      `${crossed === 'min' ? 'below' : 'above'} the ${limit}${check.unit} limit`
    );
  }
}

export function startMqttSubscriber() {
  const client = mqtt.connect(MQTT_URL, {
    reconnectPeriod: 5000, // retry every 5 s if the broker drops us
    connectTimeout: 10000,
    username: process.env.MQTT_USERNAME || 'backend_service',
    password: process.env.MQTT_PASSWORD || 'BackendTesting1234',
  });

  client.on('connect', () => {
    console.log(`[MQTT] Connected to ${MQTT_URL}`);

    client.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT] Subscribe failed:', err.message);
        return;
      }
      console.log(`[MQTT] Listening on ${MQTT_TOPIC}`);
    });
  });

  client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
  client.on('offline', () => console.warn('[MQTT] Offline'));
  client.on('error', (err) => console.error('[MQTT] Connection error:', err.message));

  client.on('message', (topic, message) => {
    handleMessage(topic, message).catch((err) => {
      console.error('[MQTT] Could not process message:', err.message);
    });
  });

  return client;
}

export function stopMqttSubscriber(client) {
  if (!client) return Promise.resolve();

  return new Promise((resolve) => {
    client.end(false, {}, resolve);
  });
}
