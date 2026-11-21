-- =====================================================================
-- Prototype extensions to plant_registry_schema.sql
--
-- Run AFTER the main schema:
--   mysql -u root < plant_registry_schema.sql
--   mysql -u root plant_registry < server/schema-extensions.sql
--
-- plant_registry_schema.sql is the submitted design. Its only change since
-- is in the IoT tables, to match the real sensor kit (see section 8).
-- Everything here is additive, apart from section 8, and exists because the
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
-- Dr Grace Lim, Senior Botanist" reads better than the name alone.

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
-- 6. Who does what with a plant (issue #8)
-- ---------------------------------------------------------------------
-- After the client consultation the roles were redrawn:
--
--   ranger    in charge only when an IoT sensor raises an alert. No longer
--             registers, edits or tags plants.
--   botanist  owns the ground-truthing: registers, edits and archives plant
--             and species records and prints tags. No longer approves, so a
--             botanist cannot publish their own record.
--   reviewer  new. Double-checks every record a botanist submits, can correct
--             it during review, and approves it or returns it with a note.
--
-- The API checks permission codes, never role names, so this is data only -
-- no code depends on the role being called "reviewer".
--
-- Safe to re-run: the role is upserted and the three roles' grants are
-- rebuilt from scratch each time. That also means a grant changed by hand
-- for these roles is put back on the next "npm run db:setup". Keep the lists
-- in step with the grant() calls in Server/seed.js.

INSERT INTO roles (id, name, label, description) VALUES
  (4, 'reviewer', 'Reviewer',
   'Double-checks every plant a botanist registers, then approves it for publication or returns it with a note')
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);

UPDATE roles SET description = 'Responds to IoT sensor alerts in the field. Does not register or edit plant records'
 WHERE name = 'ranger';
UPDATE roles SET description = 'Ground-truths plants: registers, edits and archives plant and species records, prints QR tags; sets up sensors'
 WHERE name = 'botanist';

DELETE rp FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
 WHERE r.name IN ('ranger', 'botanist', 'reviewer');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p
 WHERE (r.name = 'ranger'   AND p.code IN ('sensor.view', 'alert.resolve'))
    OR (r.name = 'botanist' AND p.code IN (
          'plant.view_all', 'plant.create', 'plant.edit', 'plant.archive', 'plant.history',
          'species.manage', 'qr.print', 'qr.manage', 'report.view', 'report.resolve',
          'sensor.view', 'sensor.manage'))
    OR (r.name = 'reviewer' AND p.code IN (
          'plant.view_all', 'plant.edit', 'plant.approve', 'plant.history'));

UPDATE settings
   SET description = 'true = botanist entries wait for a reviewer; false = they publish immediately. A "species not listed" entry always waits'
 WHERE setting_key = 'require_approval';


-- ---------------------------------------------------------------------
-- 7. Extra fields from the sensor node
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
-- 8. Real kit: light sensor out, distance sensor in
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


-- ---------------------------------------------------------------------
-- 9. Reading sequence identity
-- ---------------------------------------------------------------------
-- Each ESP32 generates a random boot_id at startup and increments sequence_no
-- for every reading in that boot. The unique key makes MQTT retries harmless
-- without writing the counter to flash on every 20-second reading.

ALTER TABLE sensor_readings
  ADD COLUMN boot_id CHAR(16) NULL AFTER recorded_at,
  ADD COLUMN sequence_no INT UNSIGNED NULL AFTER boot_id,
  ADD UNIQUE KEY uq_sr_device_sequence (device_id, boot_id, sequence_no);


-- ---------------------------------------------------------------------
-- 10. Locking an account after repeated wrong passwords
-- ---------------------------------------------------------------------
-- Without this, sign in could be tried as fast as the server answers. After
-- five wrong passwords in a row the account is locked for fifteen minutes;
-- a correct sign in resets the count, and an administrator can unlock early.
-- The limits live in Server/api.js (MAX_FAILED_LOGINS, LOCK_MINUTES).

ALTER TABLE users
  ADD COLUMN failed_login_count TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_login_at,
  ADD COLUMN locked_until       DATETIME         NULL              AFTER failed_login_count;


-- ---------------------------------------------------------------------
-- 10. Recovery codes for a forgotten password
-- ---------------------------------------------------------------------
-- The demo accounts have made-up email addresses, so a reset link by email
-- could never arrive - or worse, could arrive at a stranger's real inbox.
-- Instead each user is shown a one-time recovery code when they set a
-- password. Email + code + new password resets it without an administrator.
-- Only a hash is kept, like the password; using the code replaces it, and an
-- administrator's reset clears it. Wrong codes count towards the lockout in
-- section 9, so the code cannot be guessed any faster than a password.

ALTER TABLE users
  ADD COLUMN recovery_code_hash CHAR(64) NULL AFTER password_hash;


-- ---------------------------------------------------------------------
-- 11. Passkeys - Face ID, fingerprint, or the phone's own pattern / PIN
-- ---------------------------------------------------------------------
-- WebAuthn: the phone keeps a private key behind its own screen lock and
-- FloraScan keeps only the public half, so no fingerprint or face ever
-- reaches the server. A passkey belongs to the address it was made on
-- (rp_id), so one made on localhost does not work from the phone address.
-- An administrator's password reset removes them, like the recovery code.

CREATE TABLE passkeys (
  id             INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED    NOT NULL,
  credential_id  VARCHAR(255)    NOT NULL,   -- base64url, as the browser reports it
  public_key     TEXT            NOT NULL,   -- base64url COSE key
  counter        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  transports     VARCHAR(120)    NULL,
  rp_id          VARCHAR(255)    NOT NULL,
  device_label   VARCHAR(120)    NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_passkey_credential (credential_id),
  KEY idx_passkey_user (user_id),
  CONSTRAINT fk_passkey_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------
-- 12. Asking an administrator to approve a password reset
-- ---------------------------------------------------------------------
-- For someone who forgot their password and never saved a recovery code.
-- "Forgot password?" lets them ask from the sign-in page; every
-- administrator is notified, and the request shows on the account until it
-- is dealt with. Administrators are notified at most every 15 minutes per
-- account, so the button cannot be used to flood them.

ALTER TABLE users
  ADD COLUMN reset_requested_at DATETIME NULL AFTER locked_until;

-- The requests themselves. The person's screen shows a six-digit check code
-- and holds a secret token; they read the code to an administrator, who types
-- it in to approve. Only the browser holding the token can then set the new
-- password, so approving one request cannot be used from anywhere else.
-- users.reset_requested_at above marks the newest one for the staff list.

CREATE TABLE password_reset_requests (
  id           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED     NOT NULL,
  token_hash   CHAR(64)         NOT NULL,              -- SHA-256 of the browser's secret
  check_code   CHAR(6)          NOT NULL,              -- read out to the administrator
  status       VARCHAR(12)      NOT NULL DEFAULT 'pending', -- pending, approved, denied, used, closed
  wrong_codes  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME         NOT NULL,
  decided_by   INT UNSIGNED     NULL,
  decided_at   DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prr_token (token_hash),
  KEY idx_prr_user (user_id, status),
  CONSTRAINT fk_prr_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_prr_decider
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);


-- ---------------------------------------------------------------------
-- 13. Administrators' recovery email
-- ---------------------------------------------------------------------
-- An administrator has nobody above them to approve a reset, and may be the
-- only one. Each keeps a second, real email address; a forgotten password
-- sends a six-digit code there. The address is only saved once a code sent to
-- it has been typed back, so a mistyped or made-up address can never receive
-- reset codes - which would hand the account to whoever owns that inbox.

ALTER TABLE users
  ADD COLUMN recovery_email             VARCHAR(190) NULL AFTER recovery_code_hash,
  ADD COLUMN recovery_email_verified_at DATETIME     NULL AFTER recovery_email;

CREATE TABLE email_codes (
  id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED     NOT NULL,
  purpose     VARCHAR(12)      NOT NULL,   -- 'verify' (confirming the address) or 'reset'
  email       VARCHAR(190)     NOT NULL,   -- where it was sent
  code_hash   CHAR(64)         NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME         NOT NULL,
  used_at     DATETIME         NULL,
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ec_user (user_id, purpose),
  CONSTRAINT fk_ec_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------
-- 14. Two-step verification with an authenticator app (TOTP)
-- ---------------------------------------------------------------------
-- Scan a QR code once with Google Authenticator, Microsoft Authenticator or
-- similar; from then on sign-in asks for the password and the app's current
-- six-digit code. Free to run - the code is worked out on the phone from a
-- shared secret, nothing is sent. See Server/totp.js.
--
-- totp_secret holds the secret encrypted with a key kept outside the database
-- (.certs/totp.key). totp_pending holds one while it is being set up, until a
-- code proves the app has it. totp_last_step stops a code being used twice.
-- An administrator's password reset switches it off, for a lost phone.

ALTER TABLE users
  ADD COLUMN totp_secret     VARCHAR(255)    NULL AFTER recovery_email_verified_at,
  ADD COLUMN totp_pending    VARCHAR(255)    NULL AFTER totp_secret,
  ADD COLUMN totp_enabled_at DATETIME        NULL AFTER totp_pending,
  ADD COLUMN totp_last_step  BIGINT UNSIGNED NULL AFTER totp_enabled_at;


-- ---------------------------------------------------------------------
-- 15. AI camera alerts with a snapshot
-- ---------------------------------------------------------------------
-- The AI vision node (ai-vision-node/, "FloraGuard") watches a plant zone.
-- When someone touches the plant (ALERT) or is near it outside opening hours
-- (AFTER-HOURS) it posts the event and the snapshot that shows why to
-- POST /api/camera/alerts, signed with its own device key - the same scheme as
-- the sensor nodes (SHA-256 of the key, shown once at set-up). Warnings carry
-- no picture and stay on the camera.
--
-- Every account that can resolve alerts (the Ranger role) is notified, and the
-- photograph is served only to roles with sensor.view. It is kept in the row
-- itself, like plant_photo_data, so a backup of the database is complete.

CREATE TABLE camera_devices (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  device_code      VARCHAR(30)   NOT NULL,   -- sent with every alert, e.g. 'CAM-001'
  device_key_hash  CHAR(64)      NOT NULL,   -- SHA-256 of the secret key
  plant_id         INT UNSIGNED  NULL,       -- the plant in view; NULL = not installed
  label            VARCHAR(120)  NULL,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,  -- 0 = alerts are refused
  last_seen_at     DATETIME      NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at       DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cam_code (device_code),
  UNIQUE KEY uq_cam_key (device_key_hash),
  CONSTRAINT fk_cam_plant
    FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE SET NULL
);

CREATE TABLE camera_alerts (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  camera_id        INT UNSIGNED  NOT NULL,
  plant_id         INT UNSIGNED  NULL,
  tier             ENUM('ALERT','AFTER-HOURS') NOT NULL,
  track_id         INT UNSIGNED  NULL,       -- the camera's id for the person
  detail           VARCHAR(255)  NULL,       -- e.g. 'touch 0.82 (pose+model)'
  photo            MEDIUMBLOB    NOT NULL,   -- JPEG, at most 900 KB
  photo_mime       VARCHAR(40)   NOT NULL DEFAULT 'image/jpeg',
  photo_bytes      INT UNSIGNED  NOT NULL,
  status           ENUM('open','resolved') NOT NULL DEFAULT 'open',
  triggered_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- server time
  resolved_by      INT UNSIGNED  NULL,
  resolved_at      DATETIME      NULL,
  resolution_note  VARCHAR(500)  NULL,
  PRIMARY KEY (id),
  KEY idx_ca_status (status, triggered_at),
  KEY idx_ca_camera (camera_id, triggered_at),
  CONSTRAINT chk_ca_resolved CHECK (status = 'open' OR resolved_at IS NOT NULL),
  CONSTRAINT fk_ca_camera FOREIGN KEY (camera_id) REFERENCES camera_devices(id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_plant  FOREIGN KEY (plant_id)  REFERENCES plants(id) ON DELETE SET NULL,
  CONSTRAINT fk_ca_user   FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
