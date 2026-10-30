/*
  FloraScan plant sensor node (COS30049) - real IoT kit
  ----------------------------------------------------------------------
  One ESP32 beside one plant. Every REPORT_INTERVAL_MS it reads the kit's
  sensors and publishes one JSON reading over MQTT, which Server/mqtt.js
  saves to MySQL. Pins, calibration and sensor code come from the kit test
  sketch "IoT Project.ino" (30 Oct 2026).

    Part                    Signal                   Power
    Soil moisture board     AO   -> GPIO34           VCC -> 3V3
    Raindrop board          AO   -> GPIO35           VCC -> 3V3
    KY-037 sound sensor     A0   -> GPIO32           +   -> 3V3
    DHT11                   out  -> GPIO4            +   -> 3V3
    HC-SR501 PIR            OUT  -> GPIO27           VCC -> 5V (VIN)
    HC-SR04 ultrasonic      Trig -> GPIO18           VCC -> 5V (VIN)
                            Echo -> divider -> GPIO19
    On-board LED            GPIO2, lit while a reading is sent
    Every GND -> GND.

  HC-SR04 Echo divider: Echo outputs 5 V, the ESP32 takes 3.3 V. Echo goes
  through 5 kOhm (two 10 kOhm side by side) to GPIO19, and GPIO19's row has
  10 kOhm to GND. Never wire Echo straight to the ESP32.

  Each reading includes the HC-SR04 distance as distance_cm (null when no
  echo comes back). There is no light sensor on the kit, so no light value.

  MQTT, on the public HiveMQ broker (port 1883):
    publishes   florascan-swinburne-demo/SN-001/readings   -> backend

  Arduino IDE setup:
    Board:   DOIT ESP32 DEVKIT V1 (Tools > Board > esp32)
    Library: PubSubClient by Nick O'Leary (Sketch > Include Library > Manage Libraries)
    Serial Monitor: 115200 baud
  Before uploading, fill in WIFI_SSID and WIFI_PASSWORD below.
*/

#include <WiFi.h>
#include <PubSubClient.h>

// Where a failed DHT read stopped, so the Serial Monitor can say why.
// Keep this above every function: the Arduino IDE inserts function declarations just
// before the first function, and readDHT's declaration needs this type to exist by then.
enum DhtResult { DHT_OK, DHT_NO_RESPONSE, DHT_BITS_TIMEOUT, DHT_BAD_CHECKSUM };

// ===== 1. Wi-Fi =========================================================
const char *WIFI_SSID = "YOUR-WIFI-NAME";          // 2.4 GHz only, e.g. a phone hotspot
const char *WIFI_PASSWORD = "YOUR-WIFI-PASSWORD";  // don't share or commit your real password

// How often a full reading is sent. 20 s suits a demo; use 5UL * 60 * 1000
// (every 5 minutes) for a long trial.
const unsigned long REPORT_INTERVAL_MS = 20UL * 1000;

// ===== 2. MQTT and the FloraScan backend ===============================
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char *TOPIC_PREFIX = "florascan-swinburne-demo";  // the backend listens on <prefix>/+/readings
const char *DEVICE_CODE = "SN-001";             // sensor_devices.device_code
const char *DEVICE_KEY = "demo-key-change-me";  // the database keeps SHA2(key, 256)

// The JSON field that carries DEVICE_KEY. It must be the name Server/mqtt.js reads.
const char *KEY_FIELD = "device_key";

// ===== 3. Pins (GPIO numbers; DOIT boards print them as D34, D35...) ====
// Analog sensors must stay on ADC1 pins (GPIO 32-39): ADC2 stops working
// while Wi-Fi is on.
const int PIN_SOIL_AO = 34;   // soil moisture AO
const int PIN_RAIN_AO = 35;   // raindrop AO
const int PIN_SOUND_AO = 32;  // KY-037 A0
const int PIN_DHT = 4;        // DHT11 "out"
const int PIN_PIR = 27;       // HC-SR501 OUT
const int PIN_TRIG = 18;      // HC-SR04 Trig
const int PIN_ECHO = 19;      // HC-SR04 Echo, through the divider
const int PIN_LED = 2;        // on-board LED

// ===== 4. Calibration (re-measure with your own sensors) ===============
// Raw readings run from 0 to 4095. The soil and rain probes read HIGH when dry.
const int SOIL_RAW_DRY = 4095;     // soil probe in dry air
const int SOIL_RAW_WET = 1430;     // soil probe in a glass of water
const int RAIN_RAW_DRY = 4095;     // rain plate dry
const int RAIN_RAW_WET = 615;      // rain plate covered in water
const int SOUND_P2P_QUIET = 15;    // A0 swing (peak-to-peak) in a quiet room
const int SOUND_P2P_LOUD = 1000;   // A0 swing for a loud clap next to the mic

// Two thresholds so a few drops sitting on the plate don't flip "raining" on and off.
const float RAIN_START_PCT = 20;   // plate wetter than this = raining
const float RAIN_STOP_PCT = 10;    // ...and drier than this = rain stopped
const float LOUD_EVENT_PCT = 60;   // print a "loud noise" line above this

// HC-SR04: it holds Echo HIGH for as long as a ping takes to get there and back.
const unsigned long ECHO_TIMEOUT_US = 25000;  // a little past its 4 m limit
const unsigned long PING_GAP_MS = 60;         // datasheet minimum, so the last ping's echoes die away
const int PINGS_PER_READING = 3;
const float CM_PER_US = 0.0343f;              // speed of sound at about 20 C

// Safe ranges for the Serial Monitor summary only. The backend does the real
// check against the limits stored for the sensor in sensor_devices.
const float SOIL_MIN = 30, SOIL_MAX = 80;  // %
const float TEMP_MIN = 18, TEMP_MAX = 35;  // degrees C
const float HUM_MIN = 40, HUM_MAX = 90;    // % RH

// The HC-SR501 gives false triggers for up to a minute after power-up,
// so motion isn't counted until then.
const unsigned long PIR_WARMUP_MS = 60000UL;

// ===== Globals ==========================================================
WiFiClient net;
PubSubClient mqtt(net);
String topicReadings, clientId;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastMqttAttemptMs = 0;

portMUX_TYPE dhtMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t dhtAttempts = 0, dhtPasses = 0;

volatile uint32_t motionTotal = 0;  // PIR rising edges since it was armed (counted in the interrupt)
bool pirArmed = false;
uint32_t motionAtLastReport = 0;
uint32_t motionAtLastEvent = 0;

bool raining = false;
int loudestP2P = 0;                 // biggest sound swing since the last reading
unsigned long lastLoudEventMs = 0;
unsigned long lastReportMs = 0;
uint32_t readingNumber = 0;

// static keeps the Arduino IDE from re-declaring it, which clashes with IRAM_ATTR.
static void IRAM_ATTR onMotion() {
  motionTotal = motionTotal + 1;  // only this interrupt writes it, so no lock is needed
}

// A delay that keeps the MQTT connection alive.
void serviceDelay(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    mqtt.loop();
    delay(5);
  }
}

// ===== Helpers ==========================================================
String uptime() {
  unsigned long s = millis() / 1000;
  char buf[24];
  snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", s / 3600, (s / 60) % 60, s % 60);
  return String(buf);
}

// Maps a raw reading onto 0-100 % between two calibration points.
float toPercent(float raw, float rawAt0, float rawAt100) {
  float pct = (raw - rawAt0) * 100.0f / (rawAt100 - rawAt0);
  if (pct <= 0) pct = 0;  // "<=" also turns -0.0 into 0.0
  if (pct > 100) pct = 100;
  return pct;
}

// Averages 16 readings to smooth out ADC noise.
int readAnalogAverage(int pin) {
  long sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogRead(pin);
    delayMicroseconds(200);
  }
  return (int)(sum / 16);
}

// The KY-037's A0 is the raw microphone signal, so loudness is how far it
// swings. Watch it for 50 ms and return the swing (peak-to-peak).
int soundPeakToPeak() {
  int lowest = 4095, highest = 0;
  unsigned long start = millis();
  while (millis() - start < 50) {
    int v = analogRead(PIN_SOUND_AO);
    if (v < lowest) lowest = v;
    if (v > highest) highest = v;
  }
  return highest - lowest;
}

// ---- DHT11 ----
// The sensor answers a start pulse with 40 bits: a short HIGH is a 0, a long
// HIGH is a 1. The pin is open-drain (see startupChecks), so the code only
// pulls it LOW or lets go and never switches pin modes mid-read; the usual DHT
// libraries time out on recent ESP32 cores because that switch is too slow.

// Waits while the pin stays at 'level'. Returns how long that took in
// microseconds, or -1 after timeoutUs.
static int32_t dhtPulse(int level, uint32_t timeoutUs) {
  uint32_t start = micros();
  while (digitalRead(PIN_DHT) == level) {
    if (micros() - start > timeoutUs) return -1;
  }
  return (int32_t)(micros() - start);
}

// Fills tempC and humPct when the read works. bitsRead says how far it got.
DhtResult readDHT(float &tempC, float &humPct, int &bitsRead) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  bitsRead = 0;

  digitalWrite(PIN_DHT, LOW);   // start signal
  delay(20);                    // DHT11 needs at least 18 ms
  digitalWrite(PIN_DHT, HIGH);  // let go: the sensor answers

  DhtResult result = DHT_OK;
  portENTER_CRITICAL(&dhtMux);  // about 5 ms with no interrupts
  // The sensor's reply: pulls LOW ~80 us, then HIGH ~80 us
  if (dhtPulse(HIGH, 250) < 0 || dhtPulse(LOW, 250) < 0 || dhtPulse(HIGH, 250) < 0) {
    result = DHT_NO_RESPONSE;
  }
  // 40 bits: ~50 us LOW, then HIGH for ~27 us (a 0) or ~70 us (a 1)
  for (int i = 0; result == DHT_OK && i < 40; i++) {
    int32_t high = (dhtPulse(LOW, 250) < 0) ? -1 : dhtPulse(HIGH, 250);
    if (high < 0) {
      result = DHT_BITS_TIMEOUT;
    } else {
      d[i / 8] = (uint8_t)((d[i / 8] << 1) | (high > 48 ? 1 : 0));
      bitsRead++;
    }
  }
  portEXIT_CRITICAL(&dhtMux);

  if (result == DHT_OK && (uint8_t)(d[0] + d[1] + d[2] + d[3]) != d[4]) result = DHT_BAD_CHECKSUM;
  if (result != DHT_OK) return result;

  humPct = d[0] + d[1] * 0.1f;
  tempC = d[2] + (d[3] & 0x7F) * 0.1f;
  if (d[3] & 0x80) tempC = -tempC;
  return DHT_OK;
}

const char *dhtProblem(DhtResult r) {
  switch (r) {
    case DHT_NO_RESPONSE: return "no reply from the sensor (wiring, power, or wrong GPIO)";
    case DHT_BITS_TIMEOUT: return "reply cut off part-way (loose wire or long cable)";
    case DHT_BAD_CHECKSUM: return "checksum wrong (electrical noise; one-off misses are normal)";
    default: return "ok";
  }
}

// ---- HC-SR04 ----
// Sends one ping. Returns the distance in cm, or -1 if no echo came back in time.
float pingOnce() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);  // a 10 us pulse starts the ping
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  unsigned long echoUs = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  if (echoUs == 0) return -1;
  return echoUs * CM_PER_US / 2;  // halved: the sound went there and back
}

// Median of the pings that got an echo, so one stray reflection can't skew the result.
// Returns -1 if none did. Takes up to about 200 ms.
float readDistanceCm(int &hits) {
  float sorted[PINGS_PER_READING];
  hits = 0;

  for (int i = 0; i < PINGS_PER_READING; i++) {
    if (i > 0) serviceDelay(PING_GAP_MS);
    float cm = pingOnce();
    if (cm < 0) continue;

    int slot = hits;
    while (slot > 0 && sorted[slot - 1] > cm) {
      sorted[slot] = sorted[slot - 1];
      slot--;
    }
    sorted[slot] = cm;
    hits++;
  }
  return hits == 0 ? -1 : sorted[hits / 2];
}

const char *rangeLabel(float v, float lo, float hi, const char *lowText, const char *highText) {
  if (isnan(v)) return "NO DATA";
  if (v < lo) return lowText;
  if (v > hi) return highText;
  return "OK";
}

String jsonNumber(float v, int decimals) {
  return isnan(v) ? String("null") : String(v, decimals);
}

// ===== Start-up checks (the same five as IoT Project.ino) ===============
void startupChecks() {
  // Check 1: with nothing pulling it down, the DHT data line should idle HIGH.
  pinMode(PIN_DHT, INPUT);
  delay(10);
  int idle = digitalRead(PIN_DHT);
  Serial.printf("Check 1 - DHT data line at rest: %s\r\n",
                idle ? "HIGH (good: sensor powered, pull-up present)"
                     : "LOW (problem: check VCC/GND, the DATA wire, or add a 10k pull-up to 3V3)");

  // Open-drain from here on: the code only ever pulls the line LOW or lets it go.
  pinMode(PIN_DHT, OUTPUT_OPEN_DRAIN | PULLUP);
  digitalWrite(PIN_DHT, HIGH);

  // Check 2: the soil probe's AO should give a steady value, not 0.
  int soilIdle = readAnalogAverage(PIN_SOIL_AO);
  Serial.printf("Check 2 - soil AO at start: raw %d %s\r\n", soilIdle,
                soilIdle < 50 ? "(problem: reads ~0 V, check VCC on the probe board and the AO wire)"
                              : "(good: probe board powered)");

  // Check 3: same for the rain sensor; a dry plate should read high (near 4095).
  int rainIdle = readAnalogAverage(PIN_RAIN_AO);
  Serial.printf("Check 3 - rain AO at start: raw %d %s\r\n", rainIdle,
                rainIdle < 50 ? "(problem: reads ~0 V, check VCC on the rain board and the AO wire)"
                              : "(good: rain board powered)");

  // Check 4: in silence the mic's A0 should rest somewhere in the middle. Pinned at either
  // end, it can't swing, so every sound reads 0 %.
  int soundIdle = readAnalogAverage(PIN_SOUND_AO);
  Serial.printf("Check 4 - sound A0 at rest: raw %d %s\r\n", soundIdle,
                soundIdle < 50     ? "(problem: ~0 V, check VCC/GND and the A0 wire, or turn the knob)"
                : soundIdle > 4045 ? "(problem: stuck at the top, turn the blue knob until this drops)"
                                   : "(good)");

  // Check 5: a test ping should come back, as long as something is within 4 m.
  int pings;
  float cm = readDistanceCm(pings);
  if (cm < 0) {
    Serial.println("Check 5 - HC-SR04: no echo (problem if something is in front of it: "
                   "check 5V on VCC, GND, Trig, and the divider on Echo)");
  } else {
    Serial.printf("Check 5 - HC-SR04: %.1f cm (good)\r\n", cm);
  }

  Serial.printf("PIR warming up: motion is counted after %lu s (OUT may flicker until then)\r\n",
                PIR_WARMUP_MS / 1000);
}

// ===== Wi-Fi and MQTT ===================================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Wi-Fi: connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptMs < 15000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(" connected, IP %s, signal %d dBm\r\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println(" failed (check the name and password; it keeps retrying)");
  }
}

// Connects to the broker. Returns true when connected.
bool connectMqtt() {
  if (mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;
  lastMqttAttemptMs = millis();
  Serial.printf("MQTT: connecting to %s:%u as %s ...", MQTT_HOST, MQTT_PORT, clientId.c_str());
  if (!mqtt.connect(clientId.c_str())) {
    Serial.printf(" failed (state %d), retrying in 5 s\r\n", mqtt.state());
    return false;
  }
  Serial.println(" connected");
  return true;
}

// Called from loop(): reconnects Wi-Fi and MQTT when they drop.
void keepConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiAttemptMs > 15000) {
      lastWifiAttemptMs = millis();
      Serial.println("Wi-Fi: not connected, retrying");
      WiFi.reconnect();
    }
    return;
  }
  if (!mqtt.connected() && millis() - lastMqttAttemptMs > 5000) connectMqtt();
  mqtt.loop();
}

// ===== One full reading =================================================
void sendReading() {
  readingNumber++;

  // Soil moisture and rain (resistive: lower voltage = wetter)
  int soilRaw = readAnalogAverage(PIN_SOIL_AO);
  float soilPct = toPercent(soilRaw, SOIL_RAW_DRY, SOIL_RAW_WET);
  int rainRaw = readAnalogAverage(PIN_RAIN_AO);
  float rainPct = toPercent(rainRaw, RAIN_RAW_DRY, RAIN_RAW_WET);

  // Temperature and humidity
  float tempC = NAN, humPct = NAN;
  int dhtBits = 0;
  dhtAttempts++;
  DhtResult dht = readDHT(tempC, humPct, dhtBits);
  if (dht != DHT_OK) {   // a real DHT misses the odd read: wait and try once more
    serviceDelay(2100);  // it needs about 2 s between reads
    dht = readDHT(tempC, humPct, dhtBits);
  }
  if (dht == DHT_OK) {
    dhtPasses++;
  } else {
    tempC = NAN;
    humPct = NAN;
  }

  // Distance (HC-SR04)
  int pings = 0;
  float distCm = NAN;
  float cm = readDistanceCm(pings);
  if (cm >= 0) distCm = cm;

  // Motion and sound since the previous reading
  uint32_t motionNow = motionTotal;
  uint32_t motionEvents = motionNow - motionAtLastReport;
  motionAtLastReport = motionNow;
  int soundP2P = loudestP2P;
  float soundPeakPct = toPercent(soundP2P, SOUND_P2P_QUIET, SOUND_P2P_LOUD);
  loudestP2P = 0;
  int pirOut = digitalRead(PIN_PIR);

  // ---- Summary for the Serial Monitor ----
  Serial.println();
  Serial.printf("=== Reading #%lu   uptime %s   node %s ===\r\n",
                (unsigned long)readingNumber, uptime().c_str(), DEVICE_CODE);
  Serial.printf("  Soil moisture  %5.1f %%   (raw %4d)  %s\r\n", soilPct, soilRaw,
                rangeLabel(soilPct, SOIL_MIN, SOIL_MAX, "TOO DRY", "TOO WET"));
  Serial.printf("  Temperature    %5.1f C               %s\r\n", tempC,
                rangeLabel(tempC, TEMP_MIN, TEMP_MAX, "TOO COLD", "TOO HOT"));
  Serial.printf("  Humidity       %5.1f %%               %s\r\n", humPct,
                rangeLabel(humPct, HUM_MIN, HUM_MAX, "TOO DRY", "TOO HUMID"));
  if (dht != DHT_OK) {
    Serial.printf("    DHT failed: %s", dhtProblem(dht));
    if (dht == DHT_BITS_TIMEOUT) Serial.printf(", after %d of 40 bits", dhtBits);
    Serial.println();
  }
  if (dht == DHT_OK && (tempC < 0 || tempC > 50 || humPct < 5 || humPct > 95)) {
    Serial.println("    Outside the DHT11's range: is it a DHT22? (AM2302 / white case)");
  }
  Serial.printf("    DHT pass rate %lu/%lu\r\n", (unsigned long)dhtPasses, (unsigned long)dhtAttempts);
  Serial.printf("  Rain           %5.1f %%   (raw %4d)  %s\r\n", rainPct, rainRaw,
                raining ? "RAINING" : "dry");
  Serial.printf("  Sound (peak)   %5.1f %%   (p2p %4d, loudest since last reading)\r\n",
                soundPeakPct, soundP2P);
  if (pirArmed) {
    Serial.printf("  Motion         %5lu event(s) since last reading   (OUT now %s)\r\n",
                  (unsigned long)motionEvents, pirOut ? "HIGH" : "LOW");
  } else {
    Serial.printf("  Motion         warming up, %lu s left   (OUT now %s)\r\n",
                  (PIR_WARMUP_MS - millis()) / 1000 + 1, pirOut ? "HIGH" : "LOW");
  }
  if (isnan(distCm)) {
    Serial.println("  Distance       no echo (nothing within 4 m, or check the wiring)");
  } else {
    Serial.printf("  Distance       %5.1f cm  (%d of %d pings)\r\n", distCm, pings,
                  PINGS_PER_READING);
  }

  // ---- JSON: field names match the sensor_readings columns ----
  // recorded_at is left out on purpose: the backend stamps server time.
  // distance_cm is null when none of the pings got an echo.
  String json = "{";
  json += "\"device_code\":\"" + String(DEVICE_CODE) + "\",";
  json += "\"" + String(KEY_FIELD) + "\":\"" + String(DEVICE_KEY) + "\",";
  json += "\"soil_moisture_pct\":" + jsonNumber(soilPct, 1) + ",";
  json += "\"temperature_c\":" + jsonNumber(tempC, 1) + ",";
  json += "\"humidity_pct\":" + jsonNumber(humPct, 1) + ",";
  json += "\"rain_pct\":" + jsonNumber(rainPct, 1) + ",";
  json += "\"is_raining\":" + String(raining ? "true" : "false") + ",";
  json += "\"motion_events\":" + String(motionEvents) + ",";
  json += "\"sound_peak_pct\":" + jsonNumber(soundPeakPct, 1) + ",";
  json += "\"distance_cm\":" + jsonNumber(distCm, 1) + ",";
  json += "\"wifi_rssi_dbm\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + ",";
  json += "\"uptime_s\":" + String(millis() / 1000);
  json += "}";
  Serial.printf("  JSON  %s\r\n", json.c_str());

  // ---- Publish it ----
  digitalWrite(PIN_LED, HIGH);
  if (!connectMqtt()) {
    Serial.println("  Not sent: no Wi-Fi or MQTT connection");
  } else if (mqtt.publish(topicReadings.c_str(), json.c_str())) {
    Serial.printf("  MQTT -> %s\r\n", topicReadings.c_str());
  } else {
    Serial.println("  MQTT publish failed (message too big or connection lost)");
  }
  digitalWrite(PIN_LED, LOW);
}

// ===== Arduino entry points =============================================
void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_PIR, INPUT);            // the HC-SR501 drives OUT itself: HIGH = motion
  pinMode(PIN_TRIG, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT_PULLDOWN);  // a loose Echo wire then reads LOW instead of noise
  analogReadResolution(12);           // 0-4095

  topicReadings = String(TOPIC_PREFIX) + "/" + DEVICE_CODE + "/readings";

  // The public broker drops a client when another one connects with the same
  // ID, so add part of this chip's MAC address to make the ID unique.
  WiFi.mode(WIFI_STA);
  char id[40];
  snprintf(id, sizeof(id), "florascan-%s-%06lX", DEVICE_CODE,
           (unsigned long)(ESP.getEfuseMac() & 0xFFFFFF));
  clientId = id;

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);  // a reading is about 350 bytes; the default limit is 256
  mqtt.setKeepAlive(30);

  Serial.println();
  Serial.println("FloraScan plant sensor node");
  Serial.printf("Device %s, reporting every %lu s\r\n", DEVICE_CODE, REPORT_INTERVAL_MS / 1000);
  Serial.printf("DHT on GPIO%d, soil GPIO%d, rain GPIO%d, sound GPIO%d, PIR GPIO%d, "
                "HC-SR04 Trig GPIO%d / Echo GPIO%d\r\n",
                PIN_DHT, PIN_SOIL_AO, PIN_RAIN_AO, PIN_SOUND_AO, PIN_PIR, PIN_TRIG, PIN_ECHO);

  startupChecks();
  delay(2000);  // let the DHT settle after the line check
  connectWiFi();
  connectMqtt();
}

void loop() {
  keepConnected();

  // Arm the PIR once it has warmed up, then report each new motion straight away.
  if (!pirArmed && millis() >= PIR_WARMUP_MS) {
    attachInterrupt(digitalPinToInterrupt(PIN_PIR), onMotion, RISING);
    pirArmed = true;
    Serial.printf("[%s] PIR armed: now counting motion\r\n", uptime().c_str());
  }
  uint32_t motionNow = motionTotal;
  if (motionNow != motionAtLastEvent) {
    Serial.printf("[%s] Motion detected near the plant\r\n", uptime().c_str());
    motionAtLastEvent = motionNow;
  }

  // Rain events, with two thresholds so drops on the plate don't flicker it
  float rainPct = toPercent(readAnalogAverage(PIN_RAIN_AO), RAIN_RAW_DRY, RAIN_RAW_WET);
  if (!raining && rainPct >= RAIN_START_PCT) {
    raining = true;
    Serial.printf("[%s] Rain started (%.0f %% wet)\r\n", uptime().c_str(), rainPct);
  } else if (raining && rainPct < RAIN_STOP_PCT) {
    raining = false;
    Serial.printf("[%s] Rain stopped\r\n", uptime().c_str());
  }

  // Sound is sampled on every pass so a short clap isn't missed.
  int p2p = soundPeakToPeak();
  if (p2p > loudestP2P) loudestP2P = p2p;
  float soundPct = toPercent(p2p, SOUND_P2P_QUIET, SOUND_P2P_LOUD);
  if (soundPct >= LOUD_EVENT_PCT && millis() - lastLoudEventMs > 1000) {
    lastLoudEventMs = millis();
    Serial.printf("[%s] Loud noise near the plant (%.0f %%, p2p %d)\r\n", uptime().c_str(),
                  soundPct, p2p);
  }

  // ---- Full reading every REPORT_INTERVAL_MS (and once at start-up) ----
  if (readingNumber == 0 || millis() - lastReportMs >= REPORT_INTERVAL_MS) {
    lastReportMs = millis();
    sendReading();
  }

  delay(10);
}
