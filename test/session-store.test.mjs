import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore } from '../src/session-store.js';

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'claude') return 'claude';
  return 'codex';
}

function normalizeUiLanguage(value) {
  return value === 'en' ? 'en' : 'zh';
}

function normalizeSessionSecurityProfile(value) {
  if (!value) return null;
  return value;
}

function normalizeSessionTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSessionCompactStrategy(value) {
  if (!value) return null;
  return value;
}

function normalizeSessionCompactEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  return null;
}

function normalizeSessionCompactTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

test('createSessionStore keeps legacy fallback for fresh thread when no default workspace exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    botProvider: 'claude',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const session = store.getSession('thread-1');
  const workspaceDir = store.ensureWorkspace(session, 'thread-1');

  assert.equal(session.provider, 'claude');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(session.workspaceDir, null);
  assert.equal(fs.existsSync(workspaceDir), true);
});

test('createSessionStore resolves provider default workspace without persisting thread override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const defaultWorkspaceDir = path.join(root, 'shared-workspace');
  fs.mkdirSync(defaultWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    botProvider: 'claude',
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveDefaultWorkspace: () => ({
      workspaceDir: defaultWorkspaceDir,
      source: 'provider-scoped env',
      envKey: 'CLAUDE__DEFAULT_WORKSPACE_DIR',
    }),
  });

  const session = store.getSession('thread-1');
  const binding = store.getWorkspaceBinding(session, 'thread-1');
  const workspaceDir = store.ensureWorkspace(session, 'thread-1');

  assert.equal(binding.workspaceDir, defaultWorkspaceDir);
  assert.equal(binding.source, 'provider default');
  assert.equal(workspaceDir, defaultWorkspaceDir);
  assert.equal(session.workspaceDir, null);
});

test('createSessionStore migrates persisted legacy thread workspace to null so defaults can apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const defaultWorkspaceDir = path.join(root, 'repo-root');
  const legacyDir = path.join(workspaceRoot, 'thread-1');
  fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'codex',
        workspaceDir: legacyDir,
        runnerSessionId: 'sess-1',
        codexThreadId: 'sess-1',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        lastPrompt: 'legacy prompt',
        lastPromptAt: '2026-01-01T00:00:00.000Z',
        processLines: 5,
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveDefaultWorkspace: () => ({
      workspaceDir: defaultWorkspaceDir,
      source: 'provider-scoped env',
      envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
  });

  const session = store.getSession('thread-1');
  const binding = store.getWorkspaceBinding(session, 'thread-1');

  assert.equal(session.workspaceDir, null);
  assert.equal(binding.workspaceDir, defaultWorkspaceDir);
  assert.equal(binding.source, 'provider default');
  assert.equal('lastPrompt' in session, false);
  assert.equal('lastPromptAt' in session, false);
  assert.equal('processLines' in session, false);
});

test('createSessionStore persists provider-scoped workspace favorites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const favoriteA = path.join(root, 'repo-a');
  const favoriteB = path.join(root, 'repo-b');
  fs.mkdirSync(favoriteA, { recursive: true });
  fs.mkdirSync(favoriteB, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  const addedA = store.addFavoriteWorkspace('codex', favoriteA);
  const addedB = store.addFavoriteWorkspace('codex', favoriteB);
  const duplicate = store.addFavoriteWorkspace('codex', favoriteA);

  assert.equal(addedA.changed, true);
  assert.equal(addedB.changed, true);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(store.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteB, favoriteA]);

  const reloaded = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'safe',
      language: 'zh',
      onboardingEnabled: true,
    },
    getSessionId: (session) => String(session?.runnerSessionId || session?.codexThreadId || '').trim() || null,
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
  });

  assert.deepEqual(reloaded.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteB, favoriteA]);

  const removed = reloaded.removeFavoriteWorkspace('codex', favoriteB);
  assert.equal(removed.changed, true);
  assert.deepEqual(reloaded.listFavoriteWorkspaces({ provider: 'codex' }), [favoriteA]);
});
