import { seed } from '../Server/seed.js';
import { referencesForPlants } from '../Server/reference-photos.js';
import { SPECIES_DATA, photoExists, tintFor } from '../Server/species-data.js';
import { connect, tx, close, databaseUrl } from '../Server/sql.js';

process.loadEnvFile('.env');
const target = new URL(databaseUrl());
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  || !/^\/florascan_demo(?:_[a-z0-9_]+)?$/i.test(target.pathname)) {
  throw new Error('Use a local florascan_demo or florascan_demo_* fixture database.');
}
const fixture = seed();
const fixtureNames = new Map(fixture.species.map(s => [s.id, s.scientific_name]));
const fixturePlants = new Map(fixture.plants.map(p => [p.plant_code, fixtureNames.get(p.species_id)]));

await connect();
try {
  await tx(async db => {
    const records = await db.q(`SELECT p.id, p.plant_code, p.registered_by, p.registered_at, s.scientific_name
      FROM plants p JOIN species s ON s.id = p.species_id
      WHERE p.deleted_at IS NULL ORDER BY p.id FOR UPDATE`);
    const plants = records.filter(p => fixturePlants.get(p.plant_code) === p.scientific_name);
    const rows = plants.length ? await db.q(`SELECT * FROM plant_photos WHERE deleted_at IS NULL
      AND plant_id IN (${plants.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, plants.map(p => p.id)) : [];
    const sources = new Set(['iNaturalist', 'Wikimedia Commons', 'GBIF', 'Pl@ntNet via GBIF', 'Naturalis Biodiversity Center via GBIF']);
    const managed = rows.filter(r => /^\/api\/photos\/[^/]+\.svg$/.test(r.file_path)
      || (r.source_url && sources.has(r.source_name)));
    const refs = referencesForPlants(plants, SPECIES_DATA.species);
    for (const plant of plants) {
      const old = managed.filter(r => r.plant_id === plant.id);
      const hasUpload = rows.some(r => r.plant_id === plant.id && !managed.includes(r));
      const photos = refs.get(plant.id);
      for (const [i, photo] of photos.entries()) {
        const path = photoExists(photo.file) ? '/api/photos/file/' + photo.file : photo.url;
        const fields = {plant_id:plant.id,file_path:path,thumbnail_path:path,file_name:photo.file,
          remote_url:photo.url,source_url:photo.page,source_name:photo.source,credit:photo.attribution,
          license:photo.license,caption:photo.caption || 'Species reference: ' + plant.scientific_name,
          mime_type:'image/jpeg',tint:tintFor(photo.file),is_primary:!hasUpload && i===0 ? 1 : 0};
        if (old[i]) await db.q('UPDATE plant_photos SET '+Object.keys(fields).map(k=>k+'=?').join(',')+' WHERE id=?',[...Object.values(fields),old[i].id]);
        else await db.insert('plant_photos',{...fields,uploaded_by:old[0]?.uploaded_by ?? plant.registered_by,created_at:old[0]?.created_at ?? plant.registered_at});
      }
      for (const unused of old.slice(photos.length)) await db.q('UPDATE plant_photos SET deleted_at=NOW() WHERE id=?',[unused.id]);
    }
    for (const s of SPECIES_DATA.species) {
      const credits = s.photos.map(p=>({file:p.file,remote_url:p.url,url:p.page,credit:p.attribution,license:p.license,source:p.source}));
      await db.q('UPDATE species SET photo_credits=? WHERE scientific_name=?',[JSON.stringify(credits),s.scientific_name]);
    }
    console.log('Updated reference photos for',plants.length,'demo plants.');
  });
} finally {await close();}
