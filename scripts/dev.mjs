/** Runs the API server and the Vite dev server together (no extra dependency). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const procs = [
  spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [vite, '--config', path.join(root, 'web', 'vite.config.js')], { cwd: root, stdio: 'inherit', env: process.env }),
];

function shutdown() {
  for (const p of procs) if (!p.killed) p.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) shutdown(); });
