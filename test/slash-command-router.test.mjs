import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSlashCommandRouter,
  parseCommandActionButtonId,
} from '../src/slash-command-router.js';

class FakeActionRowBuilder {
  constructor() {
    this.data = { components: [] };
  }

  addComponents(...components) {
    this.data.components.push(...components);
    return this;
  }
}

class FakeModalBuilder {
  constructor() {
    this.data = { components: [] };
  }

  setCustomId(value) {
    this.data.customId = value;
    return this;
  }

  setTitle(value) {
    this.data.title = value;
    return this;
  }

  addComponents(...components) {
    this.data.components.push(...components);
    return this;
  }
}

class FakeTextInputBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(value) {
    this.data.customId = value;
    return this;
  }

  setLabel(value) {
    this.data.label = value;
    return this;
  }

  setStyle(value) {
    this.data.style = value;
    return this;
  }

  setPlaceholder(value) {
    this.data.placeholder = value;
    return this;
  }

  setRequired(value) {
    this.data.required = value;
    return this;
  }

  setMaxLength(value) {
    this.data.maxLength = value;
    return this;
  }
}

const FakeTextInputStyle = {
  Short: 1,
  Paragraph: 2,
};

function createInteraction(commandName, optionValues = {}) {
  return {
    commandName,
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    user: { id: 'user-1' },
    options: {
      getSubcommand() {
        return optionValues.subcommand ?? null;
      },
      getString(name) {
        return optionValues[name] ?? null;
      },
    },
  };
}

function createRouterState(overrides = {}) {
  const session = { provider: 'codex', language: 'zh' };
  const replies = [];
  let resetCalls = 0;
  const cancelCalls = [];
  const retryCalls = [];
  const browseCalls = [];
  const settingsCalls = [];
  const modelSettingsCalls = [];
  const compactCalls = [];
  let fastModeSetting = { enabled: false, supported: true, source: 'config.toml' };
  let runtimeModeSetting = { mode: 'normal', supported: true, source: 'env default' };
  let retryOutcome = { ok: true, enqueued: true, queuedAhead: 0 };
  const closeRuntimeCalls = [];

  const router = createSlashCommandRouter({
    slashRef: (name) => `/cx_${name}`,
    getSession: () => session,
    getSessionLanguage: (currentSession) => currentSession.language,
    getSessionProvider: (currentSession) => currentSession.provider,
    getProviderDisplayName: (provider) => provider,
    getEffectiveSecurityProfile: () => ({ profile: 'team' }),
    resolveFastModeSetting: () => fastModeSetting,
    resolveRuntimeModeSetting: () => runtimeModeSetting,
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
      setModel(currentSession, value) {
        currentSession.model = String(value || '').trim().toLowerCase() === 'default' ? null : value;
        return { model: currentSession.model };
      },
      setFastMode(_session, enabled) {
        fastModeSetting = { enabled: Boolean(enabled), supported: true, source: enabled === null ? 'config.toml' : 'session override' };
        return { fastModeSetting };
      },
      setRuntimeMode(_session, mode) {
        runtimeModeSetting = { mode: mode || 'normal', supported: true, source: mode ? 'session override' : 'env default' };
        session.runtimeMode = mode;
        return { runtimeMode: mode };
      },
      setReasoningEffort(currentSession, value) {
        currentSession.effort = String(value || '').trim().toLowerCase() === 'default' ? null : value;
        return { effort: currentSession.effort };
      },
      applyCompactConfig() {},
      setMode: () => ({ mode: 'safe' }),
      bindSession: () => ({ providerLabel: 'Codex', sessionId: 'sid' }),
      renameSession: () => ({ label: 'name' }),
      setOnboardingEnabled: () => ({ enabled: true }),
      setLanguage: () => ({ language: 'zh' }),
      setSecurityProfile: () => ({ profile: 'team' }),
      setTimeoutMs: () => ({ timeoutSetting: { timeoutMs: 0, source: 'default' } }),
      setExtraInfoEnabled(currentSession, enabled) {
        currentSession.extraInfoEnabled = enabled;
        return { extraInfoEnabled: enabled };
      },
      setExtraInfoText(currentSession, text) {
        currentSession.extraInfoText = text;
        return { extraInfoText: text };
      },
      resetExtraInfo(currentSession) {
        currentSession.extraInfoEnabled = null;
        currentSession.extraInfoText = null;
        return { extraInfoEnabled: null, extraInfoText: null };
      },
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
    formatFastModeConfigHelp: () => 'fast-help',
    formatFastModeConfigReport: (_language, provider, setting, changed) => `${provider}:${setting.supported}:${setting.enabled}:${setting.source}:${changed}`,
    formatRuntimeModeConfigHelp: () => 'runtime-help',
    formatRuntimeModeConfigReport: (_language, provider, setting, changed) => `${provider}:${setting.supported}:${setting.mode}:${setting.source}:${changed}`,
    formatProfileConfigHelp: () => '',
    formatProfileConfigReport: () => '',
    formatTimeoutConfigHelp: () => '',
    formatTimeoutConfigReport: () => '',
    formatProgressReport: () => '',
    formatCancelReport: (outcome) => JSON.stringify(outcome),
    formatCompactStrategyConfigHelp: () => '',
    formatCompactConfigReport: () => '',
    formatExtraInfoConfigHelp: () => 'extra-help',
    formatExtraInfoConfigReport: (_language, currentSession, key, channel, changed) => (
      `${currentSession.extraInfoEnabled}:${currentSession.extraInfoText}:${key}:${channel?.id}:${changed}`
    ),
    ActionRowBuilder: FakeActionRowBuilder,
    ModalBuilder: FakeModalBuilder,
    TextInputBuilder: FakeTextInputBuilder,
    TextInputStyle: FakeTextInputStyle,
    formatCompactConfigUnsupported: () => '',
    formatReasoningEffortUnsupported: () => '',
    normalizeProvider: (value) => value,
    parseWorkspaceCommandAction: (value) => String(value || '').trim().toLowerCase() === 'browse'
      ? { type: 'browse' }
      : { type: 'status' },
    parseUiLanguageInput: () => 'zh',
    parseFastModeAction: (value) => {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'status') return { type: 'status' };
      if (raw === 'default') return { type: 'set', enabled: null };
      if (raw === 'on') return { type: 'set', enabled: true };
      if (raw === 'off') return { type: 'set', enabled: false };
      return { type: 'invalid' };
    },
    parseRuntimeModeAction: (value) => {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'status') return { type: 'status' };
      if (raw === 'default') return { type: 'set', mode: null };
      if (raw === 'normal' || raw === 'long') return { type: 'set', mode: raw };
      return { type: 'invalid' };
    },
    parseSecurityProfileInput: () => 'team',
    parseTimeoutConfigAction: () => ({ type: 'status' }),
    parseCompactConfigAction: () => ({ type: 'status' }),
    parseExtraInfoConfigAction: (key, value) => {
      if (key === 'on') return { type: 'set_enabled', enabled: true };
      if (key === 'off') return { type: 'set_enabled', enabled: false };
      if (key === 'text') return { type: 'set_text', text: value };
      if (key === 'default') return { type: 'reset' };
      if (key === 'bad') return { type: 'invalid' };
      return { type: 'status' };
    },
    providerSupportsCompactConfigAction: () => true,
    cancelChannelWork: (key, reason) => {
      const outcome = { key, reason };
      cancelCalls.push(outcome);
      return outcome;
    },
    closeRuntimeSession: (key, reason) => {
      closeRuntimeCalls.push({ key, reason });
      return true;
    },
    retryLastPrompt: async (key, userId) => {
      retryCalls.push({ key, userId });
      return retryOutcome;
    },
    compactSession: async (message, key) => {
      compactCalls.push({ key, channelId: message.channel?.id || null });
      return { ok: true };
    },
    openWorkspaceBrowser: ({ key, mode, userId }) => {
      const payload = { content: `browse:${mode}:${key}:${userId}`, components: [] };
      browseCalls.push(payload);
      return payload;
    },
    openSettingsPanel: ({ key, userId, activeSection, flags }) => {
      const payload = { content: `settings:${key}:${userId}:${activeSection}`, components: [], flags };
      settingsCalls.push(payload);
      return payload;
    },
    openModelSettingsPanel: ({ key, userId, flags }) => {
      const payload = { content: `model-settings:${key}:${userId}`, components: [], flags };
      modelSettingsCalls.push(payload);
      return payload;
    },
    resolvePath: (value) => value,
    safeError: (err) => String(err?.message || err),
    ...overrides,
  });

  return {
    session,
    replies,
    router,
    getBrowseCalls: () => [...browseCalls],
    getResetCalls: () => resetCalls,
    getCancelCalls: () => [...cancelCalls],
    getRetryCalls: () => [...retryCalls],
    setRetryOutcome: (value) => {
      retryOutcome = value;
    },
    getSettingsCalls: () => [...settingsCalls],
    getModelSettingsCalls: () => [...modelSettingsCalls],
    getFastModeSetting: () => fastModeSetting,
    getRuntimeModeSetting: () => runtimeModeSetting,
    getCloseRuntimeCalls: () => [...closeRuntimeCalls],
    getCompactCalls: () => [...compactCalls],
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

test('createSlashCommandRouter opens compact model panel when model command has no options', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_model'),
    commandName: 'model',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getModelSettingsCalls(), [{
    content: 'model-settings:channel-1:user-1',
    components: [],
    flags: 64,
  }]);
  assert.deepEqual(state.replies, [{
    content: 'model-settings:channel-1:user-1',
    components: [],
    flags: 64,
  }]);
});

test('createSlashCommandRouter model command can update model and effort together', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_model', { name: 'gpt-5.4', effort: 'xhigh' }),
    commandName: 'model',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.session.model, 'gpt-5.4');
  assert.equal(state.session.effort, 'xhigh');
  assert.deepEqual(state.replies, ['✅ model = gpt-5.4，effort = xhigh']);
  assert.deepEqual(state.getCloseRuntimeCalls(), [{ key: 'channel-1', reason: 'runtime config changed' }]);
});

test('createSlashCommandRouter creates native Codex fork in a new thread and preserves parent binding', async () => {
  const parentSession = { provider: 'codex', language: 'zh', runnerSessionId: 'parent-1' };
  const childSession = { provider: 'codex', language: 'zh' };
  const threadCreates = [];
  const queuedPrompts = [];
  const threadMessages = [];
  const childThread = {
    id: 'fork-channel-1',
    name: 'fork',
    setNameCalls: [],
    async join() {},
    async setName(name, reason) {
      this.setNameCalls.push({ name, reason });
    },
    async send(payload) {
      threadMessages.push(payload);
    },
  };
  const state = createRouterState({
    getSession(key) {
      return key === 'fork-channel-1' ? childSession : parentSession;
    },
    getSessionId: (currentSession) => currentSession?.runnerSessionId || null,
    getRuntimeSnapshot: () => ({ running: false, queued: 0 }),
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        currentSession.forkedFromSessionId = binding.parentSessionId;
        currentSession.forkedFromChannelId = binding.parentChannelId;
        currentSession.forkedFromProvider = binding.provider;
        return binding;
      },
    },
    async forkCodexThread(options) {
      assert.deepEqual(options, { threadId: 'parent-1' });
      return { threadId: 'fork-session-1', forkedFromId: 'parent-1' };
    },
    async enqueuePrompt(message, key, content, securityContext) {
      queuedPrompts.push({ message, key, content, securityContext });
      return { ok: true, enqueued: true, queuedAhead: 0 };
    },
    resolveSecurityContext: () => ({ profile: 'team' }),
  });
  const interaction = createInteraction('cx_fork', { name: 'design branch' });
  interaction.channel = {
    id: 'channel-1',
    threads: {
      async create(options) {
        threadCreates.push(options);
        return childThread;
      },
    },
  };

  const handled = await state.router({
    interaction,
    commandName: 'fork',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(parentSession.runnerSessionId, 'parent-1');
  assert.equal(childSession.runnerSessionId, 'fork-session-1');
  assert.equal(childSession.forkedFromSessionId, 'parent-1');
  assert.equal(childSession.forkedFromChannelId, 'channel-1');
  assert.equal(threadCreates.length, 1);
  assert.equal(threadCreates[0].name, 'design branch');
  assert.deepEqual(childThread.setNameCalls, []);
  assert.equal(queuedPrompts.length, 0);
  assert.equal(threadMessages.length, 1);
  assert.match(threadMessages[0].content, /^<@user-1> 这是从 Codex session `parent-1` fork 过来的。/);
  assert.deepEqual(threadMessages[0].allowedMentions, { users: ['user-1'] });
  assert.match(state.replies[0].content, /已创建 Codex fork：<#fork-channel-1>/);
  assert.match(state.replies[0].content, /fork-session-1/);
});

test('createSlashCommandRouter creates native Claude fork in a new thread and records pending fork source', async () => {
  const parentSession = { provider: 'claude', language: 'zh', runnerSessionId: 'parent-claude-1' };
  const childSession = { provider: 'claude', language: 'zh' };
  const threadCreates = [];
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
  const state = createRouterState({
    getSession(key) {
      return key === 'fork-channel-1' ? childSession : parentSession;
    },
    getSessionProvider: (currentSession) => currentSession.provider,
    getSessionId: (currentSession) => currentSession?.runnerSessionId || null,
    getRuntimeSnapshot: () => ({ running: false, queued: 0 }),
    getProviderDisplayName: (provider) => provider === 'claude' ? 'Claude Code' : provider,
    resolveForkWorkspace: () => '/repo/parent-workspace',
    commandActions: {
      bindForkedSession(currentSession, binding) {
        currentSession.runnerSessionId = binding.sessionId;
        currentSession.forkedFromSessionId = binding.parentSessionId;
        currentSession.forkedFromChannelId = binding.parentChannelId;
        currentSession.forkedFromProvider = binding.provider;
        currentSession.pendingForkFromSessionId = binding.pendingForkFromSessionId;
        return binding;
      },
    },
    async forkCodexThread() {
      throw new Error('Codex fork should not run for Claude');
    },
  });
  const interaction = createInteraction('cx_fork', { name: 'claude branch' });
  interaction.channel = {
    id: 'channel-1',
    threads: {
      async create(options) {
        threadCreates.push(options);
        return childThread;
      },
    },
  };

  const handled = await state.router({
    interaction,
    commandName: 'fork',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(parentSession.runnerSessionId, 'parent-claude-1');
  assert.match(childSession.runnerSessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(childSession.forkedFromSessionId, 'parent-claude-1');
  assert.equal(childSession.forkedFromProvider, 'claude');
  assert.equal(childSession.workspaceDir, '/repo/parent-workspace');
  assert.equal(childSession.pendingForkFromSessionId, 'parent-claude-1');
  assert.equal(threadCreates[0].name, 'claude branch');
  assert.deepEqual(childThread.setNameCalls, []);
  assert.equal(threadMessages.length, 1);
  assert.match(threadMessages[0].content, /^<@user-1> 这是从 Claude session `parent-claude-1` fork 过来的。/);
  assert.deepEqual(threadMessages[0].allowedMentions, { users: ['user-1'] });
  assert.match(state.replies[0].content, /已创建 Claude fork：<#fork-channel-1>/);
});

test('createSlashCommandRouter refuses Codex fork while parent is running', async () => {
  const state = createRouterState({
    getSessionId: () => 'parent-1',
    getRuntimeSnapshot: () => ({ running: true, queued: 0 }),
    async forkCodexThread() {
      throw new Error('should not fork');
    },
  });

  const handled = await state.router({
    interaction: createInteraction('cx_fork'),
    commandName: 'fork',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.replies[0].content, '⏳ 父频道正在运行任务，等这轮结束后再 fork。');
});

test('createSlashCommandRouter rejects fork for providers without native fork', async () => {
  const state = createRouterState({
    async forkCodexThread() {
      throw new Error('should not fork');
    },
  });
  state.session.provider = 'gemini';

  const handled = await state.router({
    interaction: createInteraction('cx_fork'),
    commandName: 'fork',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.match(state.replies[0].content, /不支持原生 fork/);
});

test('createSlashCommandRouter rejects slash goal set without an objective instead of opening a modal', async () => {
  const modals = [];
  const state = createRouterState();
  const interaction = createInteraction('cx_goal', { action: 'set' });
  interaction.showModal = async (modal) => {
    modals.push(modal);
  };

  const handled = await state.router({
    interaction,
    commandName: 'goal',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(modals.length, 0);
  assert.match(state.replies[0].content, /goal objective is required/);
});

test('createSlashCommandRouter sets a Codex goal from slash objective fields', async () => {
  const goalCalls = [];
  const queuedPrompts = [];
  const state = createRouterState({
    getSessionId: () => 'thread-1',
    async setCodexThreadGoal(options) {
      goalCalls.push(options);
      return {
        goal: {
          threadId: options.threadId,
          objective: options.objective,
          status: options.status,
          tokenBudget: options.tokenBudget,
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
  });

  const handled = await state.router({
    interaction: createInteraction('cx_goal', {
      action: 'set',
      objective: 'ship Discord goal command',
      token_budget: '90000',
    }),
    commandName: 'goal',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(goalCalls, [{
    threadId: 'thread-1',
    objective: 'ship Discord goal command',
    status: 'active',
    tokenBudget: 90000,
  }]);
  assert.match(state.replies[0].content, /goal 已设置/);
  assert.match(state.replies[0].content, /ship Discord goal command/);
  assert.match(state.replies[0].content, /已触发自动续跑/);
  assert.equal(queuedPrompts.length, 1);
  assert.equal(queuedPrompts[0].key, 'channel-1');
  assert.match(queuedPrompts[0].content, /Continue working toward the active Codex goal/);
});

test('createSlashCommandRouter sets a Codex goal from modal submit', async () => {
  const goalCalls = [];
  const replies = [];
  const queuedPrompts = [];
  const channelSends = [];
  const interactionFollowUps = [];
  const state = createRouterState({
    getSessionId: () => 'thread-1',
    async setCodexThreadGoal(options) {
      goalCalls.push(options);
      return {
        goal: {
          threadId: options.threadId,
          objective: options.objective,
          status: options.status,
          tokenBudget: options.tokenBudget,
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
  });

  const handled = await state.router.handleGoalModalSubmit({
    customId: 'goalm:set:user-1',
    channelId: 'channel-1',
    channel: {
      id: 'channel-1',
      async send(payload) {
        channelSends.push(payload);
        return { id: 'channel-message-1' };
      },
    },
    user: { id: 'user-1' },
    fields: {
      getTextInputValue(name) {
        if (name === 'goal_objective') return 'ship Discord goal command';
        if (name === 'goal_token_budget') return '90000';
        return '';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    async followUp(payload) {
      interactionFollowUps.push(payload);
      return { id: 'interaction-followup-1' };
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(goalCalls, [{
    threadId: 'thread-1',
    objective: 'ship Discord goal command',
    status: 'active',
    tokenBudget: 90000,
  }]);
  assert.match(replies[0].content, /goal 已设置/);
  assert.match(replies[0].content, /ship Discord goal command/);
  assert.match(replies[0].content, /已触发自动续跑/);
  assert.equal(queuedPrompts.length, 1);
  assert.equal(queuedPrompts[0].key, 'channel-1');
  assert.match(queuedPrompts[0].content, /Continue working toward the active Codex goal/);

  await queuedPrompts[0].message.reply('runtime progress card');
  assert.deepEqual(channelSends, ['runtime progress card']);
  assert.deepEqual(interactionFollowUps, []);
});

test('createSlashCommandRouter rejects empty Codex goal modal submit', async () => {
  const goalCalls = [];
  const replies = [];
  const state = createRouterState({
    getSessionId: () => 'thread-1',
    async setCodexThreadGoal(options) {
      goalCalls.push(options);
      throw new Error('should not call app-server');
    },
  });

  const handled = await state.router.handleGoalModalSubmit({
    customId: 'goalm:set:user-1',
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    user: { id: 'user-1' },
    fields: {
      getTextInputValue() {
        return '';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(goalCalls.length, 0);
  assert.match(replies[0].content, /goal objective is required/);
});

test('createSlashCommandRouter rejects Codex goal without a bound session', async () => {
  const state = createRouterState({
    getSessionId: () => null,
    async setCodexThreadGoal() {
      throw new Error('should not call app-server');
    },
  });

  const handled = await state.router({
    interaction: createInteraction('cx_goal', {
      action: 'status',
    }),
    commandName: 'goal',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.match(state.replies[0].content, /还没有绑定 Codex session/);
});

test('createSlashCommandRouter rejects goal for non-codex providers', async () => {
  const state = createRouterState({
    async getCodexThreadGoal() {
      throw new Error('should not call app-server');
    },
  });
  state.session.provider = 'claude';

  const handled = await state.router({
    interaction: createInteraction('cx_goal', { action: 'status' }),
    commandName: 'goal',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.match(state.replies[0].content, /goal 只支持 Codex/);
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
  assert.deepEqual(state.getCancelCalls(), [{ key: 'channel-1', reason: 'slash_cancel' }]);
  assert.deepEqual(state.replies, [{
    content: JSON.stringify({ key: 'channel-1', reason: 'slash_cancel' }),
    flags: 64,
  }]);
});

test('createSlashCommandRouter awaits async status reports', async () => {
  const state = createRouterState({
    formatStatusReport: async () => 'status-with-live-quota',
  });

  const handled = await state.router({
    interaction: createInteraction('cx_status'),
    commandName: 'status',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: 'status-with-live-quota',
    flags: 64,
  }]);
});

test('createSlashCommandRouter blocks project upgrade mode changes for non-admin users', async () => {
  let modeCalls = 0;
  const state = createRouterState({
    canManageProjectUpgrade: () => false,
    setProjectUpgradeMode: () => {
      modeCalls += 1;
      return { mode: 'auto' };
    },
  });

  const handled = await state.router({
    interaction: createInteraction('cx_upgrade', { action: 'mode', mode: 'auto' }),
    commandName: 'upgrade',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(modeCalls, 0);
  assert.deepEqual(state.replies, [{
    content: '❌ 只有项目升级管理员可以修改升级模式。',
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

test('createSlashCommandRouter opens the interactive settings panel', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_settings'),
    commandName: 'settings',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getSettingsCalls(), [{
    content: 'settings:channel-1:user-1:defaults',
    components: [],
    flags: 64,
  }]);
  assert.deepEqual(state.replies, [{
    content: 'settings:channel-1:user-1:defaults',
    components: [],
    flags: 64,
  }]);
});

test('parseCommandActionButtonId decodes command buttons', () => {
  assert.deepEqual(parseCommandActionButtonId('cmd:new:123456789'), {
    command: 'new',
    userId: '123456789',
  });
  assert.deepEqual(parseCommandActionButtonId('cmd:retry:123456789'), {
    command: 'retry',
    userId: '123456789',
  });
  assert.equal(parseCommandActionButtonId('cmd:unknown:123456789'), null);
});

test('createSlashCommandRouter routes retry command through retry handler', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_retry'),
    commandName: 'retry',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getRetryCalls(), [{ key: 'channel-1', userId: 'user-1' }]);
  assert.deepEqual(state.replies, [{
    content: '🔁 已重新加入队列。',
    flags: 64,
  }]);
});

test('createSlashCommandRouter rejects only unsupported compact actions for non-native providers', async () => {
  const state = createRouterState({
    parseCompactConfigAction: () => ({ type: 'set_strategy', strategy: 'native' }),
    providerSupportsCompactConfigAction: () => false,
    formatCompactConfigUnsupported: () => '⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。',
  });
  state.session.provider = 'gemini';
  const interaction = createInteraction('cx_compact');
  interaction.options.getString = (name) => (name === 'key' ? 'strategy' : 'native');

  const handled = await state.router({
    interaction,
    commandName: 'compact',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: '⚠️ 当前 provider Gemini CLI 不支持 `native` 压缩。',
    flags: 64,
  }]);
});

test('createSlashCommandRouter runs manual compact from slash compact', async () => {
  const state = createRouterState({
    parseCompactConfigAction: () => ({ type: 'run' }),
  });
  const interaction = createInteraction('cx_compact');

  const handled = await state.router({
    interaction,
    commandName: 'compact',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: '已开始手动压缩。',
    flags: 64,
  }]);
  assert.deepEqual(state.getCompactCalls(), [{ key: 'channel-1', channelId: 'channel-1' }]);
});

test('createSlashCommandRouter updates extra info config', async () => {
  const state = createRouterState();

  const handled = await state.router({
    interaction: createInteraction('cx_extra_info', {
      key: 'text',
      value: '[D {thread}]',
    }),
    commandName: 'extra_info',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.session.extraInfoText, '[D {thread}]');
  assert.match(state.replies[0].content, /true/);
  assert.match(state.replies[0].content, /\[D \{thread\}\]/);
});

test('createSlashCommandRouter shows compact help for removed manual continue subcommand', async () => {
  const state = createRouterState({
    parseCompactConfigAction: () => ({ type: 'invalid' }),
    formatCompactStrategyConfigHelp: () => 'compact-help',
  });
  const interaction = createInteraction('cx_compact');
  interaction.options.getString = (name) => (name === 'key' ? 'continue' : '');

  const handled = await state.router({
    interaction,
    commandName: 'compact',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: 'compact-help',
    flags: 64,
  }]);
});

test('createSlashCommandRouter updates fast mode for codex provider', async () => {
  const state = createRouterState();
  const interaction = createInteraction('cx_fast');
  interaction.options.getString = () => 'on';

  const handled = await state.router({
    interaction,
    commandName: 'fast',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.getFastModeSetting(), { enabled: true, supported: true, source: 'session override' });
  assert.deepEqual(state.replies, [{
    content: 'codex:true:true:session override:true',
    flags: 64,
  }]);
});

test('createSlashCommandRouter updates Claude runtime mode and closes current hot process', async () => {
  const state = createRouterState();
  state.session.provider = 'claude';
  state.session.runnerSessionId = 'sess-stays';
  const interaction = createInteraction('cx_runtime');
  interaction.options.getString = () => 'long';

  const handled = await state.router({
    interaction,
    commandName: 'runtime',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(state.session.runtimeMode, 'long');
  assert.equal(state.session.runnerSessionId, 'sess-stays');
  assert.deepEqual(state.getRuntimeModeSetting(), { mode: 'long', supported: true, source: 'session override' });
  assert.deepEqual(state.getCloseRuntimeCalls(), [{ key: 'channel-1', reason: 'runtime config changed' }]);
  assert.deepEqual(state.replies, [{
    content: 'claude:true:long:session override:true',
    flags: 64,
  }]);
});

test('createSlashCommandRouter reports fast mode unsupported for non-codex providers', async () => {
  const state = createRouterState();
  state.session.provider = 'claude';
  const interaction = createInteraction('cx_fast');
  interaction.options.getString = () => 'status';

  const handled = await state.router({
    interaction,
    commandName: 'fast',
    respond: async (payload) => {
      state.replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(state.replies, [{
    content: 'claude:false:false:provider unsupported:false',
    flags: 64,
  }]);
});
