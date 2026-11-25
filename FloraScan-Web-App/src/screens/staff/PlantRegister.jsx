import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import {
  Empty, LoadingBlock, PageHead, PlantCard, PlantRow, SearchInput,
} from '../../components/ui.jsx';
import { CONSERVATION, STATUS, num } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { msg, t } from '../../lib/i18n.js';

const TABS = [
  { key: '', label: msg('All') },
  { key: 'pending', label: msg('Pending') },
  { key: 'approved', label: msg('Published') },
  { key: 'rejected', label: msg('Returned') },
  { key: 'archived', label: msg('Archived') },
];

const SORTS = [
  { value: 'recent', label: msg('Newest') },
  { value: 'name', label: msg('Scientific name') },
  { value: 'code', label: msg('Plant ID') },
];

function exportPlantsCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Plant ID', 'Scientific Name', 'Common Name', 'Family', 'Location', 'Conservation', 'Status', 'Registered'];
  const lines = [
    head.map(esc).join(','),
    ...rows.map((p) => [
      p.plant_code,
      p.scientific_name || p.proposed_species_name || '',
      p.common_name || '',
      p.family || '',
      p.site_name || '',
      p.conservation_code || '',
      p.status || '',
      p.registered_at || '',
    ].map(esc).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'florascan-register.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PlantRegister() {
  const { boot, can, counts, mobile } = useApp();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState(() => localStorage.getItem('florascan.layout') || 'table');
  const navigate = useNavigate();

  const status = params.get('status') || '';
  const q = params.get('q') || '';
  const family = params.get('family') || '';
  const conservation = params.get('conservation') || '';
  const sort = params.get('sort') || 'recent';

  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.plants({ status, q, family, conservation })
        .then((r) => { if (live) { setData(r); setLoading(false); } })
        .catch(() => { if (live) setLoading(false); });
    }, q ? 180 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [status, q, family, conservation]);

  const sortedResults = data?.results ? [...data.results].sort((a, b) => {
    if (sort === 'name') {
      const na = a.scientific_name || a.proposed_species_name || '';
      const nb = b.scientific_name || b.proposed_species_name || '';
      return na.localeCompare(nb);
    }
    if (sort === 'code') return (a.plant_code || '').localeCompare(b.plant_code || '');
    return new Date(b.registered_at || 0) - new Date(a.registered_at || 0);
  }) : [];

  const chooseLayout = (l) => { setLayout(l); localStorage.setItem('florascan.layout', l); };

  const scopeNote = can('plant.view_all')
    ? t('Every record in the register, in any status.')
    : t('The records you registered.');

  return (
    <div className="page">
      <div className="wrap wrap-wide">
        <PageHead title={t('Plant register')} sub={scopeNote}>
          {sortedResults.length > 0 && (
            <button type="button" className="btn" onClick={() => exportPlantsCsv(sortedResults)}>
              <I.Download /> {t('Export CSV')}
            </button>
          )}
          {can('plant.create') && (
            <Link className="btn btn-primary" to="/staff/register"><I.Plus /> {t('Register a plant')}</Link>
          )}
        </PageHead>

        <div className="tabs" style={{ marginBottom: 16 }}>
          {TABS.map((tab) => (
            <button key={tab.key} className={status === tab.key ? 'active' : ''} onClick={() => set('status', tab.key)}>
              {t(tab.label)}
              {counts && counts[tab.key || 'all'] !== undefined && <span className="count">{counts[tab.key || 'all']}</span>}
            </button>
          ))}
        </div>

        <div className="row row-wrap" style={{ gap: 10, marginBottom: 16 }}>
          <div className="grow" style={{ maxWidth: 420, minWidth: 220 }}>
            <SearchInput value={q} onChange={(v) => set('q', v)} placeholder={t('Name, Plant ID, family or location')} />
          </div>
          <select className="select" style={{ width: 'auto' }} value={family} onChange={(e) => set('family', e.target.value)} aria-label={t('Filter by family')}>
            <option value="">{t('All families')}</option>
            {(boot?.families || []).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} value={conservation} onChange={(e) => set('conservation', e.target.value)} aria-label={t('Filter by conservation status')}>
            <option value="">{t('Any status')}</option>
            {(boot?.conservation_statuses || []).map((c) => <option key={c.code} value={c.code}>{c.code} &mdash; {CONSERVATION[c.code]?.label || c.label}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => set('sort', e.target.value)} aria-label={t('Sort by')}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
          </select>
          <span className="spacer" />
          {!mobile && (
            <div className="segmented">
              <button className={layout === 'table' ? 'active' : ''} onClick={() => chooseLayout('table')} aria-label={t('Table view')}><I.List style={{ width: 15, height: 15 }} /></button>
              <button className={layout === 'grid' ? 'active' : ''} onClick={() => chooseLayout('grid')} aria-label={t('Grid view')}><I.Grid style={{ width: 15, height: 15 }} /></button>
            </div>
          )}
        </div>

        {loading && !data && <LoadingBlock label={t('Loading records')} />}

        {data && data.results.length === 0 && (
          <Empty
            icon={I.Leaf}
            title={t('No records here')}
            action={can('plant.create') && <Link className="btn btn-primary" to="/staff/register"><I.Plus /> {t('Register a plant')}</Link>}
          >
            {status ? t('Nothing in the register has the status "{status}".', { status: STATUS[status]?.label || status }) : t('Nothing matches those filters yet.')}
          </Empty>
        )}

        {data && data.results.length > 0 && (
          <>
            <div className="small mute" style={{ marginBottom: 10 }}>
              {num(data.total)} record{data.total === 1 ? '' : 's'}
            </div>

            {mobile || layout === 'grid' ? (
              <div className="plant-grid">
                {sortedResults.map((p) => (
                  <PlantCard key={p.id} plant={p} showStatus to={'/staff/plants/' + p.id} />
                ))}
              </div>
            ) : (
              <div className="card table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th></th><th>{t('Species')}</th><th>{t('Plant ID')}</th><th>{t('Location')}</th>
                      <th>{t('Conservation')}</th><th>{t('Status')}</th><th>{t('Registered')}</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedResults.map((p) => (
                      <PlantRow key={p.id} plant={p} onClick={() => navigate('/staff/plants/' + p.id)}>
                        <td className="num"><I.ChevronRight style={{ width: 16, height: 16, color: 'var(--text-faint)' }} /></td>
                      </PlantRow>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
