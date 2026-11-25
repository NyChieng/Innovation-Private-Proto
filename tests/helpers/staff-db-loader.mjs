export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/Server/db.js')) {
    return { ...resolved, url: new URL('./staff-memory-db.mjs', import.meta.url).href };
  }
  if (resolved.url.endsWith('/Server/sql.js')) {
    throw new Error('Live database access is forbidden in staff workflow tests');
  }
  return resolved;
}
