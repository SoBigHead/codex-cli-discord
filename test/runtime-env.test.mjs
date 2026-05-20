import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createChildThreadWorkspaceModeStore } from '../src/child-thread-workspace-mode.js';
import { createProviderDefaultWorkspaceStore, resolveConfiguredWorkspaceDir, resolvePath } from '../src/provider-default-workspace.js';
import { autoRepairProxyEnv } from '../src/proxy-env.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-runtime-env-'));
}

test('autoRepairProxyEnv infers local SOCKS proxy and persists missing keys', () => {
  const rootDir = makeTempRoot();
  const envFilePath = path.join(rootDir, '.env');
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
  };

  const result = autoRepairProxyEnv(envFilePath, { env });

  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.SOCKS_PROXY, 'socks5h://127.0.0.1:7890');
  assert.equal(env.ALL_PROXY, 'socks5h://127.0.0.1:7890');
  assert.equal(env.all_proxy, 'socks5h://127.0.0.1:7890');
  assert.match(result.logs.join('\n'), /inferred SOCKS proxy/);
  assert.match(result.logs.join('\n'), /persisted updates into \.env/);

  const content = fs.readFileSync(envFilePath, 'utf8');
  assert.match(content, /^http_proxy=http:\/\/127\.0\.0\.1:7890$/m);
  assert.match(content, /^SOCKS_PROXY=socks5h:\/\/127\.0\.0\.1:7890$/m);
});

test('resolvePath and resolveConfiguredWorkspaceDir normalize home and relative inputs', () => {
  assert.equal(
    resolvePath('~/repo/demo', { home: '/Users/tester', cwd: '/tmp/current' }),
    path.join('/Users/tester', 'repo/demo'),
  );
  assert.equal(
    resolveConfiguredWorkspaceDir(' ./project ', { home: '/Users/tester', cwd: '/tmp/current' }),
    path.resolve('/tmp/current', 'project'),
  );
  assert.equal(resolveConfiguredWorkspaceDir('   ', { cwd: '/tmp/current' }), null);
});

test('createProviderDefaultWorkspaceStore resolves provider overrides before shared default', () => {
  const store = createProviderDefaultWorkspaceStore({
    sharedDefaultWorkspaceDir: '/workspace/shared',
    providerDefaultWorkspaceOverrides: {
      codex: '/workspace/codex',
      claude: null,
      antigravity: null,
    },
  });

  assert.deepEqual(store.resolve('codex'), {
    provider: 'codex',
    workspaceDir: '/workspace/codex',
    source: 'provider-scoped env',
    envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
  });
  assert.deepEqual(store.resolve('claude'), {
    provider: 'claude',
    workspaceDir: '/workspace/shared',
    source: 'shared env',
    envKey: 'DEFAULT_WORKSPACE_DIR',
  });
});

test('createProviderDefaultWorkspaceStore.set updates env and persists provider-scoped default', () => {
  const rootDir = makeTempRoot();
  const envFilePath = path.join(rootDir, '.env');
  const env = {};
  const store = createProviderDefaultWorkspaceStore({
    env,
    envFilePath,
    sharedDefaultWorkspaceDir: '/workspace/shared',
    providerDefaultWorkspaceOverrides: {
      codex: null,
      claude: null,
      gemini: null,
    },
  });

  const next = store.set('antigravity', '/workspace/antigravity');

  assert.deepEqual(next, {
    provider: 'antigravity',
    workspaceDir: '/workspace/antigravity',
    source: 'provider-scoped env',
    envKey: 'ANTIGRAVITY__DEFAULT_WORKSPACE_DIR',
  });
  assert.equal(env.ANTIGRAVITY__DEFAULT_WORKSPACE_DIR, '/workspace/antigravity');
  const content = fs.readFileSync(envFilePath, 'utf8');
  assert.match(content, /^ANTIGRAVITY__DEFAULT_WORKSPACE_DIR=\/workspace\/antigravity$/m);
});

test('createChildThreadWorkspaceModeStore resolves provider override before shared mode', () => {
  const store = createChildThreadWorkspaceModeStore({
    sharedMode: 'inherit',
    providerModeOverrides: {
      codex: 'separate',
    },
  });

  assert.deepEqual(store.resolve('codex'), {
    provider: 'codex',
    mode: 'separate',
    source: 'provider-scoped env',
    envKey: 'CODEX__CHILD_THREAD_WORKSPACE_MODE',
  });
  assert.deepEqual(store.resolve('claude'), {
    provider: 'claude',
    mode: 'inherit',
    source: 'default',
    envKey: 'CLAUDE__CHILD_THREAD_WORKSPACE_MODE',
  });
});

test('createChildThreadWorkspaceModeStore.set persists provider-scoped mode', () => {
  const rootDir = makeTempRoot();
  const envFilePath = path.join(rootDir, '.env');
  const env = {};
  const store = createChildThreadWorkspaceModeStore({
    env,
    envFilePath,
  });

  const next = store.set('antigravity', 'separate');

  assert.deepEqual(next, {
    provider: 'antigravity',
    mode: 'separate',
    source: 'provider-scoped env',
    envKey: 'ANTIGRAVITY__CHILD_THREAD_WORKSPACE_MODE',
  });
  assert.equal(env.ANTIGRAVITY__CHILD_THREAD_WORKSPACE_MODE, 'separate');
  const content = fs.readFileSync(envFilePath, 'utf8');
  assert.match(content, /^ANTIGRAVITY__CHILD_THREAD_WORKSPACE_MODE=separate$/m);
});
