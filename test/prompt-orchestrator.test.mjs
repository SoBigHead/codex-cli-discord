import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiscordBridgePromptLine, createPromptOrchestrator } from '../src/prompt-orchestrator.js';

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
    formatProviderSessionTerm: (provider) => {
      if (provider === 'claude') return 'project session';
      if (provider === 'gemini') return 'chat session';
      return 'rollout session';
    },
    getProviderDefaultBin: () => 'codex',
    getProviderBinEnvName: () => 'CODEX_BIN',
    resolveTimeoutSetting: () => ({ timeoutMs: 60_000, source: 'session override' }),
    resolveTaskRetrySetting: () => ({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, source: 'env default' }),
    resolveCompactStrategySetting: () => ({ strategy: 'hard', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
    resolveReplyDeliverySetting: () => ({ mode: 'card_only', source: 'env default' }),
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
        threadId: 'sess-1',
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
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.equal(session.lastInputTokens, 321);
  assert.equal(harness.saveCount > 0, true);
  assert.equal(replyLog.length, 1);
  assert.match(replyLog[0], /final answer/);
  assert.match(replyLog[0], /• rollout session: \*\*demo\*\* \(`sess-1`\)/);
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

test('createPromptOrchestrator.handlePrompt continues when Discord typing indicator fails', async () => {
  const harness = createOrchestrator();
  const { replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-1',
    channel: {
      async sendTyping() {
        throw new Error('Client network socket disconnected before secure TLS connection was established');
      },
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'do work', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(replyLog.length, 1);
  assert.match(replyLog[0], /final answer/);
});

test('createPromptOrchestrator.handlePrompt clears pending Claude fork after first fork turn binds', async () => {
  const harness = createOrchestrator({
    runTask: async () => ({
      ok: true,
      cancelled: false,
      timedOut: false,
      error: '',
      logs: [],
      notes: [],
      reasonings: [],
      messages: ['done'],
      finalAnswerMessages: ['fork answer'],
      threadId: 'child-session',
      usage: { input_tokens: 111 },
    }),
  });
  const { session, orchestrator } = harness;
  session.provider = 'claude';
  session.runnerSessionId = 'child-session';
  session.codexThreadId = 'child-session';
  session.pendingForkFromSessionId = 'parent-session';
  const message = {
    id: 'msg-1',
    channel: {
      async sendTyping() {},
      async send(payload) {
        harness.replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'first fork turn', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(session.runnerSessionId, 'child-session');
  assert.equal(session.pendingForkFromSessionId, null);
  assert.equal(session.lastInputTokens, 111);
  assert.equal(harness.saveCount > 0, true);
});

test('createPromptOrchestrator.handlePrompt keeps pending Claude fork after failed first fork turn', async () => {
  const harness = createOrchestrator({
    runTask: async () => ({
      ok: false,
      cancelled: false,
      timedOut: false,
      error: 'No conversation found with session ID: parent-session',
      logs: [],
      notes: [],
      reasonings: [],
      messages: [],
      finalAnswerMessages: [],
      threadId: 'child-session',
      usage: null,
    }),
  });
  const { session, orchestrator } = harness;
  session.provider = 'claude';
  session.runnerSessionId = 'child-session';
  session.codexThreadId = 'child-session';
  session.pendingForkFromSessionId = 'parent-session';
  const message = {
    id: 'msg-1',
    channel: {
      async sendTyping() {},
      async send(payload) {
        harness.replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'first fork turn', channelState);

  assert.deepEqual(outcome, { ok: false, cancelled: false });
  assert.equal(session.runnerSessionId, 'child-session');
  assert.equal(session.pendingForkFromSessionId, 'parent-session');
});

test('buildDiscordBridgePromptLine keeps Discord context compact', () => {
  const line = buildDiscordBridgePromptLine({
    key: 'fallback-channel',
    message: {
      id: 'msg-1',
      channel: {
        id: 'thread-1',
        parentId: 'parent-1',
      },
    },
  });

  assert.equal(line, '[Via agents-in-discord; discord_thread=thread-1; parent=parent-1]');
});

test('createPromptOrchestrator.handlePrompt sends Discord bridge context as system prompt', async () => {
  const runTaskPrompts = [];
  const runTaskSystemPrompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      runTaskPrompts.push(options.prompt);
      runTaskSystemPrompts.push(options.systemPrompt);
      options.onSpawn?.({ pid: 789 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 111 },
      };
    },
  });
  const { orchestrator } = harness;
  const message = {
    id: 'msg-bridge',
    channel: {
      id: 'thread-bridge',
      parentId: 'parent-channel',
      async sendTyping() {},
      async send() {},
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-bridge', 'do work', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.deepEqual(runTaskPrompts, ['do work']);
  assert.deepEqual(runTaskSystemPrompts, [
    '[Via agents-in-discord; discord_thread=thread-bridge; parent=parent-channel]',
  ]);
});

test('createPromptOrchestrator.handlePrompt can disable or customize stable extra info', async () => {
  const prompts = [];
  const systemPrompts = [];
  const harness = createOrchestrator({
    resolveExtraInfoSetting: (currentSession) => currentSession.extraInfoSetting,
    runTask: async (options) => {
      prompts.push(options.prompt);
      systemPrompts.push(options.systemPrompt);
      options.onSpawn?.({ pid: 790 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 111 },
      };
    },
  });
  const { session, orchestrator } = harness;
  const message = {
    id: 'msg-extra',
    channel: {
      id: 'thread-extra',
      async sendTyping() {},
      async send() {},
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  session.extraInfoSetting = { enabled: false, text: '[X {thread}]' };
  await orchestrator.handlePrompt(message, 'thread-extra', 'plain', channelState);
  session.extraInfoSetting = { enabled: true, text: '[X {thread}]' };
  await orchestrator.handlePrompt(message, 'thread-extra', 'custom', channelState);

  assert.deepEqual(prompts, [
    'plain',
    'custom',
  ]);
  assert.deepEqual(systemPrompts, [
    '',
    '[X thread-extra]',
  ]);
});

test('createPromptOrchestrator.handlePrompt keeps per-message extra info out of system prompt', async () => {
  const calls = [];
  const harness = createOrchestrator({
    resolveExtraInfoSetting: (currentSession) => currentSession.extraInfoSetting,
    runTask: async (options) => {
      calls.push({ prompt: options.prompt, systemPrompt: options.systemPrompt });
      options.onSpawn?.({ pid: 795 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 111 },
      };
    },
  });
  const { session, orchestrator } = harness;
  const message = {
    id: 'msg-extra-dynamic',
    channel: {
      id: 'thread-extra',
      async sendTyping() {},
      async send() {},
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  session.extraInfoSetting = { enabled: true, text: '[X {thread} {msg}]' };
  await orchestrator.handlePrompt(message, 'thread-extra', 'custom', channelState);

  assert.deepEqual(calls, [{
    prompt: 'custom\n\n[X thread-extra msg-extra-dynamic]',
    systemPrompt: '',
  }]);
});

test('createPromptOrchestrator.handlePrompt stages native codex images and cleans them up', async () => {
  const cleanupCalls = [];
  const runTaskCalls = [];
  const harness = createOrchestrator({
    prepareNativeInputs: async () => ({
      inputImages: ['/tmp/native-a.jpg', '/tmp/native-b.png'],
      promptNote: '说明：图片附件已作为原生图片输入附带。',
      notes: [],
      cleanup: async () => {
        cleanupCalls.push('cleanup');
      },
    }),
    runTask: async (options) => {
      runTaskCalls.push(options);
      options.onSpawn?.({ pid: 999 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 111 },
      };
    },
  });
  const { orchestrator } = harness;
  const message = {
    id: 'msg-image',
    attachments: new Map([
      ['1', { name: 'img.jpg', contentType: 'image/jpeg', url: 'https://example.com/img.jpg' }],
    ]),
    channel: {
      async sendTyping() {},
      async send() {},
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'describe image', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(runTaskCalls.length, 1);
  assert.deepEqual(runTaskCalls[0].inputImages, ['/tmp/native-a.jpg', '/tmp/native-b.png']);
  assert.match(runTaskCalls[0].prompt, /原生图片输入/);
  assert.deepEqual(cleanupCalls, ['cleanup']);
});

test('createPromptOrchestrator.handlePrompt can mention the requester on terminal reply', async () => {
  const harness = createOrchestrator({
    resolveReplyDeliverySetting: () => ({ mode: 'card_mention', source: 'session override' }),
  });
  const { replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-mention',
    author: { id: 'user-mention' },
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
  assert.match(replyLog[0], /^<@user-mention>\s+/);
});

test('createPromptOrchestrator.handlePrompt uses the latest reply delivery setting for terminal replies', async () => {
  let replyMode = 'card_only';
  const harness = createOrchestrator({
    resolveReplyDeliverySetting: () => ({ mode: replyMode, source: 'env default' }),
    runTask: async (options) => {
      options.onSpawn?.({ pid: 123 });
      replyMode = 'stream_mention';
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 321 },
      };
    },
  });
  const { replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-dynamic-mention',
    author: { id: 'user-dynamic' },
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
  assert.match(replyLog[0], /^<@user-dynamic>\s+/);
});

test('createPromptOrchestrator.handlePrompt uses the latest reply delivery setting for process messages', async () => {
  let replyMode = 'card_only';
  const streamLog = [];
  const harness = createOrchestrator({
    resolveReplyDeliverySetting: () => ({ mode: replyMode, source: 'env default' }),
    safeChannelSend: async (_message, payload) => {
      streamLog.push(payload);
    },
    createProgressReporter: ({ onStreamProcessMessage }) => ({
      async start() {
        replyMode = 'stream_only';
        await onStreamProcessMessage('live event');
      },
      sync() {},
      setLatestStep() {},
      onEvent() {},
      onLog() {},
      async finish() {},
    }),
  });
  const { orchestrator } = harness;
  const message = {
    id: 'msg-dynamic-stream',
    channel: {
      async sendTyping() {},
      async send(payload) {
        streamLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'do work', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.deepEqual(streamLog, ['live event']);
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
  assert.equal(harness.session.runnerSessionId, 'sess-1');
  assert.equal(harness.session.codexThreadId, 'sess-1');
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

test('createPromptOrchestrator.handlePrompt sends workspace busy payload while waiting on lock', async () => {
  const busyPayloads = [];
  const harness = createOrchestrator({
    buildWorkspaceBusyPayload: (input) => {
      busyPayloads.push(input);
      return {
        content: `busy:${input.workspaceDir}`,
        components: [{ type: 'row' }],
      };
    },
    acquireWorkspace: async (_workspaceDir, _owner, options = {}) => {
      await options.onWait?.({ owner: { provider: 'codex', key: 'thread-2' } });
      return { acquired: true, aborted: false, release() {} };
    },
  });
  const { replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-busy',
    author: { id: 'user-busy' },
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
    async reply(payload) {
      replyLog.push(payload);
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  await orchestrator.handlePrompt(message, 'thread-1', 'do work', channelState);

  assert.equal(busyPayloads.length, 1);
  assert.deepEqual(busyPayloads[0], {
    key: 'thread-1',
    session: harness.session,
    userId: 'user-busy',
    workspaceDir: '/repo/demo',
    owner: { provider: 'codex', key: 'thread-2' },
  });
  assert.deepEqual(replyLog[0], {
    content: 'busy:/repo/demo',
    components: [{ type: 'row' }],
  });
});

test('createPromptOrchestrator.handlePrompt preserves the current session across auto retries', async () => {
  let runCount = 0;
  const harness = createOrchestrator({
    runTask: async (options) => {
      runCount += 1;
      options.onSpawn?.({ pid: 654 });
      if (runCount === 1) {
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
          threadId: 'sess-1',
          usage: null,
        };
      }
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 222 },
      };
    },
    resolveTaskRetrySetting: () => ({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, source: 'test' }),
  });
  const { session, orchestrator } = harness;
  const message = {
    id: 'msg-2b',
    channel: {
      async sendTyping() {},
      async send() {},
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'retry once', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.equal(runCount, 2);
});

test('createPromptOrchestrator.handlePrompt exposes and rejects implicit session switch on success', async () => {
  const harness = createOrchestrator({
    runTask: async (options) => {
      options.onSpawn?.({ pid: 655 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-unexpected',
        usage: { input_tokens: 222 },
      };
    },
  });
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-2c',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'work but drift', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.equal(session.lastInputTokens, 0);
  assert.equal(replyLog.length, 1);
  assert.match(replyLog[0], /本轮运行意外切到了新的 rollout session：sess-unexpected/);
  assert.match(replyLog[0], /当前仍保留原 rollout session：sess-1/);
  assert.match(replyLog[0], /显式执行 \/bot-resume sess-unexpected/);
  assert.match(replyLog[0], /• rollout session: \*\*demo\*\* \(`sess-1`\)/);
});

test('createPromptOrchestrator.handlePrompt keeps the original session after a failed run switches thread ids', async () => {
  const harness = createOrchestrator({
    runTask: async (options) => {
      options.onSpawn?.({ pid: 789 });
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
        threadId: 'sess-failed',
        usage: { input_tokens: 999 },
      };
    },
    resolveTaskRetrySetting: () => ({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, source: 'test' }),
  });
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-3',
    author: { id: 'user-10' },
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'fail once', channelState);

  assert.deepEqual(outcome, { ok: false, cancelled: false });
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.equal(typeof replyLog[0], 'object');
  assert.match(replyLog[0].content, /失败期间新建了新的 rollout session：sess-failed/);
  assert.match(replyLog[0].content, /当前仍保留原 rollout session：sess-1/);
  assert.match(replyLog[0].content, /显式执行 \/bot-resume sess-failed/);
  assert.match(replyLog[0].content, /• rollout session: `sess-1`/);
});

test('createPromptOrchestrator.handlePrompt keeps a failed session when there was no previous binding', async () => {
  const harness = createOrchestrator({
    runTask: async (options) => {
      options.onSpawn?.({ pid: 790 });
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
        threadId: 'sess-failed',
        usage: { input_tokens: 999 },
      };
    },
    resolveTaskRetrySetting: () => ({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, source: 'test' }),
  });
  harness.session.runnerSessionId = null;
  harness.session.codexThreadId = null;
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-4',
    author: { id: 'user-11' },
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'fail fresh', channelState);

  assert.deepEqual(outcome, { ok: false, cancelled: false });
  assert.equal(session.runnerSessionId, 'sess-failed');
  assert.equal(session.codexThreadId, 'sess-failed');
  assert.equal(typeof replyLog[0], 'object');
  assert.match(replyLog[0].content, /本次失败已保留当前 rollout session：sess-failed/);
  assert.match(replyLog[0].content, /• rollout session: `sess-failed`/);
});

test('createPromptOrchestrator.handlePrompt hard-compacts into a fresh session before the next run', async () => {
  const prompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      prompts.push(options.prompt);
      options.onSpawn?.({ pid: 791 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 333 },
      };
    },
    resolveCompactStrategySetting: () => ({ strategy: 'hard', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
  });
  harness.session.lastInputTokens = 250_000;
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-5',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'keep same session', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /请压缩总结当前会话上下文/);
  assert.match(prompts[1], /【压缩摘要开始】\nfinal answer\n【压缩摘要结束】/);
  assert.match(prompts[1], /keep same session/);
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.match(replyLog[0], /已自动压缩上一段rollout session：sess-1/);
});

test('createPromptOrchestrator.compactCurrentSession stores summary and clears the bound session after manual compact', async () => {
  const prompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      prompts.push(options.prompt);
      options.onSpawn?.({ pid: 793 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['manual summary'],
        finalAnswerMessages: ['manual summary'],
        threadId: 'sess-1',
        usage: { input_tokens: 333 },
      };
    },
  });
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-5b',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.compactCurrentSession(message, 'thread-1', channelState);

  assert.equal(outcome.ok, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.lastInputTokens, null);
  assert.equal(session.pendingCompactSummary, 'manual summary');
  assert.equal(session.pendingCompactSourceSessionId, 'sess-1');
  assert.match(prompts[0], /请压缩总结当前会话上下文/);
  assert.match(replyLog[0], /已压缩 rollout session：sess-1/);
});

test('createPromptOrchestrator.compactCurrentSession rescues Claude sessions that are already over context', async () => {
  const harness = createOrchestrator({
    runTask: async () => ({
      ok: false,
      cancelled: false,
      timedOut: false,
      error: 'API Error: The model has reached its context window limit.',
      logs: [],
      notes: [],
      reasonings: [],
      messages: [],
      finalAnswerMessages: [],
      threadId: 'claude-old',
      usage: { input_tokens: 0 },
    }),
    buildClaudeSessionRescueSummary: ({ sessionId, workspaceDir }) => ({
      ok: true,
      summary: `rescued ${sessionId} from ${workspaceDir}`,
      sourceFile: '/tmp/session.jsonl',
    }),
  });
  harness.session.provider = 'claude';
  harness.session.runnerSessionId = 'claude-old';
  harness.session.codexThreadId = 'claude-old';
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-5bb',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.compactCurrentSession(message, 'thread-1', channelState);

  assert.equal(outcome.ok, true);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.pendingCompactSummary, 'rescued claude-old from /repo/demo');
  assert.equal(session.pendingCompactSourceSessionId, 'claude-old');
  assert.match(replyLog[0], /已压缩 project session：claude-old/);
});

test('createPromptOrchestrator.handlePrompt consumes a pending manual compact summary on success', async () => {
  const prompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      prompts.push(options.prompt);
      options.onSpawn?.({ pid: 794 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'fresh-session',
        usage: { input_tokens: 444 },
      };
    },
    resolveCompactStrategySetting: () => ({ strategy: 'hard', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
  });
  harness.session.runnerSessionId = null;
  harness.session.codexThreadId = null;
  harness.session.pendingCompactSummary = 'manual summary';
  harness.session.pendingCompactSourceSessionId = 'old-session';
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-5c',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'continue work', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /【压缩摘要开始】\nmanual summary\n【压缩摘要结束】/);
  assert.match(prompts[0], /continue work/);
  assert.equal(session.runnerSessionId, 'fresh-session');
  assert.equal(session.codexThreadId, 'fresh-session');
  assert.equal(session.pendingCompactSummary, null);
  assert.equal(session.pendingCompactSourceSessionId, null);
  assert.match(replyLog[0], /已加载上一段rollout session：old-session 的手动压缩摘要/);
});

test('createPromptOrchestrator.handlePrompt auto-continues a pinned native compact run', async () => {
  const prompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      prompts.push(options.prompt);
      options.onSpawn?.({ pid: 792 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-1',
        usage: { input_tokens: 444 },
      };
    },
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
  });
  harness.session.lastInputTokens = 250_000;
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-6',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'keep native pinned', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.deepEqual(prompts, ['keep native pinned']);
  assert.equal(session.runnerSessionId, 'sess-1');
  assert.equal(session.codexThreadId, 'sess-1');
  assert.doesNotMatch(replyLog[0], /已达到 native 压缩阈值/);
  assert.doesNotMatch(replyLog[0], /native 压缩已将 rollout session 从 sess-1 切换到/);
});

test('createPromptOrchestrator.handlePrompt adopts the new session after native compact switches it', async () => {
  const prompts = [];
  const harness = createOrchestrator({
    runTask: async (options) => {
      prompts.push(options.prompt);
      options.onSpawn?.({ pid: 793 });
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-2',
        usage: { input_tokens: 555 },
      };
    },
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
  });
  harness.session.lastInputTokens = 250_000;
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-7',
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'continue native compact', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.deepEqual(prompts, ['continue native compact']);
  assert.equal(session.runnerSessionId, 'sess-2');
  assert.equal(session.codexThreadId, 'sess-2');
  assert.equal(session.lastInputTokens, 555);
  assert.doesNotMatch(replyLog[0], /已达到 native 压缩阈值/);
  assert.match(replyLog[0], /native 压缩已将 rollout session 从 sess-1 切换到 sess-2/);
  assert.match(replyLog[0], /• rollout session: \*\*demo\*\* \(`sess-2`\)/);
});

test('createPromptOrchestrator.handlePrompt keeps the switched native compact session across auto retries', async () => {
  let runCount = 0;
  const harness = createOrchestrator({
    runTask: async (options) => {
      runCount += 1;
      options.onSpawn?.({ pid: 794 });
      if (runCount === 1) {
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
          threadId: 'sess-2',
          usage: null,
        };
      }
      return {
        ok: true,
        cancelled: false,
        timedOut: false,
        error: '',
        logs: [],
        notes: [],
        reasonings: [],
        messages: ['done'],
        finalAnswerMessages: ['final answer'],
        threadId: 'sess-2',
        usage: { input_tokens: 666 },
      };
    },
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'env default' }),
    resolveCompactEnabledSetting: () => ({ enabled: true, source: 'env default' }),
    resolveCompactThresholdSetting: () => ({ tokens: 200_000, source: 'env default' }),
    resolveTaskRetrySetting: () => ({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, source: 'test' }),
  });
  harness.session.lastInputTokens = 250_000;
  const { session, replyLog, orchestrator } = harness;
  const message = {
    id: 'msg-8',
    author: { id: 'user-12' },
    channel: {
      async sendTyping() {},
      async send(payload) {
        replyLog.push(payload);
      },
    },
  };
  const channelState = { queue: [], cancelRequested: false, activeRun: null };

  const outcome = await orchestrator.handlePrompt(message, 'thread-1', 'retry native compact', channelState);

  assert.deepEqual(outcome, { ok: true, cancelled: false });
  assert.equal(runCount, 2);
  assert.equal(session.runnerSessionId, 'sess-2');
  assert.equal(session.codexThreadId, 'sess-2');
  assert.equal(session.lastInputTokens, 666);
  assert.match(replyLog[0], /第 1\/2 次尝试期间 native 压缩已将 rollout session 从 sess-1 切换到 sess-2/);
  assert.match(replyLog[0], /• rollout session: \*\*demo\*\* \(`sess-2`\)/);
});
