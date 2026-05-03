import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore, normalizeChildThreadWorkspaceMode } from '../src/session-store.js';

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
  assert.equal(session.extraInfoEnabled, null);
  assert.equal(session.extraInfoText, null);
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

test('createSessionStore records the parent channel for thread sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

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

  const session = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.parentChannelId, 'channel-1');
  assert.equal(persisted.threads['thread-1'].parentChannelId, 'channel-1');
  assert.equal(store.getParentSession(session), null);
});

test('createSessionStore lets a thread inherit the parent channel workspace binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

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

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, parentWorkspaceDir);
  assert.equal(binding.source, 'parent channel');
  assert.equal(binding.parentChannelId, 'channel-1');
});

test('normalizeChildThreadWorkspaceMode defaults invalid values to inherit', () => {
  assert.equal(normalizeChildThreadWorkspaceMode('inherit'), 'inherit');
  assert.equal(normalizeChildThreadWorkspaceMode('separate'), 'separate');
  assert.equal(normalizeChildThreadWorkspaceMode('unknown'), 'inherit');
});

test('createSessionStore can keep child threads on separate fallback workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    childThreadWorkspaceMode: 'separate',
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

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');
  const workspaceDir = store.ensureWorkspace(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(fs.existsSync(workspaceDir), true);
});

test('createSessionStore can resolve child thread workspace mode dynamically per provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const parentWorkspaceDir = path.join(root, 'parent-workspace');
  fs.mkdirSync(parentWorkspaceDir, { recursive: true });

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    resolveChildThreadWorkspaceMode: (provider) => (provider === 'codex' ? 'separate' : 'inherit'),
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

  const parentSession = store.getSession('channel-1');
  parentSession.workspaceDir = parentWorkspaceDir;
  store.saveDb();

  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
});

test('createSessionStore keeps thread legacy fallback isolated when parent has no explicit workspace override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');

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

  store.getSession('channel-1');
  const threadSession = store.getSession('thread-1', {
    channel: {
      parentId: 'channel-1',
      isThread: () => true,
    },
  });
  const binding = store.getWorkspaceBinding(threadSession, 'thread-1');
  const workspaceDir = store.ensureWorkspace(threadSession, 'thread-1');

  assert.equal(binding.workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(binding.source, 'legacy fallback');
  assert.equal(workspaceDir, path.join(workspaceRoot, 'thread-1'));
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'channel-1')), false);
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

test('createSessionStore backfills missing mode from defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'codex',
        runnerSessionId: 'sess-1',
        codexThreadId: 'sess-1',
        language: 'zh',
        onboardingEnabled: true,
      },
    },
  }, null, 2));

  const store = createSessionStore({
    dataFile,
    workspaceRoot,
    defaults: {
      provider: 'codex',
      mode: 'dangerous',
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
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.mode, 'dangerous');
  assert.equal(persisted.threads['thread-1'].mode, 'dangerous');
});

test('createSessionStore projects current provider state and preserves other provider buckets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        model: 'legacy-model',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          codex: {
            runnerSessionId: 'sess-codex',
            codexThreadId: 'sess-codex',
            lastInputTokens: 111,
            model: 'gpt-5.3-codex',
            effort: 'high',
            compactStrategy: 'native',
            compactEnabled: true,
            compactThresholdTokens: 1000,
            nativeCompactTokenLimit: 1000,
            configOverrides: ['personality="concise"'],
          },
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
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
  });

  const session = store.getSession('thread-1');
  session.model = 'claude-opus';
  store.saveDb();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.runnerSessionId, 'sess-claude');
  assert.equal(session.model, 'claude-opus');
  assert.equal(persisted.threads['thread-1'].providers.claude.model, 'claude-opus');
  assert.equal(persisted.threads['thread-1'].providers.codex.model, 'gpt-5.3-codex');
});

test('createSessionStore.saveDb preserves untouched provider buckets before a session is hydrated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  const favoriteDir = path.join(root, 'favorite-workspace');
  fs.mkdirSync(favoriteDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        model: 'legacy-model',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
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
  });

  store.addFavoriteWorkspace('codex', favoriteDir);
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(persisted.threads['thread-1'].providers.claude.runnerSessionId, 'sess-claude');
  assert.equal(persisted.threads['thread-1'].providers.claude.model, 'sonnet');
});

test('createSessionStore.listSessions hydrates provider-scoped state before saving list mutations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-discord-session-store-'));
  const dataFile = path.join(root, 'sessions.json');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.writeFileSync(dataFile, JSON.stringify({
    threads: {
      'thread-1': {
        provider: 'claude',
        runnerSessionId: 'legacy-claude',
        codexThreadId: 'legacy-claude',
        mode: 'safe',
        language: 'zh',
        onboardingEnabled: true,
        providers: {
          claude: {
            runnerSessionId: 'sess-claude',
            codexThreadId: 'sess-claude',
            lastInputTokens: 222,
            model: 'sonnet',
            effort: 'medium',
            compactStrategy: 'hard',
            compactEnabled: true,
            compactThresholdTokens: 2000,
            nativeCompactTokenLimit: null,
            configOverrides: [],
          },
        },
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
  });

  const [{ session }] = store.listSessions({ provider: 'claude' });
  session.runnerSessionId = null;
  session.codexThreadId = null;
  store.saveDb();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(session.runnerSessionId, null);
  assert.equal(persisted.threads['thread-1'].providers.claude.runnerSessionId, null);
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
