# FloraScan: rate limits and security headers

## What changed

`Server/security.js` defines the four request budgets and configures Helmet's HTTP security headers. `Server/api.js` installs the rate-limit router **before** the JSON parser and authentication middleware. `Server/index.js` installs the headers before the API, static files, and Vite.

```text
Request → security headers → API rate limits → JSON parsing → authentication → route handler
```

An over-budget request stops at the rate limiter. It does not reach JSON decoding, session database queries, password checking, or photo processing. The limiter counts attempts even if the request would later fail validation or permission checks.

| Category | Endpoint | Default allowance per client IP |
| --- | --- | --- |
| General API | Every request under `/api`, including unknown routes | 300 per minute |
| Login | `POST /api/auth/login` and `POST /api/auth/switch`, sharing one counter | 10 per 15 minutes |
| Password reset | `POST /api/users/:id/reset-password`, sharing a counter across target users | 5 per 15 minutes |
| Upload | `POST /api/plants`, which accepts registration photographs | 10 per minute |

The general limit also applies to the three specific categories. Successful and failed attempts both count. Counters are separate per category; changing an email, target user ID, or URL letter case does not create a new budget. IPv6 clients are grouped by /56 through express-rate-limit's default IP key generator.

The existing reset endpoint is an **administrator action**, not a public forgot-password flow. The existing upload size limits and role permissions still apply. The upload budget covers all plant-registration requests, even those without photographs.

## Run the classroom demonstration

From the repository root, using Node 22.12 or later:

```sh
npm ci
npm run test:security
npm run demo:security
```

No MySQL connection or `.env` is required for these two commands. They create temporary servers bound only to localhost and use the **real API router and normal rate-limit values**. They do not start the main application, log in, reset anyone's password, upload files, or modify records. The demonstration closes its servers and removes temporary certificate files afterward.

Expected results:

| Demonstration | First requests | First blocked request |
| --- | --- | --- |
| Login | 1–10: `400` (deliberately malformed JSON) | 11: `429` |
| Reset | 1–5: `401` (anonymous, so no password changes) | 6: `429` |
| Upload | 1–10: `401` (anonymous, so nothing is stored) | 11: `429` |
| API | 1–300: `404` (a harmless missing endpoint) | 301: `429` |

Explain that `400`, `401`, and `404` mean the request reached normal API handling. `429` proves the rate limiter stopped the request first. Each category uses a fresh isolated server, so the general counter does not interfere with the individual demonstrations.

A blocked response includes JSON in the same `error` format the UI already displays:

```json
{
  "error": "Too many login requests. Try again in 900 seconds.",
  "code": "RATE_LIMITED",
  "policy": "login",
  "retryAfter": 900
}
```

`Retry-After` is the number of seconds left before retrying. `RateLimit` and `RateLimit-Policy` describe the remaining budgets using draft-8 headers. `Cache-Control: no-store` prevents ordinary HTTP caching of a rejection. The service worker also avoids saving failed photo responses, so a temporary `429` cannot become a permanently cached broken photo. Its cache version was bumped to refresh documents with the new headers.

The final part of the demonstration creates a real HTTPS server and prints its headers. The client verifies the certificate using a temporary local CA; it does not turn off TLS verification. This proves header delivery, not browser HSTS enforcement.

## Show the headers in the application

Start MySQL and use the project's existing local database configuration. Then:

```sh
npm run build
npm run preview
```

`preview` runs the production build and defaults to HTTPS. Open the address printed by the server. For browser security features, trust the local CA using the app's existing connection instructions. Open Developer Tools → Network, reload, select the HTML document, and inspect **Response Headers**. If a previously installed app serves old content, unregister its service worker/clear that site's cache and reload once.

| Header or directive | What to explain |
| --- | --- |
| `Content-Security-Policy: … script-src 'self' …` | Production JavaScript must come from this origin; injected inline scripts and `eval` are not allowed. This reduces XSS impact, but does not replace input validation/output escaping. |
| `frame-ancestors 'none'` and `X-Frame-Options: DENY` | Other pages cannot frame the app and trick someone into clicking its controls. |
| `Strict-Transport-Security: max-age=31536000` | On production HTTPS, tells a supporting browser to remember HTTPS for one year. |
| `X-Content-Type-Options: nosniff` | Stops browsers from guessing a different file type. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Limits information sent to another site through the Referer header. |
| `Permissions-Policy: camera=(self), geolocation=(self), microphone=()` | Keeps the scanner and location features available on this origin while disabling microphone use. Users still grant camera/location permission. |

External HTTPS plant images and local/data/blob image previews are allowed. Inline CSS remains allowed because the React interface uses style attributes. That CSS exception does not allow inline JavaScript. API connections and service workers remain same-origin in production.

### Demonstrate blocked script injection

Use the **production build** above. In Developer Tools → Console, run this harmless probe:

```js
delete document.documentElement.dataset.cspDemo;
const probe = document.createElement('script');
probe.textContent = "document.documentElement.dataset.cspDemo = 'executed'";
document.head.appendChild(probe);
document.documentElement.dataset.cspDemo;
```

Expected: the last value is `undefined`, and the Console reports that an inline script was blocked by CSP. Directly typing code in DevTools is privileged; the test is whether the newly inserted `<script>` executes. Do not use `alert()` alone as a CSP test.

### Demonstrate clickjacking prevention

Open [`frame-demo.html`](frame-demo.html) as a local file in your browser. Enter the running app's address and click **Try embedding**. The app must first load normally in its own tab, so certificate problems do not confuse the result. The framed app should be refused, with a Console message citing `frame-ancestors` or `X-Frame-Options`. A blank frame by itself is not sufficient evidence.

### Explain HSTS accurately

HSTS is sent only when both production mode and HTTPS are active. Development mode and plain HTTP omit it, so local HTTP testing does not accidentally pin the machine to HTTPS. The header does not set up TLS or redirect the first HTTP visit: the deployment's HTTPS listener/reverse proxy must handle that. Browser enforcement requires a trusted certificate and a supported hostname; IP-address demos and ignored certificate warnings do not demonstrate enforcement. No `includeSubDomains` or preload is requested because this project does not control every possible subdomain.

Development keeps CSP active but allows Vite's inline React refresh preamble and `ws:`/`wss:` hot reload connections. Use `npm run preview`, not `npm run dev`, when demonstrating production script restrictions.

## Suggested explanation to the teacher

“I added security middleware at the beginning of the Express request flow. The rate limiter keeps a separate counter for each client IP and action. If the client exceeds its allowance, the server returns HTTP 429 with a retry time before doing expensive work. I also set browser security headers: CSP restricts script sources, framing restrictions help prevent clickjacking, and HSTS remembers HTTPS in production. My demonstration uses the actual middleware and API router without changing database records.”

## Deployment and testing notes

- Direct connections ignore forwarded IP/HTTPS headers. If a reverse proxy terminates TLS, set `TRUST_PROXY` to its actual source IP/CIDR (for example, `loopback` for a proxy on the same machine). The proxy must overwrite forwarded headers and the backend should accept connections only from it. Do not use `true`, hop counts, or all-addresses subnets. Incorrect proxy settings can group all visitors together or let clients spoof their IP.
- The default counters live in one Node process and reset on restart. Use a shared store, such as Redis with separate prefixes for each policy, before running multiple instances. Users behind one public IP share the allowance. Application rate limiting does not replace edge/network DDoS protection or a concurrent-upload cap.
- These changes do not redesign the existing demo authentication, including account switching and demo passwords. Rate-limiting those routes does not make the demo login model appropriate for public production use.
- The security suite checks the actual API without SQL: boundaries, shared buckets, route variants, concurrent attempts, recovery after expiry, separate clients/IPv6 grouping, trusted proxies, HTTP/HTTPS headers, and service-worker error caching. It does not validate successful database writes or browser policy enforcement.
- The older `npm test` workflow invokes `pretest`, which reseeds its configured database, and its API/UI suites generate enough traffic to encounter these new limits. Run the independent `test:security` command for this demonstration. Full integration runs need an isolated database and pacing to respect the quotas; they are not proof that production throttling should be disabled.

References: [express-rate-limit configuration](https://express-rate-limit.mintlify.app/reference/configuration), [Helmet reference](https://helmetjs.github.io/), [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies.html).
