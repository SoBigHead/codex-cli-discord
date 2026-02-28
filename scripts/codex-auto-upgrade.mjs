#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has('--dry-run') || process.env.CODEX_UPGRADE_DRY_RUN === '1';
const lockDir = path.join(os.tmpdir(), 'codex-cli-auto-upgrade.lock');

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
  console.log(`[${now()}] ${message}`);
}

function run(cmd, args, options = {}) {
  const {
    allowFailure = false,
    capture = true,
    label = null,
    mutates = false,
  } = options;

  if (dryRun && mutates) {
    log(`[dry-run] skip: ${cmd} ${args.join(' ')}`);
    return {ok: true, status: 0, stdout: '', stderr: ''};
  }

  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) {
    if (allowFailure) {
      return {ok: false, status: result.status ?? 1, stdout: '', stderr: result.error.message};
    }
    const context = label || `${cmd} ${args.join(' ')}`;
    throw new Error(`${context} failed: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    const context = label || `${cmd} ${args.join(' ')}`;
    const stderr = String(result.stderr || '').trim();
    throw new Error(`${context} exited ${status}${stderr ? `: ${stderr}` : ''}`);
  }

  return {
    ok: status === 0,
    status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function runShell(command, options = {}) {
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', command], options);
  }
  return run('/bin/sh', ['-lc', command], options);
}

function outputOrEmpty(result) {
  return String(result.stdout || '').trim();
}

function commandExists(cmd) {
  const result = run(cmd, ['--version'], {allowFailure: true});
  return result.ok;
}

function parseFirstVersionToken(line) {
  const value = String(line || '').trim();
  if (!value) return 'unknown';
  const parts = value.split(/\s+/);
  return parts[1] || parts[0] || 'unknown';
}

function installLock() {
  try {
    fs.mkdirSync(lockDir);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      log('another upgrade run is in progress; skip.');
      process.exit(0);
    }
    throw err;
  }

  const release = () => {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // ignore
    }
  };

  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
}

function runMacUpgrade() {
  const brewBin = (process.env.BREW_BIN || 'brew').trim();
  const caskName = (process.env.CODEX_CASK_NAME || 'codex').trim();
  const botLabel = String(process.env.BOT_LABEL || 'com.atou.codex-discord-bot').trim();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  if (!commandExists(brewBin)) {
    throw new Error('brew not found; cannot upgrade codex.');
  }

  const versionBeforeResult = run(brewBin, ['list', '--cask', '--versions', caskName], {allowFailure: true});
  const versionBefore = versionBeforeResult.ok
    ? parseFirstVersionToken(outputOrEmpty(versionBeforeResult))
    : 'not-installed';
  log(`codex before: ${versionBefore}`);

  if (process.env.CODEX_UPGRADE_SKIP_BREW_UPDATE !== '1') {
    log('running brew update...');
    run(brewBin, ['update', '--quiet'], {capture: false, mutates: true});
  }

  const outdatedResult = run(brewBin, ['outdated', '--cask', caskName], {allowFailure: true});
  const outdated = outputOrEmpty(outdatedResult);
  if (!outdated) {
    log('no codex update available.');
    return false;
  }

  log(`upgrading ${caskName}...`);
  run(brewBin, ['upgrade', '--cask', caskName], {capture: false, mutates: true});

  const versionAfterResult = run(brewBin, ['list', '--cask', '--versions', caskName], {allowFailure: true});
  const versionAfter = versionAfterResult.ok
    ? parseFirstVersionToken(outputOrEmpty(versionAfterResult))
    : 'unknown';
  log(`codex after: ${versionAfter}`);

  if (botLabel && uid !== null) {
    const serviceRef = `gui/${uid}/${botLabel}`;
    const hasService = run('launchctl', ['print', serviceRef], {allowFailure: true}).ok;
    if (hasService) {
      log(`restarting ${botLabel}...`);
      run('launchctl', ['kickstart', '-k', serviceRef], {capture: false, mutates: true});
      log(`restart requested for ${botLabel}.`);
    } else {
      log(`bot service ${botLabel} not found; skip restart.`);
    }
  }

  return true;
}

function runWindowsUpgrade() {
  const botTaskName = String(process.env.BOT_TASK_NAME || '').trim();
  const wingetId = String(process.env.CODEX_WINGET_ID || 'OpenAI.Codex').trim();
  const customCheckCommand = String(process.env.CODEX_UPGRADE_CHECK_COMMAND || '').trim();
  const customUpgradeCommand = String(process.env.CODEX_UPGRADE_COMMAND || '').trim();

  if (customCheckCommand) {
    log(`checking updates with custom command: ${customCheckCommand}`);
    const checkResult = runShell(customCheckCommand, {allowFailure: true});
    const text = `${checkResult.stdout || ''}\n${checkResult.stderr || ''}`;
    if (/no update|up to date|latest/i.test(text)) {
      log('no codex update available.');
      return false;
    }
  }

  if (customUpgradeCommand) {
    log(`running custom upgrade command: ${customUpgradeCommand}`);
    const upgradeResult = runShell(customUpgradeCommand, {allowFailure: true, capture: false, mutates: true});
    if (!upgradeResult.ok) {
      throw new Error('custom upgrade command failed.');
    }
  } else {
    if (!commandExists('winget')) {
      throw new Error('winget not found; set CODEX_UPGRADE_COMMAND to a custom updater command.');
    }

    const inspectResult = run(
      'winget',
      ['upgrade', '--id', wingetId, '--exact', '--accept-source-agreements'],
      {allowFailure: true},
    );
    const inspectText = `${inspectResult.stdout || ''}\n${inspectResult.stderr || ''}`;
    if (/No applicable update found|No installed package found matching input criteria/i.test(inspectText)) {
      log('no codex update available.');
      return false;
    }

    log(`upgrading ${wingetId}...`);
    const upgradeResult = run(
      'winget',
      [
        'upgrade',
        '--id',
        wingetId,
        '--exact',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      {allowFailure: true, capture: false, mutates: true},
    );
    if (!upgradeResult.ok) {
      throw new Error(`winget upgrade failed for ${wingetId}.`);
    }
  }

  if (botTaskName) {
    log(`restarting scheduled task ${botTaskName}...`);
    const restart = run('schtasks.exe', ['/Run', '/TN', botTaskName], {allowFailure: true, mutates: true});
    if (restart.ok) {
      log(`restart requested for task ${botTaskName}.`);
    } else {
      log(`task ${botTaskName} not found; skip restart.`);
    }
  }

  return true;
}

installLock();

try {
  let upgraded = false;
  if (process.platform === 'darwin') {
    upgraded = runMacUpgrade();
  } else if (process.platform === 'win32') {
    upgraded = runWindowsUpgrade();
  } else {
    log(`platform ${process.platform} is unsupported for scheduled auto-upgrade; skipping.`);
    process.exit(0);
  }

  if (!upgraded) {
    process.exit(0);
  }

  log('codex auto-upgrade run completed.');
} catch (err) {
  log(String(err?.message || err));
  process.exit(1);
}
