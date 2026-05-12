import {
  formatBusyPromptModeLabel,
  formatCodexProfileLabel,
  formatReplyDeliveryModeLabel,
  parseCompactConfigAction,
} from './session-settings.js';

const SETTINGS_COMPONENT_PREFIX = 'stg';
const SETTINGS_MODAL_PREFIX = 'stgm';
const MODEL_INPUT_ID = 'model_name';
const CODEX_PROFILE_INPUT_ID = 'codex_profile_name';
const COMPACT_THRESHOLD_INPUT_ID = 'compact_threshold_tokens';

const ALL_SECTIONS = Object.freeze([
  'overview',
  'defaults',
  'provider',
  'profile',
  'model',
  'fast',
  'runtime',
  'effort',
  'compact',
  'reply',
  'language',
  'mode',
  'workspace',
]);

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function normalizeSection(value) {
  const section = String(value || '').trim().toLowerCase();
  return ALL_SECTIONS.includes(section) ? section : 'overview';
}

function formatSettingSourceLabel(source, language) {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'session override') return 'this channel';
    if (value === 'parent channel') return 'parent channel';
    if (value === 'config.toml') return 'global config';
    if (value === 'built-in default') return 'built-in default';
    if (value === 'env default') return 'env default';
    if (value === 'provider') return 'provider default';
    if (value === 'provider unsupported') return 'not supported';
    if (value === 'thread override') return 'this channel';
    if (value === 'provider default') return 'provider default';
    if (value === 'legacy fallback') return 'legacy fallback';
    if (value === 'unset') return 'unset';
    return value || 'unknown';
  }

  if (value === 'session override') return '当前频道';
  if (value === 'parent channel') return '父频道默认';
  if (value === 'config.toml') return '全局配置';
  if (value === 'built-in default') return '内建默认';
  if (value === 'env default') return '环境默认';
  if (value === 'provider') return 'provider 默认';
  if (value === 'provider unsupported') return '当前 provider 不支持';
  if (value === 'thread override') return '当前频道';
  if (value === 'provider default') return 'provider 默认';
  if (value === 'legacy fallback') return 'legacy 回退';
  if (value === 'unset') return '未设置';
  return value || '未知';
}

function formatFastModeLabel(enabled, language) {
  return enabled
    ? (language === 'en' ? 'on' : '开启')
    : (language === 'en' ? 'off' : '关闭');
}

function formatRuntimeModeLabel(mode, language) {
  return mode === 'long'
    ? (language === 'en' ? 'long (hot session)' : 'long（热会话）')
    : (language === 'en' ? 'exec (per request)' : 'exec（每轮启动）');
}

function formatWorkspaceLabel(binding, language) {
  const workspaceDir = String(binding?.workspaceDir || '').trim();
  const source = formatSettingSourceLabel(binding?.source, language);
  if (!workspaceDir) {
    return language === 'en'
      ? `(unset) (${source})`
      : `（未设置）（${source}）`;
  }
  return language === 'en'
    ? `\`${workspaceDir}\` (${source})`
    : `\`${workspaceDir}\`（${source}）`;
}

function formatValueLabel(value, fallback, language) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (text.startsWith('(') && text.endsWith(')')) return text;
  return `\`${text}\``;
}

function formatModelPlaceholder(provider, language) {
  if (provider === 'claude') {
    return language === 'en'
      ? 'e.g. sonnet, opus, claude-sonnet-4-6, default'
      : '例如 sonnet、opus、claude-sonnet-4-6、default';
  }
  return language === 'en'
    ? 'e.g. gpt-5.4, o3, default'
    : '例如 gpt-5.4、o3、default';
}

function hasConfiguredCodexDefault(value, configured) {
  const text = String(value || '').trim();
  return Boolean(configured && text && text !== '(unknown)');
}

function formatCodexGlobalStringDefault(value, configured, language) {
  return hasConfiguredCodexDefault(value, configured)
    ? formatValueLabel(value, '', language)
    : (language === 'en' ? '(provider default)' : '（provider 默认）');
}

function formatSectionButtonLabel(section, language) {
  const labels = {
    overview: { en: 'overview', zh: '总览' },
    defaults: { en: 'defaults', zh: '默认' },
    provider: { en: 'provider', zh: '后端' },
    profile: { en: 'profile', zh: '配置' },
    model: { en: 'model', zh: '模型' },
    fast: { en: 'fast', zh: 'fast' },
    runtime: { en: 'runtime', zh: '运行时' },
    effort: { en: 'effort', zh: '推理' },
    compact: { en: 'compact', zh: '压缩' },
    reply: { en: 'reply', zh: '回复' },
    language: { en: 'language', zh: '语言' },
    mode: { en: 'mode', zh: '执行' },
    workspace: { en: 'workspace', zh: '目录' },
    close: { en: 'close', zh: '关闭' },
  };
  return labels[section]?.[language] || section;
}

function formatSectionTitleLabel(section, language) {
  const labels = {
    overview: { en: 'Overview', zh: '总览' },
    defaults: { en: 'Codex Defaults', zh: 'Codex 默认' },
    provider: { en: 'Provider', zh: 'Provider' },
    profile: { en: 'Codex Profile', zh: 'Codex Profile' },
    model: { en: 'Model', zh: '模型' },
    fast: { en: 'Fast Mode', zh: 'Fast Mode' },
    runtime: { en: 'Runtime', zh: '运行时' },
    effort: { en: 'Reasoning Effort', zh: '推理力度' },
    compact: { en: 'Context Compaction', zh: '上下文压缩' },
    reply: { en: 'Reply Delivery', zh: '回复方式' },
    language: { en: 'Language', zh: '语言' },
    mode: { en: 'Execution Mode', zh: '执行模式' },
    workspace: { en: 'Workspace', zh: '工作目录' },
  };
  return labels[section]?.[language] || section;
}

function formatReplyDeliveryButtonLabel(mode, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  if (mode === 'card_mention') return lang === 'en' ? 'Card + @' : '进度卡 + @';
  if (mode === 'stream_mention') return lang === 'en' ? 'Stream + @' : '过程消息 + @';
  if (mode === 'card_only') return lang === 'en' ? 'Card only' : '仅进度卡';
  if (mode === 'stream_only') return lang === 'en' ? 'Stream only' : '仅过程消息';
  return mode;
}

function buildSettingsComponentId(kind, target, value, userId) {
  return `${SETTINGS_COMPONENT_PREFIX}:${kind}:${target}:${value}:${String(userId || '').trim()}`;
}

function buildSettingsModalId(target, userId) {
  return `${SETTINGS_MODAL_PREFIX}:${target}:${String(userId || '').trim()}`;
}

function parseSettingsComponentId(customId) {
  const match = /^stg:(nav|set|act):([a-z_]+):([a-z0-9_-]+):([0-9]{5,32})$/i.exec(String(customId || '').trim());
  if (!match) return null;
  return {
    kind: String(match[1] || '').trim().toLowerCase(),
    target: String(match[2] || '').trim().toLowerCase(),
    value: String(match[3] || '').trim().toLowerCase(),
    userId: String(match[4] || '').trim(),
  };
}

function parseSettingsModalId(customId) {
  const match = /^stgm:([a-z_]+):([0-9]{5,32})$/i.exec(String(customId || '').trim());
  if (!match) return null;
  return {
    target: String(match[1] || '').trim().toLowerCase(),
    userId: String(match[2] || '').trim(),
  };
}

function isSettingsPanelComponentId(customId) {
  return Boolean(parseSettingsComponentId(customId));
}

function isSettingsPanelModalId(customId) {
  return Boolean(parseSettingsModalId(customId));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function truncateOptionText(value, maxLength = 100) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1);
}

function normalizeModelCatalog(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    models: models.map((model) => {
      const slug = String(model?.slug || '').trim();
      const displayName = String(model?.displayName || model?.display_name || slug).trim();
      const levels = Array.isArray(model?.supportedReasoningLevels)
        ? model.supportedReasoningLevels
        : model?.supported_reasoning_levels;
      const supportedReasoningLevels = Array.isArray(levels)
        ? levels.map((level) => String(level?.effort || level || '').trim()).filter(Boolean)
        : [];
      return {
        slug,
        displayName: displayName || slug,
        description: String(model?.description || '').trim(),
        defaultReasoningLevel: String(model?.defaultReasoningLevel || model?.default_reasoning_level || '').trim(),
        supportedReasoningLevels,
      };
    }).filter((model) => model.slug),
    error: catalog?.error ? String(catalog.error) : null,
  };
}

function buildModelSelectOptions(snapshot, session) {
  const currentOverride = String(session?.model || '').trim();
  const options = [{
    label: snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认',
    value: 'default',
    description: truncateOptionText(snapshot.language === 'en'
      ? `Effective: ${snapshot.modelValue || '(provider default)'}`
      : `当前生效：${snapshot.modelValue || 'provider 默认'}`),
    default: !currentOverride,
  }];
  const seen = new Set(['default']);
  let hasCurrentOverride = !currentOverride;

  for (const model of snapshot.modelCatalog.models) {
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    const isCurrent = currentOverride === model.slug;
    if (isCurrent) hasCurrentOverride = true;
    options.push({
      label: truncateOptionText(model.displayName || model.slug),
      value: model.slug,
      description: truncateOptionText(model.defaultReasoningLevel
        ? `default effort: ${model.defaultReasoningLevel}`
        : (model.description || model.slug)),
      default: isCurrent,
    });
    if (options.length >= 25) break;
  }

  if (!hasCurrentOverride && currentOverride && options.length < 25) {
    options.push({
      label: truncateOptionText(currentOverride),
      value: currentOverride,
      description: snapshot.language === 'en' ? 'Current custom model' : '当前手写模型',
      default: true,
    });
  }

  return options;
}

export function createSettingsPanel({
  botProvider = null,
  defaultUiLanguage = 'zh',
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  getSession = () => null,
  getSessionLanguage = () => defaultUiLanguage,
  getSessionProvider = () => 'codex',
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'unset' }),
  getProviderDefaults = () => ({ model: '(provider default)', effort: '(provider default)', source: 'provider' }),
  resolveCodexProfileSetting = () => ({ value: null, source: 'provider default', supported: false, valid: true, isExplicit: false }),
  getDefaultCodexProfile = () => ({ profile: null, source: 'env default' }),
  getProviderDisplayName = (provider) => String(provider || ''),
  getSupportedReasoningEffortLevels = () => [],
  getModelCatalog = () => ({ models: [], error: null }),
  getProviderCompactCapabilities = () => ({ strategies: ['hard', 'native', 'off'] }),
  normalizeUiLanguage = normalizeLanguage,
  resolveModelSetting = (session) => ({ value: session?.model || '(provider default)', source: session?.model ? 'session override' : 'provider' }),
  resolveReasoningEffortSetting = (session) => ({ value: session?.effort || '(provider default)', source: session?.effort ? 'session override' : 'provider' }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  resolveBusyPromptModeSetting = () => ({ mode: 'queue', requestedMode: 'queue', canSteer: false, supported: true, source: 'built-in default', reason: null }),
  resolveCompactStrategySetting = () => ({ strategy: 'native', source: 'env default' }),
  resolveCompactThresholdSetting = () => ({ tokens: 0, source: 'env default' }),
  resolveReplyDeliverySetting = () => ({ mode: 'card_mention', source: 'env default' }),
  getReplyDeliveryDefault = () => ({ mode: 'card_mention', source: 'env default' }),
  getChannelState = () => null,
  safeChannelSend = async (target, payload) => target?.channel?.send?.(payload),
  commandActions = {},
  closeRuntimeSession = () => false,
  openWorkspaceBrowser,
  slashRef = (name) => `/${name}`,
} = {}) {
  const closeRuntimeForKey = (key, reason = 'runtime config changed') => {
    try {
      closeRuntimeSession(key, reason);
    } catch {
    }
  };

  const shouldStreamProcessMessages = (mode) => mode === 'stream_mention' || mode === 'stream_only';
  const normalizeProcessActivityKey = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

  async function flushActiveRunProcessMessages(interaction, key, session, { beforeMode } = {}) {
    const afterMode = resolveReplyDeliverySetting(session).mode;
    if (shouldStreamProcessMessages(beforeMode) || !shouldStreamProcessMessages(afterMode)) return;
    const activeRun = getChannelState(key)?.activeRun;
    const activities = Array.isArray(activeRun?.recentActivities) ? activeRun.recentActivities : [];
    if (!activeRun || activities.length === 0) return;

    if (!activeRun.streamedProcessActivityKeys || !Array.isArray(activeRun.streamedProcessActivityKeys)) {
      activeRun.streamedProcessActivityKeys = [];
    }
    const sentKeys = new Set(activeRun.streamedProcessActivityKeys.map(normalizeProcessActivityKey));
    for (const activity of activities) {
      const keyName = normalizeProcessActivityKey(activity);
      if (!keyName || sentKeys.has(keyName)) continue;
      sentKeys.add(keyName);
      activeRun.streamedProcessActivityKeys.push(activity);
      await safeChannelSend(interaction, activity);
    }
  }

  function getAvailableSections(session) {
    const provider = getSessionProvider(session);
    const sections = ['overview'];
    if (provider === 'codex') sections.push('defaults');
    if (!botProvider) sections.push('provider');
    if (provider === 'codex') sections.push('profile');
    sections.push('model');
    if (provider === 'codex') sections.push('fast');
    if (provider === 'codex' || provider === 'claude') sections.push('runtime');
    if (getSupportedReasoningEffortLevels(provider).length) sections.push('effort');
    sections.push('compact', 'reply', 'language', 'mode', 'workspace');
    return sections;
  }

  function resolveActiveSection(session, requested) {
    const normalized = normalizeSection(requested);
    return getAvailableSections(session).includes(normalized) ? normalized : 'overview';
  }

  function resolveDefaultSection(session) {
    return getSessionProvider(session) === 'codex' ? 'defaults' : 'overview';
  }

  function buildSnapshot(key, session) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const provider = getSessionProvider(session);
    const defaults = getProviderDefaults(provider);
    const codexDefaults = provider === 'codex'
      ? (getProviderDefaults('codex') || {})
      : null;
    const codexProfile = resolveCodexProfileSetting(session);
    const codexProfileDefault = getDefaultCodexProfile(session);
    const modelSetting = resolveModelSetting(session);
    const effortSetting = resolveReasoningEffortSetting(session);
    const fastMode = resolveFastModeSetting(session);
    const runtimeMode = resolveRuntimeModeSetting(session);
    const busyPromptMode = resolveBusyPromptModeSetting(session);
    const compact = resolveCompactStrategySetting(session);
    const compactThreshold = resolveCompactThresholdSetting(session);
    const replyDelivery = resolveReplyDeliverySetting(session);
    const replyDefault = getReplyDeliveryDefault(session);
    const workspace = getWorkspaceBinding(session, key) || { workspaceDir: null, source: 'unset' };
    const effortLevels = getSupportedReasoningEffortLevels(provider);
    const modelCatalog = normalizeModelCatalog(getModelCatalog(provider));

    return {
      language,
      isThread: Boolean(session?.parentChannelId),
      provider,
      providerLabel: getProviderDisplayName(provider),
      defaults,
      codexDefaults,
      codexProfile,
      codexProfileDefault,
      fastMode,
      runtimeMode,
      busyPromptMode,
      compact,
      compactThreshold,
      replyDelivery,
      replyDefault,
      workspace,
      effortLevels,
      modelCatalog,
      modelValue: modelSetting?.value || defaults.model,
      modelSource: modelSetting?.source || defaults.source,
      effortValue: effortLevels.length ? (effortSetting?.value || defaults.effort) : null,
      effortSource: effortLevels.length ? (effortSetting?.source || defaults.source) : defaults.source,
    };
  }

  function buildSectionNavigation(session, userId, activeSection) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const available = getAvailableSections(session);
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSettingsComponentId('nav', 'section', 'picker', userId))
          .setPlaceholder(language === 'en' ? 'Choose a settings section' : '选择设置分区')
          .addOptions(
            available.map((section) => ({
              label: formatSectionTitleLabel(section, language),
              value: section,
              default: activeSection === section,
            })),
          ),
      ),
    ];
  }

  function buildCloseRow(session, userId) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildSettingsComponentId('act', 'panel', 'close', userId))
        .setLabel(formatSectionButtonLabel('close', language))
        .setStyle(ButtonStyle.Danger),
    );
  }

  function buildModelControlRows(session, userId, snapshot, { quick = false } = {}) {
    const modelTarget = quick ? 'quick_model' : 'model';
    const effortTarget = quick ? 'quick_model_effort' : 'model_effort';
    const modelOptions = buildModelSelectOptions(snapshot, session);
    const rows = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildSettingsComponentId('set', modelTarget, 'preset', userId))
          .setPlaceholder(snapshot.language === 'en'
            ? `Current model: ${snapshot.modelValue || '(provider default)'}`
            : `当前模型：${snapshot.modelValue || 'provider 默认'}`)
          .addOptions(modelOptions),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsComponentId('act', modelTarget, 'custom', userId))
          .setLabel(snapshot.language === 'en' ? 'Type custom model' : '手写模型名')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSettingsComponentId('act', modelTarget, 'default', userId))
          .setLabel(snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认')
          .setStyle(!session?.model ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
    ];
    if (snapshot.effortLevels.length) {
      rows.push(...chunk([...snapshot.effortLevels, 'default'], 5).map((rowValues) => new ActionRowBuilder().addComponents(
        ...rowValues.map((value) => {
          const selected = value === 'default'
            ? !session?.effort
            : session?.effort === value;
          return new ButtonBuilder()
            .setCustomId(buildSettingsComponentId('set', effortTarget, value, userId))
            .setLabel(value)
            .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
        }),
      )));
    }
    return rows;
  }

  function buildSectionControls(key, session, userId, activeSection, snapshot) {
    switch (activeSection) {
      case 'provider': {
        if (botProvider) return [];
        return [
          new ActionRowBuilder().addComponents(
            ...['codex', 'claude', 'gemini'].map((provider) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'provider', provider, userId))
              .setLabel(provider)
              .setStyle(snapshot.provider === provider ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
        ];
      }

      case 'defaults': {
        if (snapshot.provider !== 'codex' || !snapshot.codexDefaults) return [];

        const defaultFastSelected = !snapshot.codexDefaults.fastModeConfigured
          ? 'default'
          : (snapshot.codexDefaults.fastMode ? 'on' : 'off');
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'default_profile', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set profile' : '设置 profile')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'default_model', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set model' : '设置 model')
              .setStyle(ButtonStyle.Success),
          ),
          ...chunk([...snapshot.effortLevels, 'default'], 5).map((rowValues) => new ActionRowBuilder().addComponents(
            ...rowValues.map((value) => {
              const selected = value === 'default'
                ? !snapshot.codexDefaults.effortConfigured
                : snapshot.codexDefaults.effortConfigured && snapshot.codexDefaults.effort === value;
              return new ButtonBuilder()
                .setCustomId(buildSettingsComponentId('set', 'default_effort', value, userId))
                .setLabel(value)
                .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
            }),
          )),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'default', userId))
              .setLabel(snapshot.language === 'en' ? 'Use built-in default' : '使用内建默认')
              .setStyle(defaultFastSelected === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'on', userId))
              .setLabel(snapshot.language === 'en' ? 'On' : '开启')
              .setStyle(defaultFastSelected === 'on' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_fast', 'off', userId))
              .setLabel(snapshot.language === 'en' ? 'Off' : '关闭')
              .setStyle(defaultFastSelected === 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'profile': {
        const selected = snapshot.codexProfile.source === 'session override'
          ? snapshot.codexProfile.value
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow global' : '跟随全局');
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'profile', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'profile', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set custom profile' : '设置自定义 profile')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'profile', 'clear', userId))
              .setLabel(snapshot.language === 'en' ? 'Use provider default' : '使用 provider 默认')
              .setStyle(!snapshot.codexProfile.isExplicit ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'language':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'language', 'zh', userId))
              .setLabel('中文')
              .setStyle(snapshot.language === 'zh' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'language', 'en', userId))
              .setLabel('English')
              .setStyle(snapshot.language === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];

      case 'mode':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'mode', 'safe', userId))
              .setLabel('safe')
              .setStyle(session?.mode === 'safe' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'mode', 'dangerous', userId))
              .setLabel('dangerous')
              .setStyle(session?.mode === 'dangerous' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];

      case 'fast': {
        const selected = snapshot.fastMode.source === 'session override'
          ? (snapshot.fastMode.enabled ? 'on' : 'off')
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow global' : '跟随全局');
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'on', userId))
              .setLabel(snapshot.language === 'en' ? 'On' : '开启')
              .setStyle(selected === 'on' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'fast', 'off', userId))
              .setLabel(snapshot.language === 'en' ? 'Off' : '关闭')
              .setStyle(selected === 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'runtime': {
        const selected = snapshot.runtimeMode.source === 'session override'
          ? snapshot.runtimeMode.mode
          : 'follow';
        const busySelected = snapshot.busyPromptMode.source === 'session override'
          ? snapshot.busyPromptMode.requestedMode
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow default' : '跟随默认');
        const steerDisabled = !snapshot.busyPromptMode.canSteer;
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(selected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'normal', userId))
              .setLabel('exec')
              .setStyle(selected === 'normal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'runtime', 'long', userId))
              .setLabel('long')
              .setStyle(selected === 'long' ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!snapshot.runtimeMode.supported),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(busySelected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'queue', userId))
              .setLabel(snapshot.language === 'en' ? 'queue' : '排队')
              .setStyle(busySelected === 'queue' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'busy_prompt', 'steer', userId))
              .setLabel(snapshot.language === 'en' ? 'steer' : 'steer')
              .setStyle(busySelected === 'steer_if_possible' ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(steerDisabled),
          ),
        ];
      }

      case 'effort': {
        const values = [...snapshot.effortLevels, 'default'];
        return chunk(values, 5).map((rowValues) => new ActionRowBuilder().addComponents(
          ...rowValues.map((value) => {
            const selected = value === 'default'
              ? !session?.effort
              : session?.effort === value;
            return new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'effort', value, userId))
              .setLabel(value)
              .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
          }),
        ));
      }

      case 'compact': {
        const compactCapabilities = getProviderCompactCapabilities(snapshot.provider);
        const values = ['follow', ...compactCapabilities.strategies];
        const thresholdUsesDefault = session?.compactThresholdTokens === null || session?.compactThresholdTokens === undefined;
        return [
          new ActionRowBuilder().addComponents(
            ...values.map((value) => {
              const selected = value === 'follow'
                ? !session?.compactStrategy
                : session?.compactStrategy === value;
              const label = value === 'follow'
                ? (snapshot.language === 'en' ? 'Follow default' : '跟随默认')
                : value;
              return new ButtonBuilder()
                .setCustomId(buildSettingsComponentId('set', 'compact', value, userId))
                .setLabel(label)
                .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
            }),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'compact_threshold', 'custom', userId))
              .setLabel(snapshot.language === 'en' ? 'Set token limit' : '设置阈值')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'compact_threshold', 'default', userId))
              .setLabel(snapshot.language === 'en' ? 'Follow default limit' : '跟随默认阈值')
              .setStyle(thresholdUsesDefault ? ButtonStyle.Primary : ButtonStyle.Secondary),
          ),
        ];
      }

      case 'reply': {
        const currentSelected = snapshot.replyDelivery.source === 'session override'
          ? snapshot.replyDelivery.mode
          : 'follow';
        const followLabel = snapshot.isThread
          ? (snapshot.language === 'en' ? 'Follow parent/global' : '跟随父频道/全局')
          : (snapshot.language === 'en' ? 'Follow global' : '跟随全局');
        const replyModes = ['card_mention', 'stream_mention', 'card_only', 'stream_only'];
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'reply', 'follow', userId))
              .setLabel(followLabel)
              .setStyle(currentSelected === 'follow' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            ...replyModes.map((mode) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'reply', mode, userId))
              .setLabel(formatReplyDeliveryButtonLabel(mode, snapshot.language))
              .setStyle(currentSelected === mode ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
          new ActionRowBuilder().addComponents(
            ...replyModes.map((mode) => new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('set', 'default_reply', mode, userId))
              .setLabel(formatReplyDeliveryButtonLabel(mode, snapshot.language))
              .setStyle(snapshot.replyDefault.mode === mode ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          ),
        ];
      }

      case 'model':
        return buildModelControlRows(session, userId, snapshot);

      case 'workspace':
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'workspace', 'browse', userId))
              .setLabel(snapshot.language === 'en' ? 'Browse workspace' : '浏览 workspace')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(buildSettingsComponentId('act', 'workspace', 'clear', userId))
              .setLabel(snapshot.language === 'en' ? 'Follow provider default' : '跟随 provider 默认')
              .setStyle(!session?.workspaceDir ? ButtonStyle.Primary : ButtonStyle.Secondary)
              .setDisabled(!session?.workspaceDir),
          ),
        ];

      default:
        return [];
    }
  }

function formatOverviewSection(snapshot) {
  if (snapshot.language === 'en') {
    return [
      'Choose a section below.',
      snapshot.provider === 'codex' ? 'Defaults edits global Codex settings in `~/.codex/config.toml`.' : null,
      'Compact controls strategy and token limit for automatic context compaction.',
      'Reply controls whether the bot only updates the progress card or also sends process messages.',
      !botProvider ? 'Provider switches this channel to a different CLI lane and restores that provider’s saved channel settings.' : null,
    ].filter(Boolean).join('\n');
  }
  return [
    '请选择下方的设置项。',
    snapshot.provider === 'codex' ? '默认分区会直接修改 `~/.codex/config.toml` 里的全局 Codex 默认值。' : null,
    '压缩分区管理 compact 策略和 token 阈值。',
    '回复分区管理只更新进度卡还是发送过程消息，以及完成时是否触发 @。',
    !botProvider ? '切换 provider 会切到另一条 CLI 运行时，并恢复这个频道里该 provider 自己保存的设置。' : null,
  ].filter(Boolean).join('\n');
}

  function formatActiveSection(activeSection, snapshot) {
    const compactSurface = `${slashRef('compact')} key:<...> value:<...>`;
    switch (activeSection) {
      case 'defaults':
        return snapshot.language === 'en'
          ? 'This section edits global Codex defaults in `~/.codex/config.toml`. Effort and fast stay visible here. Model and profile use the modal buttons above. Enter `default` in either modal to go back to the provider default. Channel and thread overrides still win.'
          : '这个分区会直接修改 `~/.codex/config.toml` 里的全局 Codex 默认值。effort 和 fast 直接在这里改。model 和 profile 用上面的按钮弹窗修改。在弹窗里输入 `default` 就会回到 provider 默认。频道或 thread 的显式覆盖仍然优先。';
      case 'provider':
        return snapshot.language === 'en'
          ? 'Provider switches the active runtime for this channel. Each provider keeps its own saved session/model/runtime overrides.'
          : 'provider 决定这个频道当前使用哪套 CLI 运行时。每个 provider 会保留自己独立的 session、model 和运行时覆盖。';
      case 'profile':
        return snapshot.language === 'en'
          ? 'Codex profile decides which named profile this channel passes to Codex. Follow keeps inheritance. Provider default means no `--profile` flag is passed.'
          : 'Codex profile 决定当前频道向 Codex 传哪个命名 profile。跟随表示继续继承。provider 默认表示不传 `--profile`。';
      case 'model':
        return snapshot.language === 'en'
          ? 'Choose a model from the CLI catalog, type a custom model, or tune effort here. Provider default clears this channel override.'
          : '可以从 CLI 读取到的模型里选择，也可以手写模型名。推理力度也放在这里一起调，使用 provider 默认会清掉当前频道覆盖。';
      case 'fast':
        return snapshot.language === 'en'
          ? (snapshot.isThread
            ? 'Fast mode only exists on Codex. "Follow parent/global" means this thread stops overriding and inherits the parent channel setting first, then `~/.codex/config.toml` (which stays on unless `[features].fast_mode = false` is set).'
            : 'Fast mode only exists on Codex. "Follow global" means this channel stops overriding and inherits `~/.codex/config.toml` (which stays on unless `[features].fast_mode = false` is set).')
          : (snapshot.isThread
            ? 'Fast mode 仅对 Codex 生效。选择“跟随父频道/全局”表示当前 thread 不再覆盖，优先继承父频道设置，其次继承 `~/.codex/config.toml`；若未显式写 `[features].fast_mode = false`，默认保持开启。'
            : 'Fast mode 仅对 Codex 生效。选择“跟随全局”表示当前频道不再覆盖，改为继承 `~/.codex/config.toml`；若未显式写 `[features].fast_mode = false`，默认保持开启。');
      case 'runtime':
        return snapshot.language === 'en'
          ? 'Runtime chooses exec or long connection. Busy prompt decides what happens when a new message arrives during an active turn. Exec can only queue; steer stays disabled until the provider runner exposes a real active-turn steering path.'
          : '运行时选择 exec 或 long。运行中消息决定任务还在跑时新消息怎么处理。exec 只能排队；steer 只有真正接好运行中插入能力后才会启用。';
      case 'effort':
        return snapshot.language === 'en'
          ? 'Reasoning effort options are provider-specific. "default" clears this channel override.'
          : 'reasoning effort 的可选值由 provider 决定。选择 `default` 会清掉当前频道覆盖。';
      case 'compact':
        return snapshot.language === 'en'
          ? `Compact has two parts here. Strategy decides how compaction runs. Token limit decides when the bot considers a turn large enough to compact. Follow default removes this channel override. For deeper native-only details, \`${compactSurface}\` is still available.`
          : `这里的压缩设置分两层。strategy 决定怎么压缩。token 阈值决定消息多大时开始考虑 compact。跟随默认会清掉当前频道的阈值覆盖。更细的 native 专属细节仍可继续用 \`${compactSurface}\`。`;
      case 'reply':
        return snapshot.language === 'en'
          ? 'Choose whether the channel only updates the progress card or also sends process messages, and whether completion should trigger @.'
          : '在这里决定当前频道只更新进度卡，还是会发送过程消息，以及完成时是否触发 @。';
      case 'language':
        return snapshot.language === 'en'
          ? 'This only changes the bot hint language for the current channel.'
          : '这里只会切换当前频道的 bot 提示语言。';
      case 'mode':
        return snapshot.language === 'en'
          ? 'Execution mode is channel-scoped. `dangerous` removes sandbox/approval safeguards.'
          : '执行模式按频道生效。`dangerous` 会去掉 sandbox 与审批保护。';
      case 'workspace':
        return snapshot.language === 'en'
          ? 'Browsing opens the existing workspace picker in a separate ephemeral panel. "Follow provider default" clears the thread override only.'
          : '“浏览 workspace” 会在单独的 ephemeral 面板里打开现有路径选择器。“跟随 provider 默认”只会清掉当前 thread 的 workspace 覆盖。';
      default:
        return formatOverviewSection(snapshot);
    }
  }

  function formatSettingsContent(key, session, activeSection, notice = '') {
    const snapshot = buildSnapshot(key, session);
    const isDefaultsSection = activeSection === 'defaults' && snapshot.provider === 'codex';
    const lines = [
      isDefaultsSection
        ? (snapshot.language === 'en' ? '⚙️ **Global Codex Defaults**' : '⚙️ **Codex 默认设置**')
        : (snapshot.language === 'en' ? '⚙️ **Channel Settings**' : '⚙️ **频道设置**'),
      notice || null,
      ...(isDefaultsSection
        ? [
          snapshot.language === 'en'
            ? '• scope: `~/.codex/config.toml`'
            : '• 作用域：`~/.codex/config.toml`',
          snapshot.language === 'en'
            ? `• profile default: ${formatCodexProfileLabel(snapshot.codexProfileDefault.profile, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexProfileDefault.source, snapshot.language)})`
            : `• profile 默认：${formatCodexProfileLabel(snapshot.codexProfileDefault.profile, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexProfileDefault.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• model default: ${formatCodexGlobalStringDefault(snapshot.codexDefaults.model, snapshot.codexDefaults.modelConfigured, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.modelConfigured ? 'config.toml' : 'provider default', snapshot.language)})`
            : `• model 默认：${formatCodexGlobalStringDefault(snapshot.codexDefaults.model, snapshot.codexDefaults.modelConfigured, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.modelConfigured ? 'config.toml' : 'provider default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• effort default: ${formatCodexGlobalStringDefault(snapshot.codexDefaults.effort, snapshot.codexDefaults.effortConfigured, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.effortConfigured ? 'config.toml' : 'provider default', snapshot.language)})`
            : `• effort 默认：${formatCodexGlobalStringDefault(snapshot.codexDefaults.effort, snapshot.codexDefaults.effortConfigured, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.effortConfigured ? 'config.toml' : 'provider default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• fast default: ${formatFastModeLabel(snapshot.codexDefaults.fastMode, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexDefaults.fastModeConfigured ? 'config.toml' : 'built-in default', snapshot.language)})`
            : `• fast 默认：${formatFastModeLabel(snapshot.codexDefaults.fastMode, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexDefaults.fastModeConfigured ? 'config.toml' : 'built-in default', snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• effective in this channel: model ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)}, fast ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}, effort ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)}`
            : `• 当前频道生效值：model ${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}，fast ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}，effort ${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}`,
          snapshot.language === 'en'
            ? `• compact context limit: ${snapshot.compactThreshold.tokens} (${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)})`
            : `• compact context 长度：${snapshot.compactThreshold.tokens}（${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)}）`,
        ]
        : [
          snapshot.language === 'en'
            ? `• provider: \`${snapshot.provider}\` (${snapshot.providerLabel})`
            : `• provider：\`${snapshot.provider}\`（${snapshot.providerLabel}）`,
          snapshot.provider === 'codex'
            ? (snapshot.language === 'en'
              ? `• codex profile: ${formatCodexProfileLabel(snapshot.codexProfile.value, snapshot.language)} (${formatSettingSourceLabel(snapshot.codexProfile.source, snapshot.language)}${snapshot.codexProfile.valid ? '' : `, invalid: ${snapshot.codexProfile.error}`})`
              : `• Codex profile：${formatCodexProfileLabel(snapshot.codexProfile.value, snapshot.language)}（${formatSettingSourceLabel(snapshot.codexProfile.source, snapshot.language)}${snapshot.codexProfile.valid ? '' : `，无效：${snapshot.codexProfile.error}` }）`)
            : null,
          snapshot.language === 'en'
            ? `• model: ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)})`
            : `• model：${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)}）`,
          snapshot.modelCatalog.error
            ? (snapshot.language === 'en'
              ? `• model catalog: unavailable (${truncateOptionText(snapshot.modelCatalog.error, 120)})`
              : `• 模型列表：暂不可用（${truncateOptionText(snapshot.modelCatalog.error, 120)}）`)
            : null,
          snapshot.fastMode.supported
            ? (snapshot.language === 'en'
              ? `• fast mode: ${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)} (${formatSettingSourceLabel(snapshot.fastMode.source, snapshot.language)})`
              : `• fast mode：${formatFastModeLabel(snapshot.fastMode.enabled, snapshot.language)}（${formatSettingSourceLabel(snapshot.fastMode.source, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? '• fast mode: n/a (Codex only)'
              : '• fast mode：不适用（仅 Codex）'),
          snapshot.runtimeMode.supported
            ? (snapshot.language === 'en'
              ? `• runtime: ${formatRuntimeModeLabel(snapshot.runtimeMode.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.runtimeMode.source, snapshot.language)})`
              : `• 运行时：${formatRuntimeModeLabel(snapshot.runtimeMode.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.runtimeMode.source, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? '• runtime: exec (long unavailable for this provider)'
              : '• 运行时：exec（当前 provider 暂未接入 long）'),
          snapshot.language === 'en'
            ? `• busy prompt: ${formatBusyPromptModeLabel(snapshot.busyPromptMode.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.busyPromptMode.source, snapshot.language)}${snapshot.busyPromptMode.reason ? `, ${snapshot.busyPromptMode.reason}` : ''})`
            : `• 运行中消息：${formatBusyPromptModeLabel(snapshot.busyPromptMode.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.busyPromptMode.source, snapshot.language)}${snapshot.busyPromptMode.reason ? `，${snapshot.busyPromptMode.reason}` : ''}）`,
          snapshot.effortLevels.length
            ? (snapshot.language === 'en'
              ? `• effort: ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)})`
              : `• effort：${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)}）`)
            : (snapshot.language === 'en'
              ? `• effort: not exposed on ${snapshot.providerLabel}`
              : `• effort：${snapshot.providerLabel} 当前未暴露`),
          snapshot.language === 'en'
            ? `• compact: \`${snapshot.compact.strategy}\` (${formatSettingSourceLabel(snapshot.compact.source, snapshot.language)})`
            : `• compact：\`${snapshot.compact.strategy}\`（${formatSettingSourceLabel(snapshot.compact.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• compact token limit: ${snapshot.compactThreshold.tokens} (${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)})`
            : `• compact 阈值：${snapshot.compactThreshold.tokens}（${formatSettingSourceLabel(snapshot.compactThreshold.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• reply delivery: ${formatReplyDeliveryModeLabel(snapshot.replyDelivery.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.replyDelivery.source, snapshot.language)})`
            : `• 回复方式：${formatReplyDeliveryModeLabel(snapshot.replyDelivery.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.replyDelivery.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• default reply delivery: ${formatReplyDeliveryModeLabel(snapshot.replyDefault.mode, snapshot.language)} (${formatSettingSourceLabel(snapshot.replyDefault.source, snapshot.language)})`
            : `• 默认回复方式：${formatReplyDeliveryModeLabel(snapshot.replyDefault.mode, snapshot.language)}（${formatSettingSourceLabel(snapshot.replyDefault.source, snapshot.language)}）`,
          snapshot.language === 'en'
            ? `• mode: \`${session?.mode || 'safe'}\``
            : `• mode：\`${session?.mode || 'safe'}\``,
          snapshot.language === 'en'
            ? `• language: ${snapshot.language === 'en' ? 'English' : '中文'}`
            : `• language：${snapshot.language === 'en' ? 'English' : '中文'}`,
          snapshot.language === 'en'
            ? `• workspace: ${formatWorkspaceLabel(snapshot.workspace, snapshot.language)}`
            : `• workspace：${formatWorkspaceLabel(snapshot.workspace, snapshot.language)}`,
        ]),
      '',
      snapshot.language === 'en'
        ? `**Active: ${formatSectionTitleLabel(activeSection, snapshot.language)}**`
        : `**当前项：${formatSectionTitleLabel(activeSection, snapshot.language)}**`,
      formatActiveSection(activeSection, snapshot),
    ];
    return lines.filter(Boolean).join('\n');
  }

  function buildSettingsPayload({ key, session, userId, flags = undefined, activeSection = '', activeDefaultsGroup = 'model', notice = '' } = {}) {
    const section = resolveActiveSection(session, activeSection || resolveDefaultSection(session));
    const snapshot = buildSnapshot(key, session);
    const components = [
      ...buildSectionNavigation(session, userId, section),
      ...buildSectionControls(key, session, userId, section, snapshot),
      buildCloseRow(session, userId),
    ];
    const payload = {
      content: formatSettingsContent(key, session, section, notice),
      components,
    };
    if (flags !== undefined) payload.flags = flags;
    return payload;
  }

  function formatModelSettingsContent(key, session, notice = '') {
    const snapshot = buildSnapshot(key, session);
    const lines = [
      snapshot.language === 'en' ? '**Model**' : '**模型**',
      notice || null,
      snapshot.language === 'en'
        ? `• model: ${formatValueLabel(snapshot.modelValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)})`
        : `• model：${formatValueLabel(snapshot.modelValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.modelSource, snapshot.language)}）`,
      snapshot.modelCatalog.error
        ? (snapshot.language === 'en'
          ? `• model catalog: unavailable (${truncateOptionText(snapshot.modelCatalog.error, 120)})`
          : `• 模型列表：暂不可用（${truncateOptionText(snapshot.modelCatalog.error, 120)}）`)
        : null,
      snapshot.effortLevels.length
        ? (snapshot.language === 'en'
          ? `• effort: ${formatValueLabel(snapshot.effortValue, '(provider default)', snapshot.language)} (${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)})`
          : `• effort：${formatValueLabel(snapshot.effortValue, '（provider 默认）', snapshot.language)}（${formatSettingSourceLabel(snapshot.effortSource, snapshot.language)}）`)
        : (snapshot.language === 'en'
          ? `• effort: not exposed on ${snapshot.providerLabel}`
          : `• effort：${snapshot.providerLabel} 当前未暴露`),
      '',
      snapshot.language === 'en'
        ? 'Choose a model from the CLI catalog, type a custom model, or set effort below.'
        : '从 CLI 读取到的模型里选择，也可以手写模型名；推理力度在下面一起调。',
    ];
    return lines.filter(Boolean).join('\n');
  }

  function buildModelSettingsPayload({ key, session, userId, flags = undefined, notice = '' } = {}) {
    const snapshot = buildSnapshot(key, session);
    const closeLabel = snapshot.language === 'en' ? 'close' : '关闭';
    const components = [
      ...buildModelControlRows(session, userId, snapshot, { quick: true }),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsComponentId('act', 'quick_model', 'close', userId))
          .setLabel(closeLabel)
          .setStyle(ButtonStyle.Danger),
      ),
    ];
    const payload = {
      content: formatModelSettingsContent(key, session, notice),
      components,
    };
    if (flags !== undefined) payload.flags = flags;
    return payload;
  }

  function buildModelModal(session, userId, { useGlobalDefault = false, target = '' } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const defaults = useGlobalDefault ? (getProviderDefaults('codex') || {}) : null;
    const input = new TextInputBuilder()
      .setCustomId(MODEL_INPUT_ID)
      .setLabel(useGlobalDefault
        ? (language === 'en' ? 'Global model name or default' : '全局模型名或 default')
        : (language === 'en' ? 'Model name or default' : '模型名或 default'))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(useGlobalDefault
        ? formatModelPlaceholder('codex', language)
        : formatModelPlaceholder(getSessionProvider(session), language))
      .setRequired(true)
      .setMaxLength(120);
    if (useGlobalDefault) {
      if (hasConfiguredCodexDefault(defaults?.model, defaults?.modelConfigured)) {
        input.setValue(defaults.model);
      }
    } else if (session?.model) {
      input.setValue(session.model);
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(target || (useGlobalDefault ? 'default_model' : 'model'), userId))
      .setTitle(useGlobalDefault
        ? (language === 'en' ? 'Set global default model' : '设置全局默认 model')
        : (language === 'en' ? 'Set custom model' : '设置自定义模型'))
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  function buildCodexProfileModal(session, userId, { useGlobalDefault = false } = {}) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const defaults = useGlobalDefault ? getDefaultCodexProfile(session) : null;
    const input = new TextInputBuilder()
      .setCustomId(CODEX_PROFILE_INPUT_ID)
      .setLabel(useGlobalDefault
        ? (language === 'en' ? 'Global Codex profile or default' : '全局 Codex profile 或 default')
        : (language === 'en' ? 'Codex profile or default' : 'Codex profile 或 default'))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(useGlobalDefault
        ? (language === 'en' ? 'e.g. work, review, default' : '例如 work、review、default')
        : (language === 'en' ? 'e.g. work, review, default' : '例如 work、review、default'))
      .setRequired(true)
      .setMaxLength(120);
    if (useGlobalDefault) {
      if (defaults?.profile) input.setValue(defaults.profile);
    } else if (session?.codexProfile) {
      input.setValue(session.codexProfile);
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId(useGlobalDefault ? 'default_profile' : 'profile', userId))
      .setTitle(useGlobalDefault
        ? (language === 'en' ? 'Set global Codex profile' : '设置全局 Codex profile')
        : (language === 'en' ? 'Set Codex profile' : '设置 Codex profile'))
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  function buildCompactThresholdModal(session, userId) {
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);
    const input = new TextInputBuilder()
      .setCustomId(COMPACT_THRESHOLD_INPUT_ID)
      .setLabel(language === 'en' ? 'Compact token limit or default' : 'Compact token 阈值或 default')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(language === 'en' ? 'e.g. 272000 or default' : '例如 272000 或 default')
      .setRequired(true)
      .setMaxLength(20);
    if (session?.compactThresholdTokens !== null && session?.compactThresholdTokens !== undefined) {
      input.setValue(String(session.compactThresholdTokens));
    }

    return new ModalBuilder()
      .setCustomId(buildSettingsModalId('compact_threshold', userId))
      .setTitle(language === 'en' ? 'Set compact token limit' : '设置 compact token 阈值')
      .addComponents(
        new ActionRowBuilder().addComponents(input),
      );
  }

  async function handleSettingsPanelInteraction(interaction) {
    const parsed = parseSettingsComponentId(interaction.customId);
    if (!parsed) return false;

    const key = String(interaction.channelId || '').trim();
    const session = key ? getSession(key, { channel: interaction.channel || null }) : null;
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);

    if (!key || !session) {
      await interaction.reply({
        content: language === 'en' ? '❌ Unable to load channel settings.' : '❌ 无法读取当前频道设置。',
        flags: 64,
      });
      return true;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en' ? '⛔ This settings panel belongs to another user.' : '⛔ 这个设置面板属于其他用户。',
        flags: 64,
      });
      return true;
    }

    if (parsed.kind === 'nav') {
      const nextSection = parsed.target === 'section'
        ? normalizeSection(interaction.values?.[0] || '')
        : (parsed.target === 'defaults_group' ? 'defaults' : parsed.target);
      await interaction.update(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: nextSection,
      }));
      return true;
    }

    if (parsed.kind === 'act') {
      if (parsed.target === 'panel' && parsed.value === 'close') {
        await interaction.update({
          content: language === 'en' ? '⚙️ Settings panel closed.' : '⚙️ 设置面板已关闭。',
          components: [],
        });
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'close') {
        await interaction.update({
          content: language === 'en' ? 'Model panel closed.' : '模型面板已关闭。',
          components: [],
        });
        return true;
      }

      if (parsed.target === 'model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id));
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id, { target: 'quick_model' }));
        return true;
      }

      if (parsed.target === 'profile' && parsed.value === 'custom') {
        await interaction.showModal(buildCodexProfileModal(session, interaction.user.id));
        return true;
      }

      if (parsed.target === 'default_model' && parsed.value === 'custom') {
        await interaction.showModal(buildModelModal(session, interaction.user.id, { useGlobalDefault: true }));
        return true;
      }

      if (parsed.target === 'default_profile' && parsed.value === 'custom') {
        await interaction.showModal(buildCodexProfileModal(session, interaction.user.id, { useGlobalDefault: true }));
        return true;
      }

      if (parsed.target === 'compact_threshold' && parsed.value === 'custom') {
        await interaction.showModal(buildCompactThresholdModal(session, interaction.user.id));
        return true;
      }

      if (parsed.target === 'model' && parsed.value === 'default') {
        commandActions.setModel?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'model',
          notice: language === 'en' ? '✅ Model now follows the provider default.' : '✅ 当前 model 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'quick_model' && parsed.value === 'default') {
        commandActions.setModel?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildModelSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          notice: language === 'en' ? 'Model now follows the provider default.' : '当前 model 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'default_model' && parsed.value === 'default') {
        commandActions.setGlobalModelDefault?.(session, 'default');
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'defaults',
          activeDefaultsGroup: 'model',
          notice: language === 'en'
            ? '✅ Global default model cleared. Codex now follows the provider default.'
            : '✅ 已清除全局默认 model。Codex 现已回退到 provider 默认模型。',
        }));
        return true;
      }

      if (parsed.target === 'profile' && parsed.value === 'clear') {
        commandActions.setCodexProfile?.(session, 'default');
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'profile',
          notice: language === 'en' ? '✅ Codex profile now follows the provider default.' : '✅ 当前 Codex profile 已改为跟随 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'default_profile' && parsed.value === 'default') {
        commandActions.setGlobalCodexProfileDefault?.(session, 'default');
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'defaults',
          activeDefaultsGroup: 'profile',
          notice: language === 'en'
            ? '✅ Global default Codex profile cleared. Codex now follows the provider default.'
            : '✅ 已清除全局默认 Codex profile。Codex 现已回退到 provider 默认。',
        }));
        return true;
      }

      if (parsed.target === 'compact_threshold' && parsed.value === 'default') {
        commandActions.applyCompactConfig?.(session, { type: 'set_threshold', tokens: null });
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'compact',
          notice: language === 'en' ? '✅ Compact token limit now follows the default.' : '✅ compact 阈值已改为跟随默认。',
        }));
        return true;
      }

      if (parsed.target === 'workspace' && parsed.value === 'browse') {
        if (typeof openWorkspaceBrowser !== 'function') {
          await interaction.reply({
            content: language === 'en' ? '❌ Workspace browser is unavailable here.' : '❌ 当前环境没有可用的 workspace 浏览器。',
            flags: 64,
          });
          return true;
        }
        await interaction.reply(openWorkspaceBrowser({
          key,
          session,
          userId: interaction.user.id,
          mode: 'thread',
          flags: 64,
        }));
        return true;
      }

      if (parsed.target === 'workspace' && parsed.value === 'clear') {
        const result = commandActions.clearWorkspaceDir?.(session, key);
        closeRuntimeForKey(key);
        await interaction.update(buildSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
          activeSection: 'workspace',
          notice: result
            ? (language === 'en' ? '✅ This channel now follows the provider default workspace.' : '✅ 当前频道已改为跟随 provider 默认 workspace。')
            : '',
        }));
        return true;
      }
    }

    if (parsed.kind === 'set') {
      const replyDeliveryModeBefore = ['reply', 'default_reply'].includes(parsed.target)
        ? resolveReplyDeliverySetting(session).mode
        : null;
      if ((parsed.target === 'model' || parsed.target === 'quick_model') && parsed.value === 'preset') {
        const selectedModel = String(interaction.values?.[0] || '').trim();
        if (!selectedModel) {
          await interaction.reply({
            content: language === 'en' ? '❌ No model selected.' : '❌ 没有选择模型。',
            flags: 64,
          });
          return true;
        }
        commandActions.setModel?.(session, selectedModel);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'provider' && !botProvider) {
        commandActions.setProvider?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'profile') {
        commandActions.setCodexProfile?.(session, parsed.value === 'follow' ? null : parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'language') {
        commandActions.setLanguage?.(session, parsed.value);
      } else if (parsed.target === 'mode') {
        commandActions.setMode?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'default_fast') {
        const next = parsed.value === 'default' ? null : parsed.value === 'on';
        commandActions.setGlobalFastModeDefault?.(session, next);
      } else if (parsed.target === 'fast') {
        const next = parsed.value === 'follow' ? null : parsed.value === 'on';
        commandActions.setFastMode?.(session, next);
      } else if (parsed.target === 'runtime') {
        const next = parsed.value === 'follow' ? null : parsed.value;
        commandActions.setRuntimeMode?.(session, next);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'busy_prompt') {
        const next = parsed.value === 'follow' ? null : parsed.value;
        commandActions.setBusyPromptMode?.(session, next);
      } else if (parsed.target === 'default_effort') {
        commandActions.setGlobalReasoningEffortDefault?.(session, parsed.value);
      } else if (parsed.target === 'effort' || parsed.target === 'model_effort' || parsed.target === 'quick_model_effort') {
        commandActions.setReasoningEffort?.(session, parsed.value);
        closeRuntimeForKey(key);
      } else if (parsed.target === 'compact') {
        commandActions.setCompactStrategy?.(session, parsed.value === 'follow' ? null : parsed.value);
      } else if (parsed.target === 'reply') {
        commandActions.setReplyDeliveryMode?.(session, parsed.value === 'follow' ? null : parsed.value);
      } else if (parsed.target === 'default_reply') {
        commandActions.setGlobalReplyDeliveryModeDefault?.(session, parsed.value);
      } else if (parsed.target === 'default_profile') {
        commandActions.setGlobalCodexProfileDefault?.(session, parsed.value);
      }

      if (parsed.target === 'reply' || parsed.target === 'default_reply') {
        await flushActiveRunProcessMessages(interaction, key, session, {
          beforeMode: replyDeliveryModeBefore,
        });
      }

      if (parsed.target === 'quick_model' || parsed.target === 'quick_model_effort') {
        await interaction.update(buildModelSettingsPayload({
          key,
          session,
          userId: interaction.user.id,
        }));
        return true;
      }

      await interaction.update(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: parsed.target === 'default_reply'
          ? 'reply'
          : (parsed.target === 'busy_prompt')
            ? 'runtime'
          : (parsed.target === 'model' && parsed.value === 'preset')
            ? 'model'
            : (parsed.target === 'model_effort')
              ? 'model'
              : (parsed.target.startsWith('default_') ? 'defaults' : parsed.target),
        activeDefaultsGroup: parsed.target === 'default_effort'
          ? 'effort'
          : (parsed.target === 'default_fast'
            ? 'fast'
            : (parsed.target === 'default_profile'
              ? 'profile'
              : 'model')),
      }));
      return true;
    }

    await interaction.reply({
      content: language === 'en' ? '❌ Unsupported settings action.' : '❌ 不支持这个设置操作。',
      flags: 64,
    });
    return true;
  }

  async function handleSettingsPanelModalSubmit(interaction) {
    const parsed = parseSettingsModalId(interaction.customId);
    if (!parsed) return false;

    const key = String(interaction.channelId || '').trim();
    const session = key ? getSession(key, { channel: interaction.channel || null }) : null;
    const language = normalizeUiLanguage(getSessionLanguage(session) || defaultUiLanguage);

    if (!key || !session) {
      await interaction.reply({
        content: language === 'en' ? '❌ Unable to load channel settings.' : '❌ 无法读取当前频道设置。',
        flags: 64,
      });
      return true;
    }

    if (parsed.userId !== interaction.user.id) {
      await interaction.reply({
        content: language === 'en' ? '⛔ This settings panel belongs to another user.' : '⛔ 这个设置面板属于其他用户。',
        flags: 64,
      });
      return true;
    }

    if (parsed.target === 'model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      commandActions.setModel?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'model',
        flags: 64,
        notice: language === 'en' ? '✅ Model updated. This is the latest settings panel.' : '✅ model 已更新。这是最新的设置面板。',
      }));
      return true;
    }

    if (parsed.target === 'quick_model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      commandActions.setModel?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildModelSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        flags: 64,
        notice: language === 'en' ? 'Model updated.' : 'model 已更新。',
      }));
      return true;
    }

    if (parsed.target === 'default_model') {
      const rawValue = String(interaction.fields.getTextInputValue(MODEL_INPUT_ID) || '').trim();
      commandActions.setGlobalModelDefault?.(session, rawValue);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'defaults',
        activeDefaultsGroup: 'model',
        flags: 64,
        notice: language === 'en'
          ? '✅ Global default model updated in `~/.codex/config.toml`.'
          : '✅ 已更新 `~/.codex/config.toml` 里的全局默认 model。',
      }));
      return true;
    }

    if (parsed.target === 'profile') {
      const rawValue = String(interaction.fields.getTextInputValue(CODEX_PROFILE_INPUT_ID) || '').trim();
      commandActions.setCodexProfile?.(session, rawValue);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'profile',
        flags: 64,
        notice: language === 'en' ? '✅ Codex profile updated. This is the latest settings panel.' : '✅ Codex profile 已更新。这是最新的设置面板。',
      }));
      return true;
    }

    if (parsed.target === 'default_profile') {
      const rawValue = String(interaction.fields.getTextInputValue(CODEX_PROFILE_INPUT_ID) || '').trim();
      commandActions.setGlobalCodexProfileDefault?.(session, rawValue);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'defaults',
        activeDefaultsGroup: 'profile',
        flags: 64,
        notice: language === 'en'
          ? '✅ Global default Codex profile updated.'
          : '✅ 已更新全局默认 Codex profile。',
      }));
      return true;
    }

    if (parsed.target === 'compact_threshold') {
      const rawValue = String(interaction.fields.getTextInputValue(COMPACT_THRESHOLD_INPUT_ID) || '').trim();
      const parsedCompact = parseCompactConfigAction('token_limit', rawValue);
      if (parsedCompact?.type !== 'set_threshold') {
        await interaction.reply({
          content: language === 'en' ? '❌ Invalid compact token limit. Use a positive integer or `default`.' : '❌ compact 阈值无效。请输入正整数或 `default`。',
          flags: 64,
        });
        return true;
      }
      commandActions.applyCompactConfig?.(session, parsedCompact);
      closeRuntimeForKey(key);
      await interaction.reply(buildSettingsPayload({
        key,
        session,
        userId: interaction.user.id,
        activeSection: 'compact',
        flags: 64,
        notice: language === 'en' ? '✅ Compact token limit updated. This is the latest settings panel.' : '✅ compact 阈值已更新。这是最新的设置面板。',
      }));
      return true;
    }

    await interaction.reply({
      content: language === 'en' ? '❌ Unsupported settings modal.' : '❌ 不支持这个设置弹窗。',
      flags: 64,
    });
    return true;
  }

  return {
    openSettingsPanel: (options = {}) => buildSettingsPayload(options),
    openModelSettingsPanel: (options = {}) => buildModelSettingsPayload(options),
    handleSettingsPanelInteraction,
    handleSettingsPanelModalSubmit,
    isSettingsPanelComponentId,
    isSettingsPanelModalId,
  };
}
