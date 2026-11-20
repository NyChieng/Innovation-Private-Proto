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
/**
 * A tint derived from the source path, used behind the image while it loads.
 * A photograph resolving out of a related green reads as the picture arriving;
 * the same grey box everywhere reads as something being broken.
 */
function tintFor(src) {
  if (!src) return null;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = 95 + ((h >>> 0) % 55) - 20;
  return `hsl(${hue} 22% 26%)`;
}

export function SmartImage({
  src, alt = '', fallback, tint, className = '', ratio, style, eager = false, ...rest
}) {
  const [state, setState] = useState('loading'); // loading | ready | failed
  const [current, setCurrent] = useState(src);
  const triedFallback = useRef(false);
  const imgRef = useRef(null);

  useEffect(() => {
    setCurrent(src);
    setState('loading');
    triedFallback.current = false;
  }, [src]);

  /*
   * An image served from cache - a back-navigation, or the service worker -
   * can finish before React attaches onLoad, and the load event never fires.
   * Without this check those images stay at opacity 0 forever, which looks
   * exactly like a broken photo. So ask the element directly once it mounts.
   */
  useEffect(() => {
    const img = imgRef.current;
    if (!img || state !== 'loading') return undefined;

    let cancelled = false;
    const settle = () => { if (!cancelled) setState('ready'); };

    if (img.complete) {
      if (img.naturalWidth > 0) {
        // decode() resolves once it can be painted, so there is no half-drawn frame.
        if (img.decode) img.decode().then(settle, settle);
        else settle();
      } else if (!triedFallback.current && fallback) {
        triedFallback.current = true;
        setCurrent(fallback);
      } else {
        setState('failed');
      }
    }
    return () => { cancelled = true; };
  }, [current, state, fallback]);

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
      className={[
        'smart-img',
        state === 'ready' ? 'is-ready' : '',
        state === 'failed' ? 'is-failed' : '',
        className,
      ].filter(Boolean).join(' ')}
      // A measured average beats a guess from the filename, but either is
      // better than a grey box.
      style={{ aspectRatio: ratio, '--tint': tint || tintFor(current), ...style }}
    >
      {current && (
        <img
          ref={imgRef}
          src={current}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          // The hero is the one image worth fetching ahead of everything else.
          fetchpriority={eager ? 'high' : undefined}
          decoding="async"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.decode) img.decode().then(() => setState('ready'), () => setState('ready'));
            else setState('ready');
          }}
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
    const timer = setTimeout(() => { setKey(k); setPhase('in'); }, 125);
    return () => clearTimeout(timer);
  }, [k, key]);

  return <div className={`page-fade page-fade-${phase}`} key={key}>{children}</div>;
}

/* ------------------------------------------------------------------ */

/**
 * Top forest-green progress shimmer bar that sweeps across on every route
 * change so page navigation feels responsive and tactile.
 */
export function RouteProgress({ k }) {
  const [phase, setPhase] = useState('idle'); // idle | run | done
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    if (reduced()) return undefined;
    setPhase('run');
    const t1 = setTimeout(() => setPhase('done'), 240);
    const t2 = setTimeout(() => setPhase('idle'), 560);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [k]);

  if (phase === 'idle') return null;
  return <div className={`route-progress is-${phase} no-print`} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */

/**
 * Thin GPU-accelerated reading progress bar pinned under the sticky header.
 * Tracks vertical scroll position cleanly via transform: scaleX().
 */
export function ScrollProgress() {
  const barRef = useRef(null);

  useEffect(() => {
    if (reduced()) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = barRef.current;
      if (!el) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 40 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      el.style.transform = `scaleX(${ratio.toFixed(4)})`;
      el.style.opacity = ratio > 0.005 ? '1' : '0';
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return <div className="scroll-progress no-print" ref={barRef} aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */

/**
 * Subtle vertical parallax offset for hero artwork while scrolling down.
 * Bounded so the background never exposes empty gaps or causes overflow.
 */
export function useParallax(ref, factor = 0.18, maxPx = 70) {
  useEffect(() => {
    if (reduced()) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const y = Math.min(maxPx, Math.max(0, window.scrollY * factor));
      el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [ref, factor, maxPx]);
}

/* ------------------------------------------------------------------ */

/**
 * Subtle 3D tilt + pointer-following specular glare for interactive plant cards.
 * Active only on hover-capable pointers and disabled under reduced motion.
 */
export function useCardTilt() {
  const canHover = () =>
    typeof window !== 'undefined'
    && !reduced()
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const onPointerMove = (e) => {
    if (!canHover()) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const rx = ((0.5 - py) * 5.5).toFixed(2);
    const ry = ((px - 0.5) * 6.5).toFixed(2);
    el.style.setProperty('--rx', `${rx}deg`);
    el.style.setProperty('--ry', `${ry}deg`);
    el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
  };

  const onPointerLeave = (e) => {
    const el = e.currentTarget;
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
  };

  return { onPointerMove, onPointerLeave };
}

/* ------------------------------------------------------------------ */

function preloadImageUrl(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok ? url : null);
    };
    img.onload = () => {
      if (img.decode) img.decode().then(() => finish(true), () => finish(true));
      else finish(true);
    };
    img.onerror = () => finish(false);
    img.src = url;
    if (img.complete && img.naturalWidth > 0) {
      if (img.decode) img.decode().then(() => finish(true), () => finish(true));
      else finish(true);
    }
  });
}

async function resolveSlide(item) {
  if (!item) return null;
  const primary = item.src || item.photo || null;
  const fallback = item.fallback || item.photo_remote || null;
  if (primary) {
    const ok = await preloadImageUrl(primary);
    if (ok) return { ...item, resolvedUrl: ok };
  }
  if (fallback && fallback !== primary) {
    const ok = await preloadImageUrl(fallback);
    if (ok) return { ...item, resolvedUrl: ok };
  }
  return null;
}

/**
 * Double-buffered, GPU-composited crossfading slideshow for collected plant
 * photographs. Preloads and decodes each upcoming photo (automatically falling
 * back from local `src` to `fallback`) before crossfading, so transitions stay
 * completely fluid with zero blink or stutter.
 */
export function PhotoSlideshow({
  items,
  interval = 6500,
  fadeMs = 1400,
  className = '',
  onChange,
}) {
  const [layers, setLayers] = useState([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!items?.length) return undefined;

    let cancelled = false;
    let uid = 0;
    let cursor = 0;
    let activeId = null;
    let cycleTimer = 0;
    let cleanupTimer = 0;
    let raf1 = 0;
    let raf2 = 0;
    let visHandler = null;

    const nextReadySlide = async () => {
      const total = items.length;
      for (let tries = 0; tries < total; tries++) {
        if (cancelled) return null;
        const idx = cursor % total;
        cursor += 1;
        const candidate = items[idx];
        if (!candidate) continue;
        if (total > 1 && activeId !== null && candidate.id === activeId) continue;
        const resolved = await resolveSlide(candidate);
        if (cancelled) return null;
        if (resolved) return resolved;
      }
      return null;
    };

    const showSlide = (slide) => {
      if (cancelled || !slide) return;
      activeId = slide.id ?? slide.resolvedUrl;
      const myUid = ++uid;
      const immediate = reduced();
      const newLayer = { uid: myUid, url: slide.resolvedUrl, item: slide, visible: immediate };

      setLayers((prev) => {
        const currentTop = prev.length ? prev[prev.length - 1] : null;
        return currentTop && !immediate ? [currentTop, newLayer] : [newLayer];
      });
      onChangeRef.current?.(slide);

      if (immediate) return;

      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (cancelled) return;
          setLayers((prev) => prev.map((l) => (l.uid === myUid ? { ...l, visible: true } : l)));
        });
      });

      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => {
        if (cancelled) return;
        setLayers((prev) => (prev.length > 1 ? [prev[prev.length - 1]] : prev));
      }, fadeMs + 220);
    };

    const scheduleNext = () => {
      if (cancelled || items.length < 2 || reduced()) return;
      // Preload and decode the upcoming slide in the background so the swap
      // starts on the exact frame with zero network or decode jank.
      const preloadedPromise = nextReadySlide();

      const advance = async () => {
        const ready = await preloadedPromise;
        if (cancelled) return;
        if (ready) showSlide(ready);
        scheduleNext();
      };

      cycleTimer = setTimeout(() => {
        if (cancelled) return;
        if (document.hidden) {
          visHandler = () => {
            if (!document.hidden) {
              document.removeEventListener('visibilitychange', visHandler);
              visHandler = null;
              if (!cancelled) advance();
            }
          };
          document.addEventListener('visibilitychange', visHandler);
          return;
        }
        advance();
      }, interval);
    };

    nextReadySlide().then((first) => {
      if (cancelled || !first) return;
      showSlide(first);
      scheduleNext();
    });

    return () => {
      cancelled = true;
      clearTimeout(cycleTimer);
      clearTimeout(cleanupTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    };
  }, [items, interval, fadeMs]);

  return (
    <div
      className={`slideshow${className ? ' ' + className : ''}`}
      style={{ '--slide-fade': `${fadeMs}ms` }}
      aria-hidden="true"
    >
      {layers.map((layer) => (
        <div
          key={layer.uid}
          className={`slideshow-layer${layer.visible ? ' is-visible' : ''}`}
        >
          <img src={layer.url} alt="" decoding="async" />
        </div>
      ))}
    </div>
  );
}
