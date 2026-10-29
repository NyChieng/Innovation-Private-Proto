import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import {
  Avatar, ConservationBadge, Empty, LoadingBlock, Modal, Notice, PageHead, SearchInput, StatusBadge,
} from '../../components/ui.jsx';
import PlantEditDialog from '../../components/PlantEdit.jsx';
import { HEALTH, LIFE_STAGE, coords, formatDateTime, relativeTime } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import * as I from '../../lib/icons.jsx';

/**
 * The reviewer's queue (issues #6 and #8).
 *
 * Every record a botanist registers lands here, and a reviewer - a second
 * person - publishes it or returns it. Corrections no longer mean a round
 * trip: the reviewer can fix the species, the location or a measurement in
 * place, and the change is recorded against them in the history.
 */

/* ------------------------------------------------------------------ */

function RejectDialog({ plant, onClose, onDone }) {
  const { toast, refreshCounts } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const PRESETS = [
    t('Photographs do not show the diagnostic features. Please re-photograph the leaf underside and the bark slash.'),
    t('This duplicates an existing published record at the same location.'),
    t('The GPS position does not match the described site. Please confirm on the ground.'),
    t('The identification cannot be confirmed from what was submitted. Please collect a fertile specimen.'),
  ];

  const submit = async () => {
    if (!note.trim()) { toast(t('A note is required so the botanist knows what to change.'), 'err'); return; }
    setBusy(true);
    try {
      await api.reject(plant.id, note.trim());
      await refreshCounts();
      toast(t('{code} returned to the botanist.', { code: plant.plant_code }));
      onDone();
      onClose();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={t('Return {code} with a note', { code: plant.plant_code })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-danger" onClick={submit} disabled={busy}>
            {busy && <span className="spinner" />}{t('Return to botanist')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' }}>
        <Notice kind="plain">
          {t('The record stays in the register with the status returned, and {name} is notified with your note. Nothing is deleted. If only a detail is wrong, correcting it yourself is quicker.', {
            name: plant.registered_by_name || t('the botanist'),
          })}
        </Notice>
        <div className="field">
          <label htmlFor="note">{t('Note')} <span className="req">*</span></label>
          <textarea
            id="note" className="textarea" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)}
            placeholder={t('Explain what needs to change before this can be published.')}
          />
        </div>
        <div>
          <div className="hint" style={{ marginBottom: 6 }}>{t('Common reasons')}</div>
          <div className="row row-wrap" style={{ gap: 6 }}>
            {PRESETS.map((p, i) => (
              <button key={i} type="button" className="chip" onClick={() => setNote(p)} title={p}>
                <span className="truncate" style={{ maxWidth: '30ch' }}>{p}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/** What was decided last time, and what the botanist said when resubmitting. */
function PreviousRound({ plant, sub }) {
  const prev = plant.previous_return;
  if (!prev) return null;
  let reply = null;
  try {
    const pc = typeof sub.proposed_changes === 'string' ? JSON.parse(sub.proposed_changes) : sub.proposed_changes;
    reply = pc?.resubmission_note || null;
  } catch { /* not JSON - ignore */ }
  return (
    <div className="review-history" style={{ marginTop: 12 }}>
      <Notice kind="warn" title={t('Returned {when} with this note', { when: relativeTime(prev.reviewed_at) })}>
        {prev.review_comment}
      </Notice>
      {reply && (
        <Notice kind="info" title={t('The botanist replied when resubmitting')}>{reply}</Notice>
      )}
    </div>
  );
}

function SubmissionCard({ sub, onChanged }) {
  const { toast, refreshCounts, user } = useApp();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(null);
  const p = sub.plant;
  if (!p) return null;

  const waiting = sub.status === 'pending' && p.status === 'pending';
  const own = sub.submitted_by === user?.id || p.registered_by === user?.id;

  const approve = async () => {
    setBusy(true);
    try {
      await api.approve(p.id);
      await refreshCounts();
      toast(t('{code} published. QR tag issued.', { code: p.plant_code }));
      onChanged();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Avatar name={sub.submitted_by_name} role="botanist" size="sm" />
        <div className="grow" style={{ minWidth: 160 }}>
          <div className="small">
            {t('{name} submitted {code}', { name: <strong>{sub.submitted_by_name}</strong>, code: <span className="mono tiny">{p.plant_code}</span> })}
          </div>
          <div className="tiny mute">{relativeTime(sub.submitted_at)} &middot; {formatDateTime(sub.submitted_at)}</div>
        </div>
        {p.previous_return && waiting && <span className="badge badge-info">{t('Resubmitted')}</span>}
        {p.species_not_listed && <span className="badge badge-info">{t('Species not listed')}</span>}
        <StatusBadge status={waiting ? 'pending' : sub.status} />
      </div>

      <div className="card-body">
        <div className="review-grid">
          <div>
            <div style={{ aspectRatio: '4/3', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface-3)', border: '1px solid var(--border)' }}>
              {p.photo
                ? <img src={p.photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><I.Image style={{ width: 26, height: 26, color: 'var(--text-faint)' }} /></div>}
            </div>
            {p.photo_count > 1 && <div className="tiny mute" style={{ marginTop: 6 }}>{t('{n} photographs', { n: p.photo_count })}</div>}
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row row-wrap" style={{ gap: 8, marginBottom: 6 }}>
              {p.conservation_code && <ConservationBadge code={p.conservation_code} />}
            </div>
            <div className={p.scientific_name ? 'sci' : ''} style={{ fontSize: '1.12rem', fontWeight: 620, overflowWrap: 'anywhere' }}>
              {p.scientific_name || p.proposed_species_name}
            </div>
            {p.common_name && <div className="small mute">{p.common_name}</div>}

            <dl className="dl small" style={{ marginTop: 12 }}>
              <dt>{t('Location')}</dt><dd>{p.site_name}</dd>
              {coords(p.latitude, p.longitude) && <><dt>{t('Coordinates')}</dt><dd className="mono tiny">{coords(p.latitude, p.longitude)} {p.gps_accuracy_m && <span className="mute">&plusmn;{p.gps_accuracy_m} m</span>}</dd></>}
              {p.height_m && <><dt>{t('Height')}</dt><dd>{p.height_m} m</dd></>}
              {p.trunk_diameter_cm && <><dt>{t('Trunk diameter')}</dt><dd>{p.trunk_diameter_cm} cm</dd></>}
              {p.life_stage && <><dt>{t('Life stage')}</dt><dd>{LIFE_STAGE[p.life_stage]}</dd></>}
              {p.health_status && <><dt>{t('Condition')}</dt><dd>{HEALTH[p.health_status]}</dd></>}
            </dl>

            {p.morphology_notes && (
              <div className="inset small" style={{ marginTop: 12 }}>
                <div className="label" style={{ marginBottom: 3 }}>{t('Botanist field notes')}</div>
                {p.morphology_notes}
              </div>
            )}

            {waiting && <PreviousRound plant={p} sub={sub} />}

            {waiting && p.species_not_listed && (
              <div style={{ marginTop: 12 }}>
                <Notice kind="warn" title={t('Needs a species before it can be published')}>
                  {t('The API refuses to approve a record with no species, so Approve stays disabled until you set one.')}
                </Notice>
              </div>
            )}

            {!waiting && (
              <div style={{ marginTop: 12 }}>
                <Notice
                  kind={sub.status === 'approved' ? 'ok' : 'warn'}
                  title={sub.status === 'approved'
                    ? t('Approved by {name} · {when}', { name: sub.reviewed_by_name || '--', when: formatDateTime(sub.reviewed_at) })
                    : t('Returned by {name} · {when}', { name: sub.reviewed_by_name || '--', when: formatDateTime(sub.reviewed_at) })}
                >
                  {sub.review_comment || (sub.status === 'approved' ? t('Published with no note.') : null)}
                </Notice>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card-foot row row-wrap" style={{ gap: 9 }}>
        <Link className="btn btn-sm" to={'/staff/plants/' + p.id}><I.Eye /> {t('Open full record')}</Link>
        <span className="spacer" />
        {waiting && own && (
          <span className="tiny mute">{t('You submitted this, so another reviewer must decide on it.')}</span>
        )}
        {waiting && !own && (
          <>
            <button className="btn btn-sm btn-soft" onClick={() => setEditing(p.species_not_listed ? 'species' : 'all')} disabled={busy}>
              {p.species_not_listed ? <><I.Book /> {t('Set species')}</> : <><I.Edit /> {t('Correct details')}</>}
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setRejecting(true)} disabled={busy}>
              <I.X /> {t('Return with a note')}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={approve}
              disabled={busy || p.species_not_listed}
              title={p.species_not_listed ? t('Confirm the species first') : t('Publish this record and issue its QR tag')}
            >
              {busy ? <span className="spinner" /> : <I.Check />} {t('Approve and publish')}
            </button>
          </>
        )}
      </div>

      {rejecting && <RejectDialog plant={p} onClose={() => setRejecting(false)} onDone={onChanged} />}
      {editing && (
        <PlantEditDialog review plant={p} focus={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function ReviewQueue() {
  const [tab, setTab] = useState('pending');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  const load = () => {
    setLoading(true);
    api.submissions({ status: tab })
      .then((r) => { setData(r); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [tab]);

  // Oldest first while waiting - first come, first reviewed. Newest first
  // once decided, which is the order anyone looking back wants.
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    const rows = (data?.results || []).filter((s) => !n || [
      s.plant?.plant_code, s.plant?.scientific_name, s.plant?.proposed_species_name,
      s.plant?.site_name, s.submitted_by_name,
    ].filter(Boolean).join(' ').toLowerCase().includes(n));
    return tab === 'pending' ? rows : [...rows].reverse();
  }, [data, q, tab]);

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 1060 }}>
        <PageHead
          title={t('Review queue')}
          sub={t('Every plant a botanist registers waits here until a reviewer checks it. Correct what is wrong, then approve it - which issues the QR tag - or return it with a note.')}
        />

        <div className="row row-wrap" style={{ gap: 12, marginBottom: 18 }}>
          {/* minWidth 0, or the flex row lets the tabs grow past the screen
              instead of scrolling - which the longer Malay labels do at 360px. */}
          <div className="tabs grow" style={{ marginBottom: 0, minWidth: 0 }}>
            {[['pending', t('Awaiting review')], ['approved', t('Approved')], ['rejected', t('Returned')], ['all', t('All')]].map(([k, l]) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <div style={{ flex: '1 1 220px', maxWidth: 320 }}>
            <SearchInput value={q} onChange={setQ} placeholder={t('Filter by code, species, site or botanist')} />
          </div>
        </div>

        {loading && !data && <LoadingBlock label={t('Loading the queue')} />}

        {data && shown.length === 0 && (
          <Empty icon={I.CheckCircle} title={q ? t('Nothing matches that filter') : tab === 'pending' ? t('The queue is clear') : t('Nothing here')}>
            {q
              ? t('Try a plant code, a species or a site name.')
              : tab === 'pending'
                ? t('Every botanist submission has been reviewed. New ones appear here as they arrive, and you get a notification.')
                : t('No submissions with that status.')}
          </Empty>
        )}

        {shown.map((s) => <SubmissionCard key={s.id} sub={s} onChanged={load} />)}
      </div>
    </div>
  );
}
