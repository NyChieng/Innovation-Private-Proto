import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import { ConservationBadge, Notice, PageHead, Modal, SearchInput } from '../../components/ui.jsx';
import { coords, roleLabel } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { t } from '../../lib/i18n.js';

/* ------------------------------------------------------------------ */

function SpeciesPicker({ value, proposed, onPick, onPropose }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [notListed, setNotListed] = useState(!!proposed);

  useEffect(() => { api.species().then((r) => setRows(r.results)).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows.slice(0, 60);
    return rows.filter((s) =>
      [s.scientific_name, s.common_name, s.local_name, s.family, s.genus]
        .filter(Boolean).join(' ').toLowerCase().includes(n)).slice(0, 60);
  }, [rows, q]);

  const selected = rows.find((s) => s.id === value);

  return (
    <div className="field">
      <label>{t('Species')} <span className="req">*</span></label>

      {!notListed ? (
        <>
          <button type="button" className="input row" style={{ textAlign: 'left', gap: 10 }} onClick={() => setOpen(true)}>
            {selected ? (
              <>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="sci strong" style={{ display: 'block' }}>{selected.scientific_name}</span>
                  <span className="tiny mute">{[selected.common_name, selected.family].filter(Boolean).join(' · ')}</span>
                </span>
                <ConservationBadge code={selected.conservation_code} showLabel={false} />
              </>
            ) : (
              <span className="grow faint">{t('Choose a species from the list')}</span>
            )}
            <I.ChevronDown style={{ width: 16, height: 16, color: 'var(--text-faint)', flex: 'none' }} />
          </button>
          <button
            type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', marginLeft: -10 }}
            onClick={() => { setNotListed(true); onPick(null); }}
          >
            <I.Plus /> {t('The species is not in the list')}
          </button>
        </>
      ) : (
        <>
          <input
            className="input"
            value={proposed || ''}
            onChange={(e) => onPropose(e.target.value)}
            placeholder={t('e.g. Hoya sp. (waxy leaves, pale globe flowers)')}
          />
          <div className="hint">
            {t('Describe what you saw as precisely as you can. A reviewer will confirm the name before it is published.')}
          </div>
          <button
            type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', marginLeft: -10 }}
            onClick={() => { setNotListed(false); onPropose(''); }}
          >
            <I.ArrowLeft /> {t('Choose from the species list instead')}
          </button>
        </>
      )}

      {open && (
        <Modal title={t('Choose a species')} onClose={() => setOpen(false)}>
          <div style={{ marginBottom: 14 }}>
            <SearchInput value={q} onChange={setQ} placeholder={t('Scientific, common or local name')} autoFocus />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                className={'rs-item' + (value === s.id ? ' active' : '')}
                style={{ border: '1px solid var(--border)' }}
                onClick={() => { onPick(s.id); setOpen(false); }}
              >
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="nm sci truncate">{s.scientific_name}</span>
                  <span className="rl truncate">{[s.common_name, s.local_name, s.family].filter(Boolean).join(' · ')}</span>
                </span>
                <ConservationBadge code={s.conservation_code} showLabel={false} />
              </button>
            ))}
            {filtered.length === 0 && <div className="empty small">No species match &ldquo;{q}&rdquo;.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PhotoCapture({ photos, setPhotos }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const add = async (files) => {
    setBusy(true);
    const next = [];
    for (const file of Array.from(files).slice(0, 6 - photos.length)) {
      const data_url = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(file);
      });
      next.push({ data_url, file_name: file.name, mime_type: file.type, size_bytes: file.size });
    }
    setPhotos([...photos, ...next]);
    setBusy(false);
  };

  return (
    <div className="field">
      <label>{t('Photographs')}</label>
      <div className="row row-wrap" style={{ gap: 9 }}>
        {photos.map((p, i) => (
          <div key={i} style={{ position: 'relative', width: 92, height: 72, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <img src={p.data_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {i === 0 && <span className="badge badge-ok" style={{ position: 'absolute', bottom: 3, left: 3, fontSize: '0.6rem', padding: '0 5px' }}>{t('Main')}</span>}
            <button
              type="button" className="btn btn-icon"
              style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, padding: 0, borderRadius: 99, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 0 }}
              onClick={() => setPhotos(photos.filter((_, k) => k !== i))}
              aria-label={t('Remove photograph')}
            >
              <I.X style={{ width: 12, height: 12 }} />
            </button>
          </div>
        ))}
        {photos.length < 6 && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{
              width: 92, height: 72, borderRadius: 8, border: '1px dashed var(--border-strong)',
              background: 'var(--surface-2)', display: 'grid', placeItems: 'center', gap: 3, color: 'var(--text-mute)',
            }}
          >
            {busy ? <span className="spinner" /> : <I.Camera style={{ width: 19, height: 19 }} />}
            <span className="tiny">{t('Add')}</span>
          </button>
        )}
      </div>
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment" multiple
        style={{ display: 'none' }}
        onChange={(e) => { add(e.target.files); e.target.value = ''; }}
      />
      <div className="hint">
        {t('Up to six. On a phone this opens the camera. The first photograph becomes the main image on the plant page.')}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function RegisterPlant() {
  const { boot, user, can, toast, refreshCounts } = useApp();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    species_id: null, proposed_species_name: '',
    site_name: '', location_notes: '',
    latitude: null, longitude: null, gps_accuracy_m: null, altitude_m: null,
    height_m: '', trunk_diameter_cm: '',
    health_status: 'healthy', life_stage: 'mature',
    morphology_notes: '', notes: '',
  });
  const [photos, setPhotos] = useState([]);
  const [gps, setGps] = useState('idle'); // idle | locating | ok | error
  const [gpsError, setGpsError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  const up = (patch) => setForm((f) => ({ ...f, ...patch }));

  const locate = () => {
    if (!navigator.geolocation) { setGps('error'); setGpsError(t('This browser has no location support.')); return; }
    setGps('locating'); setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        up({
          latitude: Number(pos.coords.latitude.toFixed(7)),
          longitude: Number(pos.coords.longitude.toFixed(7)),
          gps_accuracy_m: pos.coords.accuracy ? Number(pos.coords.accuracy.toFixed(1)) : null,
          altitude_m: pos.coords.altitude ? Number(pos.coords.altitude.toFixed(1)) : null,
        });
        setGps('ok');
      },
      (err) => {
        setGps('error');
        setGpsError(
          err.code === 1
            ? t('Location permission was refused.')
            : window.isSecureContext
              ? err.message
              : t('Browsers only give location on HTTPS or localhost. Run "npm run https" to test this on a phone.'),
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  /* What will happen when this is submitted */
  const publishesImmediately = can('plant.approve') && !!form.species_id;
  const requireApproval = boot?.require_approval;
  const willPublish = publishesImmediately || (!requireApproval && !!form.species_id);

  const validate = () => {
    const e = {};
    if (!form.species_id && !form.proposed_species_name.trim()) e.species = t('Choose a species, or describe one that is not listed.');
    if (!form.site_name.trim()) e.site = t('Give the location or trail marker.');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) { toast(t('Some required fields are missing.'), 'err'); return; }
    setBusy(true);
    try {
      const payload = {
        ...form,
        height_m: form.height_m === '' ? null : Number(form.height_m),
        trunk_diameter_cm: form.trunk_diameter_cm === '' ? null : Number(form.trunk_diameter_cm),
        proposed_species_name: form.species_id ? null : form.proposed_species_name.trim(),
        photos,
      };
      const { plant } = await api.createPlant(payload);
      await refreshCounts();
      toast(
        plant.status === 'approved'
          ? t('{code} published. Its QR tag is ready to print.', { code: plant.plant_code })
          : t('{code} submitted for review.', { code: plant.plant_code }),
      );
      navigate('/staff/plants/' + plant.id);
    } catch (err) {
      toast(err.message, 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="wrap wrap-narrow">
        <PageHead
          back={{ to: '/staff/plants', label: t('Plant register') }}
          title={t('Register a plant')}
          sub={t('The ground-truthing form. Everything except the species and the location can be filled in later.')}
        />

        <div style={{ marginBottom: 18 }}>
          <Notice kind={willPublish ? 'ok' : 'info'} title={willPublish ? t('This will publish immediately') : t('This will go to the review queue')}>
            {publishesImmediately && t('You hold {permission}, so your own entries are published as soon as they are saved.', { permission: <span className="mono">plant.approve</span> })}
            {!publishesImmediately && willPublish && t('The {setting} setting is off, so new entries publish straight away.', { setting: <span className="mono">require_approval</span> })}
            {!willPublish && !form.species_id && form.proposed_species_name && t('A record with no confirmed species always goes to a reviewer, whatever the approval setting.')}
            {!willPublish && (form.species_id || !form.proposed_species_name) && t('A reviewer will check it and either publish it or return it with a note.')}
          </Notice>
        </div>

        <form onSubmit={submit} className="stack" style={{ '--gap': '18px' }}>
          {/* Identification */}
          <div className="card">
            <div className="card-head"><h3>{t('Identification')}</h3></div>
            <div className="card-body stack" style={{ '--gap': '16px' }}>
              <SpeciesPicker
                value={form.species_id}
                proposed={form.proposed_species_name}
                onPick={(id) => { up({ species_id: id, proposed_species_name: '' }); setErrors({ ...errors, species: null }); }}
                onPropose={(v) => { up({ proposed_species_name: v, species_id: null }); setErrors({ ...errors, species: null }); }}
              />
              {errors.species && <div className="err">{errors.species}</div>}
            </div>
          </div>

          {/* Location */}
          <div className="card">
            <div className="card-head"><h3>{t('Location')}</h3></div>
            <div className="card-body stack" style={{ '--gap': '16px' }}>
              <div className="field">
                <label htmlFor="site">{t('Site or trail marker')} <span className="req">*</span></label>
                <input
                  id="site" className={'input' + (errors.site ? ' input-invalid' : '')}
                  list="sites" value={form.site_name}
                  onChange={(e) => { up({ site_name: e.target.value }); setErrors({ ...errors, site: null }); }}
                  placeholder={t('e.g. Great Cave Trail, marker 11')}
                />
                <datalist id="sites">{(boot?.sites || []).map((s) => <option key={s} value={s} />)}</datalist>
                {errors.site && <div className="err">{errors.site}</div>}
              </div>

              <div className="field">
                <label>{t('GPS coordinates')}</label>
                <div className="row row-wrap" style={{ gap: 10 }}>
                  <button type="button" className="btn" onClick={locate} disabled={gps === 'locating'}>
                    {gps === 'locating' ? <span className="spinner" /> : <I.MapPin />}
                    {gps === 'locating' ? t('Locating...') : form.latitude ? t('Update location') : t('Use my location')}
                  </button>
                  {form.latitude != null && (
                    <span className="badge badge-ok">
                      <I.Check style={{ width: 12, height: 12 }} />
                      {coords(form.latitude, form.longitude)}
                      {form.gps_accuracy_m && <span className="mute"> &plusmn;{form.gps_accuracy_m} m</span>}
                    </span>
                  )}
                </div>
                {gps === 'error' && <div className="hint" style={{ color: 'var(--warn-fg)' }}>{gpsError}</div>}
                {form.latitude == null && gps !== 'error' && (
                  <div className="hint">{t('Captured automatically in the field. You can also leave it blank and add it later.')}</div>
                )}
              </div>

              <div className="field">
                <label htmlFor="locnotes">{t('How to find it')}</label>
                <textarea
                  id="locnotes" className="textarea" style={{ minHeight: 66 }}
                  value={form.location_notes} onChange={(e) => up({ location_notes: e.target.value })}
                  placeholder={t('Left of the boardwalk, 3 m in from the handrail.')}
                />
              </div>
            </div>
          </div>

          {/* Photographs */}
          <div className="card">
            <div className="card-head"><h3>{t('Photographs')}</h3></div>
            <div className="card-body">
              <PhotoCapture photos={photos} setPhotos={setPhotos} />
            </div>
          </div>

          {/* Specimen */}
          <div className="card">
            <div className="card-head"><h3>{t('This specimen')}</h3></div>
            <div className="card-body stack" style={{ '--gap': '16px' }}>
              <div className="grid grid-2" style={{ gap: 14 }}>
                <div className="field">
                  <label htmlFor="height">{t('Height (m)')}</label>
                  <input id="height" className="input" type="number" step="0.1" min="0"
                    value={form.height_m} onChange={(e) => up({ height_m: e.target.value })} placeholder="e.g. 18.5" />
                </div>
                <div className="field">
                  <label htmlFor="dbh">{t('Trunk diameter (cm)')}</label>
                  <input id="dbh" className="input" type="number" step="0.1" min="0"
                    value={form.trunk_diameter_cm} onChange={(e) => up({ trunk_diameter_cm: e.target.value })} placeholder={t('measured at breast height')} />
                </div>
                <div className="field">
                  <label htmlFor="life">{t('Life stage')}</label>
                  <select id="life" className="select" value={form.life_stage} onChange={(e) => up({ life_stage: e.target.value })}>
                    <option value="seedling">{t('Seedling')}</option>
                    <option value="sapling">{t('Sapling')}</option>
                    <option value="mature">{t('Mature')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="health">{t('Condition')}</label>
                  <select id="health" className="select" value={form.health_status} onChange={(e) => up({ health_status: e.target.value })}>
                    <option value="healthy">{t('Healthy')}</option>
                    <option value="fair">{t('Fair')}</option>
                    <option value="poor">{t('Poor')}</option>
                    <option value="dead">{t('Dead')}</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="morph">{t('Field notes')}</label>
                <textarea
                  id="morph" className="textarea" value={form.morphology_notes}
                  onChange={(e) => up({ morphology_notes: e.target.value })}
                  placeholder={t('Bole straight and clear to the first branch. Epiphytes on the upper limbs.')}
                />
                <div className="hint">{t('Shown on the public plant page.')}</div>
              </div>

              <div className="field">
                <label htmlFor="notes">{t('Internal notes')}</label>
                <textarea
                  id="notes" className="textarea" style={{ minHeight: 60 }}
                  value={form.notes} onChange={(e) => up({ notes: e.target.value })}
                  placeholder={t('Anything the reviewer should know. Never shown to visitors.')}
                />
              </div>
            </div>
          </div>

          <div className="row row-wrap row-end" style={{ gap: 10 }}>
            <button type="button" className="btn" onClick={() => navigate('/staff/plants')}>{t('Cancel')}</button>
            <button className="btn btn-primary btn-lg" disabled={busy}>
              {busy && <span className="spinner" />}
              {willPublish ? t('Save and publish') : t('Submit for review')}
            </button>
          </div>

          <div className="tiny faint center">
            {t('Registering as {name} ({role}). The API records who created every record.', { name: user?.full_name, role: roleLabel(user?.role_label) })}
          </div>
        </form>
      </div>
    </div>
  );
}
