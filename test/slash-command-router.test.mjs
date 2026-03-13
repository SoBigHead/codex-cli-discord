import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSlashCommandRouter,
  parseCommandActionButtonId,
} from '../src/slash-command-router.js';

function createInteraction(commandName) {
  return {
    commandName,
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    user: { id: 'user-1' },
    options: {
      getString() {
        return null;
      },
    },
  };
}

function createRouterState() {
  const session = { provider: 'codex', language: 'zh' };
  const replies = [];
  let resetCalls = 0;
  const cancelCalls = [];
  const browseCalls = [];

  const router = createSlashCommandRouter({
    slashRef: (name) => `/cx_${name}`,
    getSession: () => session,
    getSessionLanguage: (currentSession) => currentSession.language,
    getSessionProvider: (currentSession) => currentSession.provider,
    getProviderDisplayName: (provider) => provider,
    getEffectiveSecurityProfile: () => ({ profile: 'team' }),
    resolveTimeoutSetting: () => ({ timeoutMs: 0, source: 'default' }),
    isReasoningEffortSupported: () => true,
    commandActions: {
      resetSession() {
        resetCalls += 1;
      },
      startNewSession() {
        resetCalls += 1;
      },
      formatRecentSessionsReport: () => '',
      clearWorkspaceDir: () => ({}),
      setWorkspaceDir: () => ({}),
      setDefaultWorkspaceDir: () => ({}),
      setProvider: () => ({ previous: 'codex' }),
      setModel: () => ({ model: null }),
      setReasoningEffort: () => ({ effort: null }),
      applyCompactConfig() {},
      setMode: () => ({ mode: 'safe' }),
      bindSession: () => ({ providerLabel: 'Codex', sessionId: 'sid' }),
      renameSession: () => ({ label: 'name' }),
      setOnboardingEnabled: () => ({ enabled: true }),
      setLanguage: () => ({ language: 'zh' }),
      setSecurityProfile: () => ({ profile: 'team' }),
      setTimeoutMs: () => ({ timeoutSetting: { timeoutMs: 0, source: 'default' } }),
    },
    isOnboardingEnabled: () => true,
    buildOnboardingActionRows: () => [],
    formatOnboardingStepReport: () => '',
    formatOnboardingDisabledMessage: () => '',
    formatOnboardingConfigReport: () => '',
    formatStatusReport: () => '',
    formatQueueReport: () => '',
    formatDoctorReport: () => '',
    formatWorkspaceReport: () => '',
    formatWorkspaceSetHelp: () => '',
    formatWorkspaceUpdateReport: () => '',
    formatDefaultWorkspaceSetHelp: () => '',
    formatDefaultWorkspaceUpdateReport: () => '',
    formatLanguageConfigReport: () => '',
    formatProfileConfigHelp: () => '',
    formatProfileConfigReport: () => '',
    formatTimeoutConfigHelp: () => '',
    formatTimeoutConfigReport: () => '',
    formatProgressReport: () => '',
    formatCancelReport: (outcome) => JSON.stringify(outcome),
    formatCompactStrategyConfigHelp: () => '',
    formatCompactConfigReport: () => '',
    formatReasoningEffortUnsupported: () => '',
    normalizeProvider: (value) => value,
    parseWorkspaceCommandAction: (value) => String(value || '').trim().toLowerCase() === 'browse'
      ? { type: 'browse' }
      : { type: 'status' },
    parseUiLanguageInput: () => 'zh',
    parseSecurityProfileInput: () => 'team',
    parseTimeoutConfigAction: () => ({ type: 'status' }),
    parseCompactConfigAction: () => ({ type: 'status' }),
    cancelChannelWork: (key, reason) => {
      const outcome = { key, reason };
      cancelCalls.push(outcome);
      return outcome;
    },
    openWorkspaceBrowser: ({ key, mode, userId }) => {
      const payload = { content: `browse:${mode}:${key}:${userId}`, components: [] };
      browseCalls.push(payload);
      return payload;
    },
    resolvePath: (value) => value,
    safeError: (err) => String(err?.message || err),
  });

  return {
    replies,
    router,
    getBrowseCalls: () => [...browseCalls],
    getResetCalls: () => resetCalls,
    getCancelCalls: () => [...cancelCalls],
  };
}

test('createSlashCommandRouter routes new command through new-session handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_new'),
    commandName: 'new',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.getResetCalls(), 1);
  assert.deepEqual(state.replies, [{
    content: '🆕 已切换到新会话。\n下一条普通消息会开启新的上下文。',
    flags: 64,
  }]);
});

test('createSlashCommandRouter routes abort alias to cancel handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_abort'),
    commandName: 'abort',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getCancelCalls(), [{ key: 'channel-1', reason: 'slash_abort' }]);
  assert.deepEqual(state.replies, [{
    content: JSON.stringify({ key: 'channel-1', reason: 'slash_abort' }),
    flags: 64,
  }]);
});

test('createSlashCommandRouter opens workspace browser for setdir browse', async () => {
  const state = createRouterState();
  const interaction = createInteraction('cx_setdir');
  interaction.options.getString = () => 'browse';

  const handled = await state.router({
    interaction,
    commandName: 'setdir',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getBrowseCalls(), [{
    content: 'browse:thread:channel-1:user-1',
    components: [],
  }]);
  assert.deepEqual(state.replies, [{
    content: 'browse:thread:channel-1:user-1',
    components: [],
  }]);
});

test('parseCommandActionButtonId decodes command buttons', () => {
  assert.deepEqual(parseCommandActionButtonId('cmd:new:123456789'), {
    command: 'new',
    userId: '123456789',
  });
  assert.equal(parseCommandActionButtonId('cmd:retry:123456789'), null);
  assert.equal(parseCommandActionButtonId('cmd:unknown:123456789'), null);
});
