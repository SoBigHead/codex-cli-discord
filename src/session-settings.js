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
        ? 'native (Codex CLI auto-compact + continue)'
        : 'native（Codex CLI 自动压缩并继续当前 session）';
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
  compactStrategy = 'hard',
  compactOnThreshold = true,
  maxInputTokensBeforeCompact = 250000,
  modelAutoCompactTokenLimit = maxInputTokensBeforeCompact,
  readCodexDefaults = () => ({ model: '(unknown)', effort: '(unknown)' }),
  normalizeProvider = (provider) => String(provider || '').trim().toLowerCase() || 'codex',
} = {}) {
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

  function resolveCompactStrategySetting(session) {
    const sessionStrategy = normalizeSessionCompactStrategy(session?.compactStrategy);
    if (sessionStrategy) {
      return { strategy: sessionStrategy, source: 'session override' };
    }
    return { strategy: compactStrategy, source: 'env default' };
  }

  function resolveCompactEnabledSetting(session) {
    const enabled = normalizeSessionCompactEnabled(session?.compactEnabled);
    if (enabled !== null) {
      return { enabled, source: 'session override' };
    }
    return { enabled: compactOnThreshold, source: 'env default' };
  }

  function resolveCompactThresholdSetting(session) {
    const tokens = normalizeSessionCompactTokenLimit(session?.compactThresholdTokens);
    if (tokens !== null) {
      return { tokens, source: 'session override' };
    }
    return { tokens: maxInputTokensBeforeCompact, source: 'env default' };
  }

  function resolveNativeCompactTokenLimitSetting(session) {
    const direct = normalizeSessionCompactTokenLimit(session?.nativeCompactTokenLimit);
    if (direct !== null) {
      return { tokens: direct, source: 'session override' };
    }

    const threshold = normalizeSessionCompactTokenLimit(session?.compactThresholdTokens);
    if (threshold !== null) {
      return { tokens: threshold, source: 'session threshold fallback' };
    }

    return { tokens: modelAutoCompactTokenLimit, source: 'env default' };
  }

  function getProviderDefaults(provider) {
    if (normalizeProvider(provider) !== 'codex') {
      return { model: '(provider default)', effort: '(provider default)', source: 'provider' };
    }
    return {
      ...readCodexDefaults(),
      source: 'config.toml',
    };
  }

  return {
    getSessionLanguage,
    getEffectiveSecurityProfile,
    resolveTimeoutSetting,
    resolveTaskRetrySetting,
    resolveCompactStrategySetting,
    resolveCompactEnabledSetting,
    resolveCompactThresholdSetting,
    resolveNativeCompactTokenLimitSetting,
    getProviderDefaults,
  };
}
