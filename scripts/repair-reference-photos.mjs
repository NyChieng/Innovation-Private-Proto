import { referencesForPlants } from '../Server/reference-photos.js';
import { SPECIES_DATA, photoExists, tintFor } from '../Server/species-data.js';
import { connect, tx, close, databaseUrl } from '../Server/sql.js';

process.loadEnvFile('.env');
if (!['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl()).hostname)) {
  throw Error('This repair targets local demo data.');
}
await connect();
try {
  await tx(async db => {
    const rows = await db.q(`SELECT ph.*, s.scientific_name FROM plant_photos ph
      JOIN plants p ON p.id=ph.plant_id JOIN species s ON s.id=p.species_id
      WHERE ph.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY ph.id FOR UPDATE`);
    const managed = rows.filter(r => /^\/api\/photos\/[^/]+\.svg$/.test(r.file_path)
      || (r.source_url && ['iNaturalist','Wikimedia Commons','GBIF','Pl@ntNet via GBIF','Naturalis Biodiversity Center via GBIF'].includes(r.source_name)));
    const plants = [...new Map(managed.map(r => [r.plant_id, {id:r.plant_id, scientific_name:r.scientific_name}])).values()];
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
        else await db.insert('plant_photos',{...fields,uploaded_by:old[0].uploaded_by,created_at:old[0].created_at});
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
