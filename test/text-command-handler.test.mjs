import test from 'node:test';
import assert from 'node:assert/strict';

import { createTextCommandHandler } from '../src/text-command-handler.js';

function createMessage(overrides = {}) {
  return {
    author: { id: 'user-1' },
    channel: { id: 'channel-1' },
    ...overrides,
  };
}

test('createTextCommandHandler replies for unknown commands', async () => {
  const replies = [];
  const session = { provider: 'codex' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!wat');

  assert.deepEqual(replies, ['未知命令。发 `!help` 看命令列表。']);
});

test('createTextCommandHandler updates mode through shared command actions', async () => {
  const replies = [];
  const session = { provider: 'codex', mode: 'safe' };
  let saveCount = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    commandActions: {
      setMode(currentSession, mode) {
        currentSession.mode = mode;
        saveCount += 1;
        return { mode: currentSession.mode };
      },
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!mode dangerous');

  assert.equal(session.mode, 'dangerous');
  assert.equal(saveCount, 1);
  assert.deepEqual(replies, ['✅ mode = dangerous']);
});

test('createTextCommandHandler awaits async status reports', async () => {
  const replies = [];
  const session = { provider: 'codex' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    formatStatusReport: async () => 'status-with-live-quota',
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!status');

  assert.deepEqual(replies, ['status-with-live-quota']);
});

test('createTextCommandHandler blocks project upgrade apply for non-admin users', async () => {
  const replies = [];
  const session = { provider: 'codex' };
  let applyCalls = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionLanguage: () => 'zh',
    canManageProjectUpgrade: () => false,
    applyProjectUpgrade: async () => {
      applyCalls += 1;
      return { ok: true, changed: true };
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!upgrade apply');

  assert.equal(applyCalls, 0);
  assert.deepEqual(replies, ['❌ 只有项目升级管理员可以执行升级。']);
});

test('createTextCommandHandler switches to a fresh session without retry hint', async () => {
  const replies = [];
  const session = { provider: 'codex', runnerSessionId: 'sess-1', codexThreadId: 'sess-1', lastInputTokens: 42 };
  let startCalls = 0;

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    commandActions: {
      startNewSession(currentSession) {
        currentSession.runnerSessionId = null;
        currentSession.codexThreadId = null;
        currentSession.lastInputTokens = null;
        startCalls += 1;
      },
    },
    cancelChannelWork: () => ({ cancelledRunning: false, clearedQueued: 0 }),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!new');

  assert.equal(startCalls, 1);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
  assert.equal(session.lastInputTokens, null);
  assert.deepEqual(replies, ['🆕 已切换到新会话。\n下一条普通消息会开启新的上下文。']);
});

test('createTextCommandHandler dequeues queued prompts without cancelling running work', async () => {
  const replies = [];
  const dequeues = [];
  const session = { provider: 'codex' };
  let cancelCalls = 0;
  const removedMessage = {
    id: 'queued-message-1',
    reacted: [],
    async react(emoji) {
      this.reacted.push(emoji);
    },
  };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    cancelChannelWork: () => {
      cancelCalls += 1;
      return { cancelledRunning: true, clearedQueued: 99 };
    },
    canManageQueue: () => false,
    dequeuePrompt: (key, options) => {
      dequeues.push({ key, options });
      return {
        ok: true,
        removedCount: 1,
        remainingQueued: 1,
        removed: [{ message: removedMessage, content: 'queued task' }],
      };
    },
    safeReply: async (_message, payload) => replies.push(payload),
  });

  await handleCommand(createMessage({ author: { id: 'user-1' } }), 'thread-1', '!dq');

  assert.equal(cancelCalls, 0);
  assert.deepEqual(dequeues, [{
    key: 'thread-1',
    options: {
      requesterUserId: 'user-1',
      selector: { type: 'last' },
      isManager: false,
    },
  }]);
  assert.deepEqual(removedMessage.reacted, ['🗑️']);
  assert.match(replies[0], /已撤回 1 条排队消息/);
});

test('createTextCommandHandler supports dequeue by index reply and admin all', async () => {
  const replies = [];
  const calls = [];
  const handleCommand = createTextCommandHandler({
    getSession: () => ({ provider: 'codex' }),
    canManageQueue: (userId) => userId === 'admin-user',
    dequeuePrompt: (key, options) => {
      calls.push({ key, options });
      return {
        ok: true,
        removedCount: options.selector.type === 'all' ? 3 : 1,
        remainingQueued: 0,
        removed: [],
      };
    },
    safeReply: async (_message, payload) => replies.push(payload),
  });

  await handleCommand(createMessage({ author: { id: 'user-1' } }), 'thread-1', '!dq 2');
  await handleCommand(createMessage({
    author: { id: 'user-1' },
    reference: { messageId: 'queued-message-9' },
  }), 'thread-1', '!dq');
  await handleCommand(createMessage({ author: { id: 'admin-user' } }), 'thread-1', '!dq all');

  assert.deepEqual(calls.map((call) => call.options.selector), [
    { type: 'index', index: 2 },
    { type: 'message', messageId: 'queued-message-9' },
    { type: 'all' },
  ]);
  assert.equal(calls[2].options.isManager, true);
  assert.match(replies[2], /已清空 3 条排队消息/);
});

test('createTextCommandHandler reports dequeue permission and started-task failures', async () => {
  const replies = [];
  const outcomes = [
    { ok: false, reason: 'forbidden', removedCount: 0 },
    { ok: false, reason: 'forbidden_all', removedCount: 0 },
    { ok: false, reason: 'already_started', removedCount: 0 },
    { ok: false, reason: 'not_found', removedCount: 0 },
  ];
  const handleCommand = createTextCommandHandler({
    getSession: () => ({ provider: 'codex' }),
    canManageQueue: () => false,
    dequeuePrompt: () => outcomes.shift(),
    safeReply: async (_message, payload) => replies.push(payload),
  });

  await handleCommand(createMessage({ author: { id: 'user-1' } }), 'thread-1', '!dq 1');
  await handleCommand(createMessage({ author: { id: 'user-1' } }), 'thread-1', '!dq all');
  await handleCommand(createMessage({
    author: { id: 'user-1' },
    reference: { messageId: 'running-message' },
  }), 'thread-1', '!dq');
  await handleCommand(createMessage({ author: { id: 'user-1' } }), 'thread-1', '!dq');

  assert.match(replies[0], /只能撤回你自己的排队消息/);
  assert.match(replies[1], /只有管理员可以使用 `!dq all`/);
  assert.match(replies[2], /已经开始执行/);
  assert.match(replies[3], /没有找到你可撤回的排队消息/);
});

test('createTextCommandHandler rejects only unsupported compact actions for non-native providers', async () => {
  const replies = [];
  const session = { provider: 'gemini' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    getProviderDisplayName: (provider) => provider === 'gemini' ? 'Gemini CLI' : provider,
    parseCompactConfigFromText: () => ({ type: 'set_strategy', strategy: 'native' }),
    providerSupportsCompactConfigAction: () => false,
    formatCompactConfigUnsupported: () => '⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。',
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!compact strategy native');

  assert.deepEqual(replies, ['⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。']);
});

test('createTextCommandHandler shows compact help for removed manual continue subcommand', async () => {
  const replies = [];
  const session = { provider: 'codex', language: 'zh' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    parseCompactConfigFromText: () => ({ type: 'invalid' }),
    formatCompactStrategyConfigHelp: () => 'compact-help',
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand({ channel: { id: 'channel-1' }, author: { id: 'user-1' } }, 'thread-1', '!compact continue');

  assert.deepEqual(replies, ['compact-help']);
});

test('createTextCommandHandler explains provider-specific raw config surface when !config is unavailable', async () => {
  const replies = [];
  const session = { provider: 'claude', language: 'en' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'en',
    getProviderDisplayName: (provider) => provider === 'claude' ? 'Claude Code' : provider,
    providerSupportsRawConfigOverrides: () => false,
    formatProviderRawConfigSurface: () => 'no stable raw config passthrough surface exposed by the CLI',
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!config foo=bar');

  assert.match(replies[0], /Claude Code/);
  assert.match(replies[0], /raw config passthrough/);
  assert.match(replies[0], /runtime surface: no stable raw config passthrough surface exposed by the CLI/);
});

test('createTextCommandHandler shows current provider-native resume alias', async () => {
  const replies = [];
  const session = { provider: 'gemini', language: 'zh' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    formatProviderSessionLabel: (_provider, _language, { plural } = {}) => (plural ? 'Gemini chat sessions' : 'Gemini chat session'),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!resume');

  assert.match(replies[0], /!chat_resume <session-id>/);
  assert.match(replies[0], /!chat_sessions/);
  assert.doesNotMatch(replies[0], /!project_resume/);
});

test('createTextCommandHandler creates native Codex fork from text command', async () => {
  const replies = [];
  const parentSession = { provider: 'codex', language: 'zh', runnerSessionId: 'parent-1' };
  const childSession = { provider: 'codex', language: 'zh' };
  const threadMessages = [];
  const childThread = {
    id: 'fork-channel-1',
    setNameCalls: [],
    async join() {},
    async setName(name, reason) {
      this.setNameCalls.push({ name, reason });
    },
    async send(payload) {
      threadMessages.push(payload);
    },
  };
  const threadCreates = [];
  const queuedPrompts = [];
  const handleCommand = createTextCommandHandler({
    getSession: (key) => (key === 'fork-channel-1' ? childSession : parentSession),
    getSessionId: (currentSession) => currentSession?.runnerSessionId || null,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    getProviderDisplayName: () => 'Codex CLI',
    getRuntimeSnapshot: () => ({ running: false, queued: 0 }),
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        currentSession.forkedFromSessionId = binding.parentSessionId;
        return binding;
      },
    },
    async forkCodexThread(options) {
      assert.deepEqual(options, { threadId: 'parent-1' });
      return { threadId: 'fork-session-1' };
    },
    async enqueuePrompt(_message, key, content) {
      queuedPrompts.push({ key, content });
      return { ok: true, enqueued: true, queuedAhead: 0 };
    },
    resolveSecurityContext: () => ({ profile: 'team' }),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand({
    id: 'message-1',
    author: { id: 'user-1' },
    channel: {
      id: 'channel-1',
      threads: {
        async create(options) {
          threadCreates.push(options);
          return childThread;
        },
      },
    },
  }, 'channel-1', '!fork My fork thread');

  assert.equal(parentSession.runnerSessionId, 'parent-1');
  assert.equal(childSession.runnerSessionId, 'fork-session-1');
  assert.equal(childSession.forkedFromSessionId, 'parent-1');
  assert.equal(threadCreates.length, 1);
  assert.equal(threadCreates[0].name, 'My fork thread');
  assert.deepEqual(childThread.setNameCalls, []);
  assert.deepEqual(queuedPrompts, []);
  assert.equal(threadMessages.length, 1);
  assert.match(threadMessages[0].content, /^<@user-1> 这是从 Codex session `parent-1` fork 过来的。/);
  assert.deepEqual(threadMessages[0].allowedMentions, { users: ['user-1'] });
  assert.match(replies[0], /已创建 Codex fork：<#fork-channel-1>/);
});

test('createTextCommandHandler creates native Claude fork from text command', async () => {
  const replies = [];
  const parentSession = { provider: 'claude', language: 'zh', runnerSessionId: 'parent-claude-1' };
  const childSession = { provider: 'claude', language: 'zh' };
  const threadMessages = [];
  const childThread = {
    id: 'fork-channel-1',
    setNameCalls: [],
    async join() {},
    async setName(name, reason) {
      this.setNameCalls.push({ name, reason });
    },
    async send(payload) {
      threadMessages.push(payload);
    },
  };
  const threadCreates = [];
  const handleCommand = createTextCommandHandler({
    getSession: (key) => (key === 'fork-channel-1' ? childSession : parentSession),
    getSessionId: (currentSession) => currentSession?.runnerSessionId || null,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    getProviderDisplayName: () => 'Claude Code',
    getRuntimeSnapshot: () => ({ running: false, queued: 0 }),
    resolveForkWorkspace: () => '/repo/parent-workspace',
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        currentSession.forkedFromSessionId = binding.parentSessionId;
        currentSession.forkedFromProvider = binding.provider;
        currentSession.pendingForkFromSessionId = binding.pendingForkFromSessionId;
        return binding;
      },
    },
    async forkCodexThread() {
      throw new Error('Codex fork should not run for Claude');
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand({
    id: 'message-1',
    author: { id: 'user-1' },
    channel: {
      id: 'channel-1',
      threads: {
        async create(options) {
          threadCreates.push(options);
          return childThread;
        },
      },
    },
  }, 'channel-1', '!fork Claude fork thread');

  assert.equal(parentSession.runnerSessionId, 'parent-claude-1');
  assert.match(childSession.runnerSessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(childSession.forkedFromSessionId, 'parent-claude-1');
  assert.equal(childSession.forkedFromProvider, 'claude');
  assert.equal(childSession.workspaceDir, '/repo/parent-workspace');
  assert.equal(childSession.pendingForkFromSessionId, 'parent-claude-1');
  assert.equal(threadCreates[0].name, 'Claude fork thread');
  assert.deepEqual(childThread.setNameCalls, []);
  assert.equal(threadMessages.length, 1);
  assert.match(threadMessages[0].content, /^<@user-1> 这是从 Claude session `parent-claude-1` fork 过来的。/);
  assert.deepEqual(threadMessages[0].allowedMentions, { users: ['user-1'] });
  assert.match(replies[0], /已创建 Claude fork：<#fork-channel-1>/);
});

test('createTextCommandHandler rejects fork for providers without native fork', async () => {
  const replies = [];
  const session = { provider: 'gemini', language: 'zh' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    getProviderDisplayName: () => 'Gemini',
    async forkCodexThread() {
      throw new Error('should not fork');
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!fork');

  assert.match(replies[0], /不支持原生 fork/);
});

test('createTextCommandHandler sets Codex goal from free text', async () => {
  const replies = [];
  const calls = [];
  const queuedPrompts = [];
  const session = { provider: 'codex', language: 'zh', runnerSessionId: 'thread-1' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionId: (currentSession) => currentSession.runnerSessionId,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    async setCodexThreadGoal(options) {
      calls.push(options);
      return {
        goal: {
          threadId: options.threadId,
          objective: options.objective,
          status: options.status,
          tokenBudget: options.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    },
    async enqueuePrompt(_message, key, content) {
      queuedPrompts.push({ key, content });
      return { ok: true, enqueued: true, queuedAhead: 0 };
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!goal ship Discord goal command');

  assert.deepEqual(calls, [{
    threadId: 'thread-1',
    objective: 'ship Discord goal command',
    status: 'active',
  }]);
  assert.match(replies[0], /goal 已设置/);
  assert.match(replies[0], /ship Discord goal command/);
  assert.match(replies[0], /已触发自动续跑/);
  assert.equal(queuedPrompts.length, 1);
  assert.equal(queuedPrompts[0].key, 'thread-1');
  assert.match(queuedPrompts[0].content, /Continue working toward the active Codex goal/);
});

test('createTextCommandHandler includes goal message attachments in the objective', async () => {
  const replies = [];
  const calls = [];
  const queuedPrompts = [];
  const session = { provider: 'codex', language: 'zh', runnerSessionId: 'thread-1' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionId: (currentSession) => currentSession.runnerSessionId,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    async setCodexThreadGoal(options) {
      calls.push(options);
      return {
        goal: {
          threadId: options.threadId,
          objective: options.objective,
          status: options.status,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    },
    async enqueuePrompt(message, key, content) {
      queuedPrompts.push({ message, key, content });
      return { ok: true, enqueued: true, queuedAhead: 0 };
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });
  const attachments = new Map([
    ['a1', {
      name: 'brief.png',
      contentType: 'image/png',
      size: 1234,
      url: 'https://cdn.example/brief.png',
    }],
  ]);

  await handleCommand(createMessage({ attachments }), 'thread-1', '!goal use this image as the goal spec');

  assert.match(calls[0].objective, /use this image as the goal spec/);
  assert.match(calls[0].objective, /Attachments:/);
  assert.match(calls[0].objective, /brief\.png/);
  assert.equal(queuedPrompts[0].message.attachments, attachments);
  assert.match(replies[0], /brief\.png/);
});

test('createTextCommandHandler clears Codex goal', async () => {
  const replies = [];
  const calls = [];
  const session = { provider: 'codex', language: 'zh', runnerSessionId: 'thread-1' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionId: (currentSession) => currentSession.runnerSessionId,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    async clearCodexThreadGoal(options) {
      calls.push(options);
      return { removed: true };
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!goal clear');

  assert.deepEqual(calls, [{ threadId: 'thread-1' }]);
  assert.equal(replies[0], '✅ goal 已清除。');
});

test('createTextCommandHandler rejects invalid Codex goal budget before app-server call', async () => {
  const replies = [];
  const session = { provider: 'codex', language: 'zh', runnerSessionId: 'thread-1' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionId: (currentSession) => currentSession.runnerSessionId,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    async setCodexThreadGoal() {
      throw new Error('should not call app-server');
    },
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!goal budget -1');

  assert.match(replies[0], /token budget/);
});

test('createTextCommandHandler shows Claude model examples on Claude provider', async () => {
  const replies = [];
  const session = { provider: 'claude', language: 'zh' };
  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!model');

  assert.match(replies[0], /sonnet/);
  assert.doesNotMatch(replies[0], /gpt-5\.3-codex/);
});

test('createTextCommandHandler accepts !c as cancel alias', async () => {
  const replies = [];
  const cancelCalls = [];
  const session = { provider: 'codex', language: 'zh' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    cancelChannelWork: (key, reason) => {
      cancelCalls.push({ key, reason });
      return { cancelledRunning: true, clearedQueued: 2 };
    },
    formatCancelReport: (outcome) => JSON.stringify(outcome),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!c');

  assert.deepEqual(cancelCalls, [{ key: 'thread-1', reason: 'text_command:!c' }]);
  assert.deepEqual(replies, [JSON.stringify({ cancelledRunning: true, clearedQueued: 2 })]);
});

test('createTextCommandHandler updates codex fast mode', async () => {
  const replies = [];
  const session = { provider: 'codex', language: 'zh', fastMode: null };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    parseFastModeAction: () => ({ type: 'set', enabled: true }),
    resolveFastModeSetting: () => ({ enabled: false, supported: true, source: 'config.toml' }),
    commandActions: {
      setFastMode(currentSession, enabled) {
        currentSession.fastMode = enabled;
        return { fastModeSetting: { enabled, supported: true, source: 'session override' } };
      },
    },
    formatFastModeConfigHelp: () => 'help',
    formatFastModeConfigReport: (_language, provider, setting, changed) => `${provider}:${setting.enabled}:${setting.source}:${changed}`,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!fast on');

  assert.equal(session.fastMode, true);
  assert.deepEqual(replies, ['codex:true:session override:true']);
});

test('createTextCommandHandler updates extra info config', async () => {
  const replies = [];
  const session = { provider: 'codex', language: 'zh', extraInfoEnabled: null, extraInfoText: null };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionLanguage: () => 'zh',
    parseExtraInfoConfigFromText: () => ({ type: 'set_text', text: '[D {thread}]' }),
    commandActions: {
      setExtraInfoText(currentSession, text) {
        currentSession.extraInfoText = text;
        return { extraInfoText: text };
      },
    },
    formatExtraInfoConfigHelp: () => 'help',
    formatExtraInfoConfigReport: (_language, currentSession, key, channel, changed) => (
      `${currentSession.extraInfoText}:${key}:${channel?.id}:${changed}`
    ),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!extra_info text [D {thread}]');

  assert.equal(session.extraInfoText, '[D {thread}]');
  assert.deepEqual(replies, ['[D {thread}]:thread-1:channel-1:true']);
});

test('createTextCommandHandler accepts !extra-info alias', async () => {
  const replies = [];
  const session = { provider: 'codex', language: 'zh', extraInfoEnabled: null };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionLanguage: () => 'zh',
    parseExtraInfoConfigFromText: () => ({ type: 'set_enabled', enabled: false }),
    commandActions: {
      setExtraInfoEnabled(currentSession, enabled) {
        currentSession.extraInfoEnabled = enabled;
        return { extraInfoEnabled: enabled };
      },
    },
    formatExtraInfoConfigHelp: () => 'help',
    formatExtraInfoConfigReport: (_language, currentSession, key, channel, changed) => (
      `${currentSession.extraInfoEnabled}:${key}:${channel?.id}:${changed}`
    ),
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!extra-info off');

  assert.equal(session.extraInfoEnabled, false);
  assert.deepEqual(replies, ['false:thread-1:channel-1:true']);
});

test('createTextCommandHandler updates Claude runtime mode and closes current hot process', async () => {
  const replies = [];
  const closed = [];
  const session = {
    provider: 'claude',
    language: 'zh',
    runnerSessionId: 'sess-stays',
    runtimeMode: null,
  };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    parseRuntimeModeAction: () => ({ type: 'set', mode: 'long' }),
    resolveRuntimeModeSetting: (currentSession) => ({
      mode: currentSession.runtimeMode || 'normal',
      supported: true,
      source: currentSession.runtimeMode ? 'session override' : 'env default',
    }),
    commandActions: {
      setRuntimeMode(currentSession, mode) {
        currentSession.runtimeMode = mode;
        return { runtimeMode: mode };
      },
    },
    closeRuntimeSession: (key, reason) => {
      closed.push({ key, reason });
      return true;
    },
    formatRuntimeModeConfigHelp: () => 'help',
    formatRuntimeModeConfigReport: (_language, provider, setting, changed) => `${provider}:${setting.mode}:${setting.source}:${changed}`,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!runtime long');

  assert.equal(session.runtimeMode, 'long');
  assert.equal(session.runnerSessionId, 'sess-stays');
  assert.deepEqual(closed, [{ key: 'thread-1', reason: 'runtime config changed' }]);
  assert.deepEqual(replies, ['claude:long:session override:true']);
});

test('createTextCommandHandler reports fast mode unsupported on non-codex providers', async () => {
  const replies = [];
  const session = { provider: 'claude', language: 'zh' };

  const handleCommand = createTextCommandHandler({
    getSession: () => session,
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionLanguage: () => 'zh',
    formatFastModeConfigHelp: () => 'help',
    formatFastModeConfigReport: (_language, provider, setting, changed) => `${provider}:${setting.supported}:${setting.source}:${changed}`,
    safeReply: async (_message, payload) => {
      replies.push(payload);
    },
  });

  await handleCommand(createMessage(), 'thread-1', '!fast status');

  assert.deepEqual(replies, ['claude:false:provider unsupported:false']);
});
