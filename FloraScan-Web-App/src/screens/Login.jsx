import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Avatar } from '../components/ui.jsx';
import Recover from './Recover.jsx';
import { PasskeyOffer, PasskeySignIn, shouldOfferPasskey } from '../components/Passkeys.jsx';
import { TwoFactorStep } from '../components/TwoFactor.jsx';
import { PhotoSlideshow } from '../components/motion.jsx';
import { homeFor, roleLabel } from '../lib/format.js';
import * as I from '../lib/icons.jsx';
import { t } from '../lib/i18n.js';
import { plantPhoto, realPhoto } from '../lib/photo.js';

/**
 * Staff sign in.
 *
 * Full screen and outside the site shell, like the welcome screen: this is
 * the front door to the staff side, so it gets the whole viewport rather than
 * a card in the middle of the public register. A photograph from the register
 * on one side, the form on the other; on a phone the photograph becomes a band
 * above the form.
 *
 * Accounts are created by an administrator - there is no self sign-up. A
 * forgotten password is reset here with a recovery code (Recover.jsx).
 */
/**
 * The API locks an account after five wrong passwords in a row. Say how close
 * someone is, and once it happens, how long it lasts and what to do.
 */
function describe(err) {
  const b = err.body || {};
  if (err.status === 423 && b.scope === 'ip') {
    return t('Too many failed sign-ins from this network. Sign-in from here is paused for {minutes} min.', { minutes: b.minutes ?? 15 });
  }
  if (err.status === 423 && b.scope === 'device') {
    return t('Too many failed sign-ins from this device. Sign-in from it is paused for {minutes} min.', { minutes: b.minutes ?? 15 });
  }
  if (err.status === 423) {
    return t('Too many wrong passwords. This account is locked for {minutes} min. Try again later, or ask an administrator to unlock it.', { minutes: b.minutes ?? 15 });
  }
  if (err.status === 401 && b.attempts_left === 1) {
    return t('Incorrect password. 1 attempt left before the account is locked.');
  }
  if (err.status === 401 && b.attempts_left) {
    return t('Incorrect password. {count} attempts left before the account is locked.', { count: b.attempts_left });
  }
  return err.message;
}

export default function Login() {
  const { boot, signIn, signOut, toast, user } = useApp();
  const navigate = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set on every failed attempt and cleared when the animation ends, so the
  // shake replays each time without remounting (and unfocusing) the inputs.
  const [shake, setShake] = useState(false);
  const [slides, setSlides] = useState([]);
  const [hero, setHero] = useState(null);
  const [recovering, setRecovering] = useState(false);
  // Signed in with a password just now, and being offered fingerprint / face.
  const [offer, setOffer] = useState(null);
  // Password accepted, waiting for the authenticator app's code.
  const [ticket, setTicket] = useState(null);
  const emailRef = useRef(null);

  useEffect(() => {
    let live = true;
    const loadPhotos = async () => {
      const first = await api.publicPlants({ sort: 'recent', limit: 100 });
      const plants = [...(first.results || [])];
      for (let offset = plants.length; offset < (first.total || 0); offset += first.limit) {
        const page = await api.publicPlants({ sort: 'recent', limit: first.limit, offset });
        plants.push(...(page.results || []));
      }
      if (!live) return;
      const withPhotos = plants
        .filter((p) => plantPhoto(p))
        .map((p) => ({
          id: p.id,
          src: plantPhoto(p),
          fallback: realPhoto(p.photo) ? realPhoto(p.photo_remote) : undefined,
          tint: p.photo_tint,
          credit: p.photo_credit,
        }));
      for (let i = withPhotos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [withPhotos[i], withPhotos[j]] = [withPhotos[j], withPhotos[i]];
      }
      setSlides(withPhotos);
    };
    loadPhotos().catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => { if (!user) emailRef.current?.focus(); }, [user]);

  const land = (u) => navigate(loc.state?.from || homeFor(u), { replace: true });

  /** Signed in at last, by password alone or password and code. */
  const signedIn = async (u) => {
    toast(t('Signed in as {name}', { name: u.full_name }));
    // First password sign-in on a device that can: offer fingerprint / face for next time.
    if (await shouldOfferPasskey(u)) { setOffer(u); setBusy(false); return; }
    land(u);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await signIn(email, password);
      // Right password, two-step verification on: now the authenticator code.
      if (r.twoFactor) { setTicket(r.twoFactor); setBusy(false); return; }
      await signedIn(r);
    } catch (err) {
      setError(describe(err));
      setShake(true);
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    await signOut();
    setEmail(''); setPassword(''); setError(null);
  };

  const onKey = (e) => setCaps(!!e.getModifierState?.('CapsLock'));

  const park = boot?.park_name ? t(boot.park_name) : t('Niah National Park');

  return (
    <div className="signin">
      <aside className="signin-art">
        {slides.length > 0 && (
          <PhotoSlideshow items={slides} interval={6500} fadeMs={1400} onChange={setHero} />
        )}
        <div className="signin-art-inner">
          <Link to="/" className="signin-brand">
            <img src="/icons/icon-192.png" alt="" width="40" height="40" />
            <span>
              <strong>FloraScan</strong>
              <em>{t('{park}, Sarawak', { park })}</em>
            </span>
          </Link>

          <div className="signin-quote">
            <h2>{t('Every plant on the trail, recorded and verified.')}</h2>
            <ul className="signin-roles">
              <li><span>{t('Administrator')}</span>{t('Staff accounts and settings')}</li>
              <li><span>{t('Botanist')}</span>{t('Registers and identifies plants')}</li>
              <li><span>{t('Reviewer')}</span>{t('Checks every record before it is published')}</li>
              <li><span>{t('Ranger')}</span>{t('Responds to sensor alerts in the field')}</li>
            </ul>
          </div>
        </div>
        {/* Creative Commons photographs: the credit travels with the image. */}
        {hero?.credit && <span className="signin-credit">{hero.credit}</span>}
      </aside>

      <main className="signin-panel">
        <div className="signin-card">
          <div className="signin-eyebrow"><I.Lock /> {t('Staff portal')}</div>

          {/* Ahead of the signed-in view: recovering signs the user in, and the
              new recovery code must stay on screen until they have saved it. */}
          {offer ? (
            <PasskeyOffer user={offer} onDone={() => land(offer)} />
          ) : ticket ? (
            <TwoFactorStep
              ticket={ticket} email={email}
              onSignedIn={signedIn}
              onBack={() => { setTicket(null); setPassword(''); }}
            />
          ) : recovering ? (
            <Recover initialEmail={email} onBack={() => setRecovering(false)} />
          ) : user ? (
            <>
              <h1>{t('You are signed in')}</h1>
              <div className="signin-who">
                <Avatar name={user.full_name} role={user.role} />
                <span>
                  <strong>{user.full_name}</strong>
                  <em>{roleLabel(user.role_label)}{user.title ? ' · ' + user.title : ''}</em>
                </span>
              </div>
              <button className="btn btn-primary btn-lg btn-block signin-submit" onClick={() => land(user)}>
                {t('Continue to your dashboard')} <I.ChevronRight />
              </button>
              <button className="btn btn-lg btn-block signin-secondary" onClick={switchAccount}>
                <I.Logout /> {t('Sign out and use another account')}
              </button>
            </>
          ) : (
            <>
              <h1>{t('Welcome back')}</h1>
              <p className="signin-lead">{t('Sign in with the email address and password your administrator gave you.')}</p>

              <form onSubmit={submit} noValidate>
                <div
                  className={'signin-fields' + (error ? ' is-error' : '') + (shake ? ' is-shaking' : '')}
                  onAnimationEnd={() => setShake(false)}
                >
                  <label className="signin-field">
                    <span className="signin-label">{t('Email address')}</span>
                    <span className="signin-control">
                      <I.Mail />
                      <input
                        // "webauthn" lets the browser offer a saved fingerprint / face sign-in here.
                        ref={emailRef} type="email" inputMode="email" autoComplete="username webauthn"
                        value={email} onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@florascan.test" required aria-invalid={!!error}
                      />
                    </span>
                  </label>

                  <label className="signin-field">
                    <span className="signin-label">{t('Password')}</span>
                    <span className="signin-control">
                      <I.Lock />
                      <input
                        type={reveal ? 'text' : 'password'} autoComplete="current-password"
                        value={password} onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={onKey} onKeyUp={onKey}
                        required aria-invalid={!!error}
                      />
                      <button
                        type="button" className="signin-reveal"
                        onClick={() => setReveal((r) => !r)}
                        aria-label={reveal ? t('Hide password') : t('Show password')}
                        title={reveal ? t('Hide password') : t('Show password')}
                      >
                        {reveal ? <I.EyeOff /> : <I.Eye />}
                      </button>
                    </span>
                  </label>
                </div>

                {caps && !error && <div className="signin-note"><I.Alert /> {t('Caps Lock is on')}</div>}
                {error && <div className="signin-error" role="alert"><I.Alert /> {error}</div>}

                <button className="btn btn-primary btn-lg btn-block signin-submit" disabled={busy || !email || !password}>
                  {busy ? <><span className="spinner" /> {t('Signing in...')}</> : <>{t('Sign in')} <I.ChevronRight /></>}
                </button>
              </form>

              <PasskeySignIn
                onError={setError}
                onSignedIn={(u) => { toast(t('Signed in as {name}', { name: u.full_name })); land(u); }}
              />

              <p className="signin-help">
                <button type="button" className="signin-link" onClick={() => { setError(null); setRecovering(true); }}>
                  {t('Forgot your password?')}
                </button>
              </p>
            </>
          )}

          <Link to="/" className="signin-back"><I.ArrowLeft /> {t('Back to the public register')}</Link>
        </div>
      </main>
    </div>
  );
}
