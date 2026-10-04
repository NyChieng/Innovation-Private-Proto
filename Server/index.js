import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';
import qrTerminal from 'qrcode-terminal';

import { seed } from './seed.js';
import { createApi } from './api.js';
import { initPersistence, closePersistence, persistenceMiddleware } from './persist.js';
import { resolvePort } from './port.js';
import { lanAddresses } from './net.js';
import { tlsOptions, caDer, CA_PATH } from './certs.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Node reads .env itself since v20.6, so there is no dotenv dependency here.
// Real environment variables win, which is what a host expects.
try {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch { /* a malformed .env should not stop the prototype starting */ }
const argv = process.argv.slice(2);
// HTTPS by default. A phone browser refuses the camera, geolocation and the
// install prompt on a plain http:// LAN address, which is most of what this
// prototype is for. Pass --http if you specifically want plain HTTP.
const useHttps = !argv.includes('--http');
const prod = argv.includes('--prod') || process.env.NODE_ENV === 'production';

/* ------------------------------------------------------------------ */

seed();

// With DATABASE_URL set, a saved snapshot replaces the seeded data. Without
// it this does nothing and the prototype stays in memory, as before.
let persistence = null;
try {
  persistence = await initPersistence();
} catch (err) {
  console.error(`\n  Could not reach the database: ${err.message}`);
  console.error('  Carrying on in memory - the demo works, but nothing is saved.\n');
}

const app = express();
app.disable('x-powered-by');

// Hosted behind a platform's proxy, the only truthful account of the public
// scheme and host is in the forwarded headers - the app itself sees plain HTTP
// on a private container address. Trusting them locally would let any caller
// spoof the origin, so this is production only.
if (prod) app.set('trust proxy', 1);

app.use('/api', persistenceMiddleware);
app.use('/api', createApi());

/* ------------------------------------------------------------------ */

const port = await resolvePort();
const scheme = useHttps ? 'https' : 'http';
app.set('protoPort', port);
app.set('protoScheme', scheme);

// Signed by a local CA kept in .certs/ (see server/certs.js).
const tls = useHttps ? tlsOptions(path.join(root, '.certs'), lanAddresses().map((a) => a.address)) : null;
const server = useHttps
  ? https.createServer({ key: tls.key, cert: tls.cert }, app)
  : http.createServer(app);

// The CA's public certificate, for a phone to install and trust. Never the key.
app.set('protoCaPath', tls ? CA_PATH : null);
if (tls) {
  const der = caDer(tls.ca);
  app.get(CA_PATH, (req, res) => {
    res.set({
      'Content-Type': 'application/x-x509-ca-cert',
      // Inline, so iOS hands it to its profile installer by MIME type
      // rather than saving it to Files.
      'Content-Disposition': 'inline; filename="florascan-ca.crt"',
      'Cache-Control': 'no-store',
    });
    res.send(der);
  });
}

/*
 * The app is mounted after the server exists so that Vite's hot-reload
 * websocket can share it. Left to itself, Vite opens a second, plain-ws
 * port, which a page served over HTTPS refuses to connect to - the console
 * fills with SSL errors and hot reload silently stops working.
 */
if (prod) {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('\n  No dist/ build found. Run "npm run build" first, or use "npm run dev".\n');
    process.exit(1);
  }
  app.use(express.static(dist, { index: false }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    // Vite looks for its config inside `root` by default, and root is the web
    // app folder - so without this it finds no config, loads no plugins, and
    // the React JSX transform never runs. The page then dies on "React is not
    // defined", which looks nothing like a missing config file.
    configFile: path.join(root, 'vite.config.js'),
    // The React app, not the repository root. Vite takes its index.html and
    // its public/ folder from here.
    root: path.join(root, 'FloraScan-Web-App'),
    appType: 'spa',
    server: {
      middlewareMode: true,
      // Reuse this server for HMR, so it inherits the TLS and the port.
      hmr: { server },
    },
  });
  app.use(vite.middlewares);
}

server.listen(port, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const lan = addrs[0]?.address;
  const localUrl = `${scheme}://localhost:${port}`;
  const lanUrl = lan ? `${scheme}://${lan}:${port}` : null;

  const line = (s = '') => console.log('  ' + s);
  console.log('');
  line('\x1b[1m\x1b[32mFloraScan\x1b[0m  Prototype X - Smart Ground-Truthing & Digital Biodiversity System');
  line('\x1b[2mCOS30049 Computing Technology Innovation Project - NeuonAI / Niah National Park\x1b[0m');
  console.log('');
  line(`\x1b[1mThis computer\x1b[0m   ${localUrl}`);
  if (lanUrl) {
    line(`\x1b[1mPhone / tablet\x1b[0m  \x1b[36m${lanUrl}\x1b[0m   (same Wi-Fi or hotspot)`);
  }
  line(`\x1b[2mOpen ${localUrl}/connect for a scannable QR code and mobile hand-off.\x1b[0m`);
  console.log('');

  if (lanUrl) {
    line('\x1b[2mScan to open on your phone:\x1b[0m');
    qrTerminal.generate(lanUrl, { small: true }, (qr) => {
      console.log(qr.split('\n').map((l) => '   ' + l).join('\n'));
      footer(line);
    });
  } else {
    footer(line);
  }
});

function footer(line) {
  if (!useHttps) {
    line('\x1b[33mPlain HTTP: the phone camera, GPS and Add to Home Screen will not work.\x1b[0m');
    line('\x1b[2mDrop the --http flag to serve over HTTPS instead.\x1b[0m');
  } else {
    if (tls.reissued) line(`\x1b[2mServer certificate issued (${tls.reissued}).\x1b[0m`);
    line('\x1b[2mLocal certificate - every browser warns once, then remembers:\x1b[0m');
    line('\x1b[2m  Chrome / Android   Advanced  >  Proceed to ...\x1b[0m');
    line('\x1b[2m  Safari / iOS       Show Details  >  visit this website\x1b[0m');
    line('\x1b[2mAccept it once and the camera, GPS and home-screen install all work.\x1b[0m');
    line('\x1b[2mFor the iPhone home-screen icon, trust the certificate: see /connect.\x1b[0m');
  }
  line(process.env.PORT
    ? `\x1b[2mPort ${port} comes from the PORT variable and is not saved.\x1b[0m`
    : `\x1b[2mPort ${port} is saved in proto.config.json - "npm run port" picks a new one.\x1b[0m`);
  line(persistence
    ? `\x1b[2mSaved state: ${persistence}\x1b[0m`
    : '\x1b[2mIn memory only - set DATABASE_URL in .env to keep data across restarts.\x1b[0m');
  console.log('');
}

// A redeploy or a Ctrl-C should not lose the last couple of seconds of edits,
// which are still sitting in the debounce window.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await closePersistence();
    process.exit(0);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Run "npm run port" to pick another.\n`);
    process.exit(1);
  }
  throw err;
});
