import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptOrchestrator } from '../src/prompt-orchestrator.js';

function createOrchestrator(overrides = {}) {
  const replyLog = [];
  const progressCalls = [];
  let saveCount = 0;
  const session = {
    provider: 'codex',
    runnerSessionId: 'sess-1',
    codexThreadId: 'sess-1',
    language: 'zh',
    lastInputTokens: 0,
    name: 'demo',
  };

  const deps = {
    showReasoning: true,
    resultChunkChars: 1900,
    createProgressReporter: ({ initialLatestStep }) => ({
      async start() {
        progressCalls.push({ type: 'start', initialLatestStep });
      },
      sync(options = {}) {
        progressCalls.push({ type: 'sync', options });
      },
      setLatestStep(text) {
        progressCalls.push({ type: 'setLatestStep', text });
      },
      onEvent(event) {
        progressCalls.push({ type: 'onEvent', event });
      },
      onLog(line, source) {
        progressCalls.push({ type: 'onLog', line, source });
      },
      async finish(outcome) {
        progressCalls.push({ type: 'finish', outcome });
      },
    }),
    safeReply: async (_message, payload) => {
      replyLog.push(payload);
      return { id: `reply-${replyLog.length}`, edit: async () => {} };
    },
    withDiscordNetworkRetry: async (fn) => fn(),
    splitForDiscord: (text) => [text],
    getSession: () => session,
    ensureWorkspace: () => '/repo/demo',
    saveDb: () => {
      saveCount += 1;
    },
    clearSessionId: (currentSession) => {
      currentSession.runnerSessionId = null;
      currentSession.codexThreadId = null;
    },
    getSessionId: (currentSession) => currentSession.runnerSessionId || currentSession.codexThreadId || null,
    setSessionId: (currentSession, value) => {
      currentSession.runnerSessionId = value;
      currentSession.codexThreadId = value;
    },
    getSessionProvider: (currentSession) => currentSession.provider || 'codex',
    getSessionLanguage: (currentSession) => currentSession.language || 'zh',
    normalizeUiLanguage: (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
    getProviderDisplayName: (provider) => provider === 'codex' ? 'Codex CLI' : provider,
    getProviderShortName: (provider) => provider === 'codex' ? 'Codex' : provider,
    getProviderDefaultBin: () => 'codex',
    getProviderBinEnvName: () => 'CODEX_BIN',
    resolveTimeoutSetting: () => ({ timeoutMs: 60_000, source: 'session override' }),
    resolveTaskRetrySetting: () => ({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
    formatWorkspaceBusyReport: () => 'busy',
    formatTimeoutLabel: (timeoutMs) => `${timeoutMs}ms`,
    setActiveRun: (channelState, message, prompt, child = null, phase = 'exec') => {
      channelState.activeRun = {
        messageId: message.id,
        prompt,
        child,
        phase,
        queue: channelState.queue,
        completedSteps: [],
        recentActivities: [],
        progressPlan: null,
      };
    },
    acquireWorkspace: async () => ({ acquired: true, aborted: false, release() {} }),
    stopChildProcess: () => {},
    runTask: async (options) => {
      options.onSpawn?.({ pid: 123 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: ['thinking'],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-2',
        usage: { input_tokens: 321 },
      };
    },
    isCliNotFound: () => false,
    slashRef: (name) => `/bot-${name}`,
    safeError: (err) => err?.message || String(err),
    truncate: (text, max) => (String(text || '').length <= max ? String(text || '') : `${String(text).slice(0, max - 3)}...`),
    toOptionalInt: (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.floor(n) : null;
    },
    extractInputTokensFromUsage: (usage) => usage?.input_tokens ?? null,
    composeFinalAnswerText: ({ finalAnswerMessages }) => finalAnswerMessages.join('\n\n'),
    sleep: async () => {},
  };

  return {
    session,
    replyLog,
    progressCalls,
    get saveCount() {
      return saveCount;
    },
    orchestrator: createPromptOrchestrator({ ...deps, ...overrides }),
  };
}

test('createPromptOrchestrator.shouldCompactSession respects strategy threshold and session binding', () => {
  const { session, orchestrator } = createOrchestrator();
  session.lastInputTokens = 250_000;

  assert.equal(orchestrator.shouldCompactSession(session), true);

  session.runnerSessionId = null;
  session.codexThreadId = null;
  assert.equal(orchestrator.shouldCompactSession(session), false);
});

test('createPromptOrchestrator.handlePrompt runs task updates session and replies with result', async () => {
  const harness = createOrchestrator();
  const { session, replyLog, progressCalls, orchestrator } = harness;
  const message = {
    id: 'msg-1',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'do work', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(session.runnerSessionId, 'sess-2');
  assert.equal(session.codexThreadId, 'sess-2');
  assert.equal(session.lastInputTokens, 321);
  assert.equal(harness.saveCount > 0, true);
  assert.equal(replyLog.length, 1);
  assert.match(replyLog[0], /final answer/);
  assert.match(replyLog[0], /• session: \*\*demo\*\* \(`sess-2`\)/);
  assert.deepEqual(progressCalls[0], {
    type: 'start',
    initialLatestStep: '等待 workspace 锁：/repo/demo',
  });
  assert.deepEqual(progressCalls[1], {
    type: 'setLatestStep',
    text: '已获取 workspace 锁：/repo/demo',
  });
  assert.deepEqual(progressCalls[2], {
    type: 'sync',
    options: { forceEmit: true },
  });
  assert.deepEqual(progressCalls[3], {
    type: 'finish',
    outcome: { ok: true, cancelled: false, timedOut: false, error: '' },
  });
});

test('createPromptOrchestrator.handlePrompt adds retry button after final failure', async () => {
  let runCount = 0;
  const delays = [];
  const harness = createOrchestrator({
    resolveTaskRetrySetting: () => ({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 2000, source: 'env default' }),
    runTask: async (options) => {
      runCount += 1;
      options.onSpawn?.({ pid: 456 });
      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        error: 'runner exploded',
        logs: ['trace line'],
        notes: [],
        reasonings: [],
        messages: [],
        finalAnswerMessages: [],
        threadId: null,
        usage: null,
      };
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const { replyLog, progressCalls, orchestrator } = harness;
  const message = {
    id: 'msg-2',
    author: { id: 'user-9' },
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'fail this', channelState);

  assert.deepEqual(outcome, { ok: false, cancelled: false });
  assert.equal(runCount, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(typeof replyLog[0], 'object');
  assert.match(replyLog[0].content, /Codex 执行失败/);
  assert.match(replyLog[0].content, /已自动重试 2 次/);
  assert.match(replyLog[0].content, /runner exploded/);
  assert.deepEqual(replyLog[0].components, [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: 'Retry',
          custom_id: 'cmd:retry:user-9',
        },
      ],
    },
  ]);
  assert.equal(progressCalls.some((entry) => entry.type === 'setLatestStep' && /第 1\/3 次尝试失败/.test(entry.text)), true);
  assert.equal(progressCalls.some((entry) => entry.type === 'setLatestStep' && /第 2\/3 次尝试失败/.test(entry.text)), true);
  assert.deepEqual(progressCalls.at(-1), {
    type: 'finish',
    outcome: { ok: false, cancelled: false, timedOut: false, error: 'runner exploded' },
  });
});
