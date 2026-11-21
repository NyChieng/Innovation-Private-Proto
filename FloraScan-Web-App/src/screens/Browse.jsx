import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { PlantCard, SearchInput, Empty, LoadingBlock, ChipRow } from '../components/ui.jsx';
import PlantMap from '../components/PlantMap.jsx';
import { Reveal } from '../components/motion.jsx';
import { ForestBand } from '../components/forest.jsx';
import { CONSERVATION, GROWTH_FORM, num, titleCase } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { msg, t } from '../lib/i18n.js';

const SORTS = [
  { value: 'place', label: msg('By location') },
  { value: 'recent', label: msg('Newest') },
  { value: 'name', label: msg('Scientific name') },
  { value: 'code', label: msg('Plant ID') },
  { value: 'popular', label: msg('Most viewed') },
];

/** The plant types worth a chip of their own, in the order a visitor sees them. */
const TYPE_CHIPS = ['tree', 'palm', 'climber', 'shrub', 'herb', 'fern'];

/** Keeps the order records arrived in, so "Newest" still reads newest-first. */
function groupBySite(plants) {
  const groups = new Map();
  for (const p of plants) {
    const key = p.location_protected ? t('Location withheld') : (p.site_name || t('Elsewhere in the park'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()];
}

export default function Browse() {
  const { boot, mobile } = useApp();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState('grid');

  const q = params.get('q') || '';
  const family = params.get('family') || '';
  const genus = params.get('genus') || '';
  const conservation = params.get('conservation') || '';
  const site = params.get('site') || '';
  const growth_form = params.get('growth_form') || '';
  const sort = params.get('sort') || 'place';

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const PAGE = 24;

  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.publicPlants({ q, family, genus, conservation, site, growth_form, sort, limit: PAGE, offset: 0 })
        .then((r) => { if (live) { setData(r); setLoading(false); } })
        .catch(() => { if (live) setLoading(false); });
    }, q ? 180 : 0); // debounce typing, but filters apply at once
    return () => { live = false; clearTimeout(timer); };
  }, [q, family, genus, conservation, site, growth_form, sort]);

  /** Appends the next page rather than replacing, so scroll position holds. */
  const loadMore = async () => {
    if (!data?.has_more || more) return;
    setMore(true);
    try {
      const next = await api.publicPlants({
        q, family, genus, conservation, site, growth_form, sort,
        limit: PAGE, offset: data.results.length,
      });
      setData((d) => ({ ...next, results: [...d.results, ...next.results] }));
    } catch {
      /* the button stays, so the visitor can try again */
    } finally { setMore(false); }
  };

  const active = useMemo(
    () => [
      family && { key: 'family', label: family },
      genus && { key: 'genus', label: genus },
      conservation && { key: 'conservation', label: CONSERVATION[conservation]?.label || conservation },
      site && { key: 'site', label: site },
    ].filter(Boolean),
    [family, genus, conservation, site],
  );

  const types = TYPE_CHIPS.filter((g) => (boot?.growth_forms || []).includes(g));
  const grouped = sort === 'place';
  const groups = useMemo(() => (data && grouped ? groupBySite(data.results) : []), [data, grouped]);

  const countLine = loading ? t('Searching...') : (() => {
    const vars = { n: <strong>{num(data?.total || 0)}</strong>, q: <>&ldquo;{q}&rdquo;</> };
    const one = data?.total === 1;
    if (q) return one ? t('{n} published record matching {q}', vars) : t('{n} published records matching {q}', vars);
    return one ? t('{n} published record', vars) : t('{n} published records', vars);
  })();

  return (
    <div className="browse">
      <ForestBand photo={data?.results?.find((p) => p.photo)?.photo} className="list-band">
        <div className="list-band-head">
          <h1 className="display">{t('Plants')}</h1>
          <span className="list-band-count">{countLine}</span>
        </div>
        <div className="band-search-wrap">
          <SearchInput
            value={q}
            onChange={(v) => set('q', v)}
            large
            placeholder={mobile ? t('Name or tag number') : t('Name, family or tag number')}
          />
        </div>
      </ForestBand>

      {/* One toolbar row: plant type, then filters and view */}
      <div className="toolbar-strip">
        <div className="wrap toolbar-in">
          <div className="toolbar-chips" role="group" aria-label={t('Plant type')}>
            <button className="chip" aria-pressed={!growth_form} onClick={() => set('growth_form', '')}>{t('All')}</button>
            {types.map((g) => (
              <button key={g} className="chip" aria-pressed={growth_form === g} onClick={() => set('growth_form', growth_form === g ? '' : g)}>
                {GROWTH_FORM[g] || titleCase(g)}
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <button className="btn btn-sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>
              <I.Filter /> {t('More filters')}{active.length ? ` (${active.length})` : ''}
            </button>
            <div className="segmented" role="group" aria-label={t('View mode')}>
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} aria-label={t('Grid view')} title={t('Grid view')}>
                <I.Grid style={{ width: 15, height: 15 }} />
              </button>
              <button type="button" className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')} aria-label={t('Map view')} title={t('Map view')}>
                <I.MapPin style={{ width: 15, height: 15 }} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="wrap section-pad">
        {filtersOpen && (
          <div className="card card-pad filter-panel">
            <div className="field">
              <label>{t('Conservation status')}</label>
              <ChipRow
                options={['LC', 'NT', 'VU', 'EN', 'CR'].map((c) => ({ value: c, label: c }))}
                value={conservation}
                onChange={(v) => set('conservation', v)}
                allLabel={t('Any')}
              />
            </div>
            <div className="field">
              <label htmlFor="f-family">{t('Family')}</label>
              <select id="f-family" className="select" value={family} onChange={(e) => set('family', e.target.value)}>
                <option value="">{t('All families')}</option>
                {(boot?.families || []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-genus">{t('Genus')}</label>
              <select id="f-genus" className="select" value={genus} onChange={(e) => set('genus', e.target.value)}>
                <option value="">{t('All genera')}</option>
                {(boot?.genera || []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-site">{t('Location')}</label>
              <select id="f-site" className="select" value={site} onChange={(e) => set('site', e.target.value)}>
                <option value="">{t('Anywhere in the park')}</option>
                {(boot?.sites || []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-sort">{t('Sort by')}</label>
              <select id="f-sort" className="select" value={sort} onChange={(e) => set('sort', e.target.value)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
              </select>
            </div>
          </div>
        )}

        {active.length > 0 && (
          <div className="row row-wrap" style={{ gap: 7, marginBottom: 18 }}>
            {active.map((a) => (
              <button key={a.key} className="chip active" onClick={() => set(a.key, '')}>
                {a.label} <span className="chip-x">×</span>
              </button>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => setParams(q ? { q } : {}, { replace: true })}>{t('Clear filters')}</button>
          </div>
        )}

        {loading && !data && <LoadingBlock label={t('Searching the register')} />}

        {data && data.results.length === 0 && (
          <Empty
            icon={I.Search}
            title={t('No records match')}
            action={<button className="btn" onClick={() => setParams({}, { replace: true })}>{t('Clear search and filters')}</button>}
          >
            {t('Try a shorter search term, or a different family or conservation status. Only approved records appear on the public site.')}
          </Empty>
        )}

        {data && data.results.length > 0 && (
          <>
            {viewMode === 'map' ? (
              <PlantMap plants={data.results} />
            ) : !grouped ? (
              <div className="plant-grid" style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.15s' }}>
                {data.results.map((p, i) => (
                  <Reveal key={p.id} index={i % 6}><PlantCard plant={p} eager={i < 6} /></Reveal>
                ))}
              </div>
            ) : (
              <div className="site-groups" style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 0.15s' }}>
                {groups.map(([name, plants], gi) => (
                  <section key={name} className="site-group">
                    <Reveal as="div" className="site-group-head">
                      <h2 className="display">{name}</h2>
                      <span className="small mute">{t('{n} shown', { n: plants.length })}</span>
                    </Reveal>
                    <div className="plant-grid">
                      {plants.map((p, i) => (
                        <Reveal key={p.id} index={i % 6}><PlantCard plant={p} hideSite eager={gi === 0 && i < 6} /></Reveal>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            <div className="row" style={{ justifyContent: 'center', marginTop: 32 }}>
              {data.has_more ? (
                <button className="fbtn fbtn-outline" onClick={loadMore} disabled={more}>
                  {more && <span className="spinner" />}
                  {more
                    ? t('Loading') + '…'
                    : <>{t('Load more')} <span className="mute">({t('{n} left', { n: num(data.total - data.results.length) })})</span></>}
                </button>
              ) : (
                data.total > PAGE && (
                  <span className="small faint">{t('That is all {n} records.', { n: num(data.total) })}</span>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
