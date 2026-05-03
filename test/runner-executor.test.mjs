import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerExecutor } from '../src/runner-executor.js';
import {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';

test('createRunnerExecutor builds gemini args instead of codex args', () => {
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => value,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'gemini',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: (session) => ({ value: session.model || null, source: session.model ? 'session override' : 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  const args = executor.buildSessionRunnerArgs({
    provider: 'gemini',
    session: {
      provider: 'gemini',
      mode: 'dangerous',
      model: 'gemini-2.5-pro',
      runnerSessionId: 'sess-gm-1',
    },
    workspaceDir: '/tmp/workspace',
    prompt: 'summarize the repo',
  });

  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '--yolo',
    '--model',
    'gemini-2.5-pro',
    '--resume',
    'sess-gm-1',
    '--prompt',
    'summarize the repo',
  ]);
});

test('createRunnerExecutor routes Claude long runtime to the hot-session runner', async () => {
  let longRunInput = null;
  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => value,
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'claude',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: false, supported: false }),
    resolveRuntimeModeSetting: () => ({ mode: 'long', supported: true }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: () => {},
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    createClaudeLongRunnerFn: () => ({
      runTask(input) {
        longRunInput = input;
        return Promise.resolve({
          ok: true,
          cancelled: false,
          timedOut: false,
          error: '',
          logs: [],
          messages: [],
          finalAnswerMessages: ['done'],
          reasonings: [],
          usage: null,
          threadId: 'claude-session-1',
        });
      },
      closeSession: () => false,
      closeAll: () => 0,
      getSnapshot: () => [],
    }),
  });

  const result = await executor.runProviderTask({
    session: { provider: 'claude', mode: 'safe', runnerSessionId: 'claude-session-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: 'hello',
    systemPrompt: '[Via agents-in-discord; discord_thread=thread-1]',
  });

  assert.equal(result.ok, true);
  assert.equal(result.threadId, 'claude-session-1');
  assert.equal(longRunInput.sessionKey, 'discord-thread-1');
  assert.equal(longRunInput.prompt, 'hello');
  assert.equal(longRunInput.systemPrompt, '[Via agents-in-discord; discord_thread=thread-1]');
});
