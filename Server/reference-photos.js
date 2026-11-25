/** Partition species references between demo records so two tags don't claim the same photo. */
export function referencesForPlants(plants, catalogue) {
  const groups = new Map();
  for (const plant of plants) {
    if (!groups.has(plant.scientific_name)) groups.set(plant.scientific_name, []);
    groups.get(plant.scientific_name).push(plant.id);
  }
  const result = new Map(plants.map(p => [p.id, []]));
  for (const species of catalogue) {
    const ids = groups.get(species.scientific_name);
    if (!ids?.length) continue;
    ids.sort((a, b) => a - b);
    const unique = new Map(species.photos.filter(p => p.url && p.page && p.license).map(p => [p.url, p]));
    [...unique.values()].forEach((photo, i) => result.get(ids[i % ids.length]).push(photo));
  }
  return result;
}
