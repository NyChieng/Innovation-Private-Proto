import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Empty, LoadingBlock, Notice, PageHead, StatusBadge } from '../../components/ui.jsx';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { msg, t } from '../../lib/i18n.js';
import { SmartImage } from '../../components/motion.jsx';

const STEPS = [
  { key: 'submitted', label: msg('Submitted') },
  { key: 'review', label: msg('Reviewer check') },
  { key: 'done', label: msg('Published') },
];

function Track({ status }) {
  const at = status === 'pending' ? 1 : 2;
  return (
    <div className="row" style={{ gap: 0, marginTop: 10 }}>
      {STEPS.map((s, i) => {
        const done = i < at || (i === 2 && status === 'approved');
        const current = i === at && status === 'pending';
        const failed = i === 2 && status === 'rejected';
        return (
          <div key={s.key} className="row grow" style={{ gap: 7, minWidth: 0 }}>
            <span
              style={{
                width: 16, height: 16, borderRadius: 99, flex: 'none', display: 'grid', placeItems: 'center',
                background: failed ? 'var(--danger-fg)' : done ? 'var(--accent)' : 'var(--surface-3)',
                border: current ? '2px solid var(--accent)' : '1px solid var(--border)',
                color: '#fff',
              }}
            >
              {failed ? <I.X style={{ width: 9, height: 9 }} /> : done ? <I.Check style={{ width: 9, height: 9 }} /> : null}
            </span>
            <span className="tiny truncate" style={{ color: done || current ? 'var(--text)' : 'var(--text-faint)', fontWeight: current ? 640 : 500 }}>
              {failed && i === 2 ? t('Returned') : t(s.label)}
            </span>
            {i < STEPS.length - 1 && (
              <span className="grow" style={{ height: 1, background: i < at ? 'var(--accent)' : 'var(--border)', minWidth: 14 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function MySubmissions() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.submissions({ status: 'all', mine: '1' }).then(setData).catch(() => setData({ results: [] }));
  }, []);

  if (!data) return <LoadingBlock label={t('Loading your submissions')} />;

  const pending = data.results.filter((s) => s.status === 'pending');
  const done = data.results.filter((s) => s.status !== 'pending');

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 940 }}>
        <PageHead
          title={t('My submissions')}
          sub={t('What happened to the records you sent for review.')}
        >
          <Link className="btn btn-primary" to="/staff/register"><I.Plus /> {t('Register a plant')}</Link>
        </PageHead>

        {data.results.length === 0 && (
          <Empty
            icon={I.Clock}
            title={t('You have not submitted anything yet')}
            action={<Link className="btn btn-primary" to="/staff/register"><I.Plus /> {t('Register your first plant')}</Link>}
          >
            {t('Records you register appear here so you can follow them through review.')}
          </Empty>
        )}

        {pending.length > 0 && (
          <>
            <h2 style={{ fontSize: '1rem', marginBottom: 10 }}>{t('Waiting for a reviewer ({n})', { n: pending.length })}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, marginBottom: 26 }}>
              {pending.map((s) => <Card key={s.id} sub={s} />)}
            </div>
          </>
        )}

        {done.length > 0 && (
          <>
            <h2 style={{ fontSize: '1rem', marginBottom: 10 }}>{t('Reviewed ({n})', { n: done.length })}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
              {done.map((s) => <Card key={s.id} sub={s} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ sub }) {
  const p = sub.plant;
  return (
    <div className="card card-pad">
      <div className="row row-wrap" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div style={{ width: 74, height: 58, borderRadius: 8, overflow: 'hidden', background: 'var(--surface-3)', flex: 'none', border: '1px solid var(--border)' }}>
          <SmartImage src={p.photo} fallback={p.photo_remote} alt="" placeholderLabel={false} />
        </div>
        <div className="grow" style={{ minWidth: 150 }}>
          <div className="row row-wrap" style={{ gap: 8, marginBottom: 3 }}>
            <StatusBadge status={p.status} />
            {p.species_not_listed && <span className="badge badge-info">{t('Species not listed')}</span>}
          </div>
          <div className={p.scientific_name ? 'sci strong' : 'strong'}>{p.scientific_name || p.proposed_species_name}</div>
          <div className="tiny mute">
            <span className="mono">{p.plant_code}</span> &middot; {p.site_name} &middot; {t('submitted {when}', { when: relativeTime(sub.submitted_at) })}
          </div>
          <Track status={sub.status} />
        </div>
        <Link className="btn btn-sm" to={'/staff/plants/' + p.id}><I.Eye /> {t('Open')}</Link>
      </div>

      {sub.status === 'rejected' && sub.review_comment && (
        <div style={{ marginTop: 14 }}>
          <Notice kind="warn" title={t('Returned by {name} · {when}', { name: sub.reviewed_by_name || '--', when: formatDateTime(sub.reviewed_at) })}>
            {sub.review_comment}
            <div style={{ marginTop: 8 }}>
              {p.status === 'rejected'
                ? <Link className="btn btn-sm" to={'/staff/plants/' + p.id}><I.Edit /> {t('Fix and resubmit')}</Link>
                : <span className="tiny mute">{t('You resubmitted this record after the changes.')}</span>}
            </div>
          </Notice>
        </div>
      )}
      {sub.status === 'approved' && (
        <div style={{ marginTop: 14 }}>
          <Notice kind="ok" title={t('Published by {name}', { name: sub.reviewed_by_name || t('a reviewer') })}>
            {t('The record is live on the public site and its QR tag can be printed.')}
            {p.qr_token && <> <Link to={'/p/' + p.qr_token}>{t('Open the public page')}</Link>.</>}
          </Notice>
        </div>
      )}
    </div>
  );
}
