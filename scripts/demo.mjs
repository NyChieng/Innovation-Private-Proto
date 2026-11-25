/**
 * Everything for the live demo in one terminal: the FloraScan server and the
 * FloraGuard AI camera, already pointed at each other.
 *
 *   npm run demo
 *
 * The camera sends each ALERT snapshot to this server, so the rangers are
 * notified with no set-up. If the camera cannot start (no Python environment
 * yet), the server keeps running and says why. Ctrl+C stops both. Arguments
 * are passed on to the server (for example --http).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const run = (script, scriptArgs = [], env = process.env) =>
  spawn(process.execPath, [path.join(root, ...script), ...scriptArgs], { cwd: root, stdio: 'inherit', env });

// The camera finds the server from proto.config.json over HTTPS by itself. Tell
// it outright when this run differs: a one-off PORT, or --http.
const cameraEnv = { ...process.env };
const http = args.includes('--http');
if (!cameraEnv.FLORAGUARD_SERVER_URL && (process.env.PORT || http)) {
  let port = process.env.PORT;
  if (!port) {
    try { port = JSON.parse(fs.readFileSync(path.join(root, 'proto.config.json'), 'utf8')).port; } catch { /* none yet */ }
  }
  if (port) cameraEnv.FLORAGUARD_SERVER_URL = `${http ? 'http' : 'https'}://localhost:${port}`;
}

const server = run(['Server', 'index.js'], args);
const camera = run(['scripts', 'floraguard.mjs'], [], cameraEnv);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of [server, camera]) if (p.exitCode === null) p.kill();
  process.exitCode = code;
}

server.on('exit', (code) => stop(code ?? 0));
camera.on('exit', (code) => {
  if (!stopping) {
    console.log(`\n[demo] FloraGuard stopped (exit code ${code}). The FloraScan server keeps running.`);
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));
