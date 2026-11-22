import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { SmartImage, CountUp } from '../components/motion.jsx';
import { ForestBand, MarkerDot } from '../components/forest.jsx';
import { plantPhoto, realPhoto } from '../lib/photo.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/**
 * The front door: one question, one way to scan, one way to type the number,
 * and two ways to browse. Nothing else, on purpose.
 */
export default function Home() {
  const { mobile, user } = useApp();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [stats, setStats] = useState(null);
  const [featured, setFeatured] = useState(null);
  const [tiles, setTiles] = useState([]);

  useEffect(() => {
    api.publicStats().then(setStats).catch(() => {});
    api.publicPlants({ sort: 'popular', limit: 24 })
      .then((r) => {
        const withPhoto = r.results.filter((p) => plantPhoto(p) && !p.location_protected);
        setFeatured(withPhoto[0] || null);
        setTiles(withPhoto.slice(1, 3).map(plantPhoto));
      })
      .catch(() => {});
  }, []);

  const open = (e) => {
    e.preventDefault();
    const v = code.trim();
    navigate('/browse' + (v ? '?q=' + encodeURIComponent(v) : ''));
  };

  const featuredName = featured && (featured.common_name || featured.local_name || featured.scientific_name);

  return (
    <div className="home">
      <section className="wrap home-hero">
        <div className="home-hero-text">
          <h1 className="display rise">{t('What is growing beside you?')}</h1>
          <p className="home-lede rise rise-2">{t('Scan the tag, or type its number.')}</p>
          <div className="home-actions rise rise-3">
            <Link to="/scan" className="fbtn fbtn-dark fbtn-lg">
              <I.Scan /> {t('Scan a tag')}
            </Link>
            <form className="code-form" onSubmit={open}>
              <label htmlFor="home-code" className="visually-hidden">{t('Number on the tag')}</label>
              <input
                id="home-code"
                inputMode="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('Tag number, e.g. 0112')}
              />
              <button type="submit">{t('Go')}</button>
            </form>
          </div>
        </div>

        {featured && (
          <Link to={'/plant/' + featured.id} className="home-photo rise rise-2">
            <SmartImage
              src={plantPhoto(featured)}
              fallback={realPhoto(featured.photo) ? realPhoto(featured.photo_remote) : undefined}
              tint={featured.photo_tint}
              alt={featuredName || ''}
              eager
            />
            <span className="home-photo-tag">
              <MarkerDot site={featured.site_name} />
              <span className="col" style={{ gap: 0 }}>
                <strong>{featuredName}</strong>
                <span className="small mute">{featured.site_name}</span>
              </span>
            </span>
          </Link>
        )}
      </section>

      <ForestBand ferns="left" className="home-band">
        <div className="home-tiles">
          <Link to="/browse" className="photo-tile">
            {tiles[0] && <SmartImage src={tiles[0]} alt="" placeholderLabel={false} />}
            <span className="photo-tile-shade" />
            <span className="photo-tile-text">
              <strong className="display">{t('Browse plants')} <I.ChevronRight /></strong>
              {stats && <span>{t('{n} tagged plants', { n: <CountUp value={stats.published_plants} /> })}</span>}
            </span>
          </Link>
          <Link to="/species" className="photo-tile">
            {tiles[1] && <SmartImage src={tiles[1]} alt="" placeholderLabel={false} />}
            <span className="photo-tile-shade" />
            <span className="photo-tile-text">
              <strong className="display">{t('Species')} <I.ChevronRight /></strong>
              {stats && <span>{t('{n} species in {f} families', { n: <CountUp value={stats.species} />, f: stats.families })}</span>}
            </span>
          </Link>
        </div>
        {mobile && !user && (
          <Link to="/login" className="band-link">{t('Staff sign in')}</Link>
        )}
      </ForestBand>
    </div>
  );
}
