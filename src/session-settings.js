import {
  DEFAULT_EXTRA_INFO_TEMPLATE,
  normalizeExtraInfoEnabled,
  normalizeExtraInfoTemplate,
} from './extra-info.js';

export function parseUiLanguageInput(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['zh', 'zh-cn', 'cn', 'chinese', '中文'].includes(raw)) return 'zh';
  if (['en', 'en-us', 'english', '英文'].includes(raw)) return 'en';
  return null;
}

export function normalizeUiLanguage(value) {
  return parseUiLanguageInput(value) || 'zh';
}

export function formatLanguageLabel(language) {
  return language === 'en' ? 'en (English)' : 'zh (中文)';
}

const REPLY_DELIVERY_MODE_LABELS = Object.freeze({
  card_mention: {
    en: 'Only update the progress card, trigger @ when done',
    zh: '只更新进度卡，完成时触发 @',
  },
  stream_mention: {
    en: 'Send process messages, trigger @ when done',
    zh: '发送过程消息，完成时触发 @',
  },
  card_only: {
    en: 'Only update the progress card, do not trigger @ when done',
    zh: '只更新进度卡，完成时不触发 @',
  },
  stream_only: {
    en: 'Send process messages, do not trigger @ when done',
    zh: '发送过程消息，完成时不触发 @',
  },
});

export function normalizeReplyDeliveryMode(value, fallback = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (Object.prototype.hasOwnProperty.call(REPLY_DELIVERY_MODE_LABELS, raw)) {
    return raw;
  }
  return fallback;
}

export function formatReplyDeliveryModeLabel(mode, language = 'zh') {
  const normalized = normalizeReplyDeliveryMode(mode, 'card_mention');
  return REPLY_DELIVERY_MODE_LABELS[normalized]?.[language === 'en' ? 'en' : 'zh']
    || REPLY_DELIVERY_MODE_LABELS.card_mention[language === 'en' ? 'en' : 'zh'];
}

export function parseSecurityProfileInput(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['auto', 'solo', 'team', 'public'].includes(raw)) return raw;
  return null;
}

export function normalizeSessionSecurityProfile(value) {
  return parseSecurityProfileInput(value);
}

export function formatSecurityProfileLabel(profile) {
  return parseSecurityProfileInput(profile) || 'team';
}

export function normalizeCodexProfile(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function formatCodexProfileLabel(profile, language = 'zh') {
  const value = normalizeCodexProfile(profile);
  if (!value) {
    return language === 'en' ? '(provider default)' : '（provider 默认）';
  }
  return `\`${value}\``;
}

export function normalizeSessionFastMode(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'enable', 'enabled', 'yes', '开启', '启用', '打开'].includes(raw)) return true;
  if (['0', 'false', 'off', 'disable', 'disabled', 'no', '关闭', '禁用'].includes(raw)) return false;
  return null;
}

export function normalizeSessionRuntimeMode(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'normal' || raw === 'short' || raw === 'cold' || raw === 'exec') return 'normal';
  if (raw === 'long' || raw === 'hot' || raw === 'server' || raw === 'app-server') return 'long';
  return null;
}

export function parseRuntimeModeAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['default', 'inherit', 'clear', 'reset', 'follow', '跟随默认', '清除'].includes(raw)) {
    return { type: 'set', mode: null };
  }
  const mode = normalizeSessionRuntimeMode(raw);
  if (!mode) return { type: 'invalid' };
  return { type: 'set', mode };
}

export function normalizeBusyPromptMode(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (['queue', 'queued', 'enqueue', '排队'].includes(raw)) return 'queue';
  if (['steer', 'steering', 'steer_if_possible', 'steer_then_queue', '插入', '转向'].includes(raw)) {
    return 'steer_if_possible';
  }
  return null;
}

export function parseBusyPromptModeAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['default', 'inherit', 'clear', 'reset', 'follow', '跟随默认', '清除'].includes(raw)) {
    return { type: 'set', mode: null };
  }
  const mode = normalizeBusyPromptMode(raw);
  if (!mode) return { type: 'invalid' };
  return { type: 'set', mode };
}

export function formatBusyPromptModeLabel(mode, language = 'zh') {
  const normalized = normalizeBusyPromptMode(mode) || 'queue';
  if (normalized === 'steer_if_possible') {
    return language === 'en' ? 'steer if possible' : '可插入时 steer';
  }
  return language === 'en' ? 'queue' : '排队';
}

export function parseFastModeAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['default', 'inherit', 'clear', 'reset', '跟随默认', '清除'].includes(raw)) {
    return { type: 'set', enabled: null };
  }
  const enabled = normalizeSessionFastMode(raw);
  if (enabled === null) return { type: 'invalid' };
  return { type: 'set', enabled };
}

export function normalizeTimeoutMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.floor(n);
}

export function normalizeSessionTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return normalizeTimeoutMs(n, 0);
}

function normalizeTaskMaxAttempts(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(1, Math.floor(Number(fallback) || 3));
  return Math.max(1, Math.floor(n));
}

function normalizeTaskRetryDelayMs(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(n));
}

export function parseTimeoutConfigAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['off', 'disable', 'disabled', 'none', '0', '关闭', '禁用'].includes(raw)) {
    return { type: 'set', timeoutMs: 0 };
  }
  if (!/^\d+$/.test(raw)) return { type: 'invalid' };
  return { type: 'set', timeoutMs: normalizeTimeoutMs(Number(raw), 0) };
}

export function normalizeCompactStrategy(value, { logger = console } = {}) {
  const strategy = String(value || 'hard').trim().toLowerCase();
  if (['hard', 'native', 'off'].includes(strategy)) return strategy;
  logger?.warn?.(`⚠️ Unknown COMPACT_STRATEGY=${value}, fallback to hard`);
  return 'hard';
}

export function describeCompactStrategy(strategy, language = 'en') {
  switch (strategy) {
    case 'native':
      return language === 'en'
        ? 'native (provider-managed compaction + continue)'
        : 'native（由 provider CLI 原生压缩并继续当前 session）';
    case 'off':
      return language === 'en' ? 'off (disabled)' : 'off（关闭）';
    default:
      return language === 'en'
        ? 'hard (summary + new session)'
        : 'hard（先总结再新开 session）';
  }
}

export function normalizeSessionCompactStrategy(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeCompactStrategy(value, { logger: null });
}

export function normalizeSessionCompactTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function normalizeSessionCompactEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'enable', 'enabled', 'yes', '开启', '启用', '打开'].includes(raw)) return true;
  if (['0', 'false', 'off', 'disable', 'disabled', 'no', '关闭', '禁用'].includes(raw)) return false;
  return null;
}

export function parseCompactStrategyAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['hard', 'native', 'off'].includes(raw)) return { type: 'set', strategy: raw };
  return { type: 'invalid' };
}

export function parseCompactEnabledAction(value) {
  const enabled = normalizeSessionCompactEnabled(value);
  if (enabled === null) return { type: 'invalid' };
  return { type: 'set', enabled };
}

export function parseCompactTokenLimitAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['default', 'reset', 'inherit', 'clear', '跟随默认', '清除'].includes(raw)) {
    return { type: 'set', tokens: null };
  }
  if (!/^\d+$/.test(raw)) return { type: 'invalid' };
  const tokens = normalizeSessionCompactTokenLimit(Number(raw));
  if (tokens === null) return { type: 'invalid' };
  return { type: 'set', tokens };
}

export function parseCompactConfigAction(key, value = '') {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedValue = String(value || '').trim();

  if (!normalizedKey || normalizedKey === 'status') {
    return { type: 'status' };
  }
  if (['hard', 'native', 'off'].includes(normalizedKey)) {
    return { type: 'set_strategy', strategy: normalizedKey };
  }
  if (normalizedKey === 'reset') {
    return { type: 'reset' };
  }
  if (normalizedKey === 'strategy') {
    const parsed = parseCompactStrategyAction(normalizedValue);
    if (!parsed || parsed.type !== 'set') return { type: 'invalid' };
    return { type: 'set_strategy', strategy: parsed.strategy };
  }
  if (['token_limit', 'threshold', 'threshold_tokens', 'limit'].includes(normalizedKey)) {
    const parsed = parseCompactTokenLimitAction(normalizedValue);
    if (!parsed || parsed.type !== 'set') return { type: 'invalid' };
    return { type: 'set_threshold', tokens: parsed.tokens };
  }
  if (['native_limit', 'native_token_limit', 'model_auto_compact_token_limit'].includes(normalizedKey)) {
    const parsed = parseCompactTokenLimitAction(normalizedValue);
    if (!parsed || parsed.type !== 'set') return { type: 'invalid' };
    return { type: 'set_native_limit', tokens: parsed.tokens };
  }
  if (['enabled', 'on_threshold', 'auto'].includes(normalizedKey)) {
    const parsed = parseCompactEnabledAction(normalizedValue);
    if (!parsed || parsed.type !== 'set') return { type: 'invalid' };
    return { type: 'set_enabled', enabled: parsed.enabled };
  }
  return { type: 'invalid' };
}

export function parseCompactConfigFromText(arg = '') {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { type: 'status' };
  if (parts.length === 1) return parseCompactConfigAction(parts[0], '');
  return parseCompactConfigAction(parts[0], parts.slice(1).join(' '));
}

export function parseExtraInfoConfigAction(key, value = '') {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedValue = String(value || '').trim();

  if (!normalizedKey || normalizedKey === 'status') return { type: 'status' };
  if (['on', 'off', 'enabled'].includes(normalizedKey)) {
    const raw = normalizedKey === 'enabled' ? normalizedValue : normalizedKey;
    const enabled = normalizeExtraInfoEnabled(raw);
    if (enabled === null) return { type: 'invalid' };
    return { type: 'set_enabled', enabled };
  }
  if (['default', 'reset', 'inherit', 'clear', '跟随默认', '清除'].includes(normalizedKey)) {
    return { type: 'reset' };
  }
  if (['text', 'content', 'template'].includes(normalizedKey)) {
    if (['default', 'reset', 'inherit', 'clear', '跟随默认', '清除'].includes(normalizedValue.toLowerCase())) {
      return { type: 'set_text', text: null };
    }
    const text = normalizeExtraInfoTemplate(normalizedValue);
    if (!text) return { type: 'invalid' };
    return { type: 'set_text', text };
  }
  return { type: 'invalid' };
}

export function parseExtraInfoConfigFromText(arg = '') {
  const text = String(arg || '').trim();
  if (!text) return { type: 'status' };
  const [key, ...rest] = text.split(/\s+/);
  return parseExtraInfoConfigAction(key, rest.join(' '));
}

export function parseReasoningEffortInput(value, { allowDefault = false } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (allowDefault && raw === 'default') return 'default';
  if (['low', 'medium', 'high', 'xhigh'].includes(raw)) return raw;
  return null;
}

export function parseWorkspaceCommandAction(value) {
  const raw = String(value || '').trim();
  if (!raw) return { type: 'invalid' };
  const lower = raw.toLowerCase();
  if (['status', 'state', 'show', '查看', '状态'].includes(lower)) return { type: 'status' };
  if (['browse', 'picker', 'select', '浏览', '选择'].includes(lower)) return { type: 'browse' };
  if (['default', 'inherit', 'clear', 'reset', '跟随默认', '清除'].includes(lower)) return { type: 'clear' };
  return { type: 'set', value: raw };
}

export function createSessionSettings({
  defaultUiLanguage = 'zh',
  securityProfile = 'auto',
  codexTimeoutMs = 0,
  taskMaxAttempts = 3,
  taskRetryBaseDelayMs = 1000,
  taskRetryMaxDelayMs = 8000,
  compactStrategy = 'native',
  claudeRuntimeMode = 'normal',
  codexRuntimeMode = 'normal',
  compactOnThreshold = true,
  maxInputTokensBeforeCompact = 250000,
  modelAutoCompactTokenLimit = maxInputTokensBeforeCompact,
  defaultReplyDeliveryMode = 'card_mention',
  readDefaultReplyDeliveryMode = () => defaultReplyDeliveryMode,
  defaultExtraInfoEnabled = true,
  defaultExtraInfoText = DEFAULT_EXTRA_INFO_TEMPLATE,
  defaultCodexProfile = null,
  readDefaultCodexProfile = () => ({ profile: defaultCodexProfile, source: 'env default' }),
  defaultModel = null,
  readCodexDefaults = () => ({
    model: null,
    modelConfigured: false,
    effort: null,
    effortConfigured: false,
    fastMode: true,
    fastModeConfigured: false,
  }),
  readCodexProfileCatalog = () => ({ profiles: [], configPath: '' }),
  normalizeProvider = (provider) => String(provider || '').trim().toLowerCase() || 'codex',
  getSupportedCompactStrategies = () => ['hard', 'native', 'off'],
  getParentSession = () => null,
} = {}) {
  let resolveParentSessionFn = getParentSession;

  function getDefaultModelValue() {
    return String(defaultModel || '').trim();
  }

  function readProviderScopedValue(session, provider, field) {
    if (!session || typeof session !== 'object') return null;
    const normalizedProvider = normalizeProvider(provider);
    const state = session.providers?.[normalizedProvider];
    if (state && typeof state === 'object' && !Array.isArray(state) && field in state) {
      return state[field];
    }
    if (normalizeProvider(session.provider) === normalizedProvider) {
      return session[field];
    }
    return null;
  }

  function resolveParentSession(session) {
    const parent = typeof resolveParentSessionFn === 'function' ? resolveParentSessionFn(session) : null;
    if (!parent || parent === session) return null;
    return parent;
  }

  function getSessionLanguage(session) {
    if (!session) return defaultUiLanguage;
    return normalizeUiLanguage(session.language || defaultUiLanguage);
  }

  function getEffectiveSecurityProfile(session) {
    const sessionProfile = normalizeSessionSecurityProfile(session?.securityProfile);
    if (sessionProfile) {
      return { profile: sessionProfile, source: 'session override' };
    }
    return { profile: securityProfile, source: 'env default' };
  }

  function resolveTimeoutSetting(session) {
    const sessionTimeout = normalizeSessionTimeoutMs(session?.timeoutMs);
    if (sessionTimeout !== null) {
      return { timeoutMs: sessionTimeout, source: 'session override' };
    }
    return { timeoutMs: codexTimeoutMs, source: 'env default' };
  }

  function resolveTaskRetrySetting(session) {
    const hasOverride = ['taskMaxAttempts', 'taskRetryBaseDelayMs', 'taskRetryMaxDelayMs']
      .some((key) => session?.[key] !== null && session?.[key] !== undefined && session?.[key] !== '');
    const maxAttempts = normalizeTaskMaxAttempts(session?.taskMaxAttempts, taskMaxAttempts);
    const baseDelayMs = normalizeTaskRetryDelayMs(session?.taskRetryBaseDelayMs, taskRetryBaseDelayMs);
    const maxDelayMs = Math.max(
      baseDelayMs,
      normalizeTaskRetryDelayMs(session?.taskRetryMaxDelayMs, taskRetryMaxDelayMs),
    );
    return {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      source: hasOverride ? 'session override' : 'env default',
    };
  }

  function resolveFastModeSetting(session) {
    const provider = normalizeProvider(session?.provider);
    if (provider !== 'codex') {
      return {
        enabled: false,
        supported: false,
        source: 'provider unsupported',
      };
    }

    const sessionFastMode = normalizeSessionFastMode(session?.fastMode);
    if (sessionFastMode !== null) {
      return {
        enabled: sessionFastMode,
        supported: true,
        source: 'session override',
      };
    }

    const parentSession = resolveParentSession(session);
    const parentFastMode = normalizeSessionFastMode(readProviderScopedValue(parentSession, provider, 'fastMode'));
    if (parentFastMode !== null) {
      return {
        enabled: parentFastMode,
        supported: true,
        source: 'parent channel',
      };
    }

    return {
      enabled: Boolean(readCodexDefaults().fastMode),
      supported: true,
      source: 'config.toml',
    };
  }

  function resolveRuntimeModeSetting(session) {
    const provider = normalizeProvider(session?.provider);
    if (provider !== 'claude' && provider !== 'codex') {
      return {
        mode: 'normal',
        supported: false,
        source: 'provider unsupported',
      };
    }

    const sessionRuntimeMode = normalizeSessionRuntimeMode(session?.runtimeMode);
    if (sessionRuntimeMode) {
      return {
        mode: sessionRuntimeMode,
        supported: true,
        source: 'session override',
      };
    }

    const parentSession = resolveParentSession(session);
    const parentRuntimeMode = normalizeSessionRuntimeMode(readProviderScopedValue(parentSession, provider, 'runtimeMode'));
    if (parentRuntimeMode) {
      return {
        mode: parentRuntimeMode,
        supported: true,
        source: 'parent channel',
      };
    }

    return {
      mode: normalizeSessionRuntimeMode(provider === 'codex' ? codexRuntimeMode : claudeRuntimeMode) || 'normal',
      supported: true,
      source: 'env default',
    };
  }

  function resolveBusyPromptModeSetting(session) {
    const provider = normalizeProvider(session?.provider);
    const runtime = resolveRuntimeModeSetting(session);
    let requestedMode = normalizeBusyPromptMode(session?.busyPromptMode);
    let source = 'session override';

    if (!requestedMode) {
      const parentSession = resolveParentSession(session);
      requestedMode = normalizeBusyPromptMode(readProviderScopedValue(parentSession, provider, 'busyPromptMode'));
      source = requestedMode ? 'parent channel' : 'built-in default';
    }

    if (!requestedMode) requestedMode = 'queue';

    const runtimeAllowsSteer = runtime.supported && runtime.mode === 'long';
    const providerCanSteer = provider === 'codex';
    const canSteer = runtimeAllowsSteer && providerCanSteer;
    const mode = requestedMode === 'steer_if_possible' && !canSteer ? 'queue' : requestedMode;
    let reason = null;
    if (requestedMode === 'steer_if_possible' && !runtimeAllowsSteer) {
      reason = 'requires long runtime';
    } else if (requestedMode === 'steer_if_possible' && !providerCanSteer) {
      reason = 'steer unavailable';
    }

    return {
      mode,
      requestedMode,
      canSteer,
      supported: true,
      source,
      reason,
    };
  }

  function resolveModelSetting(session) {
    const provider = normalizeProvider(session?.provider);
    const currentValue = String(session?.model || '').trim();
    if (currentValue) {
      return { value: currentValue, source: 'session override' };
    }

    const parentSession = resolveParentSession(session);
    const parentValue = String(readProviderScopedValue(parentSession, provider, 'model') || '').trim();
    if (parentValue) {
      return { value: parentValue, source: 'parent channel' };
    }

    const defaultModelValue = getDefaultModelValue();
    if (provider === 'codex') {
      const codexDefaults = readCodexDefaults() || {};
      const value = String(codexDefaults.model ?? '').trim();
      const configured = codexDefaults.modelConfigured ?? Boolean(value);
      if (configured && value) {
        return { value, source: 'config.toml' };
      }
      if (defaultModelValue) {
        return { value: defaultModelValue, source: 'env default' };
      }
      return { value: null, source: 'provider' };
    }

    if (defaultModelValue) {
      return { value: defaultModelValue, source: 'env default' };
    }

    return {
      value: null,
      source: 'provider',
    };
  }

  function resolveReasoningEffortSetting(session) {
    const provider = normalizeProvider(session?.provider);
    const currentValue = String(session?.effort || '').trim();
    if (currentValue) {
      return { value: currentValue, source: 'session override' };
    }

    const parentSession = resolveParentSession(session);
    const parentValue = String(readProviderScopedValue(parentSession, provider, 'effort') || '').trim();
    if (parentValue) {
      return { value: parentValue, source: 'parent channel' };
    }

    if (provider === 'codex') {
      const codexDefaults = readCodexDefaults() || {};
      const value = String(codexDefaults.effort ?? '').trim();
      const configured = codexDefaults.effortConfigured ?? Boolean(value);
      if (configured && value) {
        return { value, source: 'config.toml' };
      }
      return { value: null, source: 'provider' };
    }

    return {
      value: null,
      source: 'provider',
    };
  }

  function resolveCodexProfileSetting(session) {
    const provider = normalizeProvider(session?.provider);
    if (provider !== 'codex') {
      return {
        value: null,
        source: 'provider unsupported',
        supported: false,
        isExplicit: false,
        valid: false,
        availableProfiles: [],
        configPath: null,
        error: null,
      };
    }

    const catalog = readCodexProfileCatalog() || {};
    const availableProfiles = Array.isArray(catalog.profiles) ? catalog.profiles : [];
    const configPath = String(catalog.configPath || '').trim() || null;
    const validate = (value, source, isExplicit) => {
      const normalized = normalizeCodexProfile(value);
      if (!normalized) {
        return {
          value: null,
          source,
          supported: true,
          isExplicit,
          valid: true,
          availableProfiles,
          configPath,
          error: null,
        };
      }
      if (availableProfiles.includes(normalized)) {
        return {
          value: normalized,
          source,
          supported: true,
          isExplicit,
          valid: true,
          availableProfiles,
          configPath,
          error: null,
        };
      }
      return {
        value: normalized,
        source,
        supported: true,
        isExplicit,
        valid: false,
        availableProfiles,
        configPath,
        error: `missing in ${configPath || '~/.codex/config.toml'}`,
      };
    };

    const sessionProfile = normalizeCodexProfile(session?.codexProfile);
    if (sessionProfile) {
      return validate(sessionProfile, 'session override', true);
    }

    const parentSession = resolveParentSession(session);
    const parentProfile = normalizeCodexProfile(readProviderScopedValue(parentSession, provider, 'codexProfile'));
    if (parentProfile) {
      return validate(parentProfile, 'parent channel', true);
    }

    const defaultProfile = normalizeCodexProfile(readDefaultCodexProfile()?.profile);
    if (defaultProfile) {
      return validate(defaultProfile, 'env default', true);
    }

    return validate(null, 'provider default', false);
  }

  function resolveCompactStrategySetting(session) {
    const provider = normalizeProvider(session?.provider);
    const supportedStrategies = new Set(getSupportedCompactStrategies(provider));
    const sessionStrategy = normalizeSessionCompactStrategy(session?.compactStrategy);
    if (sessionStrategy) {
      return {
        strategy: supportedStrategies.has(sessionStrategy) ? sessionStrategy : 'hard',
        source: 'session override',
      };
    }

    const parentSession = resolveParentSession(session);
    const parentStrategy = normalizeSessionCompactStrategy(readProviderScopedValue(parentSession, provider, 'compactStrategy'));
    if (parentStrategy) {
      return {
        strategy: supportedStrategies.has(parentStrategy) ? parentStrategy : 'hard',
        source: 'parent channel',
      };
    }

    return {
      strategy: supportedStrategies.has(compactStrategy) ? compactStrategy : 'hard',
      source: 'env default',
    };
  }

  function resolveCompactEnabledSetting(session) {
    const enabled = normalizeSessionCompactEnabled(session?.compactEnabled);
    if (enabled !== null) {
      return { enabled, source: 'session override' };
    }

    const provider = normalizeProvider(session?.provider);
    const parentSession = resolveParentSession(session);
    const parentEnabled = normalizeSessionCompactEnabled(readProviderScopedValue(parentSession, provider, 'compactEnabled'));
    if (parentEnabled !== null) {
      return { enabled: parentEnabled, source: 'parent channel' };
    }

    return { enabled: compactOnThreshold, source: 'env default' };
  }

  function resolveCompactThresholdSetting(session) {
    const tokens = normalizeSessionCompactTokenLimit(session?.compactThresholdTokens);
    if (tokens !== null) {
      return { tokens, source: 'session override' };
    }

    const provider = normalizeProvider(session?.provider);
    const parentSession = resolveParentSession(session);
    const parentTokens = normalizeSessionCompactTokenLimit(readProviderScopedValue(parentSession, provider, 'compactThresholdTokens'));
    if (parentTokens !== null) {
      return { tokens: parentTokens, source: 'parent channel' };
    }

    return { tokens: maxInputTokensBeforeCompact, source: 'env default' };
  }

  function resolveReplyDeliverySetting(session) {
    const sessionMode = normalizeReplyDeliveryMode(session?.replyDeliveryMode);
    if (sessionMode) {
      return { mode: sessionMode, source: 'session override' };
    }

    if (session?.parentChannelId) {
      const parentSession = resolveParentSession(session);
      const parentMode = normalizeReplyDeliveryMode(parentSession?.replyDeliveryMode);
      if (parentMode) {
        return { mode: parentMode, source: 'parent channel' };
      }
    }

    return {
      mode: normalizeReplyDeliveryMode(readDefaultReplyDeliveryMode(), 'card_mention'),
      source: 'env default',
    };
  }

  function resolveExtraInfoSetting(session) {
    const sessionEnabled = normalizeExtraInfoEnabled(session?.extraInfoEnabled);
    const parentSession = resolveParentSession(session);
    const parentEnabled = normalizeExtraInfoEnabled(parentSession?.extraInfoEnabled);
    const enabled = sessionEnabled !== null
      ? { enabled: sessionEnabled, source: 'session override' }
      : parentEnabled !== null
        ? { enabled: parentEnabled, source: 'parent channel' }
        : { enabled: Boolean(defaultExtraInfoEnabled), source: 'env default' };

    const sessionText = normalizeExtraInfoTemplate(session?.extraInfoText);
    const parentText = normalizeExtraInfoTemplate(parentSession?.extraInfoText);
    const text = sessionText
      ? { text: sessionText, source: 'session override' }
      : parentText
        ? { text: parentText, source: 'parent channel' }
        : { text: normalizeExtraInfoTemplate(defaultExtraInfoText) || DEFAULT_EXTRA_INFO_TEMPLATE, source: 'env default' };

    return {
      enabled: enabled.enabled,
      enabledSource: enabled.source,
      text: text.text,
      textSource: text.source,
    };
  }

  function resolveNativeCompactTokenLimitSetting(session) {
    const provider = normalizeProvider(session?.provider);
    const direct = normalizeSessionCompactTokenLimit(session?.nativeCompactTokenLimit);
    if (direct !== null) {
      return { tokens: direct, source: 'session override' };
    }

    const threshold = normalizeSessionCompactTokenLimit(session?.compactThresholdTokens);
    if (threshold !== null) {
      return { tokens: threshold, source: 'session threshold fallback' };
    }

    const parentSession = resolveParentSession(session);
    const parentDirect = normalizeSessionCompactTokenLimit(readProviderScopedValue(parentSession, provider, 'nativeCompactTokenLimit'));
    if (parentDirect !== null) {
      return { tokens: parentDirect, source: 'parent channel' };
    }

    const parentThreshold = normalizeSessionCompactTokenLimit(readProviderScopedValue(parentSession, provider, 'compactThresholdTokens'));
    if (parentThreshold !== null) {
      return { tokens: parentThreshold, source: 'parent channel threshold fallback' };
    }

    return { tokens: modelAutoCompactTokenLimit, source: 'env default' };
  }

  function getProviderDefaults(provider) {
    if (normalizeProvider(provider) !== 'codex') {
      const defaultModelValue = getDefaultModelValue();
      return {
        model: defaultModelValue || null,
        profile: null,
        profileConfigured: false,
        effort: null,
        fastMode: false,
        source: defaultModelValue ? 'env default' : 'provider',
      };
    }
    const codexDefaults = readCodexDefaults();
    const codexProfile = readDefaultCodexProfile();
    const value = String(codexDefaults?.model ?? '').trim();
    const configured = codexDefaults?.modelConfigured ?? Boolean(value);
    if (configured && value) {
      return {
        ...codexDefaults,
        profile: normalizeCodexProfile(codexProfile?.profile),
        profileConfigured: Boolean(normalizeCodexProfile(codexProfile?.profile)),
        source: 'config.toml',
      };
    }
    const defaultModelValue = getDefaultModelValue();
    return {
      ...codexDefaults,
      profile: normalizeCodexProfile(codexProfile?.profile),
      profileConfigured: Boolean(normalizeCodexProfile(codexProfile?.profile)),
      model: defaultModelValue || codexDefaults?.model || null,
      modelConfigured: defaultModelValue ? true : codexDefaults?.modelConfigured,
      source: defaultModelValue ? 'env default' : 'config.toml',
    };
  }

  return {
    setParentSessionResolver(resolver) {
      resolveParentSessionFn = typeof resolver === 'function' ? resolver : () => null;
    },
    getSessionLanguage,
    getEffectiveSecurityProfile,
    resolveTimeoutSetting,
    resolveTaskRetrySetting,
    resolveCodexProfileSetting,
    resolveModelSetting,
    resolveReasoningEffortSetting,
    resolveFastModeSetting,
    resolveRuntimeModeSetting,
    resolveBusyPromptModeSetting,
    resolveCompactStrategySetting,
    resolveCompactEnabledSetting,
    resolveCompactThresholdSetting,
    resolveNativeCompactTokenLimitSetting,
    resolveReplyDeliverySetting,
    resolveExtraInfoSetting,
    getProviderDefaults,
  };
}
