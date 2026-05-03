import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionCommandActions } from '../src/session-command-actions.js';

function createWorkspaceBindingResolver(defaultState) {
  return (session, key) => ({
    workspaceDir: session.workspaceDir || defaultState.value || `/legacy/${key}`,
    source: session.workspaceDir ? 'thread override' : defaultState.value ? 'provider default' : 'legacy fallback',
    defaultWorkspaceDir: defaultState.value,
    defaultSource: defaultState.value ? 'provider-scoped env' : 'unset',
    defaultEnvKey: `CODEX__DEFAULT_WORKSPACE_DIR`,
  });
}

test('createSessionCommandActions.setProvider clears bound session and persists', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'codex', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setProvider(session, 'claude');

  assert.equal(result.previous, 'codex');
  assert.equal(result.provider, 'claude');
  assert.equal(session.provider, 'claude');
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions updates extra info settings', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
  });
  const session = { extraInfoEnabled: null, extraInfoText: null };

  assert.deepEqual(actions.setExtraInfoEnabled(session, false), { extraInfoEnabled: false });
  assert.deepEqual(actions.setExtraInfoText(session, ' custom {thread} '), { extraInfoText: 'custom {thread}' });
  assert.equal(session.extraInfoEnabled, false);
  assert.equal(session.extraInfoText, 'custom {thread}');
  assert.deepEqual(actions.resetExtraInfo(session), { extraInfoEnabled: null, extraInfoText: null });
  assert.equal(saveCount, 3);
});

test('createSessionCommandActions.setProvider restores preserved provider-scoped session state', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    normalizeProvider: (provider) => String(provider || '').trim().toLowerCase() || 'codex',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = {
    provider: 'codex',
    runnerSessionId: 'sess-codex',
    codexThreadId: 'sess-codex',
    model: 'gpt-5.3-codex',
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
  };

  const result = actions.setProvider(session, 'claude');

  assert.equal(result.previous, 'codex');
  assert.equal(result.provider, 'claude');
  assert.equal(session.provider, 'claude');
  assert.equal(session.runnerSessionId, 'sess-claude');
  assert.equal(session.model, 'sonnet');
  assert.equal(session.providers.codex.runnerSessionId, 'sess-codex');
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setRuntimeMode preserves session id and persists the override', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = {
    provider: 'claude',
    runnerSessionId: 'sess-stays',
    codexThreadId: 'sess-stays',
    runtimeMode: null,
  };

  assert.deepEqual(actions.setRuntimeMode(session, 'long'), { runtimeMode: 'long' });
  assert.equal(session.runnerSessionId, 'sess-stays');
  assert.equal(session.codexThreadId, 'sess-stays');
  assert.equal(saveCount, 1);

  assert.deepEqual(actions.setRuntimeMode(session, null), { runtimeMode: null });
  assert.equal(session.runnerSessionId, 'sess-stays');
  assert.equal(saveCount, 2);
});

test('createSessionCommandActions.setWorkspaceDir resets codex session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'codex', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setWorkspaceDir keeps claude session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'claude', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, false);
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setWorkspaceDir resets gemini session when workspace changes', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared',
    getWorkspaceBinding: createWorkspaceBindingResolver(defaultState),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => {
      if (provider === 'claude') return 'Claude';
      if (provider === 'gemini') return 'Gemini';
      return 'Codex';
    },
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'gemini', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, 'thread-1', '/new/project');

  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(result.sessionReset, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.setDefaultWorkspaceDir clears affected codex sessions', () => {
  let saveCount = 0;
  const defaultState = { value: '/shared-a' };
  const sessionA = { provider: 'codex', workspaceDir: null, runnerSessionId: 'sess-a', codexThreadId: 'sess-a' };
  const sessionB = { provider: 'codex', workspaceDir: '/explicit', runnerSessionId: 'sess-b', codexThreadId: 'sess-b' };
  const getWorkspaceBinding = createWorkspaceBindingResolver(defaultState);
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/shared-a',
    getWorkspaceBinding,
    listStoredSessions: () => [
      { key: 'thread-a', session: sessionA },
      { key: 'thread-b', session: sessionB },
    ],
    resolveProviderDefaultWorkspace: () => ({
      workspaceDir: defaultState.value,
      source: 'provider-scoped env',
      envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
    }),
    setProviderDefaultWorkspace: (_provider, nextDir) => {
      defaultState.value = nextDir;
      return {
        workspaceDir: defaultState.value,
        source: defaultState.value ? 'provider-scoped env' : 'unset',
        envKey: 'CODEX__DEFAULT_WORKSPACE_DIR',
      };
    },
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const result = actions.setDefaultWorkspaceDir(sessionA, '/shared-b');

  assert.equal(result.affectedThreads, 1);
  assert.equal(result.resetSessions, 1);
  assert.equal(sessionA.runnerSessionId, null);
  assert.equal(sessionB.runnerSessionId, 'sess-b');
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions updates global codex defaults without mutating session state', () => {
  let writes = [];
  const session = { provider: 'codex', model: null, effort: null, fastMode: null };
  const actions = createSessionCommandActions({
    saveDb: () => {
      throw new Error('should not persist session db');
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: () => {},
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (currentSession) => currentSession.provider || 'codex',
    getProviderShortName: () => 'Codex',
    writeCodexDefaults: (updates) => {
      writes.push(updates);
      return {
        model: updates.model ?? '(unknown)',
        modelConfigured: updates.model !== null && updates.model !== undefined,
        effort: updates.effort ?? '(unknown)',
        effortConfigured: updates.effort !== null && updates.effort !== undefined,
        fastMode: updates.fastMode ?? true,
        fastModeConfigured: updates.fastMode !== null && updates.fastMode !== undefined,
      };
    },
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const modelResult = actions.setGlobalModelDefault(session, 'gpt-5.4');
  const effortResult = actions.setGlobalReasoningEffortDefault(session, 'high');
  const fastResult = actions.setGlobalFastModeDefault(session, null);

  assert.deepEqual(writes, [
    { model: 'gpt-5.4' },
    { effort: 'high' },
    { fastMode: null },
  ]);
  assert.equal(modelResult.defaults.model, 'gpt-5.4');
  assert.equal(effortResult.defaults.effort, 'high');
  assert.equal(fastResult.defaults.fastMode, true);
  assert.deepEqual(session, { provider: 'codex', model: null, effort: null, fastMode: null });
});

test('createSessionCommandActions validates codex profiles before saving session or global defaults', () => {
  let saveCount = 0;
  const session = { provider: 'codex', codexProfile: null };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: () => {},
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (currentSession) => currentSession.provider || 'codex',
    getProviderShortName: () => 'Codex',
    readCodexProfileCatalog: () => ({
      profiles: ['work', 'review'],
      configPath: '/tmp/codex-config.toml',
    }),
    resolveDefaultCodexProfile: () => ({ profile: 'review', source: 'env default' }),
    setDefaultCodexProfile: (profile) => ({ profile, source: 'env default' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  assert.deepEqual(actions.setCodexProfile(session, 'work'), { codexProfile: 'work' });
  assert.equal(session.codexProfile, 'work');
  assert.equal(saveCount, 1);

  assert.deepEqual(actions.setGlobalCodexProfileDefault(session, 'default'), {
    profile: 'review',
    source: 'env default',
  });

  assert.throws(() => actions.setCodexProfile(session, 'missing'), /unknown Codex profile: missing/);
  assert.throws(() => actions.setGlobalCodexProfileDefault(session, 'missing'), /unknown Codex profile: missing/);
});

test('createSessionCommandActions normalizes blank and spaced model/effort overrides', () => {
  let saveCount = 0;
  const session = { provider: 'codex', model: 'gpt-5.4', effort: 'high' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: () => {},
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (currentSession) => currentSession.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const trimmedModel = actions.setModel(session, '  o3  ');
  const clearedModel = actions.setModel(session, '   ');
  const trimmedEffort = actions.setReasoningEffort(session, '  HIGH  ');
  const clearedEffort = actions.setReasoningEffort(session, 'default');

  assert.equal(trimmedModel.model, 'o3');
  assert.equal(clearedModel.model, null);
  assert.equal(trimmedEffort.effort, 'high');
  assert.equal(clearedEffort.effort, null);
  assert.equal(saveCount, 4);
});

test('createSessionCommandActions.startNewSession clears bound session and token snapshot', () => {
  let saveCount = 0;
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = {
    provider: 'codex',
    runnerSessionId: 'sess-1',
    codexThreadId: 'sess-1',
    lastInputTokens: 123,
  };

  const result = actions.startNewSession(session);

  assert.equal(result.sessionId, null);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.lastInputTokens, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.bindSession adopts strict-provider workspace and clears duplicate bindings', () => {
  let saveCount = 0;
  const adoptedWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-bind-session-'));
  const currentSession = { provider: 'codex', workspaceDir: null, runnerSessionId: null, codexThreadId: null };
  const otherSession = { provider: 'codex', workspaceDir: '/legacy/thread-b', runnerSessionId: 'sess-42', codexThreadId: 'sess-42' };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/legacy/thread-a',
    listStoredSessions: () => [
      { key: 'thread-a', session: currentSession },
      { key: 'thread-b', session: otherSession },
    ],
    readCodexSessionMetaBySessionId: (sessionId) => (
      sessionId === 'sess-42'
        ? { cwd: adoptedWorkspaceDir }
        : null
    ),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const result = actions.bindSession(currentSession, 'thread-a', 'sess-42');

  assert.equal(result.sessionId, 'sess-42');
  assert.equal(result.adoptedWorkspaceDir, adoptedWorkspaceDir);
  assert.deepEqual(result.displacedKeys, ['thread-b']);
  assert.equal(currentSession.workspaceDir, adoptedWorkspaceDir);
  assert.equal(otherSession.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.bindSession rejects strict-provider sessions whose workspace no longer exists', () => {
  let saveCount = 0;
  const currentSession = { provider: 'codex', workspaceDir: null, runnerSessionId: null, codexThreadId: null };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/legacy/thread-a',
    listStoredSessions: () => [
      { key: 'thread-a', session: currentSession },
    ],
    readCodexSessionMetaBySessionId: (sessionId) => (
      sessionId === 'sess-missing'
        ? { cwd: '/path/that/does/not/exist' }
        : null
    ),
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const result = actions.bindSession(currentSession, 'thread-a', 'sess-missing');

  assert.equal(result.sessionId, null);
  assert.equal(result.missingWorkspaceDir, '/path/that/does/not/exist');
  assert.equal(currentSession.runnerSessionId, null);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.bindForkedSession records fork metadata without displacing parent', () => {
  let saveCount = 0;
  const parentSession = { provider: 'codex', runnerSessionId: 'parent-1', codexThreadId: 'parent-1' };
  const childSession = { provider: 'codex', runnerSessionId: null, codexThreadId: null };
  const actions = createSessionCommandActions({
    saveDb: () => {
      saveCount += 1;
    },
    ensureWorkspace: () => '/legacy/thread-a',
    listStoredSessions: () => [
      { key: 'parent-channel', session: parentSession },
      { key: 'child-channel', session: childSession },
    ],
    clearSessionId: (session) => {
      session.runnerSessionId = null;
      session.codexThreadId = null;
    },
    getSessionId: (session) => session.runnerSessionId,
    setSessionId: (session, value) => {
      session.runnerSessionId = value;
      session.codexThreadId = value;
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: () => 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });

  const result = actions.bindForkedSession(childSession, {
    sessionId: 'fork-1',
    parentSessionId: 'parent-1',
    parentChannelId: 'parent-channel',
    provider: 'codex',
  });

  assert.equal(result.sessionId, 'fork-1');
  assert.equal(result.parentSessionId, 'parent-1');
  assert.equal(parentSession.runnerSessionId, 'parent-1');
  assert.equal(childSession.runnerSessionId, 'fork-1');
  assert.equal(childSession.codexThreadId, 'fork-1');
  assert.equal(childSession.forkedFromProvider, 'codex');
  assert.equal(childSession.forkedFromSessionId, 'parent-1');
  assert.equal(childSession.forkedFromChannelId, 'parent-channel');
  assert.match(childSession.forkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saveCount, 1);
});

test('createSessionCommandActions.formatRecentSessionsReport renders resume hint and items', () => {
  const actions = createSessionCommandActions({
    saveDb: () => {},
    ensureWorkspace: () => '/tmp/workspace',
    clearSessionId: () => {},
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getSessionLanguage: () => 'en',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    formatRecentSessionsTitle: (provider) => provider === 'claude' ? 'Recent Claude Project Sessions' : 'Recent Codex Sessions',
    formatRecentSessionsLookup: (provider) => (
      provider === 'claude'
        ? 'prefers current workspace in `~/.claude/projects/<workspace>`'
        : 'global rollout history in `~/.codex/sessions`'
    ),
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    listRecentSessions: () => [
      { id: 'abc123', mtime: Date.now() - 1_000 },
      { id: 'def456', mtime: Date.now() - 5_000 },
    ],
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
  });
  const session = { provider: 'claude', language: 'en' };

  const report = actions.formatRecentSessionsReport({
    key: 'thread-1',
    session,
    resumeRef: '/bot-resume',
  });

  assert.match(report, /Recent Claude Project Sessions/);
  assert.match(report, /`\/bot-resume`/);
  assert.match(report, /source: prefers current workspace in `~\/\.claude\/projects\/<workspace>`/);
  assert.match(report, /1\. `abc123`/);
  assert.match(report, /2\. `def456`/);
});
