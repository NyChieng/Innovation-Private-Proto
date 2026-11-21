import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { CopyButton, LoadingBlock, Notice, PageHead } from '../components/ui.jsx';
import { InstallCard, PlatformGuides } from '../components/InstallPrompt.jsx';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/**
 * Installing the local CA on a phone. Accepting the browser warning only
 * covers the page: iOS fetches the home-screen icon separately, refuses the
 * untrusted certificate, and falls back to a plain letter tile.
 */
function TrustCard({ caUrl }) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  return (
    <div className="card" id="trust">
      <div className="card-head">
        <I.Shield style={{ width: 18, height: 18, flex: 'none', color: 'var(--accent)' }} />
        <h3 className="grow">{t('Trust this server on your phone')}</h3>
        <span className="tiny faint nowrap">{t('Once per phone')}</span>
      </div>
      <div className="card-body">
        <p className="small mute">
          {t('Without this, an iPhone puts a plain {letter} on the home screen instead of the FloraScan icon, because iOS will not fetch the icon from a server it does not trust. It also removes the certificate warning. It keeps working when this computer’s address changes.', { letter: <strong>&ldquo;F&rdquo;</strong> })}
        </p>

        <div className="grid" style={{ gap: 18, marginTop: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' }}>
          <div>
            <strong style={{ fontSize: '0.92rem' }}>{t('iPhone and iPad')}</strong>
            <ol className="install-steps" style={{ marginTop: 8 }}>
              <li><I.Download /><span>{t('In {safari}, tap {download}, then {allow}', { safari: <strong>Safari</strong>, download: <strong>{t('Download certificate')}</strong>, allow: <strong>{t('Allow')}</strong> })}</span></li>
              <li><I.Settings /><span>{t('Open {path}', { path: <><strong>{t('Settings')}</strong> &rarr; <strong>{t('Profile Downloaded')}</strong> &rarr; <strong>{t('Install')}</strong></> })}</span></li>
              <li><I.Shield /><span>{t('{path}, and switch on {ca}', { path: <><strong>{t('General')}</strong> &rarr; <strong>{t('About')}</strong> &rarr; <strong>{t('Certificate Trust Settings')}</strong></>, ca: <strong>FloraScan local CA</strong> })}</span></li>
              <li><I.Refresh /><span>{t('Delete the old home-screen icon and add FloraScan again')}</span></li>
            </ol>
          </div>
          <div>
            <strong style={{ fontSize: '0.92rem' }}>Android</strong>
            <ol className="install-steps" style={{ marginTop: 8 }}>
              <li><I.Download /><span>{t('Tap {button}', { button: <strong>{t('Download certificate')}</strong> })}</span></li>
              <li><I.Settings /><span>{t('{path} (the menu names vary by phone)', { path: <><strong>{t('Settings')}</strong> &rarr; <strong>{t('Security')}</strong> &rarr; <strong>{t('Install a certificate')}</strong> &rarr; <strong>{t('CA certificate')}</strong></> })}</span></li>
            </ol>
          </div>
        </div>

        <div className="row row-wrap" style={{ gap: 10, marginTop: 14 }}>
          <a className="btn btn-primary" href={caUrl}><I.Download /> {t('Download certificate')}</a>
          {standalone && (
            <span className="tiny" style={{ color: 'var(--warn-fg)' }}>
              {t('Open this page in Safari first: the installed app cannot download profiles.')}
            </span>
          )}
        </div>
      </div>
      <div className="card-foot tiny mute">
        {t('The certificate can only vouch for {local} and private network addresses ({ranges}), never a public website. Remove it when you no longer need it: on iPhone, {path}.', {
          local: <span className="mono">localhost</span>,
          ranges: <><span className="mono">10.x</span>, <span className="mono">172.16–31.x</span>, <span className="mono">192.168.x</span></>,
          path: <><strong>{t('General')}</strong> &rarr; <strong>{t('VPN & Device Management')}</strong></>,
        })}
      </div>
    </div>
  );
}

/**
 * "Open this on my phone."
 * Shows the LAN address of the running dev server as a QR code, so a phone on
 * the same Wi-Fi or hotspot can jump straight in without typing an IP.
 */
export default function Connect() {
  const { setView, viewPref, mobile } = useApp();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.connect().then(setInfo).catch((e) => setError(e.message));
  }, []);

  const onPhone = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  if (error) {
    return (
      <div className="page"><div className="wrap wrap-narrow">
        <Notice kind="danger" title={t('Could not read the server address')}>{error}</Notice>
      </div></div>
    );
  }
  if (!info) return <LoadingBlock label={t("Working out this machine's address")} />;

  return (
    <div className="page">
      <div className="wrap wrap-narrow">
        <PageHead
          title={t('Open on your phone')}
          sub={t("Scan this with your phone's camera while it is on the same Wi-Fi network or hotspot as this computer.")}
        />

        {onPhone ? (
          <Notice kind="ok" title={t('You are already on a phone')}>
            {t('You are on a mobile device, so the phone layout is showing. Use the Layout setting below to switch to the website layout.')}
          </Notice>
        ) : (
          <div className="card card-pad center" style={{ marginBottom: 20 }}>
            <div className="connect-qr">
              <img src={info.png} alt={t('QR code for {code}', { code: info.url })} />
            </div>
            <div className="mono" style={{ marginTop: 14, fontSize: '1.02rem', fontWeight: 600 }}>{info.url}</div>
            <div className="row row-wrap" style={{ justifyContent: 'center', gap: 8, marginTop: 12 }}>
              <CopyButton text={info.url} label={t('Copy address')} />
              <a className="btn btn-sm" href={info.url} target="_blank" rel="noreferrer"><I.External /> {t('Open in a new tab')}</a>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <InstallCard />
        </div>

        {info.ca_url && (
          <div style={{ marginBottom: 20 }}>
            <TrustCard caUrl={info.ca_url} />
          </div>
        )}

        {info.passkey_url && (
          <div className="card card-pad" style={{ marginBottom: 20 }}>
            <h3 className="section-title" style={{ marginBottom: 8 }}><I.Shield /> {t('Face ID / fingerprint sign-in')}</h3>
            <p className="small mute" style={{ marginTop: 0 }}>
              {t('Phones can only use Face ID or a fingerprint on a named address. Trust the certificate above first, then open:')}
            </p>
            <a href={info.passkey_url + '/login'} className="mono strong" style={{ overflowWrap: 'anywhere' }}>{info.passkey_url}</a>
            <p className="tiny mute" style={{ marginBottom: 0 }}>
              {t('Works on iPhone and most recent Android phones on the same Wi-Fi. If it does not open, keep using the number address and sign in with your password.')}
            </p>
          </div>
        )}

        <div style={{ marginBottom: 20 }}>
          <PlatformGuides />
        </div>

        <div className="grid grid-2" style={{ marginBottom: 20 }}>
          <div className="card card-pad">
            <h3 style={{ marginBottom: 8 }}>{t('How to connect')}</h3>
            <ol className="small mute" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.85 }}>
              {/* Hosted on a real domain, the phone reaches the site over the
                  internet: no shared network, and nothing to accept. */}
              {!info.hosted && <li>{t('Put your phone on the {network} as this computer.', { network: <strong>{t('same Wi-Fi or hotspot')}</strong> })}</li>}
              <li>{t('Open the camera app and point it at the QR code.')}</li>
              <li>{t('Tap the notification that appears.')}</li>
              {info.secure && !info.hosted && <li>{t('Accept the certificate warning once (Advanced → Proceed).')}</li>}
            </ol>
          </div>

          <div className="card card-pad">
            <h3 style={{ marginBottom: 8 }}>{t('Layout')}</h3>
            <div className="small mute" style={{ marginBottom: 12 }}>
              {t('The layout follows the screen size, but you can choose either one.')}
            </div>
            <div className="segmented">
              {[['auto', t('Auto')], ['web', t('Website')], ['mobile', t('Phone app')]].map(([v, l]) => (
                <button key={v} className={viewPref === v ? 'active' : ''} onClick={() => setView(v)}>{l}</button>
              ))}
            </div>
            <div className="tiny faint" style={{ marginTop: 10 }}>
              {mobile
                ? t('Currently showing the {layout} layout.', { layout: <strong>{t('phone app')}</strong> })
                : t('Currently showing the {layout} layout.', { layout: <strong>{t('website')}</strong> })}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <Notice kind={info.secure ? 'ok' : 'warn'} title={info.secure ? t('Running over HTTPS') : t('Camera scanning needs HTTPS')}>
            {info.note}
          </Notice>
        </div>

        {info.addresses.length > 1 && (
          <div className="card">
            <div className="card-head"><h3>{t('Other network addresses on this machine')}</h3></div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>{t('Adapter')}</th><th>{t('Address')}</th><th></th></tr>
                </thead>
                <tbody>
                  {info.addresses.map((a) => (
                    <tr key={a.address}>
                      <td className="small">
                        {a.name}
                        {a.virtual && <span className="tag" style={{ marginLeft: 7 }}>{t('virtual')}</span>}
                      </td>
                      <td className="mono small">{a.url}</td>
                      <td className="num"><CopyButton text={a.url} label={t('Copy')} className="btn btn-sm btn-ghost" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-foot tiny mute">
              {t('If the QR code does not load on your phone, try one of these. Adapters marked {tag} belong to WSL, Docker or a VM and are usually not reachable from a phone.', {
                tag: <span className="tag" style={{ margin: '0 5px' }}>{t('virtual')}</span>,
              })}
            </div>
          </div>
        )}

        <div className="tiny faint" style={{ marginTop: 20 }}>
          {t('Port {port} was picked at random on first run and saved to {file}. Run {command} to pick a new one. If the phone cannot connect, your firewall is probably blocking Node on the private network.', {
            port: info.port,
            file: <span className="mono">proto.config.json</span>,
            command: <span className="mono">npm run port</span>,
          })}
        </div>
      </div>
    </div>
  );
}
