/**
 * Start the FloraGuard AI camera (ai-vision-node) with its own Python.
 *
 *   npm run ai          -> http://127.0.0.1:7860
 *
 * It sends each ALERT snapshot to the FloraScan server on this computer by
 * itself (see ai-vision-node/app/notifier.py), so nothing needs setting up for
 * a demo. Uses ai-vision-node/.venv; ai-vision-node/README.md shows how to
 * make it. Extra arguments are passed on to the app.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeDir = path.join(root, 'ai-vision-node');
const python = [
  path.join(nodeDir, '.venv', 'Scripts', 'python.exe'), // Windows
  path.join(nodeDir, '.venv', 'bin', 'python'), // macOS, Linux
].find((p) => fs.existsSync(p));

if (!python) {
  console.error([
    '',
    '  FloraGuard needs its Python environment first (Python 3.12), once:',
    '',
    '    cd ai-vision-node',
    '    python -m venv .venv',
    '    .venv\\Scripts\\activate          (macOS/Linux: source .venv/bin/activate)',
    '    pip install -r requirements.txt',
    '    git lfs pull',
    '',
  ].join('\n'));
  process.exit(1);
}

const child = spawn(python, [path.join(nodeDir, 'app', 'floraguard_app.py'), ...process.argv.slice(2)], {
  cwd: nodeDir,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
