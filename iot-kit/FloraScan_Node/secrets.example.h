// Copy this file to secrets.h (same folder) and fill it in.
// secrets.h is gitignored: never commit the real values, or paste them in a
// chat or an issue.
#pragma once

// Wi-Fi: 2.4 GHz only, e.g. a phone hotspot.
const char *WIFI_SSID = "YOUR-WIFI-NAME";
const char *WIFI_PASSWORD = "YOUR-WIFI-PASSWORD";

// The node's broker login. Ask the IoT team.
const char *MQTT_USER = "YOUR-MQTT-USERNAME";
const char *MQTT_PASS = "YOUR-MQTT-PASSWORD";

// This node's key. The database keeps SHA2(key, 256): put the same value in
// the server's .env as IOT_DEVICE_KEY and reseed (see iot-kit/README.md).
const char *DEVICE_KEY = "YOUR-DEVICE-KEY";
