# FloraScan sensor node (real kit)

`FloraScan_Node/FloraScan_Node.ino` is the firmware for the real ESP32 kit: soil
moisture, DHT11, raindrop plate, KY-037 sound sensor, HC-SR501 PIR and HC-SR04
distance sensor. Every 20 seconds it publishes one JSON reading over MQTT, and
`Server/mqtt.js` saves it to `sensor_readings`. The wiring table is at the top of
the sketch.

## Upload it

1. Open `FloraScan_Node/FloraScan_Node.ino` in the Arduino IDE. The folder and the
   file must keep the same name, or the IDE asks to move it.
2. Board: **DOIT ESP32 DEVKIT V1**. Library: **PubSubClient** by Nick O'Leary.
3. Put your Wi-Fi name and password in `WIFI_SSID` and `WIFI_PASSWORD` (2.4 GHz
   only). Don't commit them.
4. Upload, then open the Serial Monitor at 115200 baud.

## Link it to the backend

- After pulling these changes, run `npm run db:setup` once. It adds the
  `distance_cm` column and removes the light columns, and keeps the readings
  already saved.
- `sensor_devices` needs a row for the node. `DEVICE_CODE` and `DEVICE_KEY` in the
  sketch must match it:

  ```sql
  INSERT INTO sensor_devices (device_code, device_key_hash, label)
  VALUES ('SN-001', SHA2('demo-key-change-me', 256), 'Real kit');
  ```

- Start the server with `npm run dev`. Each reading then prints
  `[MQTT] Saved sensor reading from SN-001` and shows on `/staff/iot`.
