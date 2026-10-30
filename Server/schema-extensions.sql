-- =====================================================================
-- Prototype extensions to plant_registry_schema.sql
--
-- Run AFTER the main schema:
--   mysql -u root < plant_registry_schema.sql
--   mysql -u root plant_registry < server/schema-extensions.sql
--
-- plant_registry_schema.sql is the submitted design. Its only change since
-- is in the IoT tables, to match the real sensor kit (see section 7).
-- Everything here is additive, apart from section 7, and exists because the
-- prototype does two things the schema was written before: it imports real
-- species data from GBIF, iNaturalist and Wikipedia, and it withholds the
-- locations of threatened plants from the public.
--
-- If any of these earn their place, fold them into the schema proper at the
-- next revision rather than letting this file grow into a second schema.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Staff job titles
-- ---------------------------------------------------------------------
-- Shown beside a name wherever the app credits someone - "verified by
-- Dr Lee Sue Han, Senior Botanist" reads better than the name alone.

ALTER TABLE users
  ADD COLUMN title VARCHAR(120) NULL AFTER full_name;


-- ---------------------------------------------------------------------
-- 2. Imported species data
-- ---------------------------------------------------------------------
-- The species list is built by scripts/import-species.mjs from GBIF,
-- iNaturalist and Wikipedia rather than typed by hand. These columns keep
-- the provenance, so a record can be traced back and refreshed.
--
-- occurrence_points and photo_credits are JSON because they are read whole
-- and never queried field by field; splitting them into tables would add
-- joins for no gain.

ALTER TABLE species
  ADD COLUMN authorship          VARCHAR(190)  NULL AFTER species_epithet,
  ADD COLUMN conservation_source VARCHAR(190)  NULL AFTER conservation_status_id,
  ADD COLUMN gbif_key            BIGINT        NULL,
  ADD COLUMN inat_id             BIGINT        NULL,
  ADD COLUMN wikipedia_url       VARCHAR(500)  NULL,
  ADD COLUMN occurrence_points   JSON          NULL,
  ADD COLUMN photo_credits       JSON          NULL;


-- ---------------------------------------------------------------------
-- 3. Photograph provenance and loading colour
-- ---------------------------------------------------------------------
-- Imported photographs are Creative Commons and must carry their credit and
-- licence wherever they appear; remote_url is the original, used as a
-- fallback when the local cache is missing (a fresh clone has no photo
-- cache, so without this a deployed copy would show nothing).
--
-- tint is the average colour of the photograph, painted while it loads so
-- the page does not flash white on a slow connection in the field.
--
-- The three MODIFY lines relax columns the schema marks NOT NULL: a record
-- whose photograph lives on iNaturalist has a remote_url and no local file,
-- so file_path, mime_type and size_bytes are not yet known.

ALTER TABLE plant_photos
  ADD COLUMN remote_url  VARCHAR(1000) NULL AFTER thumbnail_path,
  ADD COLUMN tint        CHAR(7)       NULL,
  ADD COLUMN credit      VARCHAR(500)  NULL,
  ADD COLUMN license     VARCHAR(120)  NULL,
  ADD COLUMN source_name VARCHAR(120)  NULL,
  ADD COLUMN source_url  VARCHAR(1000) NULL,
  MODIFY COLUMN file_path  VARCHAR(255) NULL,
  MODIFY COLUMN mime_type  VARCHAR(60)  NULL,
  MODIFY COLUMN size_bytes INT UNSIGNED NULL;


-- ---------------------------------------------------------------------
-- 4. Settings the prototype added
-- ---------------------------------------------------------------------
-- protect_locations answers the conservation requirement: a visitor must not
-- be able to read the coordinates of a critically endangered plant, because
-- a public register of where to find rare plants is a collector's shopping
-- list. The API withholds latitude, longitude and the precise site name from
-- anyone without plant.view_all, at or above the threatened level set here.
-- This is the application-level form of the note in section 7 of the schema.
--
-- public_base_url is what printed QR tags encode. A tag printed against a
-- laptop's address is a sticker pointing at nothing, so this must be set to
-- the permanent public address before any tag is printed for real.
--
-- NOTE - this overlaps with qr_base_url in the schema, which holds the same
-- address with the /p/ path already on the end. The prototype grew its own
-- key before the two were compared. They should be one setting: keep
-- qr_base_url, the submitted one, and have the API derive the origin from it.
-- Left as-is only so the running app is not broken mid-port; consolidate
-- before this reaches anyone else.

INSERT INTO settings (setting_key, setting_value, value_type, description) VALUES
  ('park_name', 'Niah National Park', 'string',
   'The park this register covers, shown in headings and on printed tags'),
  ('public_base_url', '', 'string',
   'Permanent public address of the site, e.g. https://florascan.example.org. Printed QR codes encode it, so set it before printing any tag for real. Blank uses this machine network address, which suits a demo'),
  ('protect_locations', 'VU', 'string',
   'Hide exact locations from the public at this IUCN level and above (VU, EN, CR). Blank disables the protection')
ON DUPLICATE KEY UPDATE description = VALUES(description);


-- ---------------------------------------------------------------------
-- 5. Uploaded photographs
-- ---------------------------------------------------------------------
-- The schema says photographs are files on the API server and MySQL stores
-- only their paths, which is right for a deployment with somewhere to put
-- files. This prototype has nowhere: Render's free tier has no persistent
-- disk, so anything written there is gone on the next deploy, and the imported
-- reference photographs live in the repository rather than in a bucket.
--
-- So an uploaded photograph goes here until there is object storage to put it
-- in - Cloudflare R2 or similar - at which point this table is dropped and
-- plant_photos.remote_url carries the address instead.
--
-- It is a table of its own, not a column on plant_photos, because the API
-- reads plant_photos for every card on every list page and must not drag a
-- megabyte of JPEG through each one.

CREATE TABLE IF NOT EXISTS plant_photo_data (
  photo_id    INT UNSIGNED NOT NULL,
  bytes       LONGBLOB     NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (photo_id),
  CONSTRAINT fk_photo_data_photo
    FOREIGN KEY (photo_id) REFERENCES plant_photos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 6. Extra fields from the sensor node
-- ---------------------------------------------------------------------
-- The ESP32 node (iot-kit/FloraScan_Node) sends more than the three readings
-- the schema stores: the kit also has a raindrop plate, a PIR motion sensor
-- and a sound sensor, and the node reports its Wi-Fi signal and uptime.
-- These columns keep them, so a dry spell, a visitor near a protected plant
-- or a weak-signal node can be seen later rather than lost on arrival.
-- Server/mqtt.js saves every field listed in its FIELDS and FLAGS.
--
-- All are NULL-able: older messages and the real board's first readings may
-- leave some out. wifi_rssi_dbm and uptime_s describe the node rather than
-- the plant; they sit here because they arrive with each reading.

ALTER TABLE sensor_readings
  ADD COLUMN rain_pct       DECIMAL(5,2)      NULL AFTER humidity_pct,  -- % of the plate wet
  ADD COLUMN is_raining     TINYINT(1)        NULL AFTER rain_pct,   -- 1 = raining
  ADD COLUMN motion_events  SMALLINT UNSIGNED NULL AFTER is_raining, -- PIR triggers since the last reading
  ADD COLUMN sound_peak_pct DECIMAL(5,2)      NULL AFTER motion_events,
  ADD COLUMN wifi_rssi_dbm  SMALLINT          NULL AFTER sound_peak_pct, -- e.g. -70; closer to 0 is stronger
  ADD COLUMN uptime_s       INT UNSIGNED      NULL AFTER wifi_rssi_dbm,  -- seconds since the node started
  ADD CONSTRAINT chk_sr_rain  CHECK (rain_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_sr_sound CHECK (sound_peak_pct BETWEEN 0 AND 100);


-- ---------------------------------------------------------------------
-- 7. Real kit: light sensor out, distance sensor in
-- ---------------------------------------------------------------------
-- The real kit has no light sensor, so the light columns and the 'light'
-- alert type are gone from plant_registry_schema.sql. It does have an
-- HC-SR04 ultrasonic sensor: distance_cm is how far the nearest object is
-- from it, NULL when no echo came back (nothing within about 4 m).
--
-- A new database never had the light columns, so the DROP statements below
-- find nothing and db-setup skips them. On a database set up before this
-- change they remove the light columns, so "npm run db:setup" brings it up
-- to date without --reset, and the readings already saved are kept.

ALTER TABLE sensor_readings
  ADD COLUMN distance_cm DECIMAL(5,1) NULL AFTER sound_peak_pct,  -- HC-SR04, cm
  ADD CONSTRAINT chk_sr_distance CHECK (distance_cm BETWEEN 0 AND 500);

ALTER TABLE sensor_readings
  DROP CONSTRAINT chk_sr_has_value,
  DROP COLUMN light_lux,
  ADD CONSTRAINT chk_sr_has_value
    CHECK (soil_moisture_pct IS NOT NULL OR temperature_c IS NOT NULL
           OR humidity_pct IS NOT NULL);

ALTER TABLE sensor_devices
  DROP CONSTRAINT chk_sd_light_range,
  DROP COLUMN light_min,
  DROP COLUMN light_max;

-- mqtt.js never raised a light alert, so this normally deletes nothing. It
-- is here so the ENUM change below cannot fail on an old row.
DELETE FROM sensor_alerts WHERE alert_type = 'light';

ALTER TABLE sensor_alerts
  MODIFY COLUMN alert_type ENUM('soil_moisture','temperature','humidity','offline') NOT NULL;
