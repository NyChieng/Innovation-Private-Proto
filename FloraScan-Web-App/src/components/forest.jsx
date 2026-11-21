import { useEffect, useState } from 'react';
import { SmartImage } from './motion.jsx';
import { t } from '../lib/i18n.js';
import * as I from '../lib/icons.jsx';

/**
 * The forest pieces of the visitor site: the dark green band with a canopy
 * photograph and fern fronds, the orange trail-marker dot, and the back-to-top
 * button. One definition each, so every page draws them the same way.
 */

/** A fern frond, drawn as strokes so it takes the band's colour. */
export function Fern({ className = '', style }) {
  return (
    <svg className={'fern ' + className} style={style} viewBox="0 0 200 400" aria-hidden="true" focusable="false">
      <path d="M100 400 C100 300 95 200 100 20" strokeWidth="5" />
      <path
        strokeWidth="7"
        d="M100 360 C70 350 40 335 15 310 M100 320 C72 308 48 292 25 266 M100 280 C75 268 54 252 35 226 M100 240 C80 228 62 212 48 188 M100 200 C84 190 70 176 60 154 M100 160 C88 152 78 140 72 122 M100 360 C130 350 160 335 185 310 M100 320 C128 308 152 292 175 266 M100 280 C125 268 146 252 165 226 M100 240 C120 228 138 212 152 188 M100 200 C116 190 130 176 140 154 M100 160 C112 152 122 140 128 122"
      />
    </svg>
  );
}

/**
 * Deep green band with a faded canopy photograph drifting behind it and two
 * fern fronds at the edges. `photo` is optional; without one the band is
 * plain green, never a broken image.
 */
export function ForestBand({ photo, className = '', children, ferns = 'right' }) {
  return (
    <section className={'forest-band ' + className}>
      {photo && (
        <div className="forest-band-photo" aria-hidden="true">
          <SmartImage src={photo} alt="" placeholderLabel={false} eager />
        </div>
      )}
      {(ferns === 'right' || ferns === 'both') && <Fern className="fern-tr" />}
      {(ferns === 'left' || ferns === 'both') && <Fern className="fern-bl" />}
      <div className="forest-band-in wrap">{children}</div>
    </section>
  );
}

/** "Great Cave Trail, marker 4" -> "4". Anything else has no marker. */
export function markerFrom(site) {
  const m = /\bmarker\s*(\d+)\b/i.exec(String(site || ''));
  return m ? m[1] : null;
}

/** The orange trail-marker dot. Renders nothing when there is no marker. */
export function MarkerDot({ site, value, size = 'md', className = '' }) {
  const n = value ?? markerFrom(site);
  if (!n) return null;
  return (
    <span className={`marker-dot marker-${size} ${className}`} title={t('Trail marker {n}', { n })}>
      <span aria-hidden="true">{n}</span>
      <span className="visually-hidden">{t('Trail marker {n}', { n })}</span>
    </span>
  );
}

/**
 * Appears once the visitor has scrolled a screen or so down, and takes them
 * back up. Smooth unless the device asks for reduced motion.
 */
export function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      setShown(window.scrollY > Math.max(480, window.innerHeight * 0.8));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  const up = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <button
      type="button"
      className={'back-to-top no-print' + (shown ? ' is-shown' : '')}
      onClick={up}
      aria-label={t('Back to top')}
      title={t('Back to top')}
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
    >
      <I.ChevronUp />
    </button>
  );
}
