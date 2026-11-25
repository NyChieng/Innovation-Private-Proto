/**
 * Which image paths are real photographs.
 *
 * The server can hand back three kinds of path for a plant photo:
 *   /api/photos/file/<name>.jpg   a downloaded field photograph
 *   /api/photos/upload/<id>       a photo a botanist took in the app
 *   /api/photos/<name>.svg        a generated drawing, used when neither exists
 *
 * The generated drawings looked like photographs of the wrong plant, so the app
 * no longer shows them: a plant without a real photo gets a plain placeholder.
 * Remote URLs, data: and blob: URLs (a photo being taken) are real photos.
 */
export function isRealPhoto(src) {
  if (!src || typeof src !== 'string') return false;
  if (src.startsWith('/api/photos/')) {
    return src.startsWith('/api/photos/file/') || src.startsWith('/api/photos/upload/');
  }
  return true;
}

/** The path itself when it is a real photo, otherwise null. */
export const realPhoto = (src) => (isRealPhoto(src) ? src : null);

/** The best real photo for a plant record, or null. */
export const plantPhoto = (p) => realPhoto(p?.photo) || realPhoto(p?.photo_remote);

/** Reference photograph displayed for the species catalogue entry. */
export function speciesReferencePhoto(species) {
  let credits = species?.photo_credits;
  if (typeof credits === 'string') {
    try { credits = JSON.parse(credits); } catch { return null; }
  }
  return Array.isArray(credits) ? credits.find(photo => photo?.file || photo?.remote_url) ?? null : null;
}
