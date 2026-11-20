import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import {
  ConfirmButton, ConservationBadge, CopyButton, Empty, LoadingBlock, Modal, Notice,
  PageHead, StatusBadge,
} from '../../components/ui.jsx';
import { SmartImage } from '../../components/motion.jsx';
import PlantEditDialog from '../../components/PlantEdit.jsx';
import { CONSERVATION, GROWTH_FORM, HEALTH, LIFE_STAGE, coords, formatDateTime, relativeTime, titleCase } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { t } from '../../lib/i18n.js';

/* ------------------------------------------------------------------ */

function QrPanel({ plant }) {
  const [qr, setQr] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setQr(null); setError(null);
    api.qr(plant.id).then(setQr).catch((e) => setError(e.message));
  }, [plant.id, plant.status]);

  if (error) return <Notice kind="warn" title={t('No tag yet')}>{error}</Notice>;
  if (!qr) return <LoadingBlock label={t('Generating tag')} />;

  const download = () => {
    const a = document.createElement('a');
    a.href = qr.png;
    a.download = plant.plant_code + '-qr.png';
    a.click();
  };

  return (
    <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', alignItems: 'start' }}>
      <div>
        <div className="qr-card">
          <img src={qr.png} alt={t('QR code for {code}', { code: plant.plant_code })} />
          <div className="tiny mono" style={{ wordBreak: 'break-all', textAlign: 'center', color: '#4a5a4c' }}>{qr.target_url}</div>
        </div>
        <div className="row row-wrap" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" onClick={download}><I.Download /> {t('Download PNG')}</button>
          <button className="btn btn-sm" onClick={() => window.print()}><I.Printer /> {t('Print tag')}</button>
          <CopyButton text={qr.target_url} label={t('Copy URL')} />
        </div>
      </div>

      <div className="stack" style={{ '--gap': '14px' }}>
        <div>
          <div className="label no-print" style={{ marginBottom: 6 }}>{t('Printable tag preview')}</div>
          <div className="print-region print-one">
            <div className="qr-tag">
              <img src={qr.png} alt="" style={{ width: 130, margin: '0 auto 8px' }} />
              <div className="t-sci">{qr.scientific_name || plant.proposed_species_name}</div>
              {qr.common_name && <div className="t-com">{qr.common_name}</div>}
              {plant.local_name && <div className="t-com" style={{ opacity: 0.75 }}>{plant.local_name}</div>}
              <div className="t-code">{plant.plant_code}</div>
              <div className="t-foot">{t('Scan for details · Niah National Park')}</div>
            </div>
          </div>
        </div>

        <dl className="dl small">
          <dt>{t('Token')}</dt><dd className="mono tiny" style={{ wordBreak: 'break-all' }}>{qr.qr_token}</dd>
          <dt>{t('Tag status')}</dt><dd style={{ textTransform: 'capitalize' }}>{qr.status}</dd>
          <dt>{t('Version')}</dt><dd>{qr.version}</dd>
          <dt>{t('Scans')}</dt><dd>{qr.scans}</dd>
        </dl>

        <Notice kind="plain">
          {t('The tag encodes an opaque token, never the database id, so the register cannot be enumerated by editing the URL. Editing the record does not change the token, so a printed tag stays valid.')}
        </Notice>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * `version` bumps every time the parent reloads the record, so an edit made
 * while this tab is already open shows up without switching tabs.
 */
function HistoryPanel({ plantId, version }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    api.history(plantId)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ revisions: [], audits: [] }));
    return () => { live = false; };
  }, [plantId, version]);
  if (!data) return <LoadingBlock label={t('Loading history')} />;

  const merged = [
    ...data.audits.map((a) => ({ kind: 'audit', at: a.created_at, who: a.user_name, action: a.action, a })),
    ...data.revisions.map((r) => ({ kind: 'rev', at: r.created_at, who: r.changed_by_name, r })),
  ].sort((x, y) => new Date(y.at) - new Date(x.at));

  if (!merged.length) return <Empty icon={I.Clock} title={t('No changes recorded yet')} />;

  return (
    <div className="timeline">
      {merged.map((m, i) => (
        <div key={i} className={'tl-item' + (m.kind === 'audit' && ['approve', 'reject'].includes(m.action) ? ' accent' : '')}>
          <div className="small">
            <strong>{m.who}</strong>{' '}
            {m.kind === 'audit'
              ? <>{{ create: t('registered the record'), approve: t('approved and published it'), reject: t('returned it with a note'), archive: t('archived it'), update: t('updated the record') }[m.action] || m.action}</>
              : <>{t('changed {field}', { field: <span className="mono tiny">{m.r.field_name}</span> })}</>}
          </div>
          {m.kind === 'rev' && (
            <div className="tl-diff">
              <span className="tl-old">{m.r.old_value || t('empty')}</span>
              <I.ChevronRight style={{ width: 12, height: 12, color: 'var(--text-faint)' }} />
              <span className="tl-new">{m.r.new_value || t('empty')}</span>
            </div>
          )}
          {m.kind === 'rev' && m.r.change_reason && <div className="tiny mute" style={{ marginTop: 2 }}>{m.r.change_reason}</div>}
          <div className="tl-time">{formatDateTime(m.at)} &middot; {relativeTime(m.at)}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Sending a returned record back to the reviewer. The note is optional; it
 * is shown beside the reviewer's original comment so they can see what was
 * done about it.
 */
function ResubmitDialog({ plant, onClose, onDone }) {
  const { toast } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await api.resubmit(plant.id, note.trim());
      toast(t('{code} sent back for review.', { code: plant.plant_code }));
      await onDone();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={t('Resubmit {code} for review', { code: plant.plant_code })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={send} disabled={busy}>
            {busy && <span className="spinner" />}{t('Resubmit')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' }}>
        {plant.review_comment && (
          <Notice kind="warn" title={t('The reviewer asked for')}>{plant.review_comment}</Notice>
        )}
        <div className="field">
          <label htmlFor="resub-note">{t('What did you change?')} <span className="hint">({t('optional')})</span></label>
          <textarea
            id="resub-note" className="textarea" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={t('Re-photographed the fruit and bark slash on 12 October.')}
          />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export default function PlantDetail() {
  const { id } = useParams();
  const { can, toast, refreshCounts, user } = useApp();
  const navigate = useNavigate();
  const [plant, setPlant] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState('details');
  const [editing, setEditing] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped on every reload so child panels holding their own data refetch.
  const [version, setVersion] = useState(0);

  const load = () => api.plantById(id)
    .then((r) => { setPlant(r.plant); setVersion((v) => v + 1); })
    .catch(() => setMissing(true));
  useEffect(() => { setPlant(null); setMissing(false); load(); }, [id]);

  if (missing) {
    return (
      <div className="page"><div className="wrap wrap-narrow">
        <Empty icon={I.Leaf} title={t('Record not found')} action={<Link className="btn" to="/staff/plants">{t('Back to the register')}</Link>}>
          {t('It may have been removed, or your role may not be allowed to see it.')}
        </Empty>
      </div></div>
    );
  }
  if (!plant) return <LoadingBlock label={t('Loading record')} />;

  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); await load(); await refreshCounts(); toast(msg); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const sp = plant.species || {};
  const own = plant.registered_by === user?.id;

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 1060 }}>
        <PageHead
          back={{ to: '/staff/plants', label: t('Plant register') }}
          title={<span className={plant.scientific_name ? 'sci' : ''}>{plant.scientific_name || plant.proposed_species_name}</span>}
          sub={<><span className="mono">{plant.plant_code}</span> &middot; {plant.site_name}</>}
        >
          <StatusBadge status={plant.status} />
          {plant.conservation_code && <ConservationBadge code={plant.conservation_code} />}
        </PageHead>

        {/* Action bar */}
        <div className="card card-pad row row-wrap" style={{ gap: 9, marginBottom: 18 }}>
          {plant.status === 'approved' && plant.qr_token && (
            <Link className="btn btn-sm" to={'/p/' + plant.qr_token}><I.External /> {t('View public page')}</Link>
          )}
          {can('plant.edit') && (
            <button className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy}><I.Edit /> {t('Edit')}</button>
          )}
          <span className="spacer" />
          {can('plant.approve') && plant.status === 'pending' && !own && (
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || plant.species_not_listed}
              title={plant.species_not_listed ? t('Set the species first, with Edit or from the review queue') : undefined}
              onClick={() => act(() => api.approve(plant.id), t('{code} published.', { code: plant.plant_code }))}
            >
              <I.Check /> {t('Approve and publish')}
            </button>
          )}
          {plant.status === 'rejected' && can('plant.create') && (own || can('plant.edit')) && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => setResubmitting(true)}>
              <I.Refresh /> {t('Resubmit for review')}
            </button>
          )}
          {can('plant.archive') && plant.status === 'approved' && (
            <ConfirmButton
              className="btn btn-sm btn-danger"
              icon={I.Archive}
              label={t('Archive')}
              title={t('Archive {code}?', { code: plant.plant_code })}
              confirmLabel={t('Archive record')}
              body={
                <Notice kind="warn" title={t('The record is kept, not deleted')}>
                  {t('It drops off the public site and its QR tag is withdrawn, so a scan shows “no longer on display”. The audit trail and printed tags stay accounted for, and you can restore it later.')}
                </Notice>
              }
              onConfirm={() => act(() => api.archive(plant.id, 'Archived from the staff record'), t('{code} archived.', { code: plant.plant_code }))}
            />
          )}
          {can('plant.archive') && plant.status === 'archived' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api.restore(plant.id), t('{code} restored to public view.', { code: plant.plant_code }))}>
              <I.Refresh /> {t('Restore to public view')}
            </button>
          )}
        </div>

        {plant.review_comment && (
          <div style={{ marginBottom: 18 }}>
            <Notice kind="warn" title={t('Returned by the reviewer with this note')}>
              {plant.review_comment}
              {can('plant.edit') && (
                <div className="tiny" style={{ marginTop: 6 }}>
                  {t('Make the changes with Edit, then resubmit it for review.')}
                </div>
              )}
            </Notice>
          </div>
        )}

        <div className="tabs" style={{ marginBottom: 18 }}>
          {[['details', t('Details')], ['photos', t('Photographs')], ['qr', t('QR tag')], ['history', t('History')]].map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {l}{k === 'photos' && plant.photo_count > 0 && <span className="count">{plant.photo_count}</span>}
            </button>
          ))}
        </div>

        {tab === 'details' && (
          <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 290px), 1fr))', alignItems: 'start' }}>
            <div className="card">
              <div className="card-head"><h3>{t('Specimen')}</h3></div>
              <div className="card-body" style={{ paddingBlock: 6 }}>
                <dl className="dl">
                  <dt>{t('Plant ID')}</dt><dd className="mono">{plant.plant_code}</dd>
                  <dt>{t('Status')}</dt><dd><StatusBadge status={plant.status} /></dd>
                  <dt>{t('Site')}</dt><dd>{plant.site_name}</dd>
                  {coords(plant.latitude, plant.longitude) && <><dt>{t('Coordinates')}</dt><dd className="mono tiny">{coords(plant.latitude, plant.longitude)}</dd></>}
                  {plant.gps_accuracy_m && <><dt>{t('GPS accuracy')}</dt><dd>&plusmn;{plant.gps_accuracy_m} m</dd></>}
                  {plant.height_m && <><dt>{t('Height')}</dt><dd>{plant.height_m} m</dd></>}
                  {plant.trunk_diameter_cm && <><dt>{t('Trunk diameter')}</dt><dd>{plant.trunk_diameter_cm} cm</dd></>}
                  {plant.life_stage && <><dt>{t('Life stage')}</dt><dd>{LIFE_STAGE[plant.life_stage]}</dd></>}
                  {plant.health_status && <><dt>{t('Condition')}</dt><dd>{HEALTH[plant.health_status]}</dd></>}
                  <dt>{t('Registered')}</dt><dd>{formatDateTime(plant.registered_at)}<div className="tiny mute">{plant.registered_by_name}</div></dd>
                  {plant.verified_at && <><dt>{t('Verified')}</dt><dd>{formatDateTime(plant.verified_at)}<div className="tiny mute">{plant.verified_by_name}</div></dd></>}
                  <dt>{t('Public views')}</dt><dd>{plant.view_count}</dd>
                  <dt>{t('Tag scans')}</dt><dd>{plant.scan_count ?? 0}</dd>
                </dl>
              </div>
            </div>

            <div className="stack" style={{ '--gap': '18px' }}>
              <div className="card">
                <div className="card-head">
                  <h3 className="grow">{t('Species')}</h3>
                  {plant.species_id && <Link className="btn btn-sm btn-ghost" to={'/species/' + plant.species_id}>{t('Open')} <I.ChevronRight /></Link>}
                </div>
                <div className="card-body" style={{ paddingBlock: 6 }}>
                  {plant.species_not_listed ? (
                    <Notice kind="warn" title={t('Species not confirmed')}>
                      {t('Recorded in the field as {name}. A species must be set - with Edit, or by the reviewer - before this can be published.', {
                        name: <>&ldquo;{plant.proposed_species_name}&rdquo;</>,
                      })}
                    </Notice>
                  ) : (
                    <dl className="dl">
                      <dt>{t('Scientific name')}</dt><dd className="sci">{plant.scientific_name}</dd>
                      <dt>{t('Common name')}</dt><dd>{plant.common_name || '--'}</dd>
                      <dt>{t('Local name')}</dt><dd>{plant.local_name || '--'}</dd>
                      <dt>{t('Family')}</dt><dd>{plant.family || '--'}</dd>
                      <dt>{t('Genus')}</dt><dd className="sci">{plant.genus || '--'}</dd>
                      <dt>{t('Growth form')}</dt><dd>{plant.growth_form ? (GROWTH_FORM[plant.growth_form] || titleCase(plant.growth_form)) : '--'}</dd>
                      <dt>{t('Conservation')}</dt><dd>{CONSERVATION[plant.conservation_code]?.label || plant.conservation_label || t('Not evaluated')}</dd>
                    </dl>
                  )}
                </div>
              </div>

              {plant.location_notes && (
                <div className="inset"><div className="label" style={{ marginBottom: 4 }}>{t('How to find it')}</div><div className="small">{plant.location_notes}</div></div>
              )}
              {plant.morphology_notes && (
                <div className="inset"><div className="label" style={{ marginBottom: 4 }}>{t('Field notes')}</div><div className="small">{plant.morphology_notes}</div></div>
              )}
              {plant.notes && (
                <div className="inset" style={{ borderColor: 'var(--warn-br)', background: 'var(--warn-bg)' }}>
                  <div className="label" style={{ marginBottom: 4 }}>{t('Internal notes (staff only)')}</div>
                  <div className="small">{plant.notes}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'photos' && (
          plant.photos?.length ? (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))' }}>
              {plant.photos.map((p) => (
                <div className="card" key={p.id} style={{ overflow: 'hidden' }}>
                  <div style={{ aspectRatio: '4/3', background: 'var(--surface-3)' }}>
                    <SmartImage
                      src={p.file_path || p.remote_url}
                      fallback={p.file_path ? p.remote_url : undefined}
                      tint={p.tint}
                      alt={p.caption || ''}
                    />
                  </div>
                  <div style={{ padding: 11 }}>
                    {p.is_primary ? <span className="badge badge-ok" style={{ marginBottom: 5 }}>{t('Main image')}</span> : null}
                    <div className="small">{p.caption || p.file_name}</div>
                    <div className="tiny faint" style={{ marginTop: 3 }}>{p.width_px ? `${p.width_px}×${p.height_px} · ` : ''}{p.mime_type}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty icon={I.Image} title={t('No photographs on this record')} />
        )}

        {tab === 'qr' && (
          plant.status === 'approved' || plant.qr_token
            ? <QrPanel plant={plant} />
            : (
              <Notice kind="info" title={t('No tag yet')}>
                {t('A QR code is issued automatically the moment the record is published. Approve it first and the tag appears here, ready to download and print.')}
              </Notice>
            )
        )}

        {tab === 'history' && <HistoryPanel plantId={plant.id} version={version} />}
      </div>

      {editing && <PlantEditDialog plant={plant} onClose={() => setEditing(false)} onSaved={load} />}
      {resubmitting && (
        <ResubmitDialog
          plant={plant}
          onClose={() => setResubmitting(false)}
          onDone={async () => { await load(); await refreshCounts(); }}
        />
      )}
    </div>
  );
}
