import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const provider = String(process.argv[2] || '').trim().toLowerCase();
const mode = provider || 'shared';

if (!['shared', 'codex', 'claude', 'gemini', 'kiro'].includes(mode)) {
  console.error('Usage: node scripts/start-instance.mjs <shared|codex|claude|gemini|kiro>');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(rootDir, 'src', 'index.js')], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(mode === 'shared' ? {} : { BOT_PROVIDER: mode }),
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
