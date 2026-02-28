#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(cmd, args, extraEnv = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    fail(`${cmd} failed: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  if (status !== 0) {
    process.exit(status);
  }
}

function resolveScheduler(value) {
  const normalized = String(value || 'auto').toLowerCase();
  if (!['auto', 'launchd', 'task-scheduler', 'none'].includes(normalized)) {
    fail(`invalid AUTO_UPGRADE_SCHEDULER=${value} (expected auto|launchd|task-scheduler|none)`);
  }

  if (normalized !== 'auto') return normalized;
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'win32') return 'task-scheduler';
  return 'none';
}

const scheduler = resolveScheduler(process.env.AUTO_UPGRADE_SCHEDULER);

if (scheduler === 'none') {
  console.log('[auto-upgrade] scheduler disabled (AUTO_UPGRADE_SCHEDULER=none).');
  console.log('[auto-upgrade] run manually: node scripts/codex-auto-upgrade.mjs');
  process.exit(0);
}

if (scheduler === 'launchd') {
  run('bash', ['scripts/install-codex-auto-upgrade-launchd.sh']);
  process.exit(0);
}

if (scheduler === 'task-scheduler') {
  const taskName = process.env.TASK_NAME || process.env.LABEL || 'codex-cli-auto-upgrade';
  const botTaskName = process.env.BOT_TASK_NAME || process.env.BOT_LABEL || 'codex-discord-bot';

  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/install-codex-auto-upgrade-task-scheduler.ps1',
  ], {
    TASK_NAME: taskName,
    BOT_TASK_NAME: botTaskName,
  });
  process.exit(0);
}

fail(`unsupported scheduler: ${scheduler}`);
