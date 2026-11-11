import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

// Each policy has its own counter. All requests (including failed ones) count.
// The default MemoryStore is for this prototype's single Node process.
export const RATE_LIMITS = Object.freeze({
  api: Object.freeze({ limit: 300, windowMs: 60_000 }),
  login: Object.freeze({ limit: 10, windowMs: 15 * 60_000 }),
  passwordReset: Object.freeze({ limit: 5, windowMs: 15 * 60_000 }),
  upload: Object.freeze({ limit: 10, windowMs: 60_000 }),
});

export function createApiRateLimits() {
  const router = express.Router();
  const limiter = (name) => rateLimit({
    ...RATE_LIMITS[name],
    identifier: name,
    // Keep the library's IP key generator, including IPv6 /56 grouping.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      const retryAfter = Number(res.getHeader('Retry-After'));
      res.set('Cache-Control', 'no-store');
      res.status(429).json({
        error: `Too many ${name === 'passwordReset' ? 'password reset' : name} requests. Try again in ${retryAfter} seconds.`,
        code: 'RATE_LIMITED',
        policy: name,
        retryAfter,
      });
    },
  });

  router.use(limiter('api'));
  // Use Express's route matching, so case and trailing-slash variants cannot
  // bypass a limit. Both ways of signing in share ONE login counter.
  router.post(['/auth/login', '/auth/switch'], limiter('login'));
  // A fixed per-IP bucket across all target IDs prevents ID rotation bypasses.
  router.post('/users/:id/reset-password', limiter('passwordReset'));
  // Registration is the endpoint that accepts base64 photograph uploads.
  router.post('/plants', limiter('upload'));
  return router;
}

/** Install before API, static files, SPA fallbacks, and Vite middleware. */
export function configureSecurity(app, { production = false, trustProxy = '' } = {}) {
  app.disable('x-powered-by');

  // Never trust forwarded IP/scheme headers just because NODE_ENV=production.
  // Use explicit proxy addresses/subnets, rather than a spoofable hop count.
  const proxies = trustProxy.split(',').map((value) => value.trim()).filter(Boolean);
  if (proxies.some((value) => /^(true|false|\*|\d+)$/i.test(value) || /\/0$/.test(value))) {
    throw new Error('TRUST_PROXY must list trusted proxy IPs/CIDRs (or loopback), not a boolean, wildcard, or hop count.');
  }
  app.set('trust proxy', proxies.length ? proxies : false);

  const headers = (secureProduction) => helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        // Vite's React refresh preamble is inline in development only.
        scriptSrc: production ? ["'self'"] : ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'none'"],
        // React uses style attributes; this exception does NOT allow scripts.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'"],
        connectSrc: production ? ["'self'"] : ["'self'", 'ws:', 'wss:'],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: secureProduction ? [] : null,
      },
    },
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HTTPS production only: don't pin classroom localhost/LAN HTTP demos.
    strictTransportSecurity: secureProduction
      ? { maxAge: 31_536_000, includeSubDomains: false, preload: false }
      : false,
  });
  const secureHeaders = headers(true);
  const otherHeaders = headers(false);
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
    const middleware = production && req.secure ? secureHeaders : otherHeaders;
    middleware(req, res, next);
  });
}
