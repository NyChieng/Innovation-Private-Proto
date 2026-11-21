import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ConservationBadge, Empty, LoadingBlock, SearchInput } from '../components/ui.jsx';
import { Reveal, SmartImage } from '../components/motion.jsx';
import { ForestBand } from '../components/forest.jsx';
import { num } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/** The first credited photograph of a species, as a served path. */
export function speciesPhoto(s) {
  let credits = s?.photo_credits;
  if (typeof credits === 'string') {
    try { credits = JSON.parse(credits); } catch { credits = []; }
  }
  const file = (credits || []).find((c) => c?.file)?.file;
  return file ? '/api/photos/file/' + encodeURIComponent(file) : null;
}

export default function SpeciesList() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => { api.species().then((r) => setRows(r.results)).catch(() => setRows([])); }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((s) =>
      [s.scientific_name, s.common_name, s.local_name, s.family, s.genus]
        .filter(Boolean).join(' ').toLowerCase().includes(n));
  }, [rows, q]);

  const byFamily = useMemo(() => {
    if (!filtered) return [];
    const map = new Map();
    filtered.forEach((s) => {
      const f = s.family || t('Unplaced');
      if (!map.has(f)) map.set(f, []);
      map.get(f).push(s);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (!rows) return <LoadingBlock label={t('Loading the species list')} />;

  const families = new Set(rows.map((s) => s.family).filter(Boolean)).size;
  const bandPhoto = rows.map(speciesPhoto).find(Boolean);

  return (
    <div className="species-page">
      <ForestBand photo={bandPhoto} className="list-band">
        <div className="list-band-head">
          <h1 className="display">{t('Species')}</h1>
          <span className="list-band-count">{t('{n} species in {f} families', { n: num(rows.length), f: num(families) })}</span>
        </div>
        <div className="band-search-wrap">
          <SearchInput value={q} onChange={setQ} large placeholder={t('Search species, family or local name')} />
        </div>
      </ForestBand>

      <div className="wrap section-pad">
        {filtered.length === 0 && <Empty icon={I.Book} title={t('No species match that search')} />}

        <div className="site-groups">
          {byFamily.map(([family, list], fi) => (
            <Reveal key={family} index={fi % 6} className="site-group">
              <div className="site-group-head">
                <h2 className="display">{family}</h2>
                <span className="small mute">{t('{n} species', { n: list.length })}</span>
              </div>
              <div className="species-grid">
                {list.map((s) => (
                  <Link key={s.id} className="species-card" to={'/species/' + s.id}>
                    <span className="species-thumb">
                      <SmartImage src={speciesPhoto(s)} alt="" placeholderLabel={false} />
                    </span>
                    <span className="species-text">
                      <span className="sci strong species-sci">{s.scientific_name}</span>
                      {(s.common_name || s.local_name) && (
                        <span className="small mute truncate">{[s.common_name, s.local_name].filter(Boolean).join(' · ')}</span>
                      )}
                      <span className="tiny faint">
                        {s.plant_count === 1 ? t('1 plant in the park') : t('{n} plants in the park', { n: num(s.plant_count) })}
                      </span>
                    </span>
                    <ConservationBadge code={s.conservation_code} showLabel={false} />
                  </Link>
                ))}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}
