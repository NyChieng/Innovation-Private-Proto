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
   'Permanent public address of the site, e.g. https://florascan.sarawakforestry.com. Printed QR codes encode this: set it before printing tags for real. Leave blank to use this machine network address, which is right for a demo'),
  ('protect_locations', 'VU', 'string',
   'Hide exact locations from the public at this IUCN level and above (VU, EN, CR). Blank disables the protection')
ON DUPLICATE KEY UPDATE description = VALUES(description);
