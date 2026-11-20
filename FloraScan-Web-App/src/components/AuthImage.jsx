import { useEffect, useState } from 'react';
import { protectedImageUrl } from '../lib/api.js';
import { t } from '../lib/i18n.js';

/**
 * An image the server only gives to signed-in staff with the right permission
 * (an AI camera snapshot). Fetched with the session token, shown from an
 * object URL, and released again when the component goes away.
 */
export default function AuthImage({ src, alt = '', style, className }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let made = null;
    setUrl(null);
    setFailed(false);
    protectedImageUrl(src)
      .then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [src]);

  if (failed) {
    return <div className={'tiny mute ' + (className || '')} style={style}>{t('Could not load the snapshot')}</div>;
  }
  if (!url) return <div className={className} style={{ ...style, background: 'rgba(127,127,127,0.12)' }} aria-busy="true" />;
  return <img src={url} alt={alt} className={className} style={style} />;
}
