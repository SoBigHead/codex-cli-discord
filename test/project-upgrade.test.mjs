import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createProjectUpgradeManager,
  formatProjectUpgradeStatusLine,
  normalizeProjectUpgradeMode,
  parseProjectUpgradeTextInput,
} from '../src/project-upgrade.js';
import { createProjectUpgradeScheduler } from '../src/project-upgrade-scheduler.js';

function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeReleaseNotes(filePath, version, note = 'Project upgrade test release.') {
  fs.writeFileSync(filePath, [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    `## [${version}] - 2026-05-04`,
    '',
    '### Fixed',
    `- ${note}`,
    '',
  ].join('\n'), 'utf8');
}

function createUpgradeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-upgrade-'));
  const remote = path.join(tmp, 'remote.git');
  const local = path.join(tmp, 'local');
  const other = path.join(tmp, 'other');

  fs.mkdirSync(remote);
  run(remote, ['init', '--bare', '--initial-branch=main']);

  fs.mkdirSync(local);
  run(local, ['init', '--initial-branch=main']);
  run(local, ['config', 'user.email', 'test@example.com']);
  run(local, ['config', 'user.name', 'Upgrade Test']);
  writeJson(path.join(local, 'package.json'), { name: 'fixture', version: '0.1.0' });
  writeReleaseNotes(path.join(local, 'CHANGELOG.md'), '0.1.0');
  fs.writeFileSync(path.join(local, '.gitignore'), '.env\n', 'utf8');
  run(local, ['add', 'package.json', 'CHANGELOG.md', '.gitignore']);
  run(local, ['commit', '-m', 'initial']);
  run(local, ['remote', 'add', 'origin', remote]);
  run(local, ['push', '-u', 'origin', 'main']);

  run(tmp, ['clone', remote, other]);
  run(other, ['config', 'user.email', 'test@example.com']);
  run(other, ['config', 'user.name', 'Upgrade Test']);
  writeJson(path.join(other, 'package.json'), { name: 'fixture', version: '0.1.1' });
  writeReleaseNotes(path.join(other, 'CHANGELOG.md'), '0.1.1', 'Remote version is newer.');
  run(other, ['add', 'package.json', 'CHANGELOG.md']);
  run(other, ['commit', '-m', 'release 0.1.1']);
  run(other, ['push', 'origin', 'main']);

  return { tmp, local, other };
}

test('project upgrade mode defaults to notify and parses user actions', () => {
  assert.equal(normalizeProjectUpgradeMode(''), 'notify');
  assert.equal(normalizeProjectUpgradeMode('auto'), 'auto');
  assert.equal(normalizeProjectUpgradeMode('关闭'), 'off');
  assert.deepEqual(parseProjectUpgradeTextInput('auto'), { type: 'set_mode', mode: 'auto' });
  assert.deepEqual(parseProjectUpgradeTextInput('apply'), { type: 'apply' });
});

test('project upgrade check detects a safe remote fast-forward update', async () => {
  const { local } = createUpgradeFixture();
  const manager = createProjectUpgradeManager({
    projectRoot: local,
    env: { ...process.env, AGENTS_IN_DISCORD_UPGRADE_MODE: '' },
    verifyCommand: 'off',
    installCommand: 'node -e ""',
  });

  const status = await manager.check({ fetch: true });
  assert.equal(status.ok, true);
  assert.equal(status.config.mode, 'notify');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canApply, true);
  assert.equal(status.localVersion, '0.1.0');
  assert.equal(status.remoteVersion, '0.1.1');
  assert.match(status.releaseNotes, /Remote version is newer/);
  assert.match(formatProjectUpgradeStatusLine(status, 'zh'), /发现新版本 0\.1\.0 -> 0\.1\.1/);
});

test('project upgrade apply refuses dirty worktrees', async () => {
  const { local } = createUpgradeFixture();
  fs.writeFileSync(path.join(local, 'local.txt'), 'dirty\n', 'utf8');
  const manager = createProjectUpgradeManager({
    projectRoot: local,
    env: { ...process.env },
    verifyCommand: 'off',
    installCommand: 'node -e ""',
  });

  const result = await manager.apply();
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /working tree has local changes/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.1.0');
});

test('project upgrade validates in a temporary worktree before touching the main worktree', async () => {
  const { local } = createUpgradeFixture();
  const manager = createProjectUpgradeManager({
    projectRoot: local,
    env: { ...process.env },
    verifyCommand: 'off',
    installCommand: 'node -e "process.exit(3)"',
  });

  const result = await manager.apply();
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.match(result.error, /exited 3/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.1.0');
});

test('project upgrade status cache avoids repeated fetches until refreshed', async () => {
  let fetches = 0;
  const manager = createProjectUpgradeManager({
    projectRoot: '/',
    env: { ...process.env },
    cacheTtlMs: 60_000,
    spawnSyncFn: (cmd, args) => {
      if (cmd === 'git' && args.join(' ') === 'rev-parse --is-inside-work-tree') {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'fetch') {
        fetches += 1;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args.join(' ') === 'rev-parse HEAD') {
        return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      }
      if (cmd === 'git' && args.join(' ') === 'rev-parse origin/main') {
        return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
      }
      if (cmd === 'git' && args.join(' ') === 'branch --show-current') {
        return { status: 0, stdout: 'main\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'status') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'rev-list') {
        return { status: 0, stdout: '0\n', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'merge-base') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'show') {
        return { status: 0, stdout: '{"version":"0.1.0"}\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  await manager.getCachedStatus();
  await manager.getCachedStatus();
  await manager.getCachedStatus({ refresh: true });
  assert.equal(fetches, 2);
});

test('project upgrade apply dry-run reports planned work without changing the worktree', async () => {
  const { local } = createUpgradeFixture();
  const manager = createProjectUpgradeManager({
    projectRoot: local,
    env: { ...process.env },
    verifyCommand: 'off',
    installCommand: 'node -e ""',
  });

  const result = await manager.apply({ dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.match(result.logs.join('\n'), /temporary worktree/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.1.0');
});

test('project upgrade apply fast-forwards and persists mode changes', async () => {
  const { local } = createUpgradeFixture();
  const envFile = path.join(local, '.env');
  const env = { ...process.env };
  const manager = createProjectUpgradeManager({
    projectRoot: local,
    env,
    envFilePath: envFile,
    verifyCommand: 'off',
    installCommand: 'node -e ""',
  });

  const mode = manager.setMode('auto');
  assert.equal(mode.mode, 'auto');
  assert.match(fs.readFileSync(envFile, 'utf8'), /AGENTS_IN_DISCORD_UPGRADE_MODE=auto/);

  const result = await manager.apply();
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.check.localVersion, '0.1.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.1.1');
});

test('project upgrade scheduler notifies once and blocks auto upgrade while work is active', async () => {
  const sent = [];
  let applyCalls = 0;
  let restartCalls = 0;
  const update = {
    ok: true,
    config: { mode: 'notify' },
    localVersion: '0.1.0',
    remoteVersion: '0.1.1',
    localShort: 'aaaaaaa',
    remoteShort: 'bbbbbbb',
    remoteHead: 'bbbbbbb111',
    behindCount: 1,
    aheadCount: 0,
    updateAvailable: true,
    canApply: true,
    reasons: [],
    releaseNotes: '',
  };
  const manager = {
    resolveConfig: () => update.config,
    check: async () => update,
    apply: async () => {
      applyCalls += 1;
      return { ok: true, changed: true, check: update };
    },
  };
  const client = {
    channels: {
      fetch: async () => ({ send: async (payload) => sent.push(payload.content) }),
    },
  };
  const scheduler = createProjectUpgradeScheduler({
    manager,
    notifyChannelIds: ['channel-1'],
    getClient: () => client,
    getRuntimeSnapshots: () => [],
    requestRestart: () => { restartCalls += 1; },
    stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aid-upgrade-state-')), 'state.json'),
  });

  await scheduler.tick();
  await scheduler.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /项目升级/);

  update.config = { mode: 'auto' };
  await scheduler.tick();
  assert.equal(applyCalls, 1);
  assert.equal(restartCalls, 1);

  update.remoteHead = 'ccccccc222';
  update.config = { mode: 'auto' };
  const busyScheduler = createProjectUpgradeScheduler({
    manager,
    notifyChannelIds: ['channel-1'],
    getClient: () => client,
    getRuntimeSnapshots: () => [{ key: 'thread-1', running: true, queued: 0 }],
    requestRestart: () => { restartCalls += 1; },
  });
  await busyScheduler.tick();
  assert.equal(applyCalls, 1);
});

test('project upgrade scheduler retries notices after send failures', async () => {
  let attempts = 0;
  const update = {
    ok: true,
    config: { mode: 'notify' },
    localVersion: '0.1.0',
    remoteVersion: '0.1.1',
    localShort: 'aaaaaaa',
    remoteShort: 'bbbbbbb',
    remoteHead: 'bbbbbbb111',
    behindCount: 1,
    aheadCount: 0,
    updateAvailable: true,
    canApply: true,
    reasons: [],
    releaseNotes: '',
  };
  const manager = {
    resolveConfig: () => update.config,
    check: async () => update,
    apply: async () => ({ ok: true, changed: true, check: update }),
  };
  const client = {
    channels: {
      fetch: async () => ({
        send: async () => {
          attempts += 1;
          throw new Error('discord unavailable');
        },
      }),
    },
  };
  const scheduler = createProjectUpgradeScheduler({
    manager,
    notifyChannelIds: ['channel-1'],
    getClient: () => client,
    getRuntimeSnapshots: () => [],
    stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aid-upgrade-state-')), 'state.json'),
    logger: { warn: () => {} },
  });

  await scheduler.tick();
  await scheduler.tick();

  assert.equal(attempts, 2);
});

test('project upgrade scheduler blocks auto upgrade on fresh peer heartbeat only', async () => {
  let applyCalls = 0;
  const heartbeatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-upgrade-heartbeat-'));
  const heartbeatPath = path.join(heartbeatDir, 'claude.json');
  const update = {
    ok: true,
    config: { mode: 'auto' },
    localVersion: '0.1.0',
    remoteVersion: '0.1.1',
    localShort: 'aaaaaaa',
    remoteShort: 'bbbbbbb',
    remoteHead: 'bbbbbbb111',
    behindCount: 1,
    aheadCount: 0,
    updateAvailable: true,
    canApply: true,
    reasons: [],
    releaseNotes: '',
  };
  const manager = {
    resolveConfig: () => update.config,
    check: async () => update,
    apply: async () => {
      applyCalls += 1;
      return { ok: true, changed: true, check: update };
    },
  };
  const scheduler = createProjectUpgradeScheduler({
    manager,
    notifyChannelIds: [],
    getRuntimeSnapshots: () => [],
    requestRestart: () => {},
    heartbeatDir,
    heartbeatMaxAgeMs: 1_000,
  });

  fs.writeFileSync(heartbeatPath, JSON.stringify({ id: 'claude', busy: true, updatedAt: Date.now() }), 'utf8');
  await scheduler.tick();
  assert.equal(applyCalls, 0);

  fs.writeFileSync(heartbeatPath, JSON.stringify({ id: 'claude', busy: true, updatedAt: Date.now() - 5_000 }), 'utf8');
  await scheduler.tick();
  assert.equal(applyCalls, 1);
});
