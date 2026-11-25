import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Reveal, SmartImage } from '../components/motion.jsx';
import {
  ConservationBadge, StatusBadge, Empty, LoadingBlock, Modal, Notice, CopyButton,
} from '../components/ui.jsx';
import PlantMap from '../components/PlantMap.jsx';
import {
  CONSERVATION, GROWTH_FORM, HEALTH, LIFE_STAGE, STATUS, coords, formatDate, fromServer, measure, num, titleCase,
} from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';
import { isRealPhoto } from '../lib/photo.js';
import { ForestBand, MarkerDot } from '../components/forest.jsx';

/* ------------------------------------------------------------------ */

/**
 * Photo credit. Every photograph here is somebody's work under a Creative
 * Commons licence, so the credit travels with the image rather than living in
 * a footnote nobody reads.
 */
function Credit({ photo, className = 'credit' }) {
  if (!photo?.credit && !photo?.source_name) return null;
  if (!photo.credit) {
    return <div className={className}>{photo.source_name}</div>;
  }
  return (
    <div className={className}>
      {photo.credit}
      {photo.license && <> &middot; {photo.license}</>}
      {photo.source_url && (
        <> &middot; <a href={photo.source_url} target="_blank" rel="noreferrer">{photo.source_name || 'source'}</a></>
      )}
    </div>
  );
}

function Gallery({ photos: allPhotos, alt }) {
  // Only real photographs: generated stand-in drawings are left out.
  const photos = (allPhotos || []).filter((p) => isRealPhoto(p.file_path) || isRealPhoto(p.remote_url));
  const [idx, setIdx] = useState(0);
  const [zoom, setZoom] = useState(false);

  const count = photos?.length || 0;

  useEffect(() => {
    if (!zoom || count <= 1) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx((i) => (i - 1 + count) % count); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setIdx((i) => (i + 1) % count); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, count]);

  if (!count) {
    return (
      <div className="card" style={{ aspectRatio: '4/3', overflow: 'hidden', position: 'relative' }}>
        <SmartImage src={null} alt={alt} />
      </div>
    );
  }
  const safeIdx = Math.min(idx, count - 1);
  const current = photos[safeIdx];

  return (
    <div>
      <button
        onClick={() => setZoom(true)}
        className="gallery-main"
        style={{ display: 'block', position: 'relative', width: '100%', padding: 0, border: 0, background: 'none', borderRadius: 'var(--r-md)', overflow: 'hidden', cursor: 'zoom-in' }}
        aria-label={t('Enlarge photograph')}
      >
        <div
          key={current.id}
          className="gallery-swap"
          style={{ aspectRatio: '4/3', borderRadius: 'var(--r-md)', overflow: 'hidden', border: '1px solid var(--border)' }}
        >
          <SmartImage src={current.file_path} fallback={current.remote_url} tint={current.tint} alt={alt} />
        </div>
        {current.credit && <span className="credit-overlay">{current.credit}</span>}
      </button>

      <div className="gallery-meta">
        {current.caption && <div className="tiny mute gallery-caption">{current.caption}</div>}
        <Credit photo={current} />
      </div>

      {count > 1 && (
        <div className="row row-wrap" style={{ gap: 7, marginTop: 9 }}>
          {photos.map((p, i) => (
            <button
              key={p.id}
              className="gallery-thumb"
              onClick={() => setIdx(i)}
              aria-label={t('Photograph {n}', { n: i + 1 })}
              aria-current={i === safeIdx}
              style={{
                width: 62, height: 48, padding: 0, borderRadius: 8, overflow: 'hidden',
                border: '2px solid ' + (i === safeIdx ? 'var(--accent)' : 'var(--border)'),
                background: 'var(--surface-3)', cursor: 'pointer',
              }}
            >
              <SmartImage src={p.thumbnail_path || p.file_path} fallback={p.remote_url} tint={p.tint} alt="" />
            </button>
          ))}
        </div>
      )}

      {zoom && (
        <Modal
          title={current.caption || alt}
          onClose={() => setZoom(false)}
          wide
          footer={count > 1 ? (
            <>
              <span className="tiny mute grow">{t('Photograph {n}', { n: `${safeIdx + 1} / ${count}` })}</span>
              <button type="button" className="btn btn-sm" onClick={() => setIdx((i) => (i - 1 + count) % count)}>
                <I.ChevronLeft /> {t('Previous')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setIdx((i) => (i + 1) % count)}>
                {t('Next')} <I.ChevronRight />
              </button>
            </>
          ) : undefined}
        >
          <SmartImage
            key={current.id}
            className="lightbox-img"
            src={current.file_path || current.remote_url}
            fallback={current.file_path ? current.remote_url : undefined}
            tint={current.tint}
            alt={alt}
            eager
          />
          <div style={{ marginTop: 10 }}><Credit photo={current} className="credit small" /></div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReportDialog({ plant, onClose }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ issue_type: 'wrong_name', description: '', reporter_name: '', reporter_email: '' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!form.description.trim()) { toast(t('Please describe what looks wrong.'), 'err'); return; }
    setBusy(true);
    try {
      await api.createReport({ plant_id: plant.id, ...form });
      toast(t('Thank you. A botanist will review your report.'));
      onClose();
    } catch (e) {
      toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      title={t('Report incorrect information')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy && <span className="spinner" />}{t('Send report')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' }}>
        <Notice kind="plain">
          {t('You are reporting {record}.', {
            record: <><strong>{plant.plant_code}</strong>{plant.scientific_name && <> &mdash; <span className="sci">{plant.scientific_name}</span></>}</>,
          })}
        </Notice>
        <div className="field">
          <label htmlFor="r-type">{t('What is wrong?')}</label>
          <select id="r-type" className="select" value={form.issue_type} onChange={(e) => setForm({ ...form, issue_type: e.target.value })}>
            <option value="wrong_name">{t('The species or name looks wrong')}</option>
            <option value="wrong_location">{t('The location is wrong')}</option>
            <option value="bad_photo">{t('The photograph is unclear or wrong')}</option>
            <option value="outdated">{t('The information is out of date')}</option>
            <option value="other">{t('Something else')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-desc">{t('Details')} <span className="req">*</span></label>
          <textarea
            id="r-desc" className="textarea" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t('Tell us what you saw and why you think the record is wrong.')}
          />
        </div>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="r-name">{t('Your name')} <span className="hint">({t('optional')})</span></label>
            <input id="r-name" className="input" value={form.reporter_name} onChange={(e) => setForm({ ...form, reporter_name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="r-email">{t('Email')} <span className="hint">({t('optional')})</span></label>
            <input id="r-email" type="email" className="input" value={form.reporter_email} onChange={(e) => setForm({ ...form, reporter_email: e.target.value })} />
          </div>
        </div>
        <div className="hint">{t('You do not need an account. We only use your email to ask a follow-up question.')}</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export default function PlantInfo({ byToken }) {
  const { id, token } = useParams();
  const { user, can, mobile } = useApp();
  const [plant, setPlant] = useState(null);
  const [error, setError] = useState(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    setPlant(null); setError(null);
    const p = byToken ? api.plantByToken(token) : api.plantById(id);
    p.then((r) => setPlant(r.plant)).catch((e) => setError(e));
  }, [byToken, id, token]);

  if (error) {
    const reason = error.body?.reason;
    return (
      <div className="page"><div className="wrap wrap-narrow">
        <Empty
          icon={reason === 'archived' ? I.Archive : I.Compass}
          title={reason === 'archived' ? t('This plant is no longer on display') : t('Tag not recognised')}
          action={<Link className="btn btn-primary" to="/browse">{t('Browse the register')}</Link>}
        >
          {reason === 'archived'
            ? <>{t('The record {code} has been archived by a botanist, usually because the specimen was removed. The tag stays accounted for in the register.', { code: error.body?.plant_code ? <span className="mono">{error.body.plant_code}</span> : '' })}</>
            : <>{t('This QR code does not match any plant in the register. It may be a tag from another system, or the record may not be published yet.')}</>}
        </Empty>
      </div></div>
    );
  }

  if (!plant) return <LoadingBlock label={t('Loading plant record')} />;

  const sp = plant.species || {};
  const name = plant.scientific_name || plant.proposed_species_name || t('Unidentified specimen');
  const meta = CONSERVATION[plant.conservation_code];

  const sections = [
    [t('Description'), sp.description],
    [t('Distinguishing characteristics'), sp.characteristics],
    [t('Leaves'), sp.leaf_description],
    [t('Flowers'), sp.flower_description],
    [t('Fruit'), sp.fruit_description],
    [t('Habitat'), sp.habitat],
    [t('Distribution'), sp.distribution],
  ].filter(([, v]) => v);

  // Everyday name on top for visitors; the scientific name sits right under it.
  const title = plant.common_name || plant.local_name || name;
  const bandPhoto = (plant.photos || []).map((p) => p.file_path).find((src) => isRealPhoto(src));

  return (
    <div className="plant-page">
      <ForestBand photo={bandPhoto} className="plant-band">
        <div className="wrap-narrow plant-band-in">
          {byToken && (
            <div className="row row-wrap" style={{ gap: 8 }}>
              <span className="badge badge-ok scan-pulse"><I.Check style={{ width: 12, height: 12 }} /> {t('Tag scanned')}</span>
              <span className="tiny plant-band-mist">{t('Verified record from the park register')}</span>
            </div>
          )}
          <div className="row row-wrap plant-band-tags">
            {plant.conservation_code && <ConservationBadge code={plant.conservation_code} />}
            {sp.growth_form && <span className="tag">{GROWTH_FORM[sp.growth_form] || titleCase(sp.growth_form)}</span>}
            {user && <StatusBadge status={plant.status} />}
          </div>
          <h1 className="display plant-title">{title}</h1>
          <div className="plant-band-sub">
            {title !== name && <span className={plant.scientific_name ? 'sci' : ''}>{name}</span>}
            {plant.common_name && plant.common_name !== title && <span>&middot; {plant.common_name}</span>}
            {plant.local_name && plant.local_name !== title && <span>&middot; {plant.local_name}</span>}
          </div>
          {!plant.location_protected && plant.site_name && (
            <div className="plant-band-site">
              <MarkerDot site={plant.site_name} />
              <span>{plant.site_name}</span>
            </div>
          )}
        </div>
      </ForestBand>

    <div className="page">
      <div className="wrap wrap-narrow">
        {plant.status !== 'approved' && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="warn" title={t('Not published')}>
              {t('This record is {status} and is not visible to the public. You can see it because you are signed in as staff.', { status: <strong>{STATUS[plant.status]?.label || plant.status}</strong> })}
            </Notice>
          </div>
        )}

        {plant.species_not_listed && (
          <div style={{ marginBottom: 18 }}>
            <Notice kind="warn" title={t('Species not yet confirmed')}>
              {t('A botanist recorded this specimen as {name}. The identification has not yet been confirmed.', { name: <>&ldquo;{plant.proposed_species_name}&rdquo;</> })}
            </Notice>
          </div>
        )}

        <div style={{ display: 'grid', gap: 22, gridTemplateColumns: mobile ? '1fr' : '1.15fr 1fr', alignItems: 'start' }}>
          <Gallery photos={plant.photos} alt={name} />

          <div className="stack" style={{ '--gap': '16px' }}>
            {/* Taxonomy */}
            <Reveal index={0}>
              <div className="card">
                <div className="card-head"><h3>{t('Classification')}</h3></div>
                <div className="card-body" style={{ paddingBlock: 6 }}>
                  <dl className="dl">
                    <dt>{t('Family')}</dt>
                    <dd>{sp.family ? <Link to={'/browse?family=' + encodeURIComponent(sp.family)}>{sp.family}</Link> : '--'}</dd>
                    <dt>{t('Genus')}</dt>
                    <dd>{sp.genus ? <Link className="sci" to={'/browse?genus=' + encodeURIComponent(sp.genus)}>{sp.genus}</Link> : '--'}</dd>
                    <dt>{t('Scientific name')}</dt>
                    <dd className="sci">{plant.scientific_name || '--'}</dd>
                    {plant.local_name && <><dt>{t('Local name')}</dt><dd>{plant.local_name}</dd></>}
                    <dt>{t('Conservation')}</dt>
                    <dd>{meta ? meta.label : t('Not evaluated')}</dd>
                  </dl>
                </div>
              </div>
            </Reveal>

            {/* This specimen */}
            <Reveal index={1}>
              <div className="card">
                <div className="card-head"><h3>{t('This specimen')}</h3></div>
                <div className="card-body" style={{ paddingBlock: 6 }}>
                  <dl className="dl">
                    <dt>{t('Plant ID')}</dt>
                    <dd className="mono">{plant.plant_code}</dd>
                    <dt>{t('Location')}</dt>
                    <dd>
                      {plant.location_protected
                        ? <span className="row" style={{ gap: 6 }}><I.Shield style={{ width: 14, height: 14, color: 'var(--warn-fg)' }} /> {t('Withheld')}</span>
                        : plant.site_name}
                    </dd>
                    {!plant.location_protected && coords(plant.latitude, plant.longitude) && (
                      <>
                        <dt>{t('Coordinates')}</dt>
                        <dd>
                          <span className="mono tiny">{coords(plant.latitude, plant.longitude)}</span>
                          <a
                            href={`https://www.google.com/maps?q=${plant.latitude},${plant.longitude}`}
                            target="_blank" rel="noreferrer"
                            className="tiny nowrap" style={{ marginLeft: 8 }}
                          >
                            {t('Open map')} <I.External style={{ width: 11, height: 11, display: 'inline' }} />
                          </a>
                        </dd>
                      </>
                    )}
                    {plant.height_m && <><dt>{t('Height')}</dt><dd>{measure(plant.height_m, 'm')}</dd></>}
                    {plant.trunk_diameter_cm && <><dt>{t('Trunk diameter')}</dt><dd>{measure(plant.trunk_diameter_cm, 'cm')}</dd></>}
                    {plant.life_stage && <><dt>{t('Life stage')}</dt><dd>{LIFE_STAGE[plant.life_stage]}</dd></>}
                    {plant.health_status && <><dt>{t('Condition')}</dt><dd>{HEALTH[plant.health_status]}</dd></>}
                    <dt>{t('Registered')}</dt>
                    <dd>{formatDate(plant.registered_at)}{plant.registered_by_name && <span className="mute"> {t('by {name}', { name: plant.registered_by_name })}</span>}</dd>
                    {plant.verified_at && (
                      <>
                        <dt>{t('Verified')}</dt>
                        <dd>{formatDate(plant.verified_at)}{plant.verified_by_name && <span className="mute"> {t('by {name}', { name: plant.verified_by_name })}</span>}</dd>
                      </>
                    )}
                  </dl>
                </div>
              </div>
            </Reveal>

            {!plant.location_protected && coords(plant.latitude, plant.longitude) && (
              <Reveal index={2}>
                <PlantMap plants={[plant]} single />
              </Reveal>
            )}

            {plant.location_protected && (
              <Notice kind="warn" title={t('Location withheld')}>
                {fromServer(plant.location_withheld_reason)}
                {' '}{t('Park staff can see it when signed in.')}
              </Notice>
            )}
            {plant.location_notes && (
              <div className="inset">
                <div className="label" style={{ marginBottom: 4 }}><I.MapPin style={{ width: 13, height: 13 }} /> {t('Finding it')}</div>
                <div className="small">{plant.location_notes}</div>
              </div>
            )}
            {plant.morphology_notes && (
              <div className="inset">
                <div className="label" style={{ marginBottom: 4 }}><I.Leaf style={{ width: 13, height: 13 }} /> {t('Field notes')}</div>
                <div className="small">{plant.morphology_notes}</div>
              </div>
            )}
          </div>
        </div>

        {/* Long-form species content */}
        {sections.length > 0 && (
          <Reveal index={3} style={{ marginTop: 22 }}>
            <div className="card card-pad">
              <div className="prose">
                {sections.map(([title, text]) => (
                  <div key={title}>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                ))}
              </div>
              {plant.species_id && (
                <div style={{ marginTop: 16 }}>
                  <Link className="btn btn-sm" to={'/species/' + plant.species_id}>
                    <I.Book /> All {sp.plant_count} specimen{sp.plant_count === 1 ? '' : 's'} of this species
                  </Link>
                </div>
              )}
            </div>
          </Reveal>
        )}

        {/* Footer actions */}
        <div className="row row-wrap row-between" style={{ marginTop: 24, gap: 12 }}>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setReporting(true)}>
              <I.Flag /> {t('Report incorrect information')}
            </button>
            <CopyButton text={window.location.href} label={t('Copy link')} />
            {user && can('plant.view_all') && (
              <Link className="btn btn-sm btn-soft" to={'/staff/plants/' + plant.id}>
                <I.Edit /> {t('Open in staff view')}
              </Link>
            )}
          </div>
          <div className="tiny faint row" style={{ gap: 12 }}>
            {plant.view_count > 0 && <span><I.Eye style={{ width: 12, height: 12, display: 'inline', verticalAlign: -2 }} /> {num(plant.view_count)} views</span>}
            {plant.scan_count > 0 && <span><I.Scan style={{ width: 12, height: 12, display: 'inline', verticalAlign: -2 }} /> {num(plant.scan_count)} scans</span>}
          </div>
        </div>


      </div>

      {reporting && <ReportDialog plant={plant} onClose={() => setReporting(false)} />}
    </div>
    </div>
  );
}
