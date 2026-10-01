import { useEffect, useRef, useState } from 'react';

/**
 * Motion helpers.
 *
 * The rule here is that movement should explain something — that content has
 * arrived, that an image has finished loading, that a number is a running
 * total. Nothing moves just to look busy, and everything obeys
 * prefers-reduced-motion, where each effect collapses to its finished state.
 */

const reduced = () =>
  typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */

/**
 * Fades and lifts its children into place the first time they are scrolled
 * near. `index` staggers a list so the eye follows it left to right.
 */
export function Reveal({ children, index = 0, as: Tag = 'div', className = '', style, ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(() => reduced());

  useEffect(() => {
    if (shown) return undefined;
    const el = ref.current;
    if (!el) return undefined;

    if (!('IntersectionObserver' in window)) { setShown(true); return undefined; }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setShown(true); io.disconnect(); }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={`reveal${shown ? ' is-in' : ''}${className ? ' ' + className : ''}`}
      style={{ '--reveal-delay': `${Math.min(index, 10) * 45}ms`, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Counts up to `value`. Used only for the headline figures, where watching
 * the number settle tells you it is a live count rather than a caption.
 */
export function CountUp({ value, duration = 900, format = (n) => n.toLocaleString('en-GB') }) {
  const [n, setN] = useState(() => (reduced() ? value : 0));
  const ref = useRef(null);
  const started = useRef(false);

  useEffect(() => {
    if (reduced()) { setN(value); return undefined; }
    const el = ref.current;
    if (!el) return undefined;

    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        // easeOutExpo: fast start, gentle settle
        const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        setN(Math.round(value * eased));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    if (!('IntersectionObserver' in window)) { setN(value); return undefined; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !started.current) { started.current = true; run(); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(el);

    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, duration]);

  return <span ref={ref} className="tabular">{format(n)}</span>;
}

/* ------------------------------------------------------------------ */

/**
 * An image that fades up once decoded, over a tinted placeholder, so a slow
 * photograph never lands as a white flash. Falls back to a generated
 * illustration if the file is missing.
 */
export function SmartImage({ src, alt = '', fallback, className = '', ratio, style, ...rest }) {
  const [state, setState] = useState('loading'); // loading | ready | failed
  const [current, setCurrent] = useState(src);
  const triedFallback = useRef(false);

  useEffect(() => {
    setCurrent(src);
    setState('loading');
    triedFallback.current = false;
  }, [src]);

  const onError = () => {
    if (fallback && !triedFallback.current) {
      triedFallback.current = true;
      setCurrent(fallback);
      return;
    }
    setState('failed');
  };

  return (
    <span
      className={`smart-img${state === 'ready' ? ' is-ready' : ''}${className ? ' ' + className : ''}`}
      style={{ aspectRatio: ratio, ...style }}
    >
      {current && (
        <img
          src={current}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ready')}
          onError={onError}
          {...rest}
        />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** Re-runs its entrance animation whenever `k` changes (used per route). */
export function PageTransition({ k, children }) {
  const [key, setKey] = useState(k);
  const [phase, setPhase] = useState('in');

  useEffect(() => {
    if (k === key) return undefined;
    if (reduced()) { setKey(k); return undefined; }
    setPhase('out');
    const t = setTimeout(() => { setKey(k); setPhase('in'); }, 110);
    return () => clearTimeout(t);
  }, [k, key]);

  return <div className={`page-fade page-fade-${phase}`} key={key}>{children}</div>;
}
