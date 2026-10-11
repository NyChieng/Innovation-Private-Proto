/*
  FloraScan plant sensor node (COS30049)
  ----------------------------------------------------------------------
  One ESP32 next to one monitored plant, using the sensors in our kit:

    DHT11 temperature + humidity     soil moisture probe (FC-28 style)
    raindrop plate (MH-RD)           HC-SR501 PIR motion sensor
    KY-037 sound sensor              LDR light sensor

  Every REPORT_INTERVAL_MS it reads everything, prints a summary to the
  Serial Monitor and publishes one JSON reading over MQTT to a public
  broker. The FloraScan backend (mqtt.js) subscribes to the same topic,
  checks the device code and key, and saves the reading in sensor_readings.
  Motion, rain and loud noise are also printed straight away as events.

  The same file runs in Wokwi and on the real board:
  set SIMULATION to 0 before uploading it to the real kit.

  One library is needed: PubSubClient (by Nick O'Leary).
    Wokwi:       Library Manager tab -> "+" -> PubSubClient
    Arduino IDE: Tools > Manage Libraries -> PubSubClient
  The DHT reader is built in (readDHT below).
*/
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

// ===== 1. Wokwi or the real kit? =======================================
#define SIMULATION 1  // 1 = Wokwi simulator, 0 = real ESP32 + sensors

#if SIMULATION
const char *WIFI_SSID = "Wokwi-GUEST";  // Wokwi's built-in open Wi-Fi
const char *WIFI_PASSWORD = "";
const unsigned long REPORT_INTERVAL_MS = 20UL * 1000;     // every 10 s for demos
#else
const char *WIFI_SSID = "YOUR-WIFI-NAME";
const char *WIFI_PASSWORD = "YOUR-WIFI-PASSWORD";
const unsigned long REPORT_INTERVAL_MS = 5UL * 60 * 1000; // every 5 min
#endif

// ===== 2. MQTT ==========================================================
// The node publishes to a free public broker and the backend subscribes to
// the same topic, so neither side has to reach the other directly. Anyone
// can read or write any topic on a public broker, so this is for testing
// only, and the topic starts with something unique to our group.
const char *MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char *TOPIC_PREFIX = "florascan-swinburne-demo";  // must match the backend
const char *DEVICE_CODE = "SN-001";             // sensor_devices.device_code
const char *DEVICE_KEY = "demo-key-change-me";  // key issued when a botanist sets up the sensor
// Readings go to TOPIC_PREFIX/DEVICE_CODE/readings, e.g.
// florascan-swinburne-demo/SN-001/readings

// ===== 3. Pins (identical in Wokwi and on the real board) ===============
// GPIO numbers. 30-pin boards label them D34, D35...; 38-pin boards 34, 35...
// Analog sensors must use ADC1 pins (GPIO 32-39): ADC2 pins stop working
// while Wi-Fi is on.
const int PIN_SOIL_AO = 34;   // soil moisture AO
const int PIN_RAIN_AO = 35;   // rain sensor AO
const int PIN_SOUND_AO = 32;  // KY-037 A0
const int PIN_LIGHT_AO = 33;  // light sensor: the point between the LDR and its resistor
const int PIN_DHT = 4;        // DHT11 "out"
const int PIN_PIR = 27;       // HC-SR501 OUT
const int PIN_LED = 2;        // on-board LED on DOIT boards: lit while sending

// ===== 4. Calibration (re-measure with your own sensors, see README) ===
// Raw readings run from 0 to 4095. The probes read HIGH when dry.
const int SOIL_RAW_DRY = 4095;     // soil probe in dry air
const int SOIL_RAW_WET = 1430;     // soil probe in a glass of water
const int RAIN_RAW_DRY = 4095;     // rain plate dry
const int RAIN_RAW_WET = 615;      // rain plate covered in water
const int SOUND_P2P_QUIET = 15;    // A0 swing (peak-to-peak) in a quiet room
const int SOUND_P2P_LOUD = 1000;   // A0 swing for a loud clap next to the mic

const float RAIN_START_PCT = 20;   // plate wetter than this = raining
const float RAIN_STOP_PCT = 10;    // ...and drier than this = rain stopped
const float LOUD_EVENT_PCT = 60;   // log a "loud noise" event above this

// Light: the LDR and a fixed resistor form a voltage divider. On the real
// kit, wire a 1 kOhm resistor from 3V3 to AO and the LDR from AO to GND.
// More light = less LDR resistance = lower voltage on AO.
// Wokwi's light sensor has a 10 kOhm resistor built in, so diagram.json
// gives its LDR 10 times the resistance (rl10 = 150): both circuits then
// put the same voltage on AO for the same light.
#if SIMULATION
const float LIGHT_FIXED_KOHM = 10;    // built into Wokwi's light sensor
const float LDR_KOHM_AT_10LUX = 150;  // = rl10 in diagram.json
#else
const float LIGHT_FIXED_KOHM = 1;     // your resistor (set 10 if you used 10 kOhm, see README)
const float LDR_KOHM_AT_10LUX = 15;   // GL5528, the usual kit LDR: 8-20 kOhm at 10 lux
#endif
const float LDR_GAMMA = 0.6;          // GL5528 datasheet (= gamma in diagram.json)
const float LUX_MAX = 100000;         // direct sunlight; brighter readings are capped

// Safe ranges, for the summary only: the backend does the real check using
// the limits a botanist sets in sensor_devices.
const float SOIL_MIN = 30, SOIL_MAX = 80;  // %
const float TEMP_MIN = 18, TEMP_MAX = 35;  // degrees C
const float HUM_MIN = 40, HUM_MAX = 90;    // % RH

// The real HC-SR501 gives false triggers for up to a minute after power-up.
const unsigned long PIR_WARMUP_MS = SIMULATION ? 0 : 60000UL;

// Wokwi only has the DHT22; the kit has a DHT11. They send data differently.
const bool DHT_IS_DHT22 = SIMULATION;

// ===== Globals ==========================================================
WiFiClient netClient;
PubSubClient mqtt(netClient);
char mqttTopic[96];                 // built in setup()
unsigned long lastMqttTryMs = 0;

portMUX_TYPE dhtMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t motionTotal = 0;  // PIR rising edges since boot (counted in the ISR)
bool pirArmed = false;
uint32_t motionAtLastReport = 0;
uint32_t motionAtLastEvent = 0;

bool raining = false;
float loudestSincePct = 0;          // peak sound level since the last report
unsigned long lastLoudEventMs = 0;
unsigned long lastReportMs = 0;
uint32_t readingNumber = 0;

void IRAM_ATTR onMotion() {
  motionTotal = motionTotal + 1;  // only this interrupt writes it, so no lock is needed
}

// ===== Helpers ==========================================================
String uptime() {
  unsigned long s = millis() / 1000;
  char buf[12];
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

// ---- Light (LDR) ----
// How far the light sensor's AO sits between 0 V (0.0) and the 3.3 V supply (1.0).
float readLightFraction(int rawAverage) {
#if SIMULATION
  // Wokwi's light sensor and its ADC both work on a 5 V scale, so the raw
  // reading over 4095 is already AO divided by the supply.
  return rawAverage / 4095.0f;
#else
  // The real ESP32's ADC bends near 0 V and 3.3 V. analogReadMilliVolts()
  // corrects that with the chip's factory calibration.
  (void)rawAverage;
  long mv = 0;
  for (int i = 0; i < 16; i++) {
    mv += analogReadMilliVolts(PIN_LIGHT_AO);
    delayMicroseconds(200);
  }
  return (mv / 16.0f) / 3300.0f;
#endif
}

// Turns that fraction into lux, using the LDR's datasheet curve:
// resistance = LDR_KOHM_AT_10LUX * (lux / 10) ^ -LDR_GAMMA
float luxFromFraction(float fraction) {
  if (fraction >= 0.999f) return 0;         // pitch dark
  if (fraction <= 0.0001f) return LUX_MAX;  // brighter than the circuit can measure
  float ldrKohm = LIGHT_FIXED_KOHM * fraction / (1.0f - fraction);
  float lux = 10.0f * powf(LDR_KOHM_AT_10LUX / ldrKohm, 1.0f / LDR_GAMMA);
  return lux > LUX_MAX ? LUX_MAX : lux;
}

const char *lightLabel(float lux) {
  if (lux < 10) return "dark";
  if (lux < 1000) return "dim";
  if (lux < 10000) return "bright";
  return "very bright";
}

// ---- DHT11 / DHT22 ----
// The sensor answers a start pulse with 40 bits: a short HIGH is a 0, a long
// HIGH is a 1. The pin is set up once as open-drain (see setup), so the code
// only pulls it LOW or lets go and never switches pin modes mid-read; on
// ESP32 core 3.x that switch is too slow and makes DHT libraries time out.

// Waits while the pin stays at 'level'. Returns how long that took in
// microseconds, or -1 after timeoutUs.
static int32_t dhtPulse(int level, uint32_t timeoutUs) {
  uint32_t start = micros();
  while (digitalRead(PIN_DHT) == level) {
    if (micros() - start > timeoutUs) return -1;
  }
  return (int32_t)(micros() - start);
}

bool readDHT(float &tempC, float &humPct) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  digitalWrite(PIN_DHT, LOW);              // start signal
  delay(DHT_IS_DHT22 ? 2 : 20);            // DHT11 needs at least 18 ms
  digitalWrite(PIN_DHT, HIGH);             // let go: the sensor answers

  bool ok = true;
  portENTER_CRITICAL(&dhtMux);             // ~5 ms with no interrupts on this core
  if (dhtPulse(HIGH, 250) < 0 || dhtPulse(LOW, 250) < 0 || dhtPulse(HIGH, 250) < 0) ok = false;
  for (int i = 0; ok && i < 40; i++) {
    int32_t high = (dhtPulse(LOW, 250) < 0) ? -1 : dhtPulse(HIGH, 250);
    if (high < 0) ok = false;
    else d[i / 8] = (uint8_t)((d[i / 8] << 1) | (high > 48 ? 1 : 0));
  }
  portEXIT_CRITICAL(&dhtMux);

  if (!ok || (uint8_t)(d[0] + d[1] + d[2] + d[3]) != d[4]) return false;
  if (DHT_IS_DHT22) {
    humPct = ((d[0] << 8) | d[1]) * 0.1f;
    tempC = (((d[2] & 0x7F) << 8) | d[3]) * 0.1f;
    if (d[2] & 0x80) tempC = -tempC;
  } else {
    humPct = d[0] + d[1] * 0.1f;
    tempC = d[2] + (d[3] & 0x7F) * 0.1f;
    if (d[3] & 0x80) tempC = -tempC;
  }
  return true;
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

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Wi-Fi: connecting to %s", WIFI_SSID);
#if SIMULATION
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 6);  // channel 6 skips the scan in Wokwi
#else
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#endif
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(" connected, IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(" failed (will retry at the next reading)");
  }
}

// Connects to the MQTT broker if needed. Returns true when connected.
bool connectMqtt() {
  if (mqtt.connected()) return true;
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return false;

  // Every client on the broker needs its own ID: a second client with the
  // same ID kicks the first one off. A random suffix avoids clashes.
  char clientId[48];
  snprintf(clientId, sizeof(clientId), "florascan-%s-%04lx", DEVICE_CODE,
           (unsigned long)random(0x10000));
  Serial.printf("MQTT: connecting to %s:%u as %s...", MQTT_HOST, MQTT_PORT, clientId);
  if (mqtt.connect(clientId)) {
    Serial.println(" connected");
    return true;
  }
  // state() codes: -4 timeout, -2 could not reach the broker, 5 not authorised
  Serial.printf(" failed (state %d), will retry\n", mqtt.state());
  return false;
}

// ===== One full reading =================================================
void sendReading() {
  readingNumber++;

  // Soil moisture and rain (resistive: lower voltage = wetter)
  int soilRaw = readAnalogAverage(PIN_SOIL_AO);
  float soilPct = toPercent(soilRaw, SOIL_RAW_DRY, SOIL_RAW_WET);
  int rainRaw = readAnalogAverage(PIN_RAIN_AO);
  float rainPct = toPercent(rainRaw, RAIN_RAW_DRY, RAIN_RAW_WET);

  // Light (LDR: lower voltage = brighter)
  int lightRaw = readAnalogAverage(PIN_LIGHT_AO);
  float lux = luxFromFraction(readLightFraction(lightRaw));
  unsigned long luxWhole = (unsigned long)lroundf(lux);

  // Temperature and humidity
  float tempC = NAN, humPct = NAN;
  bool dhtOk = readDHT(tempC, humPct);
  if (!dhtOk) {   // a real DHT misses the odd read: wait and try once more
    delay(2100);  // it needs about 2 s between reads
    dhtOk = readDHT(tempC, humPct);
  }
  if (!dhtOk) {
    Serial.println("[warn] DHT read failed: check its wiring");
    tempC = NAN;
    humPct = NAN;
  }

  // Motion and sound since the previous reading
  uint32_t motionNow = motionTotal;
  uint32_t motionEvents = motionNow - motionAtLastReport;
  motionAtLastReport = motionNow;
  float soundPeakPct = loudestSincePct;
  loudestSincePct = 0;

  // ---- Summary for the Serial Monitor ----
  Serial.println();
  Serial.printf("=== Reading #%lu   uptime %s   node %s ===\n",
                (unsigned long)readingNumber, uptime().c_str(), DEVICE_CODE);
  Serial.printf("  Soil moisture  %5.1f %%   (raw %4d)  %s\n", soilPct, soilRaw,
                rangeLabel(soilPct, SOIL_MIN, SOIL_MAX, "TOO DRY", "TOO WET"));
  Serial.printf("  Temperature    %5.1f C               %s\n", tempC,
                rangeLabel(tempC, TEMP_MIN, TEMP_MAX, "TOO COLD", "TOO HOT"));
  Serial.printf("  Humidity       %5.1f %%               %s\n", humPct,
                rangeLabel(humPct, HUM_MIN, HUM_MAX, "TOO DRY", "TOO HUMID"));
  Serial.printf("  Light         %6lu lx  (raw %4d)  %s\n", luxWhole, lightRaw,
                lightLabel(lux));
  Serial.printf("  Rain           %5.1f %%   (raw %4d)  %s\n", rainPct, rainRaw,
                raining ? "RAINING" : "dry");
  Serial.printf("  Motion         %5lu event(s) since last reading\n", (unsigned long)motionEvents);
  Serial.printf("  Sound (peak)   %5.1f %%\n", soundPeakPct);

  // ---- JSON body: field names match the sensor_readings table ----
  // recorded_at is left out on purpose: the backend stamps server time.
  // MQTT has no headers, so the device key travels inside the message.
  String json = "{";
  json += "\"device_code\":\"" + String(DEVICE_CODE) + "\",";
  json += "\"device_key\":\"" + String(DEVICE_KEY) + "\",";
  json += "\"soil_moisture_pct\":" + jsonNumber(soilPct, 1) + ",";
  json += "\"temperature_c\":" + jsonNumber(tempC, 1) + ",";
  json += "\"humidity_pct\":" + jsonNumber(humPct, 1) + ",";
  json += "\"light_lux\":" + String(luxWhole) + ",";
  json += "\"rain_pct\":" + jsonNumber(rainPct, 1) + ",";
  json += "\"is_raining\":" + String(raining ? "true" : "false") + ",";
  json += "\"motion_events\":" + String(motionEvents) + ",";
  json += "\"sound_peak_pct\":" + jsonNumber(soundPeakPct, 1) + ",";
  json += "\"wifi_rssi_dbm\":" + String(WiFi.RSSI()) + ",";
  json += "\"uptime_s\":" + String(millis() / 1000);
  json += "}";
  Serial.printf("  JSON  %s\n", json.c_str());

  // ---- Send it ----
  // QoS 0: "sent" means the broker got it, not that the backend saved it.
  digitalWrite(PIN_LED, HIGH);
  bool sent = connectMqtt() && mqtt.publish(mqttTopic, json.c_str());
  digitalWrite(PIN_LED, LOW);

  if (sent) {
    Serial.printf("  MQTT -> %s (%u bytes)\n", mqttTopic, json.length());
  } else if (!mqtt.connected()) {
    Serial.println("  MQTT not connected: reading not sent");
  } else {
    Serial.println("  MQTT publish failed: message bigger than the buffer?");
  }
}

// ===== Arduino entry points =============================================
void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_PIR, INPUT);
  analogReadResolution(12);  // 0-4095 (the ESP32 default, set for clarity)
  pinMode(PIN_DHT, OUTPUT_OPEN_DRAIN | PULLUP);  // DHT data line: pull LOW or let go
  digitalWrite(PIN_DHT, HIGH);                   // idle = let go

  snprintf(mqttTopic, sizeof(mqttTopic), "%s/%s/readings", TOPIC_PREFIX, DEVICE_CODE);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);   // the default 256 bytes is too small for one reading
  mqtt.setKeepAlive(30);     // seconds
  mqtt.setSocketTimeout(5);  // seconds: don't freeze the sensors for long if the broker is down

  Serial.println();
  Serial.println("FloraScan plant sensor node");
  Serial.printf("Device %s, %s, reporting every %lu s\n", DEVICE_CODE,
                SIMULATION ? "Wokwi simulation" : "real hardware", REPORT_INTERVAL_MS / 1000);
  Serial.printf("Publishing to %s on %s\n", mqttTopic, MQTT_HOST);
  Serial.println("Tip: click a sensor in the diagram to change its reading.");
  connectMqtt();  // also connects Wi-Fi
  lastMqttTryMs = millis();
}

void loop() {
  // ---- Keep the MQTT connection alive (retry every 5 s if it drops) ----
  if (!mqtt.connected() && millis() - lastMqttTryMs >= 5000) {
    lastMqttTryMs = millis();
    connectMqtt();
  }
  mqtt.loop();

  // Arm the PIR once it has warmed up
  if (!pirArmed && millis() >= PIR_WARMUP_MS) {
    attachInterrupt(digitalPinToInterrupt(PIN_PIR), onMotion, RISING);
    pirArmed = true;
  }

  // ---- Events: printed as soon as they happen ----
  uint32_t motionNow = motionTotal;
  if (motionNow != motionAtLastEvent) {
    Serial.printf("[%s] Motion detected near the plant\n", uptime().c_str());
    motionAtLastEvent = motionNow;
  }

  float rainPct = toPercent(readAnalogAverage(PIN_RAIN_AO), RAIN_RAW_DRY, RAIN_RAW_WET);
  if (!raining && rainPct >= RAIN_START_PCT) {
    raining = true;
    Serial.printf("[%s] Rain started (%.0f %% wet)\n", uptime().c_str(), rainPct);
  } else if (raining && rainPct < RAIN_STOP_PCT) {
    raining = false;
    Serial.printf("[%s] Rain stopped\n", uptime().c_str());
  }

  float soundPct = toPercent(soundPeakToPeak(), SOUND_P2P_QUIET, SOUND_P2P_LOUD);
  if (soundPct > loudestSincePct) loudestSincePct = soundPct;
  if (soundPct >= LOUD_EVENT_PCT && millis() - lastLoudEventMs > 5000) {
    lastLoudEventMs = millis();
    Serial.printf("[%s] Loud noise near the plant (%.0f %%)\n", uptime().c_str(), soundPct);
  }

  // ---- Full reading every REPORT_INTERVAL_MS (and once at start-up) ----
  if (readingNumber == 0 || millis() - lastReportMs >= REPORT_INTERVAL_MS) {
    lastReportMs = millis();
    sendReading();
  }

  delay(150);
}