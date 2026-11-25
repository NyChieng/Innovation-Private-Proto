import { useCallback, useEffect, useState } from 'react';
import {
  WebAuthnAbortService, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable, startAuthentication, startRegistration,
} from '@simplewebauthn/browser';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { relativeTime } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';

/*
 * Passkeys - signing in with Face ID, a fingerprint, or the phone's own
 * pattern or PIN. The browser and the phone do the checking; see
 * Server/passkeys.js for how the server side works.
 *
 * Options are fetched ahead of the tap. iOS only lets a page ask for Face ID
 * straight out of a tap, and a network round trip in between can cost that.
 */

const supported = () => { try { return browserSupportsWebAuthn(); } catch { return false; } };

/** The server names the device from its user agent; these are the names it uses. */
const deviceName = (label) => ({
  iPhone: t('iPhone'), iPad: t('iPad'), 'Android phone': t('Android phone'),
  'Windows computer': t('Windows computer'), Mac: t('Mac'),
  'Phone linked by QR code': t('Phone linked by QR code'),
}[label] || t('This device'));

const onWindows = () => /Windows NT/.test(navigator.userAgent);

/** The user closing the Face ID sheet is not an error worth a red message. */
const cancelled = (err) => err?.name === 'NotAllowedError' || err?.name === 'AbortError';

function NamedAddress({ url }) {
  if (!url) return null;
  return (
    <span>
      {t('Open FloraScan at {url} to use it.', {
        url: <a href={url + window.location.pathname} className="mono" style={{ overflowWrap: 'anywhere' }}>{url}</a>,
      })}
    </span>
  );
}

/*
 * Whether this browser has been linked to a FloraScan account before. Without
 * it, the sign-in button would open the phone's passkey list empty - the
 * phone has nothing to offer until the person has signed in once with a
 * password and said yes. So the button only shows where it can work.
 */
const DEVICE_KEY = 'florascan.passkey-device';
const deviceLinked = () => { try { return !!localStorage.getItem(DEVICE_KEY); } catch { return false; } };
const markDevice = (on = true) => {
  try { if (on) localStorage.setItem(DEVICE_KEY, '1'); else localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ }
};

/* ------------------------------------------------------------------ */
/* Sign-in button                                                      */
/* ------------------------------------------------------------------ */

export function PasskeySignIn({ onSignedIn, onError }) {
  const { applySession } = useApp();
  const [prepared, setPrepared] = useState(null);
  const [namedUrl, setNamedUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(deviceLinked);

  const prepare = useCallback(() => {
    api.passkeyLoginOptions()
      .then((r) => { setPrepared(r); setNamedUrl(null); })
      .catch((err) => { setPrepared(null); setNamedUrl(err.body?.named_url || null); });
  }, []);

  useEffect(() => { if (supported()) prepare(); }, [prepare]);

  /*
   * Autofill: tapping the email box offers the saved fingerprint / face
   * sign-in as a suggestion, so nothing is typed at all. It waits quietly in
   * the background; the button below cancels it when tapped instead, and
   * leaving the page cancels it too.
   */
  useEffect(() => {
    if (!supported()) return undefined;
    let live = true;
    (async () => {
      let r;
      let response;
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        // Refused on an IP address; the notice in place of the button says why.
        r = await api.passkeyLoginOptions();
        response = await startAuthentication({ optionsJSON: r.options, useBrowserAutofill: true });
      } catch {
        // Cancelled, superseded by the button, or the page was left - all quiet.
        return;
      }
      if (!live) return;
      try {
        const u = await applySession(await api.passkeyLogin(r.flow, response));
        markDevice();
        onSignedIn(u);
      } catch (err) {
        if (live) onError?.(err.message || t('Something went wrong.'));
      }
    })();
    return () => { live = false; WebAuthnAbortService.cancelCeremony(); };
    // Once per visit to the page; the callbacks are not expected to change meaning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!supported()) return null;

  if (!prepared && namedUrl) {
    return (
      <div className="signin-note" style={{ marginTop: 12 }}>
        <I.Shield /> <span>{t('Face ID and fingerprint sign-in need the named address, not a number.')} <NamedAddress url={namedUrl} /></span>
      </div>
    );
  }

  const go = async () => {
    if (!prepared || busy) return;
    setBusy(true); onError?.(null);
    try {
      const response = await startAuthentication({ optionsJSON: prepared.options });
      const res = await api.passkeyLogin(prepared.flow, response);
      const u = await applySession(res);
      markDevice();
      onSignedIn(u);
      return;
    } catch (err) {
      if (!cancelled(err)) onError?.(err.message || t('Something went wrong.'));
      // The server no longer knows this device's passkey (turned off, or an
      // administrator reset): stop offering the button until it is set up again.
      if (err?.status === 400) { markDevice(false); setLinked(false); }
    }
    // Each challenge answers one attempt, so fetch a fresh one for the next tap.
    prepare();
    setBusy(false);
  };

  const wrap = { whiteSpace: 'normal', height: 'auto', minHeight: 48, lineHeight: 1.3 };

  // Not set up on this device yet: each device uses only its own fingerprint
  // or face, so a button here would only open an empty list.
  if (!linked) {
    return (
      <p className="signin-help" style={{ marginTop: 14, paddingTop: 0, borderTop: 0 }}>
        <I.Shield style={{ width: 14, height: 14, verticalAlign: '-2px', display: 'inline-block' }} />{' '}
        {t('Want to use Face ID or your fingerprint? Sign in with your password once on this device and you will be asked to turn it on.')}
      </p>
    );
  }

  return (
    // Allowed to wrap: in Malay the label is too long for one line on a small phone.
    <button
      type="button" className="btn btn-lg btn-block signin-secondary"
      style={wrap}
      onClick={go} disabled={!prepared || busy}
    >
      {busy ? <span className="spinner" /> : <I.Shield />} {t('Sign in with Face ID or fingerprint')}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The offer straight after a password sign-in                         */
/* ------------------------------------------------------------------ */

// Per device and per account: set once this device holds a passkey, or once
// the person said "not now", so the offer is made once rather than every time.
const hereKey = (u) => 'florascan.passkey-here.' + u.id;
const declinedKey = (u) => 'florascan.passkey-declined.' + u.id;
const flag = (key) => { try { return !!localStorage.getItem(key); } catch { return true; } };
const setFlag = (key) => { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } };

/**
 * Whether to offer fingerprint / face sign-in right after a password sign-in:
 * only where the device's own sensor is ready and the address allows it, and
 * not for someone who already set it up here or declined.
 */
export async function shouldOfferPasskey(user) {
  if (!supported() || user.must_change_password) return false;
  if (flag(hereKey(user)) || flag(declinedKey(user))) return false;
  try {
    if (!(await platformAuthenticatorIsAvailable())) return false;
    const r = await api.passkeys();
    return !!r.rp_id;
  } catch {
    return false;
  }
}

export function PasskeyOffer({ user, onDone }) {
  const { toast } = useApp();
  const [options, setOptions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Fetched before the tap, as with signing in: iOS wants Face ID straight out of the tap.
  // A failed request used to skip straight on to the app, so the passkey the
  // person was about to make was silently never offered (the intermittent
  // "...and the passkey is saved" test failure). Try once more, then say so
  // and leave "Not now" as the way on.
  useEffect(() => {
    let alive = true;
    const fetchOptions = () => api.passkeyRegisterOptions().then((o) => { if (alive) setOptions(o.options); });
    fetchOptions()
      .catch(() => new Promise((r) => setTimeout(r, 800)).then(fetchOptions))
      .catch((err) => { if (alive) setError(err?.message || t('Something went wrong.')); });
    return () => { alive = false; };
  }, []);

  const yes = async () => {
    if (!options || busy) return;
    setBusy(true); setError(null);
    try {
      await api.passkeyRegister(await startRegistration({ optionsJSON: options }));
      setFlag(hereKey(user)); markDevice();
      toast(t('Face ID / fingerprint sign-in is on for this device.'), 'ok');
      onDone();
      return;
    } catch (err) {
      // Already set up here after all - nothing to do but go on.
      if (err?.name === 'InvalidStateError') { setFlag(hereKey(user)); markDevice(); onDone(); return; }
      if (!cancelled(err)) setError(err?.message || t('Something went wrong.'));
    }
    // A challenge answers one attempt; get a fresh one for another tap.
    api.passkeyRegisterOptions().then((o) => setOptions(o.options)).catch(() => setOptions(null));
    setBusy(false);
  };

  const notNow = () => { setFlag(declinedKey(user)); onDone(); };

  return (
    <>
      <div className="signin-eyebrow"><I.Shield /> {t('Faster sign-in')}</div>
      <h1>{t('Use your fingerprint or face next time?')}</h1>
      <p className="signin-lead">
        {t('Skip typing your password on this device. FloraScan asks the device to check it is you - your fingerprint or face never leaves it.')}
      </p>
      {error && <div className="signin-error" role="alert"><I.Alert /> {error}</div>}
      <button className="btn btn-primary btn-lg btn-block signin-submit" onClick={yes} disabled={!options || busy}>
        {busy ? <span className="spinner" /> : <I.Shield />} {t('Use fingerprint or face')}
      </button>
      <button className="btn btn-lg btn-block signin-secondary" onClick={notNow}>
        {t('Not now')}
      </button>
      <p className="signin-help">{t('You can turn it on or off later under Sign-in and security.')}</p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Turning it on and off, for a signed-in user                         */
/* ------------------------------------------------------------------ */

export function PasskeyCard() {
  const { user, run, toast } = useApp();
  const [list, setList] = useState(null);
  const [rpId, setRpId] = useState(null);
  const [namedUrl, setNamedUrl] = useState(null);
  const [options, setOptions] = useState(null);
  const [busy, setBusy] = useState(false);
  // Whether this device's own sensor is ready - Windows Hello, Touch ID, the
  // phone's screen lock. A laptop with a fingerprint reader still says no
  // until Windows Hello has been set up, which is the usual surprise.
  const [builtIn, setBuiltIn] = useState(null);

  useEffect(() => {
    if (!supported()) return;
    platformAuthenticatorIsAvailable().then(setBuiltIn).catch(() => setBuiltIn(false));
  }, []);

  const load = useCallback(async () => {
    const r = await api.passkeys();
    setList(r.results); setRpId(r.rp_id); setNamedUrl(r.named_url);
    if (r.rp_id && supported()) {
      api.passkeyRegisterOptions().then((o) => setOptions(o.options)).catch(() => setOptions(null));
    }
  }, []);

  useEffect(() => { load().catch(() => setList([])); }, [load]);

  const add = async () => {
    if (!options || busy) return;
    setBusy(true);
    try {
      const response = await startRegistration({ optionsJSON: options });
      await run(() => api.passkeyRegister(response), { success: t('Face ID / fingerprint sign-in is on for this device.') });
      setFlag(hereKey(user)); markDevice();
    } catch (err) {
      if (err?.name === 'InvalidStateError') toast(t('This device is already set up.'));
      else if (!cancelled(err) && !err?.status) toast(err?.message || t('Something went wrong.'), 'err');
    }
    setBusy(false);
    load().catch(() => {});
  };

  const remove = async (pk) => {
    if (!window.confirm(t('Turn off Face ID / fingerprint sign-in for {device}?', { device: deviceName(pk.device_label) }))) return;
    try {
      await run(() => api.passkeyRemove(pk.id), { success: t('Turned off.') });
      load().catch(() => {});
    } catch { /* the toast says why */ }
  };

  const here = (list || []).filter((pk) => pk.rp_id === rpId);

  return (
    <div className="card card-pad stack" style={{ '--gap': '12px', marginTop: 18 }}>
      <div className="section-title"><I.Shield /> {t('Face ID / fingerprint sign-in')}</div>
      <p className="small mute" style={{ margin: 0 }}>
        {t('Sign in by unlocking your phone - Face ID, a fingerprint, or your screen-lock pattern or PIN. Your face or fingerprint never leaves the device.')}
      </p>

      {!supported() ? (
        <p className="small" style={{ margin: 0 }}>{t('This browser does not support it.')}</p>
      ) : !rpId && list ? (
        <p className="small" style={{ margin: 0 }}>
          {t('Face ID and fingerprint sign-in need the named address, not a number.')} <NamedAddress url={namedUrl} />
        </p>
      ) : null}

      {list && list.length > 0 && (
        <ul className="stack" style={{ '--gap': '8px', listStyle: 'none', padding: 0, margin: 0 }}>
          {list.map((pk) => (
            <li key={pk.id} className="row" style={{ gap: 10 }}>
              <I.Phone style={{ width: 16, height: 16, flex: 'none' }} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="small strong" style={{ display: 'block' }}>{deviceName(pk.device_label)}</span>
                <span className="tiny mute truncate" style={{ display: 'block' }}>
                  {pk.rp_id} · {pk.last_used_at
                    ? t('last used {when}', { when: relativeTime(pk.last_used_at) })
                    : t('added {when}', { when: relativeTime(pk.created_at) })}
                </span>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => remove(pk)}>{t('Turn off')}</button>
            </li>
          ))}
        </ul>
      )}

      {rpId && supported() && builtIn === false && (
        <div className="notice notice-warn">
          <I.Info />
          <div>
            <strong>{t("This device's own fingerprint or face sign-in is not set up")}</strong>
            {onWindows()
              ? t('On Windows: Settings → Accounts → Sign-in options. Set up a PIN first, then Fingerprint or Facial recognition. Then come back and turn this on.')
              : t("Turn on the device's screen lock - fingerprint, face, PIN or pattern - then come back and turn this on.")}
          </div>
        </div>
      )}

      {/* Windows reports Hello as available whenever the hardware exists, set
          up or not, so the way to switch it on is always shown there. */}
      {rpId && supported() && builtIn !== false && onWindows() && (
        <p className="tiny mute" style={{ margin: 0 }}>
          {t('On Windows: Settings → Accounts → Sign-in options. Set up a PIN first, then Fingerprint or Facial recognition. Then come back and turn this on.')}
        </p>
      )}

      {rpId && supported() && (
        <button type="button" className="btn btn-block" onClick={add} disabled={!options || busy}>
          {busy ? <span className="spinner" /> : <I.Shield />}{' '}
          {here.length ? t('Add another device') : t('Turn on for this device')}
        </button>
      )}
    </div>
  );
}
