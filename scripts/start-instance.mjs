import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const providerArg = process.argv.find((arg, index) => index > 1 && arg !== '--dry-run');
const provider = String(providerArg || '').trim().toLowerCase();
const mode = provider || 'shared';

if (!['shared', 'codex', 'claude', 'antigravity', 'gemini', 'google', 'agy'].includes(mode)) {
  console.error('Usage: node scripts/start-instance.mjs <shared|codex|claude|antigravity|gemini>');
  process.exit(1);
}

const providerMode = ['gemini', 'google', 'agy'].includes(mode) ? 'antigravity' : mode;
const legacyGeminiMode = mode === 'gemini';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const childEnv = {
  ...process.env,
  ...(providerMode === 'shared' ? {} : { BOT_PROVIDER: providerMode }),
  ...(legacyGeminiMode && !process.env.SLASH_PREFIX && !process.env.ANTIGRAVITY__SLASH_PREFIX && !process.env.GEMINI__SLASH_PREFIX
    ? { SLASH_PREFIX: 'gm' }
    : {}),
};

if (dryRun) {
  console.log(JSON.stringify({
    input: mode,
    provider: providerMode,
    botProvider: childEnv.BOT_PROVIDER || '',
    slashPrefix: childEnv.SLASH_PREFIX || '',
  }, null, 2));
  process.exit(0);
}

const child = spawn(process.execPath, [path.join(rootDir, 'src', 'index.js')], {
  cwd: rootDir,
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
