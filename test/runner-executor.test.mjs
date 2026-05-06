import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createRunnerExecutor } from '../src/runner-executor.js';
import { CODEX_GOAL_CONTINUATION_PROMPT } from '../src/codex-goal-flow.js';
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

test('createRunnerExecutor stops Codex goal continuation when official goal state becomes complete', async () => {
  let killed = false;
  const goalCalls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 1,
    async getCodexThreadGoal({ threadId }) {
      goalCalls.push(threadId);
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
          tokenBudget: 1000,
          tokensUsed: 900,
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"先完成实现。"}}',
          '{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"再完成线上验收。"}}',
          '',
        ].join('\n')));
      });
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.error, '');
  assert.equal(result.threadId, 'goal-thread-1');
  assert.deepEqual(result.finalAnswerMessages, ['先完成实现。', '再完成线上验收。']);
  assert.deepEqual(goalCalls, ['goal-thread-1']);
});

test('createRunnerExecutor lets Codex goal completion emit its final summary before stopping', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: () => () => {},
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 50,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"item.completed","item":{"type":"agent_message","phase":"final_answer","text":"完整总结：验证细节和剩余事项都在这里。"}}',
          '',
        ].join('\n')));
        child.emit('close', 0, null);
      }, 10);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalAnswerMessages, ['完整总结：验证细节和剩余事项都在这里。']);
});

test('createRunnerExecutor collects Codex goal final output from bridged session events', async () => {
  let killed = false;
  let bridgeOnEvent = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };

  const executor = createRunnerExecutor({
    spawnEnv: process.env,
    ensureDir: () => {},
    normalizeProvider: (value) => String(value || '').trim().toLowerCase(),
    getSessionProvider: (session) => session.provider,
    getProviderBin: () => 'codex',
    getSessionId: (session) => session.runnerSessionId,
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0 }),
    resolveFastModeSetting: () => ({ enabled: true, source: 'config.toml' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard' }),
    resolveCompactEnabledSetting: () => ({ enabled: false }),
    resolveNativeCompactTokenLimitSetting: () => ({ tokens: 0 }),
    normalizeTimeoutMs: (value) => Number(value || 0),
    safeError: (err) => String(err?.message || err),
    stopChildProcess: (target) => target.kill(),
    startSessionProgressBridge: ({ onEvent: nextOnEvent }) => {
      bridgeOnEvent = nextOnEvent;
      return () => {};
    },
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
    codexGoalMonitorIntervalMs: 1,
    codexGoalCompletionGraceMs: 20,
    async getCodexThreadGoal({ threadId }) {
      return {
        goal: {
          threadId,
          objective: 'ship goal mode',
          status: 'complete',
        },
      };
    },
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from([
          '{"type":"thread.started","thread_id":"goal-thread-1"}',
          '',
        ].join('\n')));
      });
      setTimeout(() => {
        bridgeOnEvent?.({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: '桥接总结：过程、验证和结果都在这里。',
            phase: 'final_answer',
          },
        });
        bridgeOnEvent?.({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: '桥接总结：过程、验证和结果都在这里。',
          },
        });
      }, 5);
      return child;
    },
  });

  const result = await executor.runProviderTask({
    session: { provider: 'codex', mode: 'safe', runnerSessionId: 'goal-thread-1' },
    sessionKey: 'discord-thread-1',
    workspaceDir: '/tmp/workspace',
    prompt: CODEX_GOAL_CONTINUATION_PROMPT,
    onEvent: () => {},
  });

  assert.equal(killed, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalAnswerMessages, ['桥接总结：过程、验证和结果都在这里。']);
});
