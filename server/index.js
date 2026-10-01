import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import express from 'express';
import qrTerminal from 'qrcode-terminal';

import { seed } from './seed.js';
import { createApi } from './api.js';
import { resolvePort } from './port.js';
import { lanAddresses } from './net.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
// HTTPS by default. A phone browser refuses the camera, geolocation and the
// install prompt on a plain http:// LAN address, which is most of what this
// prototype is for. Pass --http if you specifically want plain HTTP.
const useHttps = !argv.includes('--http');
const prod = argv.includes('--prod') || process.env.NODE_ENV === 'production';

/* ------------------------------------------------------------------ */

seed();

const app = express();
app.disable('x-powered-by');

app.use('/api', createApi());

/* ------------------------------------------------------------------ */

async function tlsOptions() {
  const dir = path.join(root, '.certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const { generate } = await import('selfsigned').then((m) => ({ generate: m.default.generate }));
  const altNames = [
    { type: 2, value: 'localhost' },
    ...lanAddresses().map((a) => ({ type: 7, ip: a.address })),
    { type: 7, ip: '127.0.0.1' },
  ];
  const pems = generate([{ name: 'commonName', value: 'FloraScan Prototype' }], {
    days: 365, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const port = await resolvePort();
const scheme = useHttps ? 'https' : 'http';
app.set('protoPort', port);
app.set('protoScheme', scheme);

const server = useHttps
  ? https.createServer(await tlsOptions(), app)
  : http.createServer(app);

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
    root,
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
    line('\x1b[2mSelf-signed certificate - every browser warns once, then remembers:\x1b[0m');
    line('\x1b[2m  Chrome / Android   Advanced  >  Proceed to ...\x1b[0m');
    line('\x1b[2m  Safari / iOS       Show Details  >  visit this website\x1b[0m');
    line('\x1b[2mAccept it once and the camera, GPS and home-screen install all work.\x1b[0m');
  }
  line(`\x1b[2mPort ${port} is saved in proto.config.json - "npm run port" picks a new one.\x1b[0m`);
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use. Run "npm run port" to pick another.\n`);
    process.exit(1);
  }
  throw err;
});
