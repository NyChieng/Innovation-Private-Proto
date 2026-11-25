import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, LoadingBlock, Modal, Notice, PageHead, Stat } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/store.jsx';
import AuthImage from '../../components/AuthImage.jsx';
import { relativeTime, titleCase } from '../../lib/format.js';
import * as I from '../../lib/icons.jsx';
import { msg, t } from '../../lib/i18n.js';

/**
 * IoT plant monitoring.
 *
 * Sensor nodes publish readings over MQTT; Server/mqtt.js checks each node's
 * device key, saves the reading and opens an alert when a value leaves the
 * range set for that sensor. This page reads it all back from GET /api/sensors
 * and polls every few seconds, so new readings appear without a reload.
 */

const REFRESH_MS = 10_000;

const METRICS = [
  { key: 'soil_moisture_pct', limit: 'soil_moisture', label: msg('Soil moisture'), unit: '%', decimals: 1 },
  { key: 'temperature_c', limit: 'temperature', label: msg('Temperature'), unit: '°C', decimals: 1 },
  { key: 'humidity_pct', limit: 'humidity', label: msg('Humidity'), unit: '%', decimals: 1 },
  // The rest of the kit, and the node's own Wi-Fi signal. Sound and distance
  // have safe ranges (a loud noise or something too close to the plant raises
  // an alert); the others give context (rain explains a soil reading, motion
  // shows visitors near the plant) and help diagnose a node that goes quiet.
  { key: 'rain_pct', limit: null, label: msg('Rain'), unit: '%', decimals: 1 },
  { key: 'motion_events', limit: null, label: msg('Motion'), unit: msg('events'), decimals: 0, nonNegative: true },
  { key: 'sound_peak_pct', limit: 'sound', label: msg('Sound (peak)'), unit: '%', decimals: 1 },
  { key: 'distance_cm', limit: 'distance', label: msg('Distance'), unit: 'cm', decimals: 1, nonNegative: true },
  { key: 'wifi_rssi_dbm', limit: null, label: msg('Wi-Fi signal'), unit: 'dBm', decimals: 0 },
];

// Units are symbols ("%", "cm") except "events", which is a word to translate.
const unitOf = (m) => (m.unit === 'events' ? t(m.unit) : m.unit);

const ALERT_METRIC = {
  soil_moisture: METRICS[0],
  temperature: METRICS[1],
  humidity: METRICS[2],
  sound: METRICS.find((m) => m.key === 'sound_peak_pct'),
  distance: METRICS.find((m) => m.key === 'distance_cm'),
};

const RANGES = [
  { value: '1', label: msg('Last hour') },
  { value: '2', label: msg('2 hours') },
  { value: '6', label: msg('6 hours') },
  { value: '24', label: msg('24 hours') },
];

// One series per chart, so one colour. Taken from a palette checked for
// contrast in both themes; the dark value is a separate, lighter step.
const VIZ_STYLE = `
.iot-viz { --series-1: #2a78d6; }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .iot-viz { --series-1: #3987e5; }
}
:root[data-theme="dark"] .iot-viz { --series-1: #3987e5; }
`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmt(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** 'low', 'high' or null, against a { min, max } pair where either may be null. */
function outOfRange(value, lim) {
  if (value === null || value === undefined || !lim) return null;
  if (lim.min !== null && value < lim.min) return 'low';
  if (lim.max !== null && value > lim.max) return 'high';
  return null;
}

/** The badge on each sensor card: Offline, Warning or OK. */
function deviceState(d) {
  if (!d.online) return { label: msg('Offline'), cls: 'badge-neutral' };
  const outside = METRICS.some((m) => m.limit && outOfRange(d.latest?.[m.key], d.limits[m.limit]));
  if (outside || d.open_alerts > 0) return { label: msg('Warning'), cls: 'badge-warn' };
  return { label: msg('OK'), cls: 'badge-ok' };
}

/** A round step (1, 2 or 5 times a power of ten) for axis ticks. */
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function IoT() {
  const { can } = useApp();
  const [hours, setHours] = useState('2');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [resolving, setResolving] = useState(null);
  const [resolvingCamera, setResolvingCamera] = useState(null);
  const [showTable, setShowTable] = useState(false);

  // Each request gets a number; a slow reply that arrives after a newer one
  // (say, after switching the time range) is thrown away.
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latestRequest.current;
    try {
      const res = await api.get('/sensors', { hours });
      if (id !== latestRequest.current) return;
      setData(res);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      if (id !== latestRequest.current) return;
      setError(err.message);
    }
  }, [hours]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Opened from a camera-alert notification: go to the camera alerts once the
  // page has drawn them.
  const scrolledToHash = useRef(false);
  useEffect(() => {
    if (!data || scrolledToHash.current || window.location.hash !== '#camera-alerts') return;
    scrolledToHash.current = true;
    document.getElementById('camera-alerts')?.scrollIntoView({ block: 'start' });
  }, [data]);

  const devices = data?.devices || [];
  const selected = devices.find((d) => d.id === deviceId) || devices[0] || null;
  const alerts = data?.alerts || [];
  const cameraAlerts = data?.camera_alerts || [];

  const series = useMemo(
    () => (data?.readings || []).filter((r) => selected && r.device_id === selected.id),
    [data, selected],
  );

  if (!data && !error) {
    return (
      <div className="page"><div className="wrap" style={{ maxWidth: 1100 }}>
        <LoadingBlock label={t('Loading sensors')} />
      </div></div>
    );
  }

  if (!data && error) {
    return (
      <div className="page"><div className="wrap" style={{ maxWidth: 1100 }}>
        <PageHead title={t('IoT plant monitoring')} />
        <Notice kind="danger" title={t('Could not load the sensors')}>{error}</Notice>
      </div></div>
    );
  }

  const online = devices.filter((d) => d.online).length;
  const openAlerts = data.open_alerts ?? alerts.filter((a) => a.status === 'open').length;
  const range = RANGES.find((r) => r.value === hours);
  const rangeLabel = range ? t(range.label) : t('{n} hours', { n: hours });

  return (
    <div className="page iot-viz">
      <style>{VIZ_STYLE}</style>
      <div className="wrap" style={{ maxWidth: 1100 }}>
        <PageHead
          title={t('IoT plant monitoring')}
          sub={t('Soil, temperature, humidity, rain, motion, sound and distance around monitored plants, with alerts when a reading leaves its safe range.')}
        >
          <span className="badge badge-ok"><span className="dot" />{t('Live')}</span>
          {updatedAt && <span className="tiny mute">{t('Updated {time}', { time: updatedAt.toLocaleTimeString() })}</span>}
        </PageHead>

        {error && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="warn" title={t('Could not refresh')}>
              {error} {t('The figures below are from the last successful update.')}
            </Notice>
          </div>
        )}

        {/* Headline numbers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
          <Stat label={t('Sensors online')} value={`${online} / ${devices.length}`}
            detail={t('Offline after {n} min without a reading', { n: data.offline_minutes })} />
          <Stat label={t('Open alerts')} value={openAlerts} accent={openAlerts > 0}
            detail={openAlerts ? t('Waiting for a ranger to resolve') : t('Every reading is in range')} />
          <Stat label={t('Readings shown')} value={series.length}
            detail={selected ? `${selected.device_code}, ${rangeLabel}` : rangeLabel} />
        </div>

        {devices.length === 0 ? (
          <Empty icon={I.Sensor} title={t('No sensors registered')}>
            {t("Add a row to sensor_devices with the node's device code and the hash of its key, then start the node.")}
          </Empty>
        ) : (
          <>
            {/* Sensor cards */}
            <h2 style={{ fontSize: '1.05rem', marginBottom: 10 }}>{t('Sensors')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 26 }}>
              {devices.map((d) => (
                <DeviceCard
                  key={d.id}
                  device={d}
                  selected={selected?.id === d.id}
                  selectable={devices.length > 1}
                  onSelect={() => setDeviceId(d.id)}
                />
              ))}
            </div>

            {/* Filters: one row, above everything they change */}
            <div className="row row-wrap" style={{ gap: 7, marginBottom: 14, alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.05rem', margin: '0 10px 0 0' }}>
                {selected && devices.length > 1 ? t('Readings: {device}', { device: selected.device_code }) : t('Readings')}
              </h2>
              {RANGES.map((r) => (
                <button key={r.value} className="chip" aria-pressed={hours === r.value} onClick={() => setHours(r.value)}>
                  {t(r.label)}
                </button>
              ))}
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" onClick={() => setShowTable((v) => !v)}>
                {showTable ? t('Hide table') : t('Show as table')}
              </button>
            </div>

            <div className="grid grid-2" style={{ marginBottom: 14 }}>
              {METRICS.map((m) => (
                <div className="card card-pad" key={m.key}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <h3 style={{ margin: 0 }}>{t(m.label)}</h3>
                    <span className="spacer" />
                    {m.limit && selected && (
                      <span className="tiny mute">
                        {t('Safe range {min}–{max} {unit}', {
                          min: fmt(selected.limits[m.limit].min, 0), max: fmt(selected.limits[m.limit].max, 0), unit: unitOf(m),
                        })}
                      </span>
                    )}
                  </div>
                  <LineChart
                    metric={m}
                    hours={Number(hours)}
                    limits={m.limit && selected ? selected.limits[m.limit] : null}
                    points={series.map((r) => ({ t: r.recorded_at, v: r[m.key] }))}
                  />
                </div>
              ))}
            </div>

            {showTable && <ReadingsTable readings={series} />}
          </>
        )}

        {/* AI camera alerts */}
        <div className="card card-pad" style={{ marginTop: 22 }} id="camera-alerts">
          <div className="row" style={{ marginBottom: 4 }}>
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{t('Camera alerts')}</h2>
            <span className="spacer" />
            <span className="tiny mute">{t('Most recent 50, unresolved first')}</span>
          </div>
          <div className="tiny mute">
            {t('Snapshots from the AI camera when someone touches a plant or is near it after hours.')}
          </div>
          {cameraAlerts.length === 0 ? (
            <div className="small mute" style={{ padding: '14px 0 4px' }}>{t('No camera alerts yet.')}</div>
          ) : (
            cameraAlerts.map((a) => (
              <CameraAlertItem key={a.id} alert={a} onResolve={can('alert.resolve') ? () => setResolvingCamera(a) : null} />
            ))
          )}
        </div>

        {/* Alerts */}
        <div className="card card-pad" style={{ marginTop: 22 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{t('Alerts')}</h2>
            <span className="spacer" />
            <span className="tiny mute">{t('Most recent 50, unresolved first')}</span>
          </div>
          {alerts.length === 0 ? (
            <div className="small mute" style={{ padding: '14px 0 4px' }}>
              {t("No alerts yet. One opens when a reading leaves its sensor's safe range.")}
            </div>
          ) : (
            alerts.map((a) => (
              <AlertItem key={a.id} alert={a} onResolve={can('alert.resolve') ? () => setResolving(a) : null} />
            ))
          )}
        </div>
      </div>

      {resolving && (
        <ResolveModal
          alert={resolving}
          onClose={() => setResolving(null)}
          onDone={() => { setResolving(null); load(); }}
        />
      )}
      {resolvingCamera && (
        <CameraResolveModal
          alert={resolvingCamera}
          onClose={() => setResolvingCamera(null)}
          onDone={() => { setResolvingCamera(null); load(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI camera alerts                                                    */
/* ------------------------------------------------------------------ */

const cameraWhat = (a) => (a.tier === 'AFTER-HOURS' ? t('Someone at the plant after hours') : t('Someone touched the plant'));

function CameraAlertItem({ alert: a, onResolve }) {
  const open = a.status === 'open';
  const resolvedBy = a.resolved_by_name
    ? t('Resolved by {name} {when}', { name: a.resolved_by_name, when: a.resolved_at ? relativeTime(a.resolved_at) : '' })
    : t('Resolved {when}', { when: a.resolved_at ? relativeTime(a.resolved_at) : '' });
  return (
    <div className="row camera-alert" style={{ gap: 12, padding: '12px 0', borderTop: '1px solid rgba(127,127,127,0.18)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 'none' }}>
        <AuthImage src={a.photo_url} alt={t('Camera snapshot')} style={{ width: 128, height: 72, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
      </div>
      <div className="grow" style={{ minWidth: 160 }}>
        <div className="strong">{cameraWhat(a)}</div>
        {a.detail && <div className="small mono">{a.detail}</div>}
        <div className="tiny mute">
          <span className="mono">{a.device_code}</span>
          {a.plant_code ? ` · ${a.plant_code}` : ''} · {relativeTime(a.triggered_at)}
        </div>
        {!open && (
          <div className="tiny mute" style={{ marginTop: 4 }}>
            {resolvedBy}
            {a.resolution_note ? `: “${a.resolution_note}”` : ''}
          </div>
        )}
      </div>
      <span className={'badge ' + (open ? 'badge-warn' : 'badge-neutral')}><span className="dot" />{open ? t('Unresolved') : t('Resolved')}</span>
      {open && onResolve && (
        <button className="btn btn-sm" onClick={onResolve}><I.Check />{t('Resolve')}</button>
      )}
    </div>
  );
}

function CameraResolveModal({ alert: a, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/sensors/camera-alerts/${a.id}/resolve`, { note });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Resolve camera alert')}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy && <span className="spinner" />}{t('Resolve')}
          </button>
        </>
      )}
    >
      <AuthImage src={a.photo_url} alt={t('Camera snapshot')} style={{ width: '100%', borderRadius: 8, display: 'block', marginBottom: 10 }} />
      <p className="small" style={{ marginTop: 0 }}>
        {cameraWhat(a)} · <span className="mono">{a.device_code}</span>{a.plant_code ? ` (${a.plant_code})` : ''} · {relativeTime(a.triggered_at)}
      </p>
      <label className="small strong" htmlFor="camera-resolve-note">{t('What was done? (optional)')}</label>
      <textarea
        id="camera-resolve-note"
        className="input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        style={{ width: '100%', minHeight: 90, marginTop: 6, font: 'inherit', padding: 8, boxSizing: 'border-box' }}
      />
      {error && <div style={{ marginTop: 10 }}><Notice kind="danger">{error}</Notice></div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Sensor card                                                         */
/* ------------------------------------------------------------------ */

function DeviceCard({ device: d, selected, selectable, onSelect }) {
  const state = deviceState(d);
  const plant = d.plant;

  const body = (
    <>
      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <span className="avatar"><I.Sensor style={{ width: 16, height: 16 }} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong mono">{d.device_code}</div>
          {d.label && <div className="tiny mute truncate">{d.label}</div>}
        </div>
        {d.is_simulated && <span className="badge badge-info">{t('Simulated')}</span>}
        <span className={'badge ' + state.cls}><span className="dot" />{t(state.label)}</span>
      </div>

      {plant ? (
        <div className="small" style={{ marginBottom: 12 }}>
          <span className={plant.scientific_name ? 'sci' : ''}>{plant.scientific_name || t('Unidentified plant')}</span>
          <div className="tiny mute">
            <span className="mono">{plant.plant_code}</span>{plant.site_name ? ` · ${plant.site_name}` : ''}
          </div>
        </div>
      ) : (
        <div className="small mute" style={{ marginBottom: 12 }}>{t('Not linked to a plant')}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
        {METRICS.map((m) => {
          const value = d.latest?.[m.key];
          const lim = m.limit ? d.limits[m.limit] : null;
          const out = outOfRange(value, lim);
          return (
            <div key={m.key}>
              <div className="tiny mute">{t(m.label)}</div>
              <div className="row" style={{ gap: 6 }}>
                <span className="strong">{fmt(value, m.decimals)}</span>
                {value !== null && value !== undefined && <span className="tiny mute">{unitOf(m)}</span>}
                {out && (
                  <span className="badge badge-warn" title={out === 'low'
                    ? t('Below {value} {unit}', { value: lim.min, unit: unitOf(m) })
                    : t('Above {value} {unit}', { value: lim.max, unit: unitOf(m) })}>
                    {out === 'low' ? t('Low') : t('High')}
                  </span>
                )}
                {m.key === 'rain_pct' && d.latest?.is_raining && (
                  <span className="badge badge-info">{t('Raining')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="tiny faint" style={{ marginTop: 12 }}>
        {d.last_seen_at ? t('Last reading {when}', { when: relativeTime(d.last_seen_at) }) : t('Has never reported')}
      </div>
    </>
  );

  if (!selectable) return <div className="card card-pad">{body}</div>;

  return (
    <button
      type="button"
      className="card card-pad"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        textAlign: 'left', font: 'inherit', color: 'inherit', width: '100%', cursor: 'pointer',
        outline: selected ? '2px solid var(--series-1)' : 'none', outlineOffset: 2,
      }}
    >
      {body}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Line chart                                                          */
/* ------------------------------------------------------------------ */

/**
 * One measurement over time, drawn in SVG. Dashed lines mark the sensor's
 * safe range. A gap in the readings (the node was off) breaks the line rather
 * than drawing a straight bridge across it. Hover, or focus and use the arrow
 * keys, to read individual values.
 */
function LineChart({ points, metric, limits, hours }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(520);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = 180;
  // Room at the top for the "max" label sitting above its dashed line.
  const pad = { top: 18, right: 12, bottom: 24, left: 42 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const pts = useMemo(
    () => points
      .filter((p) => p.v !== null && p.v !== undefined)
      .map((p) => ({ t: new Date(p.t).getTime(), v: Number(p.v) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t),
    [points],
  );

  // The x-axis always spans the chosen window, so a node that went quiet
  // shows up as empty space at the right rather than a stretched line.
  const end = Math.max(Date.now(), pts.length ? pts[pts.length - 1].t : 0);
  const start = end - hours * 3600_000;

  // The y-axis covers the readings and the safe range, with a little margin.
  const ys = pts.map((p) => p.v);
  if (limits?.min !== null && limits?.min !== undefined) ys.push(limits.min);
  if (limits?.max !== null && limits?.max !== undefined) ys.push(limits.max);
  let lo = ys.length ? Math.min(...ys) : 0;
  let hi = ys.length ? Math.max(...ys) : 1;
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (metric.unit === '%' || metric.nonNegative) lo = Math.max(0, lo);

  const x = (t) => pad.left + ((t - start) / (end - start)) * innerW;
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo)) * innerH;

  const yTicks = [];
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(Number(v.toFixed(6)));
  const xTicks = [start, start + (end - start) / 2, end];

  // Split into runs wherever the gap is far longer than the usual interval.
  const segments = useMemo(() => {
    if (!pts.length) return [];
    const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const breakAfter = Math.max(typical * 4, 60_000);
    const runs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t > breakAfter) runs.push([]);
      runs[runs.length - 1].push(pts[i]);
    }
    return runs;
  }, [pts]);

  const visible = pts.filter((p) => p.t >= start);

  const nearest = (t) => {
    let best = null;
    for (let i = 0; i < visible.length; i++) {
      if (best === null || Math.abs(visible[i].t - t) < Math.abs(visible[best].t - t)) best = i;
    }
    return best;
  };

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const t = start + ((px - pad.left) / innerW) * (end - start);
    setHover(nearest(t));
  };

  const onKey = (e) => {
    if (!visible.length) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? visible.length) - 1)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(visible.length - 1, (h ?? -1) + 1)); }
  };

  const point = hover !== null ? visible[hover] : null;
  const latest = visible[visible.length - 1];

  const limitLine = (value, label) => (value === null || value === undefined ? null : (
    <g key={label}>
      <line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)}
        stroke="currentColor" strokeOpacity="0.45" strokeDasharray="4 4" />
      <text x={width - pad.right} y={y(value) - 4} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.7">
        {label} {fmt(value, 0)}
      </text>
    </g>
  ));

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: '1.35rem', fontWeight: 600 }}>{latest ? fmt(latest.v, metric.decimals) : '—'}</span>
        {latest && <span className="small mute">{t('{unit} now', { unit: unitOf(metric) })}</span>}
      </div>

      {visible.length === 0 ? (
        <div className="small mute" style={{ height, display: 'grid', placeItems: 'center' }}>
          {t('No readings in this period')}
        </div>
      ) : (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('{metric} over the selected period. Latest {value} {unit}. Use the arrow keys to step through readings.', {
            metric: t(metric.label), value: fmt(latest.v, metric.decimals), unit: unitOf(metric),
          })}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(visible.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
          style={{ display: 'block', touchAction: 'pan-y', overflow: 'visible' }}
        >
          {/* Grid and y labels */}
          <g className="faint">
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.15" />
                <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="currentColor">{fmt(v, 0)}</text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={t} x={x(t)} y={height - 6} fontSize="10" fill="currentColor"
                textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
                {fmtTime(t)}
              </text>
            ))}
          </g>

          {/* Safe range */}
          <g className="mute">
            {limitLine(limits?.max, t('max'))}
            {limitLine(limits?.min, t('min'))}
          </g>

          {/* The readings */}
          {segments.map((run, i) => (run.length === 1 ? (
            <circle key={i} cx={x(run[0].t)} cy={y(run[0].v)} r="2.5" fill="var(--series-1)" />
          ) : (
            <path
              key={i}
              d={run.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--series-1)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )))}

          {/* Hover crosshair */}
          {point && (
            <g>
              <line x1={x(point.t)} x2={x(point.t)} y1={pad.top} y2={pad.top + innerH}
                stroke="currentColor" strokeOpacity="0.35" />
              <circle cx={x(point.t)} cy={y(point.v)} r="4.5" fill="var(--series-1)" stroke="var(--surface, #fff)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}

      {point && (
        <div
          className="card"
          style={{
            position: 'absolute',
            top: 40,
            left: Math.min(Math.max(x(point.t) - 60, 0), width - 120),
            width: 120,
            padding: '6px 9px',
            pointerEvents: 'none',
            boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
          }}
        >
          <div className="strong">{fmt(point.v, metric.decimals)} {unitOf(metric)}</div>
          <div className="tiny mute">{new Date(point.t).toLocaleTimeString()}</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table view of the same readings                                     */
/* ------------------------------------------------------------------ */

function ReadingsTable({ readings }) {
  const rows = readings.slice(-30).reverse();
  const cell = { padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap' };
  return (
    <div className="card card-pad" style={{ overflowX: 'auto' }}>
      <div className="tiny mute" style={{ marginBottom: 8 }}>{t('Newest 30 readings')}</div>
      <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr className="mute">
            <th style={{ ...cell, textAlign: 'left' }}>{t('Time')}</th>
            {METRICS.map((m) => <th key={m.key} style={cell}>{t(m.label)} ({unitOf(m)})</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid rgba(127,127,127,0.18)' }}>
              <td style={{ ...cell, textAlign: 'left' }}>{new Date(r.recorded_at).toLocaleTimeString()}</td>
              {METRICS.map((m) => <td key={m.key} style={cell}>{fmt(r[m.key], m.decimals)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

function AlertItem({ alert: a, onResolve }) {
  const m = ALERT_METRIC[a.alert_type] || { label: titleCase(String(a.alert_type || 'Reading').replace(/_/g, ' ')), unit: '', decimals: 1 };
  const open = a.status === 'open';
  const label = ALERT_METRIC[a.alert_type] ? t(m.label) : m.label;
  const withUnit = (v) => `${fmt(v, m.decimals)} ${unitOf(m)}`.trim();
  const resolvedBy = a.resolved_by_name
    ? t('Resolved by {name} {when}', { name: a.resolved_by_name, when: a.resolved_at ? relativeTime(a.resolved_at) : '' })
    : t('Resolved {when}', { when: a.resolved_at ? relativeTime(a.resolved_at) : '' });

  return (
    <div className="row" style={{ gap: 12, padding: '12px 0', borderTop: '1px solid rgba(127,127,127,0.18)', alignItems: 'flex-start' }}>
      {open
        ? <I.Alert style={{ width: 18, height: 18, flex: 'none', marginTop: 2 }} />
        : <I.CheckCircle style={{ width: 18, height: 18, flex: 'none', marginTop: 2, opacity: 0.6 }} />}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="strong">
          {a.limit_crossed === 'min'
            ? t('{metric} below the safe range', { metric: label })
            : t('{metric} above the safe range', { metric: label })}
        </div>
        <div className="small">
          {t('{value}, limit {limit}', { value: withUnit(a.reading_value), limit: withUnit(a.limit_value) })}
        </div>
        <div className="tiny mute">
          <span className="mono">{a.device_code}</span>
          {a.plant_code ? ` · ${a.plant_code}` : ''} · {relativeTime(a.triggered_at)}
        </div>
        {!open && (
          <div className="tiny mute" style={{ marginTop: 4 }}>
            {resolvedBy}
            {a.resolution_note ? `: “${a.resolution_note}”` : ''}
          </div>
        )}
      </div>
      <span className={'badge ' + (open ? 'badge-warn' : 'badge-neutral')}><span className="dot" />{open ? t('Unresolved') : t('Resolved')}</span>
      {open && onResolve && (
        <button className="btn btn-sm" onClick={onResolve}><I.Check />{t('Resolve')}</button>
      )}
    </div>
  );
}

function ResolveModal({ alert: a, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const m = ALERT_METRIC[a.alert_type];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/sensors/alerts/${a.id}/resolve`, { note });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Resolve alert')}
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy && <span className="spinner" />}{t('Resolve')}
          </button>
        </>
      )}
    >
      <p className="small" style={{ marginTop: 0 }}>
        {t('{metric} on {device}: {value}, limit {limit}.', {
          metric: m ? t(m.label) : t('Reading'),
          device: <span className="mono" key="d">{a.device_code}{a.plant_code ? ` (${a.plant_code})` : ''}</span>,
          value: `${fmt(a.reading_value, m?.decimals ?? 1)} ${m ? unitOf(m) : ''}`.trim(),
          limit: `${fmt(a.limit_value, m?.decimals ?? 1)} ${m ? unitOf(m) : ''}`.trim(),
        })}
      </p>
      <label className="small strong" htmlFor="resolve-note">{t('What was done? (optional)')}</label>
      <textarea
        id="resolve-note"
        className="input"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder={t('For example: watered the plant, soil back above 30 %.')}
        style={{ width: '100%', minHeight: 90, marginTop: 6, font: 'inherit', padding: 8, boxSizing: 'border-box' }}
      />
      {error && <div style={{ marginTop: 10 }}><Notice kind="danger">{error}</Notice></div>}
    </Modal>
  );
}