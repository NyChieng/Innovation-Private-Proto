import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { createApi } from '../../Server/api.js';
import { configureSecurity } from '../../Server/security.js';

// The real API router, with no database connection or mock rate limiter.
// Tests/demo only send malformed JSON, anonymous protected requests, or 404s.
export async function securityServer({ production = true, trustProxy = '', tls } = {}) {
  const app = express();
  configureSecurity(app, { production, trustProxy });
  app.use('/api', createApi());
  app.get('/client', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  app.get('*', (_req, res) => res.type('html').send('<!doctype html><title>Security check</title><p>Security check</p>'));
  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
    request(path, { method = 'GET', body, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const client = tls ? https : http;
        const req = client.request(origin + path, {
          method,
          headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          // Trust only this fixture's CA. Certificate verification stays on.
          ...(tls ? { ca: tls.ca } : {}),
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({
            status: res.statusCode, headers: res.headers, text,
            json: () => JSON.parse(text),
          }));
        });
        req.on('error', reject);
        req.end(body);
      });
    },
  };
}
