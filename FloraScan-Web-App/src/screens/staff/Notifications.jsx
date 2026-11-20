import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import { Empty, LoadingBlock, PageHead } from '../../components/ui.jsx';
import AuthImage from '../../components/AuthImage.jsx';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { msg, t } from '../../lib/i18n.js';

const TYPES = {
  'submission.new': { icon: I.Clock, cls: 'badge-warn', label: msg('New submission') },
  'submission.approved': { icon: I.CheckCircle, cls: 'badge-ok', label: msg('Approved') },
  'submission.rejected': { icon: I.XCircle, cls: 'badge-danger', label: msg('Returned') },
  'report.new': { icon: I.Flag, cls: 'badge-info', label: msg('Visitor report') },
  'sensor.alert': { icon: I.Alert, cls: 'badge-danger', label: msg('Sensor alert') },
  'camera.alert': { icon: I.Alert, cls: 'badge-danger', label: msg('Camera alert') },
};

/**
 * Notification titles are written by the server in English, in a handful of
 * fixed shapes. Those are translated here; anything else shows as written.
 */
const TITLES = [
  [/^New submission awaiting review$/, () => t('New submission awaiting review')],
  [/^Resubmitted for review$/, () => t('Resubmitted for review')],
  [/^Visitor reported incorrect information$/, () => t('Visitor reported incorrect information')],
  [/^Submission published(?:: (.+))?$/, (code) => (code ? t('Submission published: {code}', { code }) : t('Submission published'))],
  [/^Submission returned: (.+)$/, (code) => t('Submission returned: {code}', { code })],
  [/^Submission withdrawn: (.+)$/, (code) => t('Submission withdrawn: {code}', { code })],
  [/^Sensor alert: (.+)$/, (code) => t('Sensor alert: {code}', { code })],
  [/^Camera alert: (.+)$/, (code) => t('Camera alert: {code}', { code })],
];

function noticeTitle(title) {
  for (const [re, fn] of TITLES) {
    const m = re.exec(title || '');
    if (m) return fn(m[1]);
  }
  return title;
}

export default function Notifications() {
  const { refreshCounts, toast, can } = useApp();
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  const load = () => api.notifications().then(setData).catch(() => setData({ results: [], unread: 0 }));
  useEffect(() => { load(); }, []);

  const open = async (n) => {
    if (!n.is_read) {
      try { await api.readNotification(n.id); await refreshCounts(); } catch { /* non-fatal */ }
    }
    if (n.related_type === 'plant' && n.related_id) navigate('/staff/plants/' + n.related_id);
    else if (n.related_type === 'submission') navigate('/staff/review');
    // A password reset request opens that person's account, where the reset is.
    else if (n.related_type === 'user' && n.related_id) navigate('/staff/users?open=' + n.related_id);
    else if (n.related_type === 'sensor_alert') navigate('/staff/iot');
    else if (n.related_type === 'camera_alert') navigate('/staff/iot#camera-alerts');
    else load();
  };

  const readAll = async () => {
    await api.readAllNotifications();
    await refreshCounts();
    load();
    toast(t('All notifications marked as read.'));
  };

  if (!data) return <LoadingBlock label={t('Loading notifications')} />;

  return (
    <div className="page">
      <div className="wrap" style={{ maxWidth: 820 }}>
        <PageHead
          title={t('Notifications')}
          sub={t('New submissions, approvals, returns and visitor reports.')}
        >
          {data.unread > 0 && <button className="btn btn-sm" onClick={readAll}><I.Check /> {t('Mark all read')}</button>}
        </PageHead>

        {data.results.length === 0 ? (
          <Empty icon={I.Bell} title={t('Nothing to catch up on')}>
            {t('You will be notified here when a submission needs your attention, or when one of yours is reviewed.')}
          </Empty>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {data.results.map((n) => {
              const kind = TYPES[n.type] || { icon: I.Bell, cls: 'badge-neutral', label: n.type };
              return (
                <button
                  key={n.id}
                  className="card card-pad row"
                  style={{
                    gap: 13, textAlign: 'left', alignItems: 'flex-start', width: '100%',
                    borderLeft: n.is_read ? undefined : '3px solid var(--accent)',
                    background: n.is_read ? 'var(--surface)' : 'var(--accent-soft)',
                  }}
                  onClick={() => open(n)}
                >
                  <span className="avatar" style={{ flex: 'none' }}><kind.icon style={{ width: 15, height: 15 }} /></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="row row-wrap" style={{ gap: 8, marginBottom: 2 }}>
                      <span className="strong small">{noticeTitle(n.title)}</span>
                      {!n.is_read && <span className="badge badge-ok" style={{ fontSize: '0.62rem' }}>{t('New')}</span>}
                    </span>
                    {n.body && <span className="small mute" style={{ display: 'block' }}>{n.body}</span>}
                    {n.related_type === 'camera_alert' && n.related_id && can('sensor.view') && (
                      <AuthImage
                        src={`/api/sensors/camera-alerts/${n.related_id}/photo`}
                        alt={t('Camera snapshot')}
                        style={{ width: 220, maxWidth: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 6, display: 'block', marginTop: 6 }}
                      />
                    )}
                    <span className="tiny faint" style={{ display: 'block', marginTop: 4 }}>
                      {relativeTime(n.created_at)} &middot; {formatDateTime(n.created_at)}
                    </span>
                  </span>
                  <I.ChevronRight style={{ width: 16, height: 16, color: 'var(--text-faint)', flex: 'none', marginTop: 4 }} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
