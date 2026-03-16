import test from 'node:test';
import assert from 'node:assert/strict';

import { createTextCommandHandler } from '../src/text-command-handler.js';

function createMessage() {
  return {
    channel: { id: 'channel-1' },
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
