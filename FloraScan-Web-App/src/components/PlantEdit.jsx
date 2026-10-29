import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { ConservationBadge, Modal, Notice, SearchInput } from './ui.jsx';
import { HEALTH, LIFE_STAGE } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import * as I from '../lib/icons.jsx';

/**
 * Editing a plant record, from the record page or from the review queue
 * (issue #6).
 *
 * The review version used to offer one thing - setting a species on a
 * "species not listed" record - so a reviewer who spotted a wrong species, a
 * typo in the site name or a height in the wrong unit could only return the
 * whole record and wait. Now every field a botanist entered can be corrected
 * in place, and the reviewer sees exactly what will change before saving.
 *
 * Only changed fields are sent. Each one becomes a line in the record's
 * history with the old value, the new value and the reason, so a correction
 * made at review is as accountable as the original entry.
 */

const NUMERIC = ['latitude', 'longitude', 'height_m', 'trunk_diameter_cm'];
const FIELDS = ['species_id', 'site_name', 'location_notes', ...NUMERIC,
  'life_stage', 'health_status', 'morphology_notes', 'notes'];

const LABELS = {
  species_id: () => t('Species'),
  site_name: () => t('Site or trail marker'),
  location_notes: () => t('How to find it'),
  latitude: () => t('Latitude'),
  longitude: () => t('Longitude'),
  height_m: () => t('Height (m)'),
  trunk_diameter_cm: () => t('Trunk diameter (cm)'),
  life_stage: () => t('Life stage'),
  health_status: () => t('Condition'),
  morphology_notes: () => t('Field notes'),
  notes: () => t('Internal notes (staff only)'),
};

const initialForm = (p) => ({
  species_id: p.species_id ?? null,
  site_name: p.site_name || '',
  location_notes: p.location_notes || '',
  latitude: p.latitude ?? '',
  longitude: p.longitude ?? '',
  height_m: p.height_m ?? '',
  trunk_diameter_cm: p.trunk_diameter_cm ?? '',
  life_stage: p.life_stage || '',
  health_status: p.health_status || '',
  morphology_notes: p.morphology_notes || '',
  notes: p.notes || '',
});

/** Compare as the database will store it: blanks are null, numbers are numbers. */
function norm(field, v) {
  if (v === '' || v === undefined || v === null) return null;
  if (NUMERIC.includes(field)) return Number(v);
  if (field === 'species_id') return Number(v);
  return typeof v === 'string' ? v.trim() : v;
}

/* ------------------------------------------------------------------ */

function SpeciesPicker({ current, proposed, onPick }) {
  const { can } = useApp();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.species().then((r) => setRows(r.results)).catch(() => setRows([]));
  }, []);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const base = n
      ? (rows || []).filter((s) => [s.scientific_name, s.common_name, s.local_name, s.family, s.genus]
          .filter(Boolean).join(' ').toLowerCase().includes(n))
      : (rows || []);
    return base.slice(0, 40);
  }, [rows, q]);

  return (
    <div className="stack" style={{ '--gap': '10px' }}>
      {proposed && (
        <Notice kind="plain">
          {t('Recorded in the field as {name}.', { name: <strong>&ldquo;{proposed}&rdquo;</strong> })}
        </Notice>
      )}
      <SearchInput value={q} onChange={setQ} placeholder={t('Search the species list')} autoFocus />
      <div className="picker-list" role="listbox" aria-label={t('Species')}>
        {rows === null && <div className="tiny mute" style={{ padding: 8 }}>{t('Loading')}...</div>}
        {filtered.map((s) => (
          <button
            key={s.id} type="button" role="option" aria-selected={current === s.id}
            className={'rs-item' + (current === s.id ? ' active' : '')}
            style={{ border: '1px solid var(--border)' }}
            onClick={() => onPick(s)}
          >
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="nm sci truncate">{s.scientific_name}</span>
              <span className="rl truncate">{[s.common_name, s.family].filter(Boolean).join(' · ')}</span>
            </span>
            <ConservationBadge code={s.conservation_code} showLabel={false} />
            {current === s.id && <I.Check style={{ width: 16, height: 16, color: 'var(--accent)' }} />}
          </button>
        ))}
        {rows && !filtered.length && <div className="tiny mute" style={{ padding: 8 }}>{t('No species match that search.')}</div>}
      </div>
      {can('species.manage') && (
        <div><Link className="btn btn-sm" to="/staff/species"><I.Plus /> {t('Add a new species')}</Link></div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function PlantEditDialog({ plant, onClose, onSaved, review = false, focus }) {
  const { toast } = useApp();
  const start = useMemo(() => initialForm(plant), [plant]);
  const [form, setForm] = useState(start);
  const [speciesName, setSpeciesName] = useState(plant.scientific_name || null);
  const [picking, setPicking] = useState(focus === 'species' || (review && plant.species_not_listed));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const up = (p) => setForm((f) => ({ ...f, ...p }));

  const changed = FIELDS.filter((f) => norm(f, form[f]) !== norm(f, start[f]));
  const coordsHalf = (form.latitude === '') !== (form.longitude === '');

  const save = async () => {
    if (!changed.length) return;
    if (coordsHalf) { toast(t('Enter both latitude and longitude, or neither.'), 'err'); return; }
    if (!String(form.site_name).trim()) { toast(t('A location or site name is required.'), 'err'); return; }
    setBusy(true);
    try {
      const body = { change_reason: reason.trim() || (review ? t('Corrected at review') : null) };
      for (const f of changed) body[f] = norm(f, form[f]);
      await api.updatePlant(plant.id, body);
      toast(changed.length === 1
        ? t('1 change saved. It is in the record history.')
        : t('{n} changes saved. They are in the record history.', { n: changed.length }));
      onSaved?.();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const display = (f, v) => {
    // Only ever asked for the starting value; the new one is speciesName.
    if (f === 'species_id') return plant.scientific_name || plant.proposed_species_name;
    if (f === 'life_stage') return LIFE_STAGE[v] || null;
    if (f === 'health_status') return HEALTH[v] || null;
    return v === '' || v === null ? null : String(v);
  };

  return (
    <Modal
      wide
      title={review ? t('Correct {code} before deciding', { code: plant.plant_code }) : t('Edit {code}', { code: plant.plant_code })}
      onClose={onClose}
      footer={
        <>
          <span className="tiny mute grow">
            {changed.length
              ? (changed.length === 1 ? t('1 field changed') : t('{n} fields changed', { n: changed.length }))
              : t('No changes yet')}
          </span>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !changed.length}>
            {busy && <span className="spinner" />}{t('Save changes')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' }}>
        <Notice kind="plain">
          {review
            ? t('Fix what is wrong here instead of returning the whole record. Each change is written to the history with the old and new value, under your name, and the botanist can see it.')
            : t('Every field you change is written to the history with the old and new value, and to the audit trail against your account.')}
        </Notice>

        {/* Species */}
        <div className="field">
          <span className="label-row">
            <label>{t('Species')}</label>
            {!picking && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(true)}>
                <I.Book /> {form.species_id ? t('Change species') : t('Set species')}
              </button>
            )}
          </span>
          {!picking && (
            <div className="inset small">
              {form.species_id
                ? <span className="sci">{speciesName}</span>
                : <span className="mute">{t('Not confirmed - recorded as {name}', { name: <strong>&ldquo;{plant.proposed_species_name}&rdquo;</strong> })}</span>}
            </div>
          )}
          {picking && (
            <SpeciesPicker
              current={form.species_id}
              proposed={plant.species_not_listed ? plant.proposed_species_name : null}
              onPick={(s) => { up({ species_id: s.id }); setSpeciesName(s.scientific_name); setPicking(false); }}
            />
          )}
        </div>

        <div className="field">
          <label htmlFor="e-site">{t('Site or trail marker')} <span className="req">*</span></label>
          <input id="e-site" className="input" value={form.site_name} maxLength={150} onChange={(e) => up({ site_name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="e-loc">{t('How to find it')}</label>
          <textarea id="e-loc" className="textarea" style={{ minHeight: 60 }} maxLength={2000} value={form.location_notes} onChange={(e) => up({ location_notes: e.target.value })} />
        </div>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="e-lat">{t('Latitude')}</label>
            <input id="e-lat" type="number" step="0.000001" min="-90" max="90" className="input" value={form.latitude} onChange={(e) => up({ latitude: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="e-lon">{t('Longitude')}</label>
            <input id="e-lon" type="number" step="0.000001" min="-180" max="180" className="input" value={form.longitude} onChange={(e) => up({ longitude: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="e-h">{t('Height (m)')}</label>
            <input id="e-h" type="number" step="0.1" min="0" max="150" className="input" value={form.height_m} onChange={(e) => up({ height_m: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="e-d">{t('Trunk diameter (cm)')}</label>
            <input id="e-d" type="number" step="0.1" min="0" max="1200" className="input" value={form.trunk_diameter_cm} onChange={(e) => up({ trunk_diameter_cm: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="e-life">{t('Life stage')}</label>
            <select id="e-life" className="select" value={form.life_stage} onChange={(e) => up({ life_stage: e.target.value })}>
              <option value="">{t('Not recorded')}</option>
              {Object.entries(LIFE_STAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="e-health">{t('Condition')}</label>
            <select id="e-health" className="select" value={form.health_status} onChange={(e) => up({ health_status: e.target.value })}>
              <option value="">{t('Not recorded')}</option>
              {Object.entries(HEALTH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        {coordsHalf && <div className="tiny" style={{ color: 'var(--danger-fg)' }}>{t('Enter both latitude and longitude, or neither.')}</div>}

        <div className="field">
          <label htmlFor="e-morph">{t('Field notes')}</label>
          <textarea id="e-morph" className="textarea" maxLength={2000} value={form.morphology_notes} onChange={(e) => up({ morphology_notes: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="e-notes">{t('Internal notes (staff only)')}</label>
          <textarea id="e-notes" className="textarea" style={{ minHeight: 60 }} maxLength={2000} value={form.notes} onChange={(e) => up({ notes: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="e-reason">{t('Reason for the change')} <span className="hint">({t('optional')})</span></label>
          <input
            id="e-reason" className="input" value={reason} maxLength={250} onChange={(e) => setReason(e.target.value)}
            placeholder={review ? t('Corrected at review') : t('Corrected after a site visit')}
          />
        </div>

        {changed.length > 0 && (
          <div className="inset small" aria-live="polite">
            <div className="label" style={{ marginBottom: 6 }}>{t('What will change')}</div>
            <div className="change-list">
              {changed.map((f) => (
                <div key={f} className="change-row">
                  <span className="mute">{LABELS[f]()}</span>
                  <span className="tl-diff">
                    <span className="tl-old">{display(f, start[f]) || t('empty')}</span>
                    <I.ChevronRight style={{ width: 12, height: 12, color: 'var(--text-faint)', flex: 'none' }} />
                    <span className="tl-new">{f === 'species_id' ? speciesName : (display(f, form[f]) || t('empty'))}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
