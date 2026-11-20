import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { PlantCard, SearchInput, Skeleton } from '../components/ui.jsx';
import { Reveal, CountUp, PhotoSlideshow, useParallax } from '../components/motion.jsx';
import { num } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

export default function Home() {
  const { boot, mobile } = useApp();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);
  const [threatened, setThreatened] = useState(null);
  const [q, setQ] = useState('');
  const heroPhotoRef = useRef(null);
  const navigate = useNavigate();
  useParallax(heroPhotoRef, 0.16, 60);

  useEffect(() => {
    api.publicStats().then(setStats).catch(() => {});
    const loadPlants = async () => {
      const first = await api.publicPlants({ sort: 'recent', limit: 100 });
      const plants = [...first.results];
      for (let offset = first.results.length; offset < first.total; offset += first.limit) {
        const page = await api.publicPlants({ sort: 'recent', limit: first.limit, offset });
        plants.push(...page.results);
      }
      setRecent(plants);
    };
    loadPlants().catch(() => setRecent([]));
    Promise.all(['CR', 'EN', 'VU'].map((c) => api.publicPlants({ conservation: c })))
      .then((rs) => setThreatened(rs.flatMap((r) => r.results)))
      .catch(() => setThreatened([]));
  }, []);

  const submit = (e) => {
    e.preventDefault();
    navigate('/browse' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''));
  };

  /* Where the published records actually are, so a visitor standing on a
     trail can start from the trail rather than from a species name. */
  const places = useMemo(() => {
    if (!recent) return [];
    const counts = new Map();
    recent.forEach((p) => counts.set(p.site_name, (counts.get(p.site_name) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [recent]);

  // Shuffle every published record with a photo so the hero cycles smoothly through the full register.
  const heroSlides = useMemo(() => {
    if (!recent?.length) return [];
    const shuffled = recent
      .filter((p) => p.photo || p.photo_remote)
      .map((p) => ({
        id: p.id,
        src: p.photo || p.photo_remote,
        fallback: p.photo ? p.photo_remote : undefined,
        tint: p.photo_tint,
      }));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }, [recent]);
  const families = (boot?.families || []).slice(0, 12);
  const newest = (recent || []).slice(0, mobile ? 4 : 8);
  const atRisk = (threatened || []).slice(0, 4);

  return (
    <>
      {/* ---------------- Hero ---------------- */}
      <section className="hero">
        {heroSlides.length > 0 && (
          <div className="hero-photo" ref={heroPhotoRef} aria-hidden="true">
            <PhotoSlideshow items={heroSlides} interval={6500} fadeMs={1400} />
          </div>
        )}
        <div className="wrap">
          <div className="hero-in">
            <div className="hero-place">
              <I.MapPin style={{ width: 13, height: 13 }} />
              {t('{park}, Sarawak', { park: boot?.park_name ? t(boot.park_name) : t('Niah National Park') })}
            </div>

            <h1>{t('Every plant on the trail, explained.')}</h1>
            <p>
              {t('Scan the tag beside a plant, or search the register by name, family or location. Nothing appears here until a botanist has recorded it and a reviewer has checked it.')}
            </p>

            <form onSubmit={submit} className="hero-search">
              <SearchInput
                value={q}
                onChange={setQ}
                large
                placeholder={mobile ? t('Search the register') : t('Try "Belian", "Nepenthes", "Dipterocarpaceae" or a Plant ID')}
              />
            </form>

            <div className="hero-actions">
              <Link to="/scan" className="hero-btn hero-btn-solid"><I.Scan /> {t('Scan a tag')}</Link>
              <Link to="/browse" className="hero-btn"><I.Grid /> {t('Browse all plants')}</Link>
            </div>

            {stats && (
              <div className="hero-figures">
                <span>{t('{n} plants', { n: <strong><CountUp value={stats.published_plants} /></strong> })}</span>
                <span>{t('{n} species', { n: <strong><CountUp value={stats.species} /></strong> })}</span>
                <span>{t('{n} families', { n: <strong><CountUp value={stats.families} /></strong> })}</span>
                <span>{t('{n} threatened', { n: <strong><CountUp value={stats.threatened} /></strong> })}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="page">
        <div className="wrap">
          {/* ---------------- Start from where you are ---------------- */}
          {places.length > 0 && (
            <Reveal className="section">
              <div className="section-head">
                <h2>{t('Start from where you are')}</h2>
                <p>{t('Published records, grouped by where they stand in the park.')}</p>
              </div>
              <div className="place-list">
                {places.map(([site, count], i) => (
                  <Link key={site} to={'/browse?site=' + encodeURIComponent(site)} className="place">
                    <I.MapPin />
                    <span className="grow truncate">{site}</span>
                    <span className="place-n">{count}</span>
                  </Link>
                ))}
              </div>
            </Reveal>
          )}

          {/* ---------------- Recently verified ---------------- */}
          <Reveal className="section">
            <div className="section-head">
              <div className="grow">
                <h2>{t('Recently verified')}</h2>
                <p>{t('The newest records to pass review.')}</p>
              </div>
              <Link to="/browse" className="btn btn-sm">All {num(stats?.published_plants || 0)} <I.ChevronRight /></Link>
            </div>

            <div className="plant-grid">
              {recent
                ? newest.map((p, i) => (
                    <Reveal key={p.id} index={i}><PlantCard plant={p} eager={i < 4} /></Reveal>
                  ))
                : Array.from({ length: 4 }).map((_, i) => (
                    <div className="card" key={i}>
                      <Skeleton h={0} style={{ aspectRatio: '4/3', height: 'auto' }} />
                      <div style={{ padding: 14 }}><Skeleton h={14} w="70%" /><div style={{ height: 7 }} /><Skeleton h={11} w="45%" /></div>
                    </div>
                  ))}
            </div>
          </Reveal>

          {/* ---------------- Conservation ---------------- */}
          {atRisk.length > 0 && (
            <Reveal className="section">
              <div className="section-head">
                <div className="grow">
                  <h2>{t('Under pressure')}</h2>
                  <p>{t('Specimens of species assessed as vulnerable or worse on the IUCN Red List.')}</p>
                </div>
              </div>

              <div className="ramp">
                {['LC', 'NT', 'VU', 'EN', 'CR'].map((c) => (
                  <Link key={c} to={'/browse?conservation=' + c} className="ramp-step" style={{ '--c': `var(--cs-${c})` }}>
                    <span className="ramp-bar" />
                    <span className="ramp-code">{c}</span>
                  </Link>
                ))}
                <span className="ramp-caption">{t('least concern → critically endangered')}</span>
              </div>

              <div className="plant-grid">
                {atRisk.map((p, i) => <Reveal key={p.id} index={i}><PlantCard plant={p} /></Reveal>)}
              </div>
            </Reveal>
          )}

          {/* ---------------- Families ---------------- */}
          {families.length > 0 && (
            <Reveal className="section">
              <div className="section-head">
                <h2>{t('By family')}</h2>
                <p>{t('Taxonomy is held once per species, so a correction reaches every specimen at once.')}</p>
              </div>
              <div className="row row-wrap" style={{ gap: 7 }}>
                {families.map((f) => (
                  <Link key={f} className="chip" to={'/browse?family=' + encodeURIComponent(f)}>{f}</Link>
                ))}
                <Link className="chip" to="/species">{t('All species')} <I.ChevronRight style={{ width: 13, height: 13 }} /></Link>
              </div>
            </Reveal>
          )}

          {/* ---------------- Provenance + reporting ---------------- */}
          <Reveal className="colophon">
            <div>
              <strong>{t('Where this comes from.')}</strong>{' '}
              {t('Taxonomy and Red List categories are drawn from {gbif}; photographs are contributed to {inat} under Creative Commons licences and credited on each plant page. Specimen records are entered by park botanists and checked by a reviewer before they appear.', {
                gbif: <a href="https://www.gbif.org" target="_blank" rel="noreferrer">GBIF</a>,
                inat: <a href="https://www.inaturalist.org" target="_blank" rel="noreferrer">iNaturalist</a>,
              })}
            </div>
            <div style={{ marginTop: 10 }}>
              <strong>{t('Spotted something wrong?')}</strong>{' '}
              {t('Open any plant page and use {action}. No account needed.', { action: <em>{t('Report incorrect information')}</em> })}
            </div>
          </Reveal>
        </div>
      </div>
    </>
  );
}
