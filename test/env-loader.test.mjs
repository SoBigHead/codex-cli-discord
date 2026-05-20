import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRuntimeEnv } from '../src/env-loader.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-env-'));
}

test('loadRuntimeEnv applies provider-scoped keys from a single .env file', () => {
  const rootDir = makeTempRoot();
  fs.writeFileSync(
    path.join(rootDir, '.env'),
    [
      'BOT_PROVIDER=codex',
      'DEFAULT_MODEL=shared-model',
      'SHOW_REASONING=false',
      'CODEX__DEFAULT_MODEL=o3',
      'CODEX__DEFAULT_MODE=dangerous',
      'CODEX__SLASH_PREFIX=cmdx',
    ].join('\n'),
  );

  const env = {};
  const result = loadRuntimeEnv({ rootDir, env });

  assert.equal(env.BOT_PROVIDER, 'codex');
  assert.equal(env.DEFAULT_MODEL, 'o3');
  assert.equal(env.DEFAULT_MODE, 'dangerous');
  assert.equal(env.SLASH_PREFIX, 'cmdx');
  assert.equal(env.SHOW_REASONING, 'false');
  assert.equal(result.appliedProviderScope, 'codex');
  assert.deepEqual(result.loadedFiles.map((file) => path.basename(file)), ['.env']);
  assert.equal(path.basename(result.writableEnvFile), '.env');
});

test('loadRuntimeEnv respects shell env priority over provider-scoped keys', () => {
  const rootDir = makeTempRoot();
  fs.writeFileSync(
    path.join(rootDir, '.env'),
    ['CLAUDE__DEFAULT_MODEL=sonnet', 'CLAUDE__SHOW_REASONING=false'].join('\n'),
  );

  const env = {
    BOT_PROVIDER: 'claude',
    DEFAULT_MODEL: 'from-shell',
  };
  const result = loadRuntimeEnv({ rootDir, env });

  assert.equal(env.BOT_PROVIDER, 'claude');
  assert.equal(env.DEFAULT_MODEL, 'from-shell');
  assert.equal(env.SHOW_REASONING, 'false');
  assert.deepEqual(result.loadedFiles.map((file) => path.basename(file)), ['.env']);
  assert.equal(path.basename(result.writableEnvFile), '.env');
});

test('loadRuntimeEnv lets antigravity scoped keys shadow legacy gemini scoped keys', () => {
  const rootDir = makeTempRoot();
  fs.writeFileSync(
    path.join(rootDir, '.env'),
    [
      'BOT_PROVIDER=antigravity',
      'GEMINI__DEFAULT_WORKSPACE_DIR=/legacy',
      'ANTIGRAVITY__DEFAULT_WORKSPACE_DIR=/canonical',
    ].join('\n'),
  );

  const env = {};
  const result = loadRuntimeEnv({ rootDir, env });

  assert.equal(result.appliedProviderScope, 'antigravity');
  assert.equal(env.BOT_PROVIDER, 'antigravity');
  assert.equal(env.DEFAULT_WORKSPACE_DIR, '/canonical');
});

test('loadRuntimeEnv still applies legacy gemini scope for antigravity when canonical key is absent', () => {
  const rootDir = makeTempRoot();
  fs.writeFileSync(
    path.join(rootDir, '.env'),
    [
      'BOT_PROVIDER=gemini',
      'GEMINI__DEFAULT_WORKSPACE_DIR=/legacy',
    ].join('\n'),
  );

  const env = {};
  const result = loadRuntimeEnv({ rootDir, env });

  assert.equal(result.appliedProviderScope, 'antigravity');
  assert.equal(env.BOT_PROVIDER, 'gemini');
  assert.equal(env.DEFAULT_WORKSPACE_DIR, '/legacy');
});

test('loadRuntimeEnv still respects explicit ENV_FILE overlays', () => {
  const rootDir = makeTempRoot();
  fs.writeFileSync(path.join(rootDir, '.env'), ['BOT_PROVIDER=codex', 'CODEX__DEFAULT_MODEL=o3'].join('\n'));
  fs.writeFileSync(path.join(rootDir, '.env.local'), ['CODEX__DEFAULT_MODE=dangerous'].join('\n'));

  const env = { ENV_FILE: '.env.local' };
  const result = loadRuntimeEnv({ rootDir, env });

  assert.equal(env.BOT_PROVIDER, 'codex');
  assert.equal(env.DEFAULT_MODEL, 'o3');
  assert.equal(env.DEFAULT_MODE, 'dangerous');
  assert.deepEqual(result.loadedFiles.map((file) => path.basename(file)), ['.env', '.env.local']);
  assert.equal(path.basename(result.writableEnvFile), '.env.local');
});
