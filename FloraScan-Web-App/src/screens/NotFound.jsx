import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { PlantCard } from '../components/ui.jsx';
import { Reveal } from '../components/motion.jsx';
import { ForestBand } from '../components/forest.jsx';
import { plantPhoto } from '../lib/photo.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/** 404: off the trail. A way back, a search, and a few plants to find instead. */
export default function NotFound() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [plants, setPlants] = useState([]);

  useEffect(() => {
    api.publicPlants({ sort: 'popular', limit: 12 })
      .then((r) => setPlants(r.results.filter((p) => plantPhoto(p)).slice(0, 3)))
      .catch(() => setPlants([]));
  }, []);

  const search = (e) => {
    e.preventDefault();
    navigate('/browse' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''));
  };

  return (
    <div className="not-found">
      <ForestBand photo={plantPhoto(plants[0])} ferns="both" className="nf-band">
        <div className="nf-grid">
          <div className="nf-code-col">
            <span className="nf-code" aria-hidden="true">404</span>
            <span className="nf-trail" aria-hidden="true">
              <span className="marker-dot marker-md">?</span>
              <span className="nf-trail-line" />
              <I.X className="nf-trail-end" />
            </span>
          </div>
          <div className="nf-text">
            <h1 className="display">{t('You have wandered off the trail')}</h1>
            <p>{t('This page does not exist. Head back, or look for a plant.')}</p>
            <form className="band-search" role="search" onSubmit={search}>
              <label htmlFor="nf-q" className="visually-hidden">{t('Search plants')}</label>
              <input id="nf-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Plant name or tag number')} />
              <button type="submit">{t('Search')}</button>
            </form>
            <div className="row row-wrap" style={{ gap: 12 }}>
              <Link to="/" className="fbtn fbtn-light">{t('Back to home')}</Link>
              <Link to="/scan" className="fbtn fbtn-outline-light">{t('Scan a tag')}</Link>
            </div>
          </div>
        </div>
      </ForestBand>

      {plants.length > 0 && (
        <section className="wrap section-pad">
          <h2 className="display section-title">{t('Found on the trail instead')}</h2>
          <div className="plant-grid">
            {plants.map((p, i) => <Reveal key={p.id} index={i}><PlantCard plant={p} /></Reveal>)}
          </div>
        </section>
      )}
    </div>
  );
}
