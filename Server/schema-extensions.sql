-- =====================================================================
-- Prototype extensions to plant_registry_schema.sql
--
-- Run AFTER the main schema:
--   mysql -u root < plant_registry_schema.sql
--   mysql -u root plant_registry < server/schema-extensions.sql
--
-- plant_registry_schema.sql is the submitted design and is left untouched.
-- Everything here is additive, and exists because the prototype does two
-- things the schema was written before: it imports real species data from
-- GBIF, iNaturalist and Wikipedia, and it withholds the locations of
-- threatened plants from the public.
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
