import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { ConservationBadge, PlantCard, SearchInput, Skeleton } from '../components/ui.jsx';
import { Reveal, CountUp, PhotoSlideshow, SmartImage, useParallax } from '../components/motion.jsx';
import { num } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { msg, t } from '../lib/i18n.js';

const WORKFLOW_STEPS = [
  {
    num: '01',
    title: msg('Scan on the trail'),
    badge: msg('Trailside QR discovery'),
    desc: msg('Point any phone camera at a trail tag to open that exact specimen record instantly, with no app to install.'),
  },
  {
    num: '02',
    title: msg('Field registration'),
    badge: msg('Botanist field capture'),
    desc: msg('Botanists record taxonomy, measurements, and compressed photographs directly in the field, even when signal drops.'),
  },
  {
    num: '03',
    title: msg('Peer verification'),
    badge: msg('Two-person scientific review'),
    desc: msg('Every submission is independently checked by a second reviewer before publication, preserving a complete audit trail.'),
  },
  {
    num: '04',
    title: msg('Live conservation'),
    badge: msg('Protected coordinates & IoT alerts'),
    desc: msg('Exact GPS locations of threatened flora stay hidden from the public while rangers monitor trailside conditions.'),
  },
];

function WorkflowShowcase({ photos }) {
  const [step, setStep] = useState(0);
  const [jump, setJump] = useState(null);
  const [paused, setPaused] = useState(false);
  const seqRef = useRef(0);

  const wfSlides = useMemo(() => {
    if (!photos?.length) return [];
    return WORKFLOW_STEPS.map((_, i) => ({
      ...photos[i % photos.length],
      id: `wf-${i}-${photos[i % photos.length].id}`,
    }));
  }, [photos]);

  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const selectStep = (nextIdx) => {
    const wrapped = (nextIdx + WORKFLOW_STEPS.length) % WORKFLOW_STEPS.length;
    setStep(wrapped);
    if (wfSlides.length) {
      seqRef.current += 1;
      setJump({ index: wrapped, seq: seqRef.current });
    }
  };

  const current = WORKFLOW_STEPS[step];
  const currentPhoto = wfSlides[step] || null;

  return (
    <Reveal className="section">
      <div className="section-head">
        <div className="grow">
          <h2>{t('How FloraScan works')}</h2>
          <p>{t('From trailside discovery to verified park record.')}</p>
        </div>
      </div>

      <div className={'wf-shell' + (paused ? ' is-paused' : '')}>
        <div className="wf-media">
          {wfSlides.length > 0 && (
            <PhotoSlideshow items={wfSlides} interval={0} fadeMs={1050} jumpTo={jump} />
          )}
          <div key={current.num} className="wf-photo-card">
            <div className="wf-photo-badge">{t(current.badge)}</div>
            <div className="wf-photo-caption">
              {currentPhoto?.scientific_name ? (
                <>
                  <span className="sci" style={{ fontWeight: 600 }}>{currentPhoto.scientific_name}</span>
                  {currentPhoto.common_name && <span style={{ opacity: 0.78 }}> &middot; {currentPhoto.common_name}</span>}
                </>
              ) : (
                <span>{current.num} &middot; {t(current.title)}</span>
              )}
            </div>
          </div>
        </div>

        <div className="wf-panel">
          <div>
            <div className="wf-pill">
              <span className="wf-pill-num">{current.num}</span>
              <span style={{ opacity: 0.4 }}>|</span>
              <span>{t('FloraScan workflow')}</span>
            </div>

            <div className="wf-steps" role="tablist" aria-label={t('FloraScan workflow')}>
              {WORKFLOW_STEPS.map((st, i) => {
                const dist = Math.min(3, Math.abs(i - step));
                return (
                  <button
                    key={st.num}
                    type="button"
                    role="tab"
                    aria-selected={i === step}
                    data-distance={dist}
                    className="wf-step-btn"
                    onClick={(e) => {
                      selectStep(i);
                      if (e.detail > 0) e.currentTarget.blur();
                    }}
                  >
                    <span className="wf-step-num">{st.num}</span>
                    <span className="wf-step-title">{t(st.title)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div key={current.num} className="wf-detail">
              <p className="wf-detail-desc">{t(current.desc)}</p>
            </div>
            <div className="wf-segments">
              {WORKFLOW_STEPS.map((st, i) => (
                <button
                  key={st.num}
                  type="button"
                  className={'wf-seg' + (i < step ? ' is-done' : i === step ? ' is-active' : '')}
                  aria-label={t(st.title)}
                  onClick={(e) => {
                    selectStep(i);
                    if (e.detail > 0) e.currentTarget.blur();
                  }}
                >
                  <span
                    key={`${step}-${i}`}
                    className="wf-seg-fill"
                    onAnimationEnd={() => {
                      if (i === step && !document.hidden) {
                        if (document.activeElement?.classList?.contains('wf-step-btn')) {
                          document.activeElement.blur();
                        }
                        selectStep(step + 1);
                      }
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

export default function Home() {
  const { boot, mobile } = useApp();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);
  const [threatened, setThreatened] = useState(null);
  const [activeHero, setActiveHero] = useState(null);
  const [heroJump, setHeroJump] = useState(null);
  const [q, setQ] = useState('');
  const heroPhotoRef = useRef(null);
  const heroJumpSeq = useRef(0);
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
        plant_code: p.plant_code,
        scientific_name: p.scientific_name || p.proposed_species_name,
        common_name: p.common_name,
        local_name: p.local_name,
        site_name: p.site_name,
        location_protected: p.location_protected,
        conservation_code: p.conservation_code,
      }));
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }, [recent]);
  const quickHeroPicks = heroSlides.slice(0, 5);
  const activeHeroIdx = activeHero ? heroSlides.findIndex((s) => s.id === activeHero.id) : 0;
  const activeDotIdx = quickHeroPicks.length ? ((activeHeroIdx >= 0 ? activeHeroIdx : 0) % quickHeroPicks.length) : 0;
  const families = (boot?.families || []).slice(0, 12);
  const newest = (recent || []).slice(0, mobile ? 4 : 8);
  const atRisk = (threatened || []).slice(0, 4);

  return (
    <>
      {/* ---------------- Hero ---------------- */}
      <section className="hero">
        {heroSlides.length > 0 && (
          <div className="hero-photo" ref={heroPhotoRef} aria-hidden="true">
            <PhotoSlideshow
              items={heroSlides}
              interval={6500}
              fadeMs={1400}
              onChange={setActiveHero}
              jumpTo={heroJump}
            />
          </div>
        )}
        <div className="wrap">
          <div className="hero-layout">
            <div className="hero-in">
              <div className="hero-place">
                <I.MapPin style={{ width: 13, height: 13 }} />
                {t('{park}, Sarawak', { park: boot?.park_name ? t(boot.park_name) : t('Niah National Park') })}
              </div>

              <h1 className="hero-mask-in"><span>{t('Every plant on the trail, explained.')}</span></h1>
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
                <Link to="/scan" className="hero-btn hero-btn-solid">
                  <I.Scan /> {t('Scan a tag')} <I.ChevronRight className="hero-btn-arrow" />
                </Link>
                <Link to="/browse" className="hero-btn">
                  <I.Grid /> {t('Browse all plants')} <I.ChevronRight className="hero-btn-arrow" />
                </Link>
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

            {activeHero && (
              <div className="hero-glass-wrap">
                <div className="hero-glass">
                  <div className="hero-glass-head">
                    <span className="hero-glass-kicker">{t('Featured specimen')}</span>
                    {quickHeroPicks.length > 1 && (
                      <div className="hero-glass-dots" role="tablist" aria-label={t('Switch featured specimen')}>
                        {quickHeroPicks.map((s, idx) => (
                          <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={activeDotIdx === idx}
                            aria-label={s.scientific_name || s.plant_code}
                            className={'hero-glass-dot' + (activeDotIdx === idx ? ' is-active' : '')}
                            onClick={() => {
                              heroJumpSeq.current += 1;
                              setHeroJump({ index: idx, seq: heroJumpSeq.current });
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div key={activeHero.id} className="hero-glass-body">
                    <div className="hero-glass-main">
                      <div className="hero-glass-thumb">
                        <SmartImage
                          src={activeHero.resolvedUrl || activeHero.src}
                          fallback={activeHero.fallback}
                          tint={activeHero.tint}
                          alt={activeHero.scientific_name || ''}
                          eager
                        />
                      </div>
                      <div className="hero-glass-meta">
                        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                          {activeHero.conservation_code && <ConservationBadge code={activeHero.conservation_code} showLabel={false} />}
                          {activeHero.plant_code && <span className="mono tiny" style={{ color: 'rgba(220,236,222,0.72)' }}>{activeHero.plant_code}</span>}
                        </div>
                        <div className="hero-glass-sci truncate">{activeHero.scientific_name}</div>
                        {(activeHero.common_name || activeHero.local_name) && (
                          <div className="hero-glass-common truncate">
                            {[activeHero.common_name, activeHero.local_name].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="hero-glass-foot">
                      <span className="hero-glass-site truncate">
                        {activeHero.location_protected ? t('Withheld') : (activeHero.site_name || '')}
                      </span>
                      <Link className="hero-glass-link" to={'/plant/' + activeHero.id}>
                        {t('View specimen')} <I.ChevronRight />
                      </Link>
                    </div>
                  </div>
                </div>
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
                {places.map(([site, count]) => (
                  <Link key={site} to={'/browse?site=' + encodeURIComponent(site)} className="place">
                    <I.MapPin />
                    <span className="grow truncate">{site}</span>
                    <span className="place-n">{count}</span>
                  </Link>
                ))}
              </div>
            </Reveal>
          )}

          {/* ---------------- 01-04 Interactive workflow focus module ---------------- */}
          <WorkflowShowcase photos={heroSlides} />

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
