import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionCommandActions } from '../src/session-command-actions.js';

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
    resolveProcessLinesSetting: () => ({ lines: 2, source: 'session override' }),
    ensureGitRepo: () => {},
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

test('createSessionCommandActions.setWorkspaceDir ensures repo and resets session binding', () => {
  let ensuredPath = null;
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
    getSessionId: () => null,
    setSessionId: () => {},
    getSessionProvider: (session) => session.provider || 'codex',
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    resolveProcessLinesSetting: () => ({ lines: 2, source: 'session override' }),
    ensureGitRepo: (resolvedPath) => {
      ensuredPath = resolvedPath;
    },
    listRecentSessions: () => [],
    humanAge: () => '0s',
  });
  const session = { provider: 'codex', workspaceDir: '/old', runnerSessionId: 'sess-1', codexThreadId: 'sess-1' };

  const result = actions.setWorkspaceDir(session, '/new/project');

  assert.equal(ensuredPath, '/new/project');
  assert.equal(result.workspaceDir, '/new/project');
  assert.equal(session.workspaceDir, '/new/project');
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
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
    getProviderShortName: (provider) => provider === 'claude' ? 'Claude' : 'Codex',
    resolveTimeoutSetting: () => ({ timeoutMs: 60000, source: 'session override' }),
    resolveProcessLinesSetting: () => ({ lines: 2, source: 'session override' }),
    ensureGitRepo: () => {},
    listRecentSessions: () => [
      { id: 'abc123', mtime: Date.now() - 1_000 },
      { id: 'def456', mtime: Date.now() - 5_000 },
    ],
    humanAge: (ms) => `${Math.round(ms / 1000)}s`,
  });
  const session = { provider: 'codex' };

  const report = actions.formatRecentSessionsReport({
    key: 'thread-1',
    session,
    resumeRef: '/bot-resume',
  });

  assert.match(report, /最近 Codex Sessions/);
  assert.match(report, /`\/bot-resume`/);
  assert.match(report, /1\. `abc123`/);
  assert.match(report, /2\. `def456`/);
});
