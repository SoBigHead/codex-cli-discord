import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsPanel } from '../src/settings-panel.js';

class FakeButtonBuilder {
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

  setDisabled(value) {
    this.data.disabled = value;
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeStringSelectMenuBuilder {
  constructor() {
    this.data = { options: [] };
  }

  setCustomId(value) {
    this.data.customId = value;
    return this;
  }

  setPlaceholder(value) {
    this.data.placeholder = value;
    return this;
  }

  addOptions(...options) {
    this.data.options.push(...options.flat());
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

  setValue(value) {
    this.data.value = value;
    return this;
  }
}

const ButtonStyle = {
  Primary: 'primary',
  Secondary: 'secondary',
  Success: 'success',
  Danger: 'danger',
};

const TextInputStyle = {
  Short: 'short',
};

function createPanel({ session, botProvider = null, openWorkspaceBrowser, commandActions = {}, modelCatalog } = {}) {
  return createSettingsPanel({
    botProvider,
    defaultUiLanguage: 'zh',
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder: FakeStringSelectMenuBuilder,
    ModalBuilder: FakeModalBuilder,
    TextInputBuilder: FakeTextInputBuilder,
    TextInputStyle,
    getSession: () => session,
    getSessionLanguage: (currentSession) => currentSession?.language || 'zh',
    getSessionProvider: (currentSession) => currentSession?.provider || 'codex',
    getWorkspaceBinding: (currentSession) => ({
      workspaceDir: currentSession?.workspaceDir || '/repo/demo',
      source: currentSession?.workspaceDir ? 'thread override' : 'provider default',
    }),
    getProviderDefaults: (provider) => ({
      model: provider === 'codex' ? (session?.globalDefaultModel ?? 'gpt-5.4') : '(provider default)',
      profile: provider === 'codex' ? (session?.globalDefaultCodexProfile ?? null) : null,
      profileConfigured: provider === 'codex' ? Boolean(session?.globalDefaultCodexProfile) : false,
      modelConfigured: provider === 'codex' ? (session?.globalDefaultModelConfigured ?? true) : false,
      effort: provider === 'codex' ? (session?.globalDefaultEffort ?? 'high') : '(provider default)',
      effortConfigured: provider === 'codex' ? (session?.globalDefaultEffortConfigured ?? true) : false,
      fastMode: provider === 'codex' ? (session?.globalDefaultFastMode ?? true) : false,
      fastModeConfigured: provider === 'codex' ? (session?.globalDefaultFastModeConfigured ?? true) : false,
      source: provider === 'codex' ? 'config.toml' : 'provider',
    }),
    getProviderDisplayName: (provider) => ({
      codex: 'Codex CLI',
      claude: 'Claude Code',
      gemini: 'Gemini CLI',
    }[provider] || provider),
    getSupportedReasoningEffortLevels: (provider) => provider === 'gemini' ? [] : (provider === 'claude' ? ['high', 'medium', 'low'] : ['xhigh', 'high', 'medium', 'low']),
    getModelCatalog: () => modelCatalog || {
      models: [
        {
          slug: 'gpt-5.4',
          displayName: 'gpt-5.4',
          defaultReasoningLevel: 'medium',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        },
        {
          slug: 'o3',
          displayName: 'o3',
          defaultReasoningLevel: 'high',
          supportedReasoningLevels: ['low', 'medium', 'high'],
        },
      ],
      error: null,
    },
    getProviderCompactCapabilities: () => ({ strategies: ['hard', 'native', 'off'] }),
    normalizeUiLanguage: (value) => String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh',
    resolveModelSetting: (currentSession) => ({
      value: currentSession?.model || currentSession?.inheritedModel || 'gpt-5.4',
      source: currentSession?.modelSource || (currentSession?.model ? 'session override' : 'config.toml'),
    }),
    resolveCodexProfileSetting: (currentSession) => ({
      value: currentSession?.codexProfile || currentSession?.inheritedCodexProfile || null,
      source: currentSession?.codexProfileSource
        || (currentSession?.codexProfile ? 'session override' : (currentSession?.inheritedCodexProfile ? 'parent channel' : 'provider default')),
      supported: currentSession?.provider !== 'claude' && currentSession?.provider !== 'gemini',
      valid: currentSession?.codexProfileValid !== false,
      isExplicit: Boolean(currentSession?.codexProfile || currentSession?.inheritedCodexProfile),
      error: currentSession?.codexProfileError || null,
      availableProfiles: ['work', 'review'],
      configPath: '/tmp/codex-config.toml',
    }),
    getDefaultCodexProfile: () => ({
      profile: session?.globalDefaultCodexProfile || null,
      source: session?.globalDefaultCodexProfile ? 'env default' : 'provider default',
    }),
    resolveReasoningEffortSetting: (currentSession) => ({
      value: currentSession?.effort || currentSession?.inheritedEffort || 'high',
      source: currentSession?.effortSource || (currentSession?.effort ? 'session override' : 'config.toml'),
    }),
    resolveFastModeSetting: (currentSession) => currentSession?.provider === 'codex'
      ? {
        enabled: currentSession?.fastMode ?? currentSession?.inheritedFastMode ?? true,
        supported: true,
        source: currentSession?.fastModeSource
          || (currentSession?.fastMode === null || currentSession?.fastMode === undefined ? 'config.toml' : 'session override'),
      }
      : { enabled: false, supported: false, source: 'provider unsupported' },
    resolveRuntimeModeSetting: (currentSession) => currentSession?.provider === 'claude' || currentSession?.provider === 'codex'
      ? {
        mode: currentSession?.runtimeMode || currentSession?.inheritedRuntimeMode || 'normal',
        supported: true,
        source: currentSession?.runtimeModeSource
          || (currentSession?.runtimeMode ? 'session override' : 'env default'),
      }
      : { mode: 'normal', supported: false, source: 'provider unsupported' },
    resolveBusyPromptModeSetting: (currentSession) => {
      const requestedMode = currentSession?.busyPromptMode || 'queue';
      const canSteer = currentSession?.provider === 'codex' && currentSession?.runtimeMode === 'long';
      return {
        mode: requestedMode === 'steer_if_possible' && !canSteer ? 'queue' : requestedMode,
        requestedMode,
        canSteer,
        supported: true,
        source: currentSession?.busyPromptMode ? 'session override' : 'built-in default',
        reason: requestedMode === 'steer_if_possible' && !canSteer ? 'steer unavailable' : null,
      };
    },
    resolveCompactStrategySetting: (currentSession) => ({
      strategy: currentSession?.compactStrategy || 'native',
      source: currentSession?.compactStrategy ? 'session override' : 'env default',
    }),
    resolveCompactThresholdSetting: (currentSession) => ({
      tokens: currentSession?.compactThresholdTokens ?? currentSession?.inheritedCompactThresholdTokens ?? 272000,
      source: currentSession?.compactThresholdSource
        || ((currentSession?.compactThresholdTokens ?? currentSession?.inheritedCompactThresholdTokens) !== undefined
          ? (currentSession?.compactThresholdTokens !== null && currentSession?.compactThresholdTokens !== undefined ? 'session override' : 'parent channel')
          : 'env default'),
    }),
    resolveReplyDeliverySetting: (currentSession) => ({
      mode: currentSession?.replyDeliveryMode || currentSession?.inheritedReplyDeliveryMode || 'card_only',
      source: currentSession?.replyDeliverySource
        || (currentSession?.replyDeliveryMode ? 'session override' : 'env default'),
    }),
    getReplyDeliveryDefault: () => ({
      mode: session?.globalReplyDeliveryMode || 'card_mention',
      source: session?.globalReplyDeliverySource || 'env default',
    }),
    commandActions,
    openWorkspaceBrowser,
    slashRef: (base) => `/cx_${base}`,
  });
}

test('createSettingsPanel opens an overview payload with key channel settings', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    codexProfile: 'work',
    codexProfileSource: 'session override',
    fastMode: null,
    model: null,
  };
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'overview',
    flags: 64,
  });

  assert.equal(payload.flags, 64);
  assert.match(payload.content, /频道设置/);
  assert.match(payload.content, /provider：`codex`/);
  assert.match(payload.content, /Codex profile：`work`（当前频道）/);
  assert.match(payload.content, /model：`gpt-5.4`/);
  assert.equal(payload.components.length, 2);
  assert.equal(payload.components[0].components[0].data.customId, 'stg:nav:section:picker:12345');
  assert.equal(payload.components[0].components[0].data.placeholder, '选择设置分区');
  assert.equal(payload.components[1].components[0].data.label, '关闭');
});

test('createSettingsPanel defaults to the global codex defaults section', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
  };
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
  });

  assert.match(payload.content, /Codex 默认设置/);
  assert.match(payload.content, /作用域：`~\/.codex\/config\.toml`/);
  assert.match(payload.content, /当前项：Codex 默认/);
  assert.match(payload.content, /effort 和 fast 直接在这里改/);
  assert.match(payload.content, /compact context 长度：272000（环境默认）/);
  assert.equal(payload.components.length, 5);
  assert.equal(payload.components[1].components[0].data.customId, 'stg:act:default_profile:custom:12345');
  assert.equal(payload.components[1].components[1].data.customId, 'stg:act:default_model:custom:12345');
  assert.equal(payload.components[2].components.length, 5);
  assert.equal(payload.components[3].components[0].data.customId, 'stg:set:default_fast:default:12345');
});

test('createSettingsPanel switches active section through the section picker', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
  };
  const updates = [];
  const panel = createPanel({ session });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:nav:section:picker:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    values: ['compact'],
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
  });

  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /当前项：上下文压缩/);
});

test('createSettingsPanel updates fast mode through button interaction', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    fastMode: null,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setFastMode(currentSession, enabled) {
        currentSession.fastMode = enabled;
        return { fastModeSetting: { enabled, supported: true, source: 'session override' } };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:fast:on:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.fastMode, true);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /当前项：Fast Mode/);
  assert.match(updates[0].content, /fast mode：开启（当前频道）/);
});

test('createSettingsPanel updates reply delivery and shows effective source', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    replyDeliveryMode: null,
    globalReplyDeliveryMode: 'card_mention',
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setReplyDeliveryMode(currentSession, mode) {
        currentSession.replyDeliveryMode = mode;
        return { replyDeliveryMode: currentSession.replyDeliveryMode };
      },
      setGlobalReplyDeliveryModeDefault(_currentSession, mode) {
        session.globalReplyDeliveryMode = mode;
        return { mode };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:reply:stream_mention:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.replyDeliveryMode, 'stream_mention');
  assert.match(updates[0].content, /当前项：回复方式/);
  assert.match(updates[0].content, /回复方式：发送过程消息，完成时触发 @（当前频道）/);
  assert.match(updates[0].content, /默认回复方式：只更新进度卡，完成时触发 @（环境默认）/);
});

test('createSettingsPanel updates Claude runtime mode and closes the hot process without clearing session id', async () => {
  const session = {
    provider: 'claude',
    language: 'zh',
    mode: 'safe',
    runnerSessionId: 'sess-claude',
    runtimeMode: null,
  };
  const updates = [];
  const closed = [];

  const actualPanel = createSettingsPanel({
    botProvider: null,
    defaultUiLanguage: 'zh',
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder: FakeStringSelectMenuBuilder,
    ModalBuilder: FakeModalBuilder,
    TextInputBuilder: FakeTextInputBuilder,
    TextInputStyle,
    getSession: () => session,
    getSessionLanguage: () => 'zh',
    getSessionProvider: () => 'claude',
    getWorkspaceBinding: () => ({ workspaceDir: '/repo/demo', source: 'provider default' }),
    getProviderDefaults: () => ({ model: '(provider default)', effort: '(provider default)', source: 'provider' }),
    getProviderDisplayName: () => 'Claude Code',
    getSupportedReasoningEffortLevels: () => ['high', 'medium', 'low'],
    getProviderCompactCapabilities: () => ({ strategies: ['hard', 'native', 'off'] }),
    normalizeUiLanguage: () => 'zh',
    resolveModelSetting: () => ({ value: null, source: 'provider' }),
    resolveReasoningEffortSetting: () => ({ value: null, source: 'provider' }),
    resolveFastModeSetting: () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
    resolveRuntimeModeSetting: (currentSession) => ({
      mode: currentSession.runtimeMode || 'normal',
      supported: true,
      source: currentSession.runtimeMode ? 'session override' : 'env default',
    }),
    resolveBusyPromptModeSetting: (currentSession) => ({
      mode: currentSession.busyPromptMode === 'steer_if_possible' ? 'queue' : (currentSession.busyPromptMode || 'queue'),
      requestedMode: currentSession.busyPromptMode || 'queue',
      canSteer: false,
      supported: true,
      source: currentSession.busyPromptMode ? 'session override' : 'built-in default',
      reason: currentSession.busyPromptMode === 'steer_if_possible' ? 'steer unavailable' : null,
    }),
    resolveCompactStrategySetting: () => ({ strategy: 'native', source: 'env default' }),
    commandActions: {
      setRuntimeMode(currentSession, mode) {
        currentSession.runtimeMode = mode;
        return { runtimeMode: mode };
      },
      setBusyPromptMode(currentSession, mode) {
        currentSession.busyPromptMode = mode === 'steer' ? 'steer_if_possible' : mode;
        return { busyPromptMode: currentSession.busyPromptMode };
      },
    },
    closeRuntimeSession: (key, reason) => {
      closed.push({ key, reason });
    },
    slashRef: (base) => `/cx_${base}`,
  });

  await actualPanel.handleSettingsPanelInteraction({
    customId: 'stg:set:runtime:long:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.runtimeMode, 'long');
  assert.equal(session.runnerSessionId, 'sess-claude');
  assert.deepEqual(closed, [{ key: 'thread-1', reason: 'runtime config changed' }]);
  assert.match(updates[0].content, /当前项：运行时/);
  assert.match(updates[0].content, /运行时：long/);
  assert.match(updates[0].content, /运行中消息：排队/);
});

test('createSettingsPanel keeps steer disabled when runtime cannot actually steer', async () => {
  const session = {
    provider: 'claude',
    language: 'zh',
    mode: 'safe',
    runtimeMode: 'long',
    busyPromptMode: null,
  };
  const actualPanel = createPanel({
    session,
    commandActions: {
      setBusyPromptMode(currentSession, mode) {
        currentSession.busyPromptMode = mode === 'steer' ? 'steer_if_possible' : mode;
        return { busyPromptMode: currentSession.busyPromptMode };
      },
    },
  });
  const payload = actualPanel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'runtime',
  });
  const busyRow = payload.components[2];
  const steerButton = busyRow.components.find((component) => component.data.customId === 'stg:set:busy_prompt:steer:12345');
  assert.equal(steerButton.data.disabled, true);

  const updates = [];
  await actualPanel.handleSettingsPanelInteraction({
    customId: 'stg:set:busy_prompt:queue:12345',
    channelId: 'thread-1',
    channel: { id: 'thread-1' },
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.busyPromptMode, 'queue');
  assert.match(updates[0].content, /运行中消息：排队/);
});

test('createSettingsPanel enables steer for Codex long runtime', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    runtimeMode: 'long',
    busyPromptMode: 'steer_if_possible',
  };
  const actualPanel = createPanel({ session });
  const payload = actualPanel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'runtime',
  });
  const busyRow = payload.components[2];
  const steerButton = busyRow.components.find((component) => component.data.customId === 'stg:set:busy_prompt:steer:12345');
  assert.equal(steerButton.data.disabled, false);
  assert.equal(steerButton.data.style, ButtonStyle.Primary);
});

test('createSettingsPanel shows parent channel as the inherited fast mode source for threads', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    fastMode: null,
    fastModeSource: 'parent channel',
    inheritedFastMode: true,
    parentChannelId: 'channel-1',
  };
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'fast',
  });

  assert.match(payload.content, /fast mode：开启（父频道默认）/);
  const labels = payload.components.flatMap((row) => row.components.map((button) => button.data.label));
  assert.ok(labels.includes('跟随父频道/全局'));
});

test('createSettingsPanel shows parent channel as the inherited model source for threads', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    model: null,
    modelSource: 'parent channel',
    inheritedModel: 'gpt-5.4',
    parentChannelId: 'channel-1',
  };
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'overview',
  });

  assert.match(payload.content, /model：`gpt-5.4`（父频道默认）/);
});

test('createSettingsPanel model section offers CLI catalog choices and effort controls', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    model: 'o3',
    effort: 'high',
  };
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'model',
  });

  assert.match(payload.content, /当前项：模型/);
  assert.match(payload.content, /推理力度也放在这里一起调/);
  const modelSelect = payload.components[1].components[0];
  assert.equal(modelSelect.data.customId, 'stg:set:model:preset:12345');
  assert.deepEqual(modelSelect.data.options.map((option) => option.value), ['default', 'gpt-5.4', 'o3']);
  assert.equal(modelSelect.data.options.find((option) => option.value === 'o3').default, true);
  const labels = payload.components.flatMap((row) => row.components.map((component) => component.data.label));
  assert.ok(labels.includes('手写模型名'));
  assert.ok(labels.includes('xhigh'));
  assert.ok(labels.includes('default'));
});

test('createSettingsPanel exposes a compact model-only panel', () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    model: 'o3',
    effort: 'high',
  };
  const panel = createPanel({ session });

  const payload = panel.openModelSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    flags: 64,
  });

  assert.equal(payload.flags, 64);
  assert.match(payload.content, /^\*\*模型\*\*/);
  assert.doesNotMatch(payload.content, /provider：/);
  assert.doesNotMatch(payload.content, /当前项：/);
  assert.equal(payload.components[0].components[0].data.customId, 'stg:set:quick_model:preset:12345');
  const labels = payload.components.flatMap((row) => row.components.map((component) => component.data.label));
  assert.ok(labels.includes('手写模型名'));
  assert.ok(labels.includes('xhigh'));
  assert.ok(labels.includes('关闭'));
});

test('createSettingsPanel reads Claude model catalog and keeps custom model control', () => {
  const session = {
    provider: 'claude',
    language: 'zh',
    mode: 'safe',
    model: 'sonnet',
    effort: 'high',
  };
  const panel = createPanel({
    session,
    modelCatalog: {
      models: [
        { slug: 'sonnet', displayName: 'sonnet' },
        { slug: 'opus', displayName: 'opus' },
        { slug: 'claude-sonnet-4-6', displayName: 'claude-sonnet-4-6' },
      ],
      error: null,
    },
  });

  const payload = panel.openModelSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
  });

  const modelSelect = payload.components[0].components[0];
  assert.deepEqual(modelSelect.data.options.map((option) => option.value), [
    'default',
    'sonnet',
    'opus',
    'claude-sonnet-4-6',
  ]);
  assert.equal(modelSelect.data.options.find((option) => option.value === 'sonnet').default, true);
  const labels = payload.components.flatMap((row) => row.components.map((component) => component.data.label));
  assert.ok(labels.includes('手写模型名'));
  assert.ok(labels.includes('high'));
  assert.ok(labels.includes('medium'));
  assert.ok(labels.includes('low'));
  assert.ok(!labels.includes('xhigh'));
});

test('createSettingsPanel applies model catalog selection and stays in model section', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    model: null,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setModel(currentSession, value) {
        currentSession.model = String(value || '').trim().toLowerCase() === 'default' ? null : value;
        return { model: currentSession.model };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:model:preset:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    values: ['gpt-5.4'],
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.model, 'gpt-5.4');
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /Active: Model/);
  assert.match(updates[0].content, /model: `gpt-5.4` \(this channel\)/);
});

test('createSettingsPanel applies compact model panel selection without expanding settings', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    model: null,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setModel(currentSession, value) {
        currentSession.model = String(value || '').trim().toLowerCase() === 'default' ? null : value;
        return { model: currentSession.model };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:quick_model:preset:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    values: ['gpt-5.4'],
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.model, 'gpt-5.4');
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /^\*\*Model\*\*/);
  assert.doesNotMatch(updates[0].content, /Active:/);
  assert.match(updates[0].content, /model: `gpt-5.4` \(this channel\)/);
});

test('createSettingsPanel applies effort from the model section without leaving it', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    effort: null,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setReasoningEffort(currentSession, value) {
        currentSession.effort = value === 'default' ? null : value;
        return { effort: currentSession.effort };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:model_effort:xhigh:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.effort, 'xhigh');
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /当前项：模型/);
  assert.match(updates[0].content, /effort：`xhigh`（当前频道）/);
});

test('createSettingsPanel opens a model modal from the model section', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    model: 'gpt-5.4',
  };
  const modals = [];
  const panel = createPanel({ session });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:model:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  assert.equal(modals.length, 1);
  assert.equal(modals[0].data.customId, 'stgm:model:12345');
  assert.equal(modals[0].data.components[0].components[0].data.customId, 'model_name');
  assert.equal(modals[0].data.components[0].components[0].data.value, 'gpt-5.4');
});

test('createSettingsPanel uses Claude examples in Claude model modal', async () => {
  const session = {
    provider: 'claude',
    language: 'zh',
    mode: 'safe',
  };
  const modals = [];
  const panel = createPanel({ session });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:quick_model:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  assert.equal(modals.length, 1);
  assert.match(modals[0].data.components[0].components[0].data.placeholder, /sonnet/);
  assert.doesNotMatch(modals[0].data.components[0].components[0].data.placeholder, /gpt-5\.4/);
});

test('createSettingsPanel opens a global default model modal from the defaults section', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    globalDefaultModel: 'gpt-5.4',
    globalDefaultModelConfigured: true,
  };
  const modals = [];
  const panel = createPanel({ session });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:default_model:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  assert.equal(modals.length, 1);
  assert.equal(modals[0].data.customId, 'stgm:default_model:12345');
  assert.equal(modals[0].data.components[0].components[0].data.value, 'gpt-5.4');
});

test('createSettingsPanel opens codex profile modals from profile and defaults sections', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    codexProfile: 'work',
    globalDefaultCodexProfile: 'review',
  };
  const modals = [];
  const panel = createPanel({ session });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:profile:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:default_profile:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  assert.equal(modals.length, 2);
  assert.equal(modals[0].data.customId, 'stgm:profile:12345');
  assert.equal(modals[0].data.components[0].components[0].data.customId, 'codex_profile_name');
  assert.equal(modals[0].data.components[0].components[0].data.value, 'work');
  assert.equal(modals[1].data.customId, 'stgm:default_profile:12345');
  assert.equal(modals[1].data.components[0].components[0].data.value, 'review');
});

test('createSettingsPanel shows compact threshold in the panel and opens compact threshold modal', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    compactStrategy: 'native',
    compactThresholdTokens: 333000,
  };
  const modals = [];
  const panel = createPanel({ session });

  const payload = panel.openSettingsPanel({
    key: 'thread-1',
    session,
    userId: '12345',
    activeSection: 'compact',
  });

  assert.match(payload.content, /compact 阈值：333000（当前频道）/);
  assert.match(payload.content, /当前项：上下文压缩/);

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:compact_threshold:custom:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal(modal) {
      modals.push(modal);
    },
  });

  assert.equal(modals.length, 1);
  assert.equal(modals[0].data.customId, 'stgm:compact_threshold:12345');
  assert.equal(modals[0].data.components[0].components[0].data.customId, 'compact_threshold_tokens');
  assert.equal(modals[0].data.components[0].components[0].data.value, '333000');
});

test('createSettingsPanel applies model modal submit and replies with a refreshed panel', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    model: null,
  };
  const replies = [];
  const panel = createPanel({
    session,
    commandActions: {
      setModel(currentSession, value) {
        currentSession.model = String(value || '').trim().toLowerCase() === 'default' ? null : value;
        return { model: currentSession.model };
      },
    },
  });

  await panel.handleSettingsPanelModalSubmit({
    customId: 'stgm:model:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    fields: {
      getTextInputValue() {
        return 'o3';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  });

  assert.equal(session.model, 'o3');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].content, /Model updated/);
  assert.match(replies[0].content, /model: `o3` \(this channel\)/);
});

test('createSettingsPanel applies compact threshold modal submit and refreshes compact section', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    compactStrategy: 'native',
    compactThresholdTokens: null,
  };
  const replies = [];
  const panel = createPanel({
    session,
    commandActions: {
      applyCompactConfig(currentSession, parsed) {
        if (parsed.type === 'set_threshold') currentSession.compactThresholdTokens = parsed.tokens;
        return { compactThresholdTokens: currentSession.compactThresholdTokens };
      },
    },
  });

  await panel.handleSettingsPanelModalSubmit({
    customId: 'stgm:compact_threshold:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    fields: {
      getTextInputValue() {
        return '320000';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  });

  assert.equal(session.compactThresholdTokens, 320000);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].content, /Compact token limit updated/);
  assert.match(replies[0].content, /compact token limit: 320000 \(this channel\)/);
  assert.match(replies[0].content, /Active: Context Compaction/);
});

test('createSettingsPanel clears compact threshold override through button interaction', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    compactStrategy: 'native',
    compactThresholdTokens: 320000,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      applyCompactConfig(currentSession, parsed) {
        if (parsed.type === 'set_threshold') currentSession.compactThresholdTokens = parsed.tokens;
        return { compactThresholdTokens: currentSession.compactThresholdTokens };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:compact_threshold:default:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.compactThresholdTokens, null);
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /compact 阈值已改为跟随默认/);
  assert.match(updates[0].content, /compact 阈值：272000（环境默认）/);
});

test('createSettingsPanel rejects invalid compact threshold input', async () => {
  const session = {
    provider: 'codex',
    language: 'en',
    mode: 'safe',
    compactThresholdTokens: 320000,
  };
  const replies = [];
  const panel = createPanel({
    session,
    commandActions: {
      applyCompactConfig() {
        throw new Error('should not apply invalid compact threshold');
      },
    },
  });

  await panel.handleSettingsPanelModalSubmit({
    customId: 'stgm:compact_threshold:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    fields: {
      getTextInputValue() {
        return 'oops';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
  });

  assert.equal(session.compactThresholdTokens, 320000);
  assert.deepEqual(replies, [{
    content: '❌ Invalid compact token limit. Use a positive integer or `default`.',
    flags: 64,
  }]);
});

test('createSettingsPanel updates global effort defaults through button interaction', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    globalDefaultEffort: 'high',
    globalDefaultEffortConfigured: true,
  };
  const updates = [];
  const panel = createPanel({
    session,
    commandActions: {
      setGlobalReasoningEffortDefault(_session, value) {
        session.globalDefaultEffort = value === 'default' ? 'high' : value;
        session.globalDefaultEffortConfigured = value !== 'default';
        return { defaults: { effort: session.globalDefaultEffort, effortConfigured: session.globalDefaultEffortConfigured } };
      },
    },
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:set:default_effort:xhigh:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update(payload) {
      updates.push(payload);
    },
    async reply() {
      throw new Error('should not reply');
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.equal(session.globalDefaultEffort, 'xhigh');
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /当前项：Codex 默认/);
  assert.match(updates[0].content, /effort 默认：`xhigh`（全局配置）/);
});

test('createSettingsPanel opens the existing workspace browser in a separate reply', async () => {
  const session = {
    provider: 'codex',
    language: 'zh',
    mode: 'safe',
    workspaceDir: '/repo/current',
  };
  const replies = [];
  const panel = createPanel({
    session,
    openWorkspaceBrowser: ({ mode, key, userId, flags }) => ({
      content: `browse:${mode}:${key}:${userId}`,
      components: [],
      flags,
    }),
  });

  await panel.handleSettingsPanelInteraction({
    customId: 'stg:act:workspace:browse:12345',
    channelId: 'thread-1',
    user: { id: '12345' },
    async update() {
      throw new Error('should not update');
    },
    async reply(payload) {
      replies.push(payload);
    },
    async showModal() {
      throw new Error('should not show modal');
    },
  });

  assert.deepEqual(replies, [{
    content: 'browse:thread:thread-1:12345',
    components: [],
    flags: 64,
  }]);
});
