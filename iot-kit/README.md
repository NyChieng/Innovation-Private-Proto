# FloraScan sensor node (real kit)

`FloraScan_Node/FloraScan_Node.ino` is the firmware for the real ESP32 kit: soil
moisture, DHT11, raindrop plate, KY-037 sound sensor, HC-SR501 PIR and HC-SR04
distance sensor. Every 20 seconds it publishes one JSON reading over MQTT, and
`Server/mqtt.js` saves it to `sensor_readings`. Each reading includes a random
`boot_id` and an increasing `sequence` so MQTT retries cannot create duplicate
database rows. The wiring table is at the top of the sketch.

## Upload it

1. Open `FloraScan_Node/FloraScan_Node.ino` in the Arduino IDE. The folder and the
   file must keep the same name, or the IDE asks to move it.
2. Board: **DOIT ESP32 DEVKIT V1**. Library: **PubSubClient** by Nick O'Leary.
3. Copy `FloraScan_Node/secrets.example.h` to `FloraScan_Node/secrets.h` and fill
   in your Wi-Fi name and password (2.4 GHz only), the node's broker login
   (`MQTT_USER` / `MQTT_PASS`, ask the IoT team) and its `DEVICE_KEY`.
   `secrets.h` is gitignored, so none of these reach git. The sketch will not
   compile without it.
4. Upload, then open the Serial Monitor at 115200 baud.

## Link it to the backend

- After pulling these changes, run `npm run db:setup` once. It adds the
  `distance_cm` column and removes the light columns, and keeps the readings
  already saved.
- Put the same device key in the server's `.env` as `IOT_DEVICE_KEY`, then run
  `npm run db:seed` (or `npm run db:reset`). It adds the node's row to
  `sensor_devices`: `SN-001`, keeping the key's SHA-256, matching `DEVICE_CODE`
  in the sketch and `DEVICE_KEY` in `secrets.h`. Without `IOT_DEVICE_KEY`,
  SN-001 gets a random key and the server ignores the kit's readings. To change
  the key without reseeding:

  ```sql
  UPDATE sensor_devices SET device_key_hash = SHA2('the-new-key', 256)
   WHERE device_code = 'SN-001';
  ```

  For a second node, add a row and give its copy of the sketch that code and key:

  ```sql
  INSERT INTO sensor_devices (device_code, device_key_hash, label)
  VALUES ('SN-002', SHA2('another-key', 256), 'Second kit');
  ```

- Put the backend's broker login in `.env` as `MQTT_USERNAME` and
  `MQTT_PASSWORD` (see `.env.example`). Without them the server still starts,
  prints `[MQTT] Not connected: ...` once, and receives no readings.
- Start the server with `npm run dev`. Each reading then prints
  `[MQTT] Saved sensor reading from SN-001` and shows on `/staff/iot`.
