import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConservationBadge, Empty } from './ui.jsx';
import { SmartImage } from './motion.jsx';
import { coords, fromServer } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import * as I from '../lib/icons.jsx';

/**
 * Interactive SVG specimen map for Niah National Park.
 *
 * Self-contained (no external tile CDN), so it works offline under forest
 * canopy and respects the Content-Security-Policy header. Specimens whose
 * locations are withheld for conservation protection are never plotted.
 */
export default function PlantMap({ plants = [], single = false }) {
  const plotted = useMemo(
    () => plants.filter(
      (p) => !p.location_protected
        && p.latitude !== null && p.latitude !== undefined
        && p.longitude !== null && p.longitude !== undefined
        && Number.isFinite(Number(p.latitude))
        && Number.isFinite(Number(p.longitude)),
    ),
    [plants],
  );

  const withheldCount = useMemo(
    () => plants.filter((p) => p.location_protected).length,
    [plants],
  );

  const [selectedId, setSelectedId] = useState(() => plotted[0]?.id ?? null);
  const selected = useMemo(
    () => plotted.find((p) => p.id === selectedId) || plotted[0] || null,
    [plotted, selectedId],
  );

  const bounds = useMemo(() => {
    if (!plotted.length) {
      return { minLat: 3.805, maxLat: 3.825, minLon: 113.765, maxLon: 113.795 };
    }
    const lats = plotted.map((p) => Number(p.latitude));
    const lons = plotted.map((p) => Number(p.longitude));
    let minLat = Math.min(...lats);
    let maxLat = Math.max(...lats);
    let minLon = Math.min(...lons);
    let maxLon = Math.max(...lons);
    const latSpan = Math.max(0.006, (maxLat - minLat) * 1.35);
    const lonSpan = Math.max(0.008, (maxLon - minLon) * 1.35);
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;
    return {
      minLat: midLat - latSpan / 2,
      maxLat: midLat + latSpan / 2,
      minLon: midLon - lonSpan / 2,
      maxLon: midLon + lonSpan / 2,
    };
  }, [plotted]);

  if (!plotted.length) {
    return (
      <Empty icon={I.MapPin} title={t('No map coordinates available for these records')}>
        {withheldCount > 0
          ? t('Locations of threatened species are withheld to protect them from collection.')
          : t('Try clearing a filter to see mapped specimens across the park.')}
      </Empty>
    );
  }

  const W = 760;
  const H = single ? 260 : 400;
  const PAD = 36;

  const project = (lat, lon) => {
    const x = PAD + ((Number(lon) - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (W - PAD * 2);
    const y = (H - PAD) - ((Number(lat) - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * (H - PAD * 2);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };

  // Group nearby site labels so the park trail structure is easy to read.
  const siteAnchors = useMemo(() => {
    const bySite = new Map();
    for (const p of plotted) {
      const s = fromServer(p.site_name || '').split(',')[0].trim();
      if (!s) continue;
      if (!bySite.has(s)) bySite.set(s, []);
      bySite.get(s).push(project(p.latitude, p.longitude));
    }
    const out = [];
    for (const [name, pts] of bySite.entries()) {
      const cx = pts.reduce((a, b) => a + b.x, 0) / pts.length;
      const cy = pts.reduce((a, b) => a + b.y, 0) / pts.length;
      out.push({ name, x: cx, y: cy, count: pts.length });
    }
    return out.slice(0, 6);
  }, [plotted, bounds]);

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ position: 'relative', background: 'var(--surface-inset)' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('Park specimen map')}
          style={{ width: '100%', height: 'auto', display: 'block', maxHeight: single ? 260 : 420 }}
        >
          <defs>
            <pattern id="map-grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="currentColor" strokeOpacity="0.07" strokeWidth="1" />
            </pattern>
            <radialGradient id="canopy-glow" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="var(--green-500)" stopOpacity="0.14" />
              <stop offset="100%" stopColor="var(--green-500)" stopOpacity="0" />
            </radialGradient>
          </defs>

          <rect width={W} height={H} fill="url(#map-grid)" />
          <ellipse cx={W * 0.52} cy={H * 0.48} rx={W * 0.42} ry={H * 0.38} fill="url(#canopy-glow)" />

          {/* Stylized trail path connecting site clusters */}
          {siteAnchors.length > 1 && (
            <path
              d={siteAnchors.map((s, i) => `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--accent)"
              strokeOpacity="0.28"
              strokeWidth="2.5"
              strokeDasharray="6 6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Site cluster labels */}
          {siteAnchors.map((s) => (
            <g key={s.name} transform={`translate(${s.x}, ${Math.max(18, s.y - 16)})`} style={{ pointerEvents: 'none' }}>
              <text
                textAnchor="middle"
                fontSize="10.5"
                fontWeight="600"
                fill="var(--text-mute)"
                style={{ paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3, strokeLinejoin: 'round' }}
              >
                {s.name}
              </text>
            </g>
          ))}

          {/* Specimen pins */}
          {plotted.map((p) => {
            const { x, y } = project(p.latitude, p.longitude);
            const isSel = selected?.id === p.id;
            const color = p.conservation_code ? `var(--cs-${p.conservation_code})` : 'var(--accent)';
            return (
              <g
                key={p.id}
                transform={`translate(${x}, ${y})`}
                onClick={() => setSelectedId(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(p.id); } }}
                tabIndex={0}
                role="button"
                aria-label={`${p.scientific_name || p.plant_code} (${p.site_name})`}
                style={{ cursor: 'pointer', outline: 'none' }}
              >
                {isSel && (
                  <circle r="14" fill={color} opacity="0.22" />
                )}
                <circle
                  r={isSel ? 8 : 6}
                  fill={color}
                  stroke="var(--surface)"
                  strokeWidth={isSel ? 2.5 : 1.8}
                />
              </g>
            );
          })}

          {/* Compass & coordinate bounds */}
          <g transform={`translate(${W - 28}, 26)`} className="mute" style={{ pointerEvents: 'none' }}>
            <circle r="13" fill="var(--surface)" stroke="var(--border)" />
            <path d="M0 -8 L3 4 L0 1 L-3 4 Z" fill="var(--accent)" />
            <text y="-16" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor">N</text>
          </g>
          <text x="14" y={H - 10} fontSize="10" fill="var(--text-faint)" className="mono">
            {coords(bounds.minLat, bounds.minLon)} — {coords(bounds.maxLat, bounds.maxLon)}
          </text>
        </svg>
      </div>

      {/* Selected specimen bar */}
      {selected && !single && (
        <div className="card-foot row row-wrap" style={{ gap: 12, background: 'var(--surface)' }}>
          <div style={{ width: 56, height: 44, borderRadius: 8, overflow: 'hidden', background: 'var(--surface-3)', flex: 'none', border: '1px solid var(--border)' }}>
            {selected.photo && <SmartImage src={selected.photo} fallback={selected.photo_remote} tint={selected.photo_tint} alt="" eager />}
          </div>
          <div className="grow" style={{ minWidth: 180 }}>
            <div className="row row-wrap" style={{ gap: 6 }}>
              <span className="sci strong">{selected.scientific_name || selected.proposed_species_name}</span>
              {selected.conservation_code && <ConservationBadge code={selected.conservation_code} showLabel={false} />}
            </div>
            <div className="tiny mute">
              <span className="mono">{selected.plant_code}</span> &middot; {fromServer(selected.site_name)} &middot; <span className="mono">{coords(selected.latitude, selected.longitude)}</span>
            </div>
          </div>
          <Link className="btn btn-sm btn-primary" to={'/plant/' + selected.id}>
            {t('Open')} <I.ChevronRight />
          </Link>
        </div>
      )}

      {withheldCount > 0 && !single && (
        <div className="card-foot tiny mute" style={{ borderTop: '1px solid var(--border)' }}>
          <I.Shield style={{ width: 13, height: 13, display: 'inline', verticalAlign: -2, marginRight: 5, color: 'var(--warn-fg)' }} />
          {t('{n} threatened specimen locations are withheld from the public map.', { n: withheldCount })}
        </div>
      )}
    </div>
  );
}
