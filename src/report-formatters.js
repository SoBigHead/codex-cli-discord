import { formatWorkspaceBusyReport as formatWorkspaceBusyReportBase } from './workspace-busy-report.js';
import { getProviderCommandAlias } from './command-spec.js';
import { formatCodexProfileLabel, formatReplyDeliveryModeLabel } from './session-settings.js';
import { formatCodexGoalBudget, formatCodexGoalStatus } from './codex-goal-flow.js';
import {
  buildExtraInfoPromptLine,
  DEFAULT_EXTRA_INFO_TEMPLATE,
  estimatePromptTokenCount,
} from './extra-info.js';

const REASONING_LEVEL_DISPLAY_ORDER = Object.freeze(['xhigh', 'high', 'medium', 'low']);

export function createReportFormatters({
  botProvider = null,
  allowedChannelIds = null,
  allowedUserIds = null,
  progressProcessLines = 3,
  progressPlanMaxLines = 3,
  progressDoneStepsMax = 3,
  slashRef = (name) => `/${name}`,
  getSessionLanguage = () => 'zh',
  normalizeUiLanguage = (value) => (String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'),
  getSessionProvider = () => 'codex',
  getProviderDisplayName = (provider) => String(provider || ''),
  getProviderShortName = (provider) => String(provider || ''),
  getProviderCompactCapabilities = () => ({
    strategies: ['hard', 'native', 'off'],
    supportsNativeStrategy: true,
    supportsNativeLimit: true,
  }),
  providerSupportsRawConfigOverrides = () => false,
  formatProviderSessionTerm = () => 'session',
  formatProviderRuntimeSummary = () => '',
  formatProviderSessionStoreSurface = () => '',
  formatProviderResumeSurface = () => '',
  formatProviderNativeCompactSurface = () => '',
  formatProviderRawConfigSurface = () => '',
  formatProviderReasoningSurface = () => '',
  getSupportedReasoningEffortLevels = () => ['xhigh', 'high', 'medium', 'low'],
  getProviderDefaults = () => ({ model: '(unknown)', effort: '(unknown)', source: 'provider' }),
  resolveModelSetting = (session) => ({ value: session?.model || '(unknown)', source: session?.model ? 'session override' : 'provider' }),
  resolveCodexProfileSetting = () => ({ value: null, source: 'provider default', valid: true, isExplicit: false, supported: false }),
  resolveReasoningEffortSetting = (session) => ({ value: session?.effort || '(unknown)', source: session?.effort ? 'session override' : 'provider' }),
  getCliHealth = () => ({ ok: false, error: 'unavailable' }),
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
  resolveSecurityContext = () => ({ mentionOnly: false, maxQueuePerChannel: 0 }),
  resolveTimeoutSetting = () => ({ timeoutMs: 0, source: 'env default' }),
  resolveFastModeSetting = () => ({ enabled: false, supported: false, source: 'provider unsupported' }),
  resolveRuntimeModeSetting = () => ({ mode: 'normal', supported: false, source: 'provider unsupported' }),
  resolveReplyDeliverySetting = () => ({ mode: 'card_mention', source: 'env default' }),
  resolveExtraInfoSetting = () => ({ enabled: true, enabledSource: 'env default', text: DEFAULT_EXTRA_INFO_TEMPLATE, textSource: 'env default' }),
  getEffectiveSecurityProfile = () => ({ profile: 'team', source: 'env default' }),
  resolveCompactStrategySetting = () => ({ strategy: 'native', source: 'env default' }),
  resolveCompactEnabledSetting = () => ({ enabled: true, source: 'env default' }),
  resolveCompactThresholdSetting = () => ({ tokens: 0, source: 'env default' }),
  resolveNativeCompactTokenLimitSetting = () => ({ tokens: 0, source: 'env default' }),
  getProviderRateLimits = async () => null,
  getSessionId = (session) => session?.runnerSessionId || session?.codexThreadId || null,
  getCodexThreadGoal = async () => null,
  getWorkspaceBinding = () => ({
    workspaceDir: null,
    source: 'unset',
    defaultWorkspaceDir: null,
    defaultSource: 'unset',
    defaultEnvKey: 'DEFAULT_WORKSPACE_DIR',
  }),
  readWorkspaceLock = () => ({ owner: null }),
  formatCliHealth = (health) => String(health?.error || 'unknown'),
  formatPermissionsLabel = () => '',
  formatLanguageLabel = (language) => String(language || ''),
  formatSecurityProfileDisplay = () => '',
  formatSecurityProfileLabel = (profile) => String(profile || ''),
  formatQueueLimit = (limit) => String(limit ?? ''),
  formatRuntimeLabel = () => 'idle',
  formatTimeoutLabel = () => 'off (no hard timeout)',
  describeCompactStrategy = (strategy) => String(strategy || ''),
  formatWorkspaceSessionPolicy = (provider) => `session policy unavailable for ${provider}`,
  formatWorkspaceSessionResetReason = (provider) => `reset because workspace policy unavailable for ${provider}`,
  humanAge = (ms) => `${ms}ms`,
  formatTokenValue = (value) => String(value ?? '-'),
  truncate = (text, max) => (String(text || '').length <= max ? String(text || '') : `${String(text || '').slice(0, Math.max(0, max - 3))}...`),
  estimateExtraInfoTokens = estimatePromptTokenCount,
  formatConfigCommandStatus = () => 'disabled',
  describeConfigPolicy = () => '(none)',
  formatSessionStatusLabel = () => '`(auto)`',
  formatProgressPlanSummary = () => '',
  formatCompletedStepsSummary = () => '',
  renderProcessContentLines = () => [],
  localizeProgressLines = (lines) => (Array.isArray(lines) ? lines : []),
  renderProgressPlanLines = () => [],
  renderCompletedStepsLines = () => [],
} = {}) {
  function formatProviderDefaultLabel(value, language = 'en') {
    const source = value?.source || 'provider';
    const model = String(value?.value || '').trim();

    if (!model) {
      return language === 'en' ? '_(provider default)_' : '_(provider 默认)_';
    }

    if (source === 'config.toml') {
      return `${model} _(config.toml)_`;
    }

    return language === 'en'
      ? `${model} _(provider default)_`
      : `${model} _(provider 默认)_`;
  }

  function formatResolvedSettingLabel(setting, fallback, language = 'en') {
    const fallbackText = String(fallback ?? '').trim();
    const value = String(setting?.value || '').trim() || fallbackText;
    const source = setting?.source || 'unknown';
    if (source === 'config.toml' || source === 'provider') {
      return formatProviderDefaultLabel({ value, source }, language);
    }
    if (language === 'en') {
      return `\`${value}\` (${formatSettingSourceLabel(source, language)})`;
    }
    return `\`${value}\`（${formatSettingSourceLabel(source, language)}）`;
  }

  function formatResolvedModelLabel(setting, fallback, language = 'en') {
    const fallbackText = String(fallback ?? '').trim();
    const value = String(setting?.value || '').trim() || fallbackText;
    const source = setting?.source || 'unknown';
    if (!value) {
      return language === 'en' ? 'unknown model' : '未知 model';
    }
    if (source === 'config.toml') {
      return `${value} _(config.toml)_`;
    }
    if (source === 'provider') {
      return value;
    }
    if (source === 'env default') {
      return language === 'en'
        ? `${value} _(env default)_`
        : `${value} _(环境默认)_`;
    }
    if (language === 'en') {
      return `\`${value}\` (${formatSettingSourceLabel(source, language)})`;
    }
    return `\`${value}\`（${formatSettingSourceLabel(source, language)}）`;
  }

  function formatResolvedCodexProfileLabel(setting, language = 'en') {
    if (!setting?.supported) return null;
    const base = language === 'en'
      ? `${formatCodexProfileLabel(setting.value, language)} (${formatSettingSourceLabel(setting.source, language)})`
      : `${formatCodexProfileLabel(setting.value, language)}（${formatSettingSourceLabel(setting.source, language)}）`;
    if (setting.valid !== false) return base;
    return language === 'en'
      ? `${base} [invalid: ${setting.error || 'unknown'}]`
      : `${base}【无效：${setting.error || '未知'}】`;
  }

  function formatProgressSettingValue(setting, fallback, language = 'en') {
    const value = String(setting?.value || '').trim() || fallback;
    const source = String(setting?.source || 'unknown').trim().toLowerCase();
    if (!value) return null;
    if (source === 'provider') {
      return language === 'en' ? 'provider default' : 'provider 默认';
    }
    return value;
  }

  function formatSettingSourceLabel(source, language = 'en') {
    if (source === 'session override') {
      return language === 'en' ? 'session override' : '频道覆盖';
    }
    if (source === 'parent channel') {
      return language === 'en' ? 'parent channel' : '父频道默认';
    }
    if (source === 'config.toml') {
      return 'config.toml';
    }
    if (source === 'session threshold fallback') {
      return language === 'en' ? 'threshold fallback' : '阈值回退';
    }
    if (source === 'env default') {
      return language === 'en' ? 'env default' : '环境默认';
    }
    if (source === 'provider unsupported') {
      return language === 'en' ? 'provider unsupported' : '当前 provider 不支持';
    }
    return source || (language === 'en' ? 'unknown' : '未知');
  }

  function formatFastModeLabel(enabled, language = 'en') {
    return enabled
      ? (language === 'en' ? 'on' : '开启')
      : (language === 'en' ? 'off' : '关闭');
  }

  function formatRuntimeModeLabel(mode, language = 'en') {
    return mode === 'long'
      ? (language === 'en' ? 'long (hot session)' : 'long（热会话）')
      : (language === 'en' ? 'normal (per request)' : 'normal（每轮启动）');
  }

  function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    if (Number.isInteger(number)) return String(number);
    return String(Math.round(number * 10) / 10);
  }

  function formatResetAt(epochSeconds, language = 'en') {
    const seconds = Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return language === 'en' ? 'unknown' : '未知';
    }
    const date = new Date(seconds * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function selectCodexRateLimitSnapshot(rateLimitReport) {
    if (!rateLimitReport || rateLimitReport.ok === false) return null;
    return rateLimitReport.rateLimitsByLimitId?.codex
      || rateLimitReport.rateLimits
      || null;
  }

  function formatRateLimitWindowLine(label, window, language = 'en') {
    if (!window) return null;
    const used = Number(window.usedPercent);
    const safeUsed = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null;
    const remaining = safeUsed === null ? '-' : formatPercent(Math.max(0, 100 - safeUsed));
    const usedText = safeUsed === null ? '-' : formatPercent(safeUsed);
    const resetAt = formatResetAt(window.resetsAt, language);
    if (language === 'en') {
      return `• Codex ${label} quota: ${remaining}% remaining (used ${usedText}%, resets ${resetAt})`;
    }
    return `• Codex ${label} 余量: ${remaining}%（已用 ${usedText}%，重置 ${resetAt}）`;
  }

  function formatCodexAccountLine(rateLimitReport, language = 'en') {
    const account = rateLimitReport?.account;
    if (!account) return null;
    const pieces = [];
    const name = String(account.name || '').trim();
    const email = String(account.email || '').trim();
    const authMode = String(account.authMode || '').trim();
    const planType = String(account.planType || '').trim();
    const orgTitle = String(account.organizationTitle || '').trim();

    if (name && email) {
      pieces.push(`${name} <${email}>`);
    } else if (email) {
      pieces.push(email);
    } else if (name) {
      pieces.push(name);
    }

    if (authMode) pieces.push(authMode);
    if (planType) pieces.push(planType);
    if (orgTitle) pieces.push(orgTitle);

    if (!pieces.length) return null;
    return language === 'en'
      ? `• Codex account: ${pieces.join(' · ')}`
      : `• Codex 账号: ${pieces.join(' · ')}`;
  }

  function formatCodexRateLimitLines(provider, rateLimitReport, language = 'en') {
    if (provider !== 'codex' || !rateLimitReport) return [];
    const accountLine = formatCodexAccountLine(rateLimitReport, language);
    if (rateLimitReport.ok === false) {
      const error = String(rateLimitReport.error || 'unknown error').replace(/\s+/g, ' ').trim();
      return [
        accountLine,
        language === 'en'
          ? `• Codex quota: unavailable (${error || 'unknown error'})`
          : `• Codex 额度: 暂不可用（${error || '未知错误'}）`,
      ].filter(Boolean);
    }

    const snapshot = selectCodexRateLimitSnapshot(rateLimitReport);
    if (!snapshot) {
      return [
        accountLine,
        language === 'en'
          ? '• Codex quota: unavailable (empty rate limit response)'
          : '• Codex 额度: 暂不可用（返回为空）',
      ].filter(Boolean);
    }

    const staleLine = rateLimitReport.stale
      ? (() => {
        const reason = String(rateLimitReport.staleReason || 'unknown error').replace(/\s+/g, ' ').trim();
        const age = humanAge(Number(rateLimitReport.cacheAgeMs) || 0, language);
        return language === 'en'
          ? `• Codex quota: live query unavailable (${reason}); showing cached snapshot from ${age} ago`
          : `• Codex 额度: 实时查询失败（${reason}），显示 ${age} 前缓存`;
      })()
      : null;

    return [
      accountLine,
      staleLine,
      formatRateLimitWindowLine('5h', snapshot.primary, language),
      formatRateLimitWindowLine('weekly', snapshot.secondary, language),
    ].filter(Boolean);
  }

  function formatCodexGoalLines(provider, goalReport, language = 'en') {
    if (provider !== 'codex' || !goalReport) return [];
    if (goalReport.ok === false) {
      if (goalReport.reason === 'missing_session') {
        return [
          language === 'en'
            ? '• Codex goal: unavailable (no bound Codex session; run or resume a session first)'
            : '• Codex goal: 暂不可查（当前频道还没有绑定 Codex session，先跑一轮或 resume 一个 session）',
        ];
      }
      const error = String(goalReport.error || 'unknown error').replace(/\s+/g, ' ').trim();
      return [
        language === 'en'
          ? `• Codex goal: unavailable (${error || 'unknown error'})`
          : `• Codex goal: 暂不可查（${error || '未知错误'}）`,
      ];
    }
    const goal = goalReport.goal;
    if (!goal) {
      return [
        language === 'en'
          ? '• Codex goal: not set'
          : '• Codex goal: 未设置',
      ];
    }
    const objective = String(goal.objective || '').replace(/\s+/g, ' ').trim() || (language === 'en' ? '(empty objective)' : '（空目标）');
    if (language === 'en') {
      return [
        `• Codex goal: ${formatCodexGoalStatus(goal.status, language)}; objective: ${objective}; budget: ${formatCodexGoalBudget(goal, language)}`,
        '• Codex goal run state: active goals continue when the runner is idle; use progress or queue to see actual execution',
      ];
    }
    return [
      `• Codex goal: ${formatCodexGoalStatus(goal.status, language)}；目标：${objective}；预算：${formatCodexGoalBudget(goal, language)}`,
      '• Codex goal 运行状态: active goal 会在 runner 空闲时续跑；看实际执行用 progress 或 queue',
    ];
  }

  function formatWorkspaceSourceLabel(source, language = 'zh') {
    const value = String(source || '').trim().toLowerCase();
    if (language === 'en') {
      if (value === 'thread override') return 'thread override';
      if (value === 'parent channel') return 'parent channel';
      if (value === 'provider default') return 'provider default';
      if (value === 'legacy fallback') return 'legacy fallback';
      return value || 'unknown';
    }
    if (value === 'thread override') return 'thread 覆盖';
    if (value === 'parent channel') return '父频道默认';
    if (value === 'provider default') return 'provider 默认';
    if (value === 'legacy fallback') return 'legacy 回退';
    return value || '未知';
  }

  function formatDefaultWorkspaceSourceLabel(source, envKey = null, language = 'zh') {
    const suffix = envKey ? `, ${envKey}` : '';
    const value = String(source || '').trim().toLowerCase();
    if (language === 'en') {
      if (value === 'provider-scoped env') return `provider-scoped env${suffix}`;
      if (value === 'shared env') return `shared env${suffix}`;
      if (value === 'unset') return `unset${suffix}`;
      return `${value || 'unknown'}${suffix}`;
    }
    if (value === 'provider-scoped env') return `provider 专属 env${suffix}`;
    if (value === 'shared env') return `共享 env${suffix}`;
    if (value === 'unset') return `未设置${suffix}`;
    return `${value || '未知'}${suffix}`;
  }

  function formatWorkspaceDefaultDisplay(binding, language = 'zh') {
    if (binding.defaultWorkspaceDir) {
      return `\`${binding.defaultWorkspaceDir}\` (${formatDefaultWorkspaceSourceLabel(binding.defaultSource, binding.defaultEnvKey, language)})`;
    }
    if (language === 'en') {
      return `(unset; ${binding.defaultEnvKey || 'DEFAULT_WORKSPACE_DIR'})`;
    }
    return `（未设置；${binding.defaultEnvKey || 'DEFAULT_WORKSPACE_DIR'}）`;
  }

  function formatNativeCompactValue(provider, nativeLimit, language = 'en') {
    const compact = getProviderCompactCapabilities(provider);
    if (compact.supportsNativeLimit) {
      if (language === 'en') {
        return `${nativeLimit.tokens} (${formatSettingSourceLabel(nativeLimit.source, language)})`;
      }
      return `${nativeLimit.tokens}（${formatSettingSourceLabel(nativeLimit.source, language)}）`;
    }
    if (compact.supportsNativeStrategy) {
      if (language === 'en') {
        return 'n/a (this provider does not expose a native limit override)';
      }
      return 'n/a（当前 provider 没有暴露 native limit 覆盖）';
    }
    if (language === 'en') {
      return 'n/a (native compact unavailable for this provider)';
    }
    return 'n/a（当前 provider 不支持 native compact）';
  }

  function formatNativeCompactSetting(provider, nativeLimit, language = 'en') {
    const compact = getProviderCompactCapabilities(provider);
    if (compact.supportsNativeLimit) {
      return {
        label: 'native compact limit',
        value: formatNativeCompactValue(provider, nativeLimit, language),
      };
    }
    if (compact.supportsNativeStrategy) {
      return language === 'en'
        ? {
          label: 'native compact',
          value: 'provider default behavior (no exposed limit override)',
        }
        : {
          label: 'native compact',
          value: 'provider 默认行为（不暴露 limit 覆盖）',
        };
    }
    return language === 'en'
      ? {
        label: 'native compact',
        value: 'unavailable for this provider',
      }
      : {
        label: 'native compact',
        value: '当前 provider 不支持',
      };
  }

  function getCompactCommandKeys(provider) {
    const compact = getProviderCompactCapabilities(provider);
    const keys = ['status', 'strategy', 'token_limit'];
    if (compact.supportsNativeLimit) keys.push('native_limit');
    keys.push('enabled', 'reset');
    return keys;
  }

  function getReasoningEffortLevels(provider) {
    const supported = new Set(getSupportedReasoningEffortLevels(provider));
    return REASONING_LEVEL_DISPLAY_ORDER.filter((level) => supported.has(level));
  }

  function getWorkspaceStatusLines(key, session, language = 'zh') {
    const binding = getWorkspaceBinding(session, key);
    if (language === 'en') {
      return [
        `• workspace: \`${binding.workspaceDir}\` (${formatWorkspaceSourceLabel(binding.source, language)})`,
        `• provider default workspace: ${formatWorkspaceDefaultDisplay(binding, language)}`,
      ];
    }
    return [
      `• workspace: \`${binding.workspaceDir}\`（${formatWorkspaceSourceLabel(binding.source, language)}）`,
      `• provider 默认 workspace: ${formatWorkspaceDefaultDisplay(binding, language)}`,
    ];
  }

  function formatBotModeLabel() {
    if (!botProvider) {
      return 'shared (provider can switch per channel)';
    }
    return `locked to \`${botProvider}\` (${getProviderDisplayName(botProvider)})`;
  }

  function formatForkParentLine(session, language = 'zh') {
    const parentSessionId = String(session?.forkedFromSessionId || '').trim();
    if (!parentSessionId) return null;
    const provider = String(session?.forkedFromProvider || 'codex').trim() || 'codex';
    const channelId = String(session?.forkedFromChannelId || '').trim();
    const channelPart = channelId ? ` <#${channelId}>` : '';
    if (language === 'en') {
      return `• forked from: ${getProviderDisplayName(provider)} \`${parentSessionId}\`${channelPart}`;
    }
    return `• fork 来源: ${getProviderDisplayName(provider)} \`${parentSessionId}\`${channelPart}`;
  }

  function formatExtraInfoStatusLine({ key, session, channel, language = 'zh' }) {
    const setting = resolveExtraInfoSetting(session);
    const rendered = buildExtraInfoPromptLine({
      setting,
      channel,
      key,
      messageId: '000000000000000000',
    });
    const tokens = estimateExtraInfoTokens(rendered);
    const enabledSource = formatSettingSourceLabel(setting.enabledSource || 'env default', language);
    const textSource = formatSettingSourceLabel(setting.textSource || 'env default', language);

    if (language === 'en') {
      return setting.enabled
        ? `• extra info: on (${enabledSource}), ~${tokens} tokens, text ${textSource}`
        : `• extra info: off (${enabledSource}), 0 tokens`;
    }
    return setting.enabled
      ? `• 额外信息：on（${enabledSource}），约 ${tokens} tokens，内容 ${textSource}`
      : `• 额外信息：off（${enabledSource}），0 tokens`;
  }

  function formatStatusReport(key, session, channel = null, { rateLimitReport = null, goalReport = null } = {}) {
    const language = getSessionLanguage(session);
    const lang = normalizeUiLanguage(language);
    const provider = getSessionProvider(session);
    const defaults = getProviderDefaults(provider);
    const modelSetting = resolveModelSetting(session);
    const codexProfileSetting = resolveCodexProfileSetting(session);
    const effortSetting = resolveReasoningEffortSetting(session);
    const cliHealth = getCliHealth(provider);
    const security = resolveSecurityContext(channel, session);
    const fastMode = resolveFastModeSetting(session);
    const runtimeMode = resolveRuntimeModeSetting(session);
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const compactThreshold = resolveCompactThresholdSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const replyDelivery = resolveReplyDeliverySetting(session);
    const extraInfoLine = formatExtraInfoStatusLine({ key, session, channel, language: lang });
    const modeDesc = session?.mode === 'dangerous'
      ? (lang === 'en' ? 'dangerous (no sandbox, full access)' : 'dangerous（无沙盒，全权限）')
      : (lang === 'en' ? 'safe (sandboxed, no network)' : 'safe（沙盒隔离，无网络）');
    const workspaceLines = getWorkspaceStatusLines(key, session, lang);
    const defaultModel = formatResolvedModelLabel(modelSetting, defaults.model, lang);
    const defaultEffort = formatResolvedSettingLabel(effortSetting, defaults.effort, lang);
    const runtimeSummary = formatProviderRuntimeSummary(provider, lang);
    const sessionFieldLabel = formatProviderSessionTerm(provider, lang);
    const nativeCompact = formatNativeCompactSetting(provider, nativeLimit, lang);
    const rateLimitLines = formatCodexRateLimitLines(provider, rateLimitReport, lang);
    const goalLines = formatCodexGoalLines(provider, goalReport, lang);

    if (lang === 'en') {
      return [
        '🧭 **Current Status**',
        `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
        runtimeSummary ? `• runtime profile: ${runtimeSummary}` : null,
        provider === 'codex' ? `• codex profile: ${formatResolvedCodexProfileLabel(codexProfileSetting, lang)}` : null,
        `• model: ${defaultModel}`,
        `• mode: ${modeDesc}`,
        `• effort: ${defaultEffort}`,
        fastMode.supported ? `• fast mode: ${formatFastModeLabel(fastMode.enabled, lang)} (${formatSettingSourceLabel(fastMode.source, lang)})` : null,
        runtimeMode.supported ? `• Claude runtime: ${formatRuntimeModeLabel(runtimeMode.mode, lang)} (${formatSettingSourceLabel(runtimeMode.source, lang)})` : null,
        ...workspaceLines,
        `• compact strategy: ${describeCompactStrategy(compactSetting.strategy, lang)} (${formatSettingSourceLabel(compactSetting.source, lang)})`,
        `• reply delivery: ${formatReplyDeliveryModeLabel(replyDelivery.mode, lang)} (${formatSettingSourceLabel(replyDelivery.source, lang)})`,
        extraInfoLine,
        `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'} (${formatSettingSourceLabel(compactEnabled.source, lang)})`,
        `• compact token limit: ${compactThreshold.tokens} (${formatSettingSourceLabel(compactThreshold.source, lang)})`,
        `• ${nativeCompact.label}: ${nativeCompact.value}`,
        `• ui language: ${formatLanguageLabel(language)}`,
        `• permissions: ${formatPermissionsLabel(session, lang)}`,
        `• cli: ${formatCliHealth(cliHealth, lang)}`,
        ...rateLimitLines,
        ...goalLines,
        `• ${sessionFieldLabel}: ${formatSessionStatusLabel(session)}`,
        formatForkParentLine(session, lang),
        `• last run input tokens: ${formatTokenValue(session?.lastInputTokens)}`,
        `• security profile: ${formatSecurityProfileDisplay(security, lang)}`,
      ].filter(Boolean).join('\n');
    }

    return [
      '🧭 **当前状态**',
      `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
      runtimeSummary ? `• runtime 能力面: ${runtimeSummary}` : null,
      provider === 'codex' ? `• Codex profile：${formatResolvedCodexProfileLabel(codexProfileSetting, lang)}` : null,
      `• model: ${defaultModel}`,
      `• mode: ${modeDesc}`,
      `• effort: ${defaultEffort}`,
      fastMode.supported ? `• fast mode: ${formatFastModeLabel(fastMode.enabled, lang)}（${formatSettingSourceLabel(fastMode.source, lang)}）` : null,
      runtimeMode.supported ? `• Claude runtime: ${formatRuntimeModeLabel(runtimeMode.mode, lang)}（${formatSettingSourceLabel(runtimeMode.source, lang)}）` : null,
      ...workspaceLines,
      `• compact strategy: ${describeCompactStrategy(compactSetting.strategy, lang)}（${formatSettingSourceLabel(compactSetting.source, lang)}）`,
      `• 回复方式：${formatReplyDeliveryModeLabel(replyDelivery.mode, lang)}（${formatSettingSourceLabel(replyDelivery.source, lang)}）`,
      extraInfoLine,
      `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'}（${formatSettingSourceLabel(compactEnabled.source, lang)}）`,
      `• compact token limit: ${compactThreshold.tokens}（${formatSettingSourceLabel(compactThreshold.source, lang)}）`,
      `• ${nativeCompact.label}: ${nativeCompact.value}`,
      `• 界面语言: ${formatLanguageLabel(language)}`,
      `• 权限: ${formatPermissionsLabel(session, lang)}`,
      `• CLI: ${formatCliHealth(cliHealth, lang)}`,
      ...rateLimitLines,
      ...goalLines,
      `• ${sessionFieldLabel}: ${formatSessionStatusLabel(session)}`,
      formatForkParentLine(session, lang),
      `• 上一轮输入 tokens: ${formatTokenValue(session?.lastInputTokens)}`,
      `• security profile: ${formatSecurityProfileDisplay(security, lang)}`,
    ].filter(Boolean).join('\n');
  }

  async function formatStatusReportWithLiveData(key, session, channel = null) {
    const provider = getSessionProvider(session);
    let rateLimitReport = null;
    let goalReport = null;
    if (provider === 'codex') {
      const threadId = String(getSessionId(session) || '').trim();
      const [rateLimitResult, goalResult] = await Promise.allSettled([
        getProviderRateLimits(provider),
        threadId ? getCodexThreadGoal({ threadId }) : Promise.resolve({ missingSession: true }),
      ]);
      if (rateLimitResult.status === 'fulfilled') {
        rateLimitReport = rateLimitResult.value;
      } else {
        rateLimitReport = {
          ok: false,
          error: String(rateLimitResult.reason?.message || rateLimitResult.reason || 'unknown error'),
        };
      }
      if (!threadId) {
        goalReport = { ok: false, reason: 'missing_session' };
      } else if (goalResult.status === 'fulfilled') {
        goalReport = { ok: true, goal: goalResult.value?.goal || null };
      } else {
        goalReport = {
          ok: false,
          error: String(goalResult.reason?.message || goalResult.reason || 'unknown error'),
        };
      }
    }
    return formatStatusReport(key, session, channel, { rateLimitReport, goalReport });
  }

  function formatQueueReport(key, session = null, channel = null) {
    const runtime = getRuntimeSnapshot(key);
    const security = resolveSecurityContext(channel, session);
    const planSummary = formatProgressPlanSummary(runtime.progressPlan);
    const completedSummary = formatCompletedStepsSummary(runtime.completedSteps, {
      planState: runtime.progressPlan,
      latestStep: runtime.progressText,
      maxSteps: 3,
    });
    const processLines = renderProcessContentLines(runtime.recentActivities, 'en', progressProcessLines);
    return [
      '📮 **任务队列状态**',
      `• runtime: ${formatRuntimeLabel(runtime)}`,
      `• queued prompts: ${runtime.queued}`,
      `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
      runtime.progressText ? `• latest activity: ${runtime.progressText}` : null,
      ...processLines,
      planSummary ? `• plan: ${planSummary}` : null,
      completedSummary ? `• completed milestones: ${completedSummary}` : null,
      runtime.progressAgoMs !== null ? `• progress updated: ${humanAge(runtime.progressAgoMs)} ago` : null,
      runtime.messageId ? `• active message id: \`${runtime.messageId}\`` : null,
      runtime.progressMessageId ? `• progress message id: \`${runtime.progressMessageId}\`` : null,
    ].filter(Boolean).join('\n');
  }

  function formatProgressReport(key, session = null, channel = null) {
    const runtime = getRuntimeSnapshot(key);
    const security = resolveSecurityContext(channel, session);
    const language = getSessionLanguage(session);
    const lang = normalizeUiLanguage(language);
    const provider = getSessionProvider(session);
    const defaults = getProviderDefaults(provider);
    const modelSetting = resolveModelSetting(session);
    const effortSetting = resolveReasoningEffortSetting(session);
    const effortValue = getReasoningEffortLevels(provider).length
      ? formatProgressSettingValue(effortSetting, defaults.effort, lang)
      : null;
    const defaultModel = formatResolvedModelLabel(modelSetting, defaults.model, lang);
    if (!runtime.running) {
      if (lang === 'en') {
        return [
          'ℹ️ No running task in this channel.',
          `• queued prompts: ${runtime.queued}`,
          `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
          `• hint: After sending a task, use \`${slashRef('status')}\` to check status.`,
        ].join('\n');
      }
      return [
        'ℹ️ 当前没有运行中的任务。',
        `• 排队任务: ${runtime.queued}`,
        `• 队列上限: ${formatQueueLimit(security.maxQueuePerChannel)}`,
        `• 提示: 发送新任务后可用 \`${slashRef('status')}\` 查看状态。`,
      ].join('\n');
    }
    const processLines = renderProcessContentLines(runtime.recentActivities, lang, progressProcessLines);
    const planLines = localizeProgressLines(renderProgressPlanLines(runtime.progressPlan, progressPlanMaxLines), lang);
    const completedLines = localizeProgressLines(renderCompletedStepsLines(runtime.completedSteps, {
      planState: runtime.progressPlan,
      latestStep: runtime.progressText,
      maxSteps: progressDoneStepsMax,
    }), lang);
    if (lang === 'en') {
      return [
        '🧵 **Task Progress**',
        `• runtime: ${formatRuntimeLabel(runtime, lang)}`,
        `• model: ${defaultModel}`,
        effortValue ? `• effort: ${effortValue}` : null,
        resolveFastModeSetting(session)?.supported
          ? `• fast mode: ${formatFastModeLabel(resolveFastModeSetting(session).enabled, lang)} (${formatSettingSourceLabel(resolveFastModeSetting(session).source, lang)})`
          : null,
        `• event count: ${runtime.progressEvents}`,
        runtime.progressText ? `• latest activity: ${runtime.progressText}` : null,
        ...processLines,
        ...planLines,
        ...completedLines,
        runtime.progressAgoMs !== null ? `• last update: ${humanAge(runtime.progressAgoMs)} ago` : null,
        runtime.messageId ? `• active message id: \`${runtime.messageId}\`` : null,
        runtime.progressMessageId ? `• progress message id: \`${runtime.progressMessageId}\`` : null,
        `• queued prompts: ${runtime.queued}`,
        `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
        '• hint: Use `!c` to interrupt.',
      ].filter(Boolean).join('\n');
    }
    return [
      '🧵 **任务进度**',
      `• 运行状态: ${formatRuntimeLabel(runtime, lang)}`,
      `• model: ${defaultModel}`,
      effortValue ? `• effort: ${effortValue}` : null,
      resolveFastModeSetting(session)?.supported
        ? `• fast mode: ${formatFastModeLabel(resolveFastModeSetting(session).enabled, lang)}（${formatSettingSourceLabel(resolveFastModeSetting(session).source, lang)}）`
        : null,
      `• 事件数: ${runtime.progressEvents}`,
      runtime.progressText ? `• 最新活动: ${runtime.progressText}` : null,
      ...processLines,
      ...planLines,
      ...completedLines,
      runtime.progressAgoMs !== null ? `• 上次更新: ${humanAge(runtime.progressAgoMs)}前` : null,
      runtime.messageId ? `• 运行消息 ID: \`${runtime.messageId}\`` : null,
      runtime.progressMessageId ? `• 进度消息 ID: \`${runtime.progressMessageId}\`` : null,
      `• 排队任务: ${runtime.queued}`,
      `• 队列上限: ${formatQueueLimit(security.maxQueuePerChannel)}`,
      '• 提示: 可用 `!c` 中断。',
    ].filter(Boolean).join('\n');
  }

  function formatCancelReport(outcome) {
    if (!outcome.cancelledRunning && outcome.clearedQueued === 0) {
      return 'ℹ️ 当前没有运行中或排队任务。';
    }
    return [
      '🛑 已处理取消请求',
      `• running task interrupted: ${outcome.cancelledRunning ? 'yes' : 'no'}`,
      outcome.pid ? `• pid: ${outcome.pid}` : null,
      `• cleared queued prompts: ${outcome.clearedQueued}`,
    ].filter(Boolean).join('\n');
  }

  function formatDoctorReport(key, session = null, channel = null) {
    const runtime = getRuntimeSnapshot(key);
    const provider = getSessionProvider(session);
    const cliHealth = getCliHealth(provider);
    const security = resolveSecurityContext(channel, session);
    const timeoutSetting = resolveTimeoutSetting(session);
    const fastMode = resolveFastModeSetting(session);
    const runtimeMode = resolveRuntimeModeSetting(session);
    const codexProfileSetting = resolveCodexProfileSetting(session);
    const securitySetting = getEffectiveSecurityProfile(session);
    const compactSetting = resolveCompactStrategySetting(session);
    const compactEnabled = resolveCompactEnabledSetting(session);
    const compactThreshold = resolveCompactThresholdSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const workspaceBinding = getWorkspaceBinding(session, key);
    const workspaceLock = workspaceBinding.workspaceDir ? readWorkspaceLock(workspaceBinding.workspaceDir) : { owner: null };
    const rawConfigStatus = providerSupportsRawConfigOverrides(provider)
      ? formatConfigCommandStatus()
      : `${formatConfigCommandStatus()} (provider unsupported)`;
    const sessionStoreSurface = formatProviderSessionStoreSurface(provider);
    const resumeSurface = formatProviderResumeSurface(provider);
    const nativeCompactSurface = formatProviderNativeCompactSurface(provider);
    const rawConfigSurface = formatProviderRawConfigSurface(provider);
    const reasoningSurface = formatProviderReasoningSurface(provider);
    const nativeCompact = formatNativeCompactSetting(provider, nativeLimit);
    return [
      '🩺 **Bot Doctor**',
      `• bot mode: ${formatBotModeLabel()}`,
      `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
      `• cli: ${formatCliHealth(cliHealth)}`,
      `• workspace: \`${workspaceBinding.workspaceDir}\` (${workspaceBinding.source})`,
      `• workspace serialization: ${workspaceLock.owner ? 'busy' : 'idle'}`,
      `• runtime: ${formatRuntimeLabel(runtime)}`,
      `• queued prompts: ${runtime.queued}`,
      sessionStoreSurface ? `• runtime session store: ${sessionStoreSurface}` : null,
      resumeSurface ? `• runtime resume surface: ${resumeSurface}` : null,
      nativeCompactSurface ? `• runtime native compact: ${nativeCompactSurface}` : null,
      rawConfigSurface ? `• runtime raw config: ${rawConfigSurface}` : null,
      reasoningSurface ? `• runtime reasoning: ${reasoningSurface}` : null,
      provider === 'codex' ? `• codex profile: ${formatResolvedCodexProfileLabel(codexProfileSetting)}` : null,
      `• security profile: ${formatSecurityProfileDisplay(security)}`,
      `• profile setting: ${formatSecurityProfileLabel(securitySetting.profile)} (${securitySetting.source})`,
      `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
      `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
      `• !config: ${rawConfigStatus}`,
      `• config allowlist: ${describeConfigPolicy()}`,
      `• ALLOWED_CHANNEL_IDS: ${allowedChannelIds ? `${allowedChannelIds.size} configured` : '(all channels)'}`,
      `• ALLOWED_USER_IDS: ${allowedUserIds ? `${allowedUserIds.size} configured` : '(all users)'}`,
      `• runner timeout: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`,
      fastMode.supported ? `• fast mode: ${formatFastModeLabel(fastMode.enabled)} (${fastMode.source})` : null,
      runtimeMode.supported ? `• Claude runtime: ${formatRuntimeModeLabel(runtimeMode.mode)} (${runtimeMode.source})` : null,
      `• compact strategy: ${describeCompactStrategy(compactSetting.strategy)} (${compactSetting.source})`,
      `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'} (${compactEnabled.source})`,
      `• compact token limit: ${compactThreshold.tokens} (${compactThreshold.source})`,
      `• ${nativeCompact.label}: ${nativeCompact.value}`,
    ].filter(Boolean).join('\n');
  }

  function formatCompactStrategyConfigHelp(language, provider = 'codex') {
    const compact = getProviderCompactCapabilities(provider);
    const strategyExample = compact.supportsNativeStrategy ? 'native' : 'hard';
    const commandKeys = getCompactCommandKeys(provider).join('|');
    const examples = [
      `\`!compact strategy ${strategyExample}\``,
      '\`!compact token_limit 272000\`',
      '\`!compact enabled on\`',
    ];
    if (compact.supportsNativeLimit) {
      examples.splice(2, 0, '\`!compact native_limit 320000\`');
    }
    if (language === 'en') {
      return [
        `Usage: \`!compact <${commandKeys}> [value]\``,
        `Slash: \`${slashRef('compact')} key:<...> value:<...>\``,
        `Examples: ${examples.join(', ')}`,
        compact.supportsNativeLimit
          ? 'Note: this provider supports provider-native compaction. `hard` stays bot-managed, `native_limit` overrides the native token limit, and native runs continue automatically.'
          : compact.supportsNativeStrategy
            ? 'Note: this provider supports provider-native compaction. `hard` stays bot-managed, `native_limit` is not exposed, and native runs continue automatically.'
            : 'Note: this provider only supports bot-managed hard compaction.',
      ].join('\n');
    }
    return [
      `用法：\`!compact <${commandKeys}> [value]\``,
      `Slash：\`${slashRef('compact')} key:<...> value:<...>\``,
      `示例：${examples.join('、')}`,
      compact.supportsNativeLimit
        ? '说明：当前 provider 支持原生 native 压缩；`hard` 仍由 bot 统一管理，`native_limit` 用来覆盖原生 token limit，native 任务会自动续跑。'
        : compact.supportsNativeStrategy
          ? '说明：当前 provider 支持原生 native 压缩；`hard` 仍由 bot 统一管理，但不暴露 `native_limit`，native 任务会自动续跑。'
          : '说明：当前 provider 仅支持 bot 侧的 hard 压缩。',
    ].join('\n');
  }

  function formatCompactConfigReport(language, session, changed = false) {
    const provider = getSessionProvider(session);
    const compact = getProviderCompactCapabilities(provider);
    const strategy = resolveCompactStrategySetting(session);
    const enabled = resolveCompactEnabledSetting(session);
    const threshold = resolveCompactThresholdSetting(session);
    const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
    const nativeCompact = formatNativeCompactSetting(provider, nativeLimit, language);

    if (language === 'en') {
      return [
        changed ? '✅ Compact config updated' : 'ℹ️ Compact config',
        `• strategy: ${describeCompactStrategy(strategy.strategy, language)} (${formatSettingSourceLabel(strategy.source, language)})`,
        `• enabled: ${enabled.enabled ? 'on' : 'off'} (${formatSettingSourceLabel(enabled.source, language)})`,
        `• token limit: ${threshold.tokens} (${formatSettingSourceLabel(threshold.source, language)})`,
        `• ${nativeCompact.label}: ${nativeCompact.value}`,
        compact.supportsNativeLimit
          ? '• note: native compaction is handled inside the provider CLI and continues automatically; if it rolls to a new session, the bot will disclose the new session id.'
          : compact.supportsNativeStrategy
            ? '• note: native compaction is still handled inside the provider CLI and continues automatically; if it rolls to a new session, the bot will disclose the new session id.'
            : '• note: this provider only uses bot-managed hard compaction; native compaction is unavailable.',
      ].join('\n');
    }
    return [
      changed ? '✅ compact 配置已更新' : 'ℹ️ 当前 compact 配置',
      `• strategy: ${describeCompactStrategy(strategy.strategy, language)}（${formatSettingSourceLabel(strategy.source, language)}）`,
      `• enabled: ${enabled.enabled ? 'on' : 'off'}（${formatSettingSourceLabel(enabled.source, language)}）`,
      `• token limit: ${threshold.tokens}（${formatSettingSourceLabel(threshold.source, language)}）`,
      `• ${nativeCompact.label}: ${nativeCompact.value}`,
      compact.supportsNativeLimit
        ? '• 说明：native 压缩发生在 provider CLI 内部并自动续跑；如果切到新的 session，bot 会明确显示新的 session id。'
        : compact.supportsNativeStrategy
          ? '• 说明：native 压缩仍发生在 provider CLI 内部并自动续跑；如果切到新的 session，bot 会明确显示新的 session id。'
          : '• 说明：当前 provider 只使用 bot 侧的 hard 压缩，不支持 native 压缩。',
    ].join('\n');
  }

  function formatExtraInfoConfigHelp(language = 'zh') {
    if (language === 'en') {
      return [
        'Usage: `!extra_info <status|on|off|text|default> [value]`',
        `Slash: \`${slashRef('extra_info')} key:<...> value:<...>\``,
        'Placeholders: `{thread}`, `{parent}`, `{msg}`',
      ].join('\n');
    }
    return [
      '用法：`!extra_info <status|on|off|text|default> [value]`',
      `Slash：\`${slashRef('extra_info')} key:<...> value:<...>\``,
      '占位符：`{thread}`、`{parent}`、`{msg}`',
    ].join('\n');
  }

  function formatExtraInfoConfigReport(language, session, key, channel = null, changed = false) {
    const setting = resolveExtraInfoSetting(session);
    const rendered = buildExtraInfoPromptLine({
      setting,
      channel,
      key,
      messageId: '000000000000000000',
    });
    const tokens = estimateExtraInfoTokens(rendered);
    const enabledSource = formatSettingSourceLabel(setting.enabledSource || 'env default', language);
    const textSource = formatSettingSourceLabel(setting.textSource || 'env default', language);
    const preview = rendered ? truncate(rendered, 300) : '';

    if (language === 'en') {
      return [
        changed ? '✅ Extra info updated' : 'ℹ️ Extra info',
        `• enabled: ${setting.enabled ? 'on' : 'off'} (${enabledSource})`,
        `• tokens: ~${setting.enabled ? tokens : 0}`,
        `• text source: ${textSource}`,
        setting.enabled ? `• rendered text: \`${preview}\`` : null,
      ].filter(Boolean).join('\n');
    }
    return [
      changed ? '✅ 额外信息已更新' : 'ℹ️ 当前额外信息',
      `• 开关：${setting.enabled ? 'on' : 'off'}（${enabledSource}）`,
      `• tokens：约 ${setting.enabled ? tokens : 0}`,
      `• 内容来源：${textSource}`,
      setting.enabled ? `• 渲染结果：\`${preview}\`` : null,
    ].filter(Boolean).join('\n');
  }

  function formatReasoningEffortHelp(language, provider = 'codex') {
    const levels = getReasoningEffortLevels(provider);
    if (!levels.length) {
      return language === 'en'
        ? `Current provider ${getProviderDisplayName(provider)} does not expose reasoning effort. Use the provider default behavior.`
        : `当前 provider ${getProviderDisplayName(provider)} 没有暴露 reasoning effort，请使用 provider 默认行为。`;
    }
    const usage = [...levels, 'default'].join('|');
    return language === 'en'
      ? `Usage: \`!effort <${usage}>\``
      : `用法：\`!effort <${usage}>\``;
  }

  function formatFastModeConfigHelp(language, provider = 'codex') {
    if (provider !== 'codex') {
      return language === 'en'
        ? `Current provider ${getProviderDisplayName(provider)} does not expose Fast mode.`
        : `当前 provider ${getProviderDisplayName(provider)} 不支持 Fast mode。`;
    }
    if (language === 'en') {
      return [
        'Usage: `!fast <on|off|status|default>`',
        `Slash: \`${slashRef('fast')} <on|off|status|default>\``,
        'Default: `default` follows `~/.codex/config.toml`; when `[features].fast_mode` is unset, it stays on.',
        'Note: Fast mode is a Codex feature intended for the GPT-5.4 path and may use plan quota faster.',
      ].join('\n');
    }
    return [
      '用法：`!fast <on|off|status|default>`',
      `Slash：\`${slashRef('fast')} <on|off|status|default>\``,
      '默认：`default` 会跟随 `~/.codex/config.toml`；如果没显式写 `[features].fast_mode = false`，就保持开启。',
      '说明：Fast mode 是 Codex 的能力，主要对应 GPT-5.4 路径，可能会更快消耗套餐额度。',
    ].join('\n');
  }

  function formatFastModeConfigReport(language, provider, fastModeSetting, changed = false) {
    if (!fastModeSetting?.supported) {
      return language === 'en'
        ? `⚠️ Current provider ${getProviderDisplayName(provider)} does not support Fast mode.`
        : `⚠️ 当前 provider ${getProviderDisplayName(provider)} 不支持 Fast mode。`;
    }
    if (language === 'en') {
      return [
        changed ? '✅ Fast mode updated' : 'ℹ️ Fast mode',
        `• status: ${formatFastModeLabel(fastModeSetting.enabled, language)} (${formatSettingSourceLabel(fastModeSetting.source, language)})`,
        '• note: when the effective setting is off, the bot explicitly passes `features.fast_mode=false`; channel and parent overrides are also passed through to mirror Codex `/fast`.',
      ].join('\n');
    }
    return [
      changed ? '✅ Fast mode 已更新' : 'ℹ️ 当前 Fast mode',
      `• 状态：${formatFastModeLabel(fastModeSetting.enabled, language)}（${formatSettingSourceLabel(fastModeSetting.source, language)}）`,
      '• 说明：只要当前生效值是关闭，bot 就会在非交互 `codex exec` 中显式透传 `features.fast_mode=false`；频道和父频道覆盖也会继续透传，对齐 Codex 里的 `/fast` 行为。',
    ].join('\n');
  }

  function formatRuntimeModeConfigHelp(language, provider = 'claude') {
    if (provider !== 'claude') {
      return language === 'en'
        ? `Current provider ${getProviderDisplayName(provider)} does not support Claude runtime mode.`
        : `当前 provider ${getProviderDisplayName(provider)} 不支持 Claude runtime mode。`;
    }
    if (language === 'en') {
      return [
        'Usage: `!runtime <normal|long|status|default>`',
        `Slash: \`${slashRef('runtime')} <normal|long|status|default>\``,
        '`normal` keeps the old one-process-per-request path. `long` keeps one hot Claude process per thread and releases it after the idle window.',
      ].join('\n');
    }
    return [
      '用法：`!runtime <normal|long|status|default>`',
      `Slash：\`${slashRef('runtime')} <normal|long|status|default>\``,
      '`normal` 保留原来的每轮启动方式。`long` 会让每个 thread 保留一个热 Claude 进程，空闲到期后释放。',
    ].join('\n');
  }

  function formatRuntimeModeConfigReport(language, provider, runtimeModeSetting, changed = false) {
    if (!runtimeModeSetting?.supported) {
      return language === 'en'
        ? `⚠️ Current provider ${getProviderDisplayName(provider)} does not support Claude runtime mode.`
        : `⚠️ 当前 provider ${getProviderDisplayName(provider)} 不支持 Claude runtime mode。`;
    }
    const label = `${formatRuntimeModeLabel(runtimeModeSetting.mode, language)} (${formatSettingSourceLabel(runtimeModeSetting.source, language)})`;
    if (language === 'en') {
      return [
        changed ? '✅ Claude runtime updated' : 'ℹ️ Claude runtime',
        `• status: ${label}`,
        '• note: switching mode keeps the bound session id; any hot process in this thread is restarted on the next run.',
      ].join('\n');
    }
    return [
      changed ? '✅ Claude runtime 已更新' : 'ℹ️ 当前 Claude runtime',
      `• 状态：${label}`,
      '• 说明：切换方式不会清掉绑定的 session id；当前 thread 的热进程会在下次运行时按新配置重启。',
    ].join('\n');
  }

  function formatLanguageConfigHelp(language) {
    if (language === 'en') {
      return [
        'Usage: `!lang <zh|en>`',
        `Current: ${formatLanguageLabel(language)}`,
        'Examples: `!lang en`, `!lang zh`',
      ].join('\n');
    }
    return [
      '用法：`!lang <zh|en>`',
      `当前：${formatLanguageLabel(language)}`,
      '示例：`!lang en`、`!lang zh`',
    ].join('\n');
  }

  function formatLanguageConfigReport(language, changed) {
    if (language === 'en') {
      return changed
        ? `✅ Message language set to ${formatLanguageLabel(language)}`
        : `ℹ️ Message language is ${formatLanguageLabel(language)}`;
    }
    return changed
      ? `✅ 消息提示语言已设置为 ${formatLanguageLabel(language)}`
      : `ℹ️ 当前消息提示语言为 ${formatLanguageLabel(language)}`;
  }

  function formatProfileConfigHelp(language) {
    if (language === 'en') {
      return [
        'Usage: `!profile <auto|solo|team|public|status>`',
        `Slash: \`${slashRef('profile')} <auto|solo|team|public|status>\``,
      ].join('\n');
    }
    return [
      '用法：`!profile <auto|solo|team|public|status>`',
      `Slash：\`${slashRef('profile')} <auto|solo|team|public|status>\``,
    ].join('\n');
  }

  function formatProfileConfigReport(language, profile, changed) {
    const label = formatSecurityProfileLabel(profile);
    if (language === 'en') {
      return changed
        ? `✅ Security profile set to ${label}`
        : `ℹ️ Security profile is ${label}`;
    }
    return changed
      ? `✅ 安全策略 profile 已设置为 ${label}`
      : `ℹ️ 当前安全策略 profile 为 ${label}`;
  }

  function formatTimeoutConfigHelp(language) {
    if (language === 'en') {
      return [
        'Usage: `!timeout <ms|off|status>`',
        `Slash: \`${slashRef('timeout')} <ms|off|status>\``,
        'Examples: `!timeout 60000`, `!timeout off`, `!timeout status`',
      ].join('\n');
    }
    return [
      '用法：`!timeout <毫秒|off|status>`',
      `Slash：\`${slashRef('timeout')} <毫秒|off|status>\``,
      '示例：`!timeout 60000`、`!timeout off`、`!timeout status`',
    ].join('\n');
  }

  function formatTimeoutConfigReport(language, timeoutSetting, changed) {
    const label = `${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`;
    if (language === 'en') {
      return changed
        ? `✅ Runner timeout set to ${label}`
        : `ℹ️ Runner timeout is ${label}`;
    }
    return changed
      ? `✅ Runner 超时已设置为 ${label}`
      : `ℹ️ 当前 Runner 超时为 ${label}`;
  }

  function formatHelpReport(session) {
    const language = getSessionLanguage(session);
    const provider = getSessionProvider(session);
    const compact = getProviderCompactCapabilities(provider);
    const reasoningLevels = getReasoningEffortLevels(provider);
    const resumeAlias = getProviderCommandAlias(provider, 'resume');
    const sessionsAlias = getProviderCommandAlias(provider, 'sessions');
    if (language === 'en') {
      return [
        '**📋 Commands**',
        '',
        botProvider
          ? `Bot mode: locked to ${getProviderDisplayName(botProvider)}`
          : 'Bot mode: shared (use `!provider` / `/provider` to switch per channel)',
        '',
        '**Session**',
        '• `!status` — current config snapshot',
        `• \`${slashRef('settings')}\` — interactive channel settings panel`,
        '• `!queue` — queue status in current channel',
        '• `!doctor` — runtime + security diagnostics',
        `• \`${slashRef('onboarding')}\` — interactive onboarding`,
        '• `!onboarding` — onboarding text checklist',
        `• \`${slashRef('onboarding_config')} <on|off|status>\` / \`!onboarding <on|off|status>\` — onboarding switch`,
        `• \`${slashRef('language')} <中文|English>\` / \`!lang <zh|en>\` — message language`,
        `• \`${slashRef('profile')} <auto|solo|team|public|status>\` / \`!profile <...|status>\` — channel security profile`,
        `• \`${slashRef('timeout')} <ms|off|status>\` / \`!timeout <...>\` — runner timeout`,
        `• \`${slashRef('progress')}\` / \`!progress\` — current run progress`,
        `• \`${slashRef('cancel')}\` / \`${slashRef('abort')}\` / \`!cancel\` / \`!c\` / \`!abort\` / \`!stop\` — stop running task and clear queue`,
        `• \`${slashRef('new')}\` / \`!new\` — switch to a fresh session but keep channel settings`,
        `• \`${slashRef('reset')}\` / \`!reset\` — clear session context and extra config overrides`,
        '• `!resume <session_id>` — bind existing provider session',
        resumeAlias ? `• current provider alias: \`!${resumeAlias} <session_id>\`` : null,
        '• `!sessions` — list recent provider sessions from the native runtime store',
        sessionsAlias ? `• current provider alias: \`!${sessionsAlias}\`` : null,
        provider === 'codex' ? `• \`${slashRef('fork')} [session_id] [prompt]\` / \`!fork [session_id] [prompt]\` — create a native Codex fork in a new Discord thread` : null,
        provider === 'codex' ? `• \`${slashRef('goal')} action:<status|set|pause|resume|done|clear|budget>\` / \`!goal <status|objective|pause|resume|done|clear>\` — manage the current Codex goal; active goals continue when the runner is idle` : null,
        !botProvider ? '• `!provider <codex|claude|gemini|status>` — switch provider for current channel' : null,
        '',
        '**Workspace**',
        '• `!setdir <path|browse|default|status>` — set or clear current thread workspace',
        '• `!cd <...>` — alias of `!setdir`',
        '• `!setdefaultdir <path|browse|clear|status>` — set provider default workspace',
        `• \`${slashRef('setdir')} path:<...>\` / \`${slashRef('setdefaultdir')} path:<...>\` — workspace controls`,
        '',
        '**Model & Runtime**',
        `• \`${slashRef('model')}\` — choose model and effort from a compact panel`,
        reasoningLevels.length
          ? `• \`${slashRef('model')} name:<name|default> effort:<${[...reasoningLevels, 'default'].join('|')}>\` / \`!model <name|default>\` — set model or effort directly`
          : `• \`${slashRef('model')} name:<name|default>\` / \`!model <name|default>\` — set model directly`,
        provider === 'codex' ? `• \`${slashRef('fast')} <on|off|status|default>\` / \`!fast <...>\` — toggle Codex Fast mode for this channel` : null,
        provider === 'claude' ? `• \`${slashRef('runtime')} <normal|long|status|default>\` / \`!runtime <...>\` — switch Claude runtime mode for this channel` : null,
        reasoningLevels.length ? null : `• effort — not exposed by current provider (${getProviderDisplayName(provider)})`,
        compact.supportsNativeLimit
          ? `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — context compaction config (native + native_limit available on current provider)`
          : compact.supportsNativeStrategy
            ? `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — context compaction config (native available; current provider keeps the provider-default native limit)`
            : `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — context compaction config (hard only on current provider)`,
        `• \`${slashRef('extra_info')} key:<...> value:<...>\` / \`!extra_info <...>\` — configure extra context and token cost`,
        '• `!mode <safe|dangerous>` — execution mode',
        providerSupportsRawConfigOverrides(provider)
          ? '• `!config <key=value>` — append raw provider config override'
          : `• raw config passthrough — not exposed by current provider CLI (${getProviderDisplayName(provider)})`,
        '',
        'Normal messages are forwarded to the current provider.',
      ].filter(Boolean).join('\n');
    }
    return [
      '**📋 命令列表**',
      '',
      botProvider
        ? `Bot 模式：已锁定到 ${getProviderDisplayName(botProvider)}`
        : 'Bot 模式：共享实例（可用 `!provider` / `/provider` 按频道切换）',
      '',
      '**会话管理**',
      '• `!status` — 当前配置一览',
      `• \`${slashRef('settings')}\` — 当前频道的交互式设置面板`,
      '• `!queue` — 查看当前频道队列（运行中/排队数）',
      '• `!doctor` — 查看 bot 健康状态与当前安全策略',
      `• \`${slashRef('onboarding')}\` — 交互式引导（按钮分步）`,
      '• `!onboarding` — 文本版引导流程与检查清单',
      `• \`${slashRef('onboarding_config')} <on|off|status>\` / \`!onboarding <on|off|status>\` — onboarding 开关`,
      `• \`${slashRef('language')} <中文|English>\` / \`!lang <zh|en>\` — 消息提示语言`,
      `• \`${slashRef('profile')} <auto|solo|team|public|status>\` / \`!profile <...|status>\` — 当前频道 security profile`,
      `• \`${slashRef('timeout')} <毫秒|off|status>\` / \`!timeout <...>\` — runner 超时`,
      `• \`${slashRef('progress')}\` / \`!progress\` — 查看当前任务的最新进度`,
      `• \`${slashRef('cancel')}\` / \`${slashRef('abort')}\` / \`!cancel\` / \`!c\` / \`!abort\` / \`!stop\` — 中断当前任务并清空队列`,
      `• \`${slashRef('new')}\` / \`!new\` — 切到新会话，但保留当前频道配置`,
      `• \`${slashRef('reset')}\` / \`!reset\` — 清空会话与额外配置，下条消息新开上下文`,
      '• `!resume <session_id>` — 继承一个已有的 provider session',
      resumeAlias ? `• 当前 provider 别名：\`!${resumeAlias} <session_id>\`` : null,
      '• `!sessions` — 从 provider 原生运行时存储里列出最近的 sessions',
      sessionsAlias ? `• 当前 provider 别名：\`!${sessionsAlias}\`` : null,
      provider === 'codex' ? `• \`${slashRef('fork')} [session_id] [prompt]\` / \`!fork [session_id] [prompt]\` — 用 Codex 原生 fork 创建新 Discord thread` : null,
      provider === 'codex' ? `• \`${slashRef('goal')} action:<status|set|pause|resume|done|clear|budget>\` / \`!goal <状态|目标|暂停|恢复|完成|清除>\` — 管理当前 Codex goal；active 时会在空闲后续跑` : null,
      !botProvider ? '• `!provider <codex|claude|gemini|status>` — 切换当前频道 provider' : null,
      '',
      '**工作目录**',
      '• `!setdir <path|browse|default|status>` — 设置或清除当前 thread 的 workspace',
      '• `!cd <...>` — 同 `!setdir` 的别名',
      '• `!setdefaultdir <path|browse|clear|status>` — 设置当前 provider 的默认 workspace',
      `• \`${slashRef('setdir')} path:<...>\` / \`${slashRef('setdefaultdir')} path:<...>\` — workspace 控制`,
        '',
        '**模型 & 执行**',
        `• \`${slashRef('model')}\` — 打开只包含模型和推理力度的小面板`,
        reasoningLevels.length
          ? `• \`${slashRef('model')} name:<name|default> effort:<${[...reasoningLevels, 'default'].join('|')}>\` / \`!model <name|default>\` — 直接设置 model 或 effort`
          : `• \`${slashRef('model')} name:<name|default>\` / \`!model <name|default>\` — 直接设置 model`,
        provider === 'codex' ? `• \`${slashRef('fast')} <on|off|status|default>\` / \`!fast <...>\` — 切换当前频道的 Codex Fast mode` : null,
        provider === 'claude' ? `• \`${slashRef('runtime')} <normal|long|status|default>\` / \`!runtime <...>\` — 切换当前频道的 Claude 接入方式` : null,
      reasoningLevels.length ? null : `• effort — 当前 provider (${getProviderDisplayName(provider)}) 未暴露`,
      compact.supportsNativeLimit
        ? `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — 上下文压缩配置（当前 provider 支持 native 与 native_limit）`
        : compact.supportsNativeStrategy
          ? `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — 上下文压缩配置（当前 provider 支持 native，但 native_limit 走 provider 默认行为）`
          : `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — 上下文压缩配置（当前 provider 仅支持 hard）`,
      `• \`${slashRef('extra_info')} key:<...> value:<...>\` / \`!extra_info <...>\` — 配置额外信息和 token 占用`,
      '• `!mode <safe|dangerous>` — 执行模式',
      providerSupportsRawConfigOverrides(provider)
        ? '• `!config <key=value>` — 添加 provider 原生配置透传'
        : `• raw config passthrough — 当前 provider CLI (${getProviderDisplayName(provider)}) 未暴露`,
      '',
      '普通消息直接转给当前 provider。',
    ].filter(Boolean).join('\n');
  }

  function formatWorkspaceReport(key, session) {
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const lines = getWorkspaceStatusLines(key, session, language);
    const provider = getSessionProvider(session);
    if (language === 'en') {
      return [
        '📁 **Workspace**',
        ...lines,
        `• session rule: ${formatWorkspaceSessionPolicy(provider, language)}`,
      ].join('\n');
    }
    return [
      '📁 **工作目录**',
      ...lines,
      `• session 规则：${formatWorkspaceSessionPolicy(provider, language)}`,
    ].join('\n');
  }

  function formatWorkspaceSetHelp(language = 'zh') {
    if (language === 'en') {
      return [
        'Usage: `!setdir <path|browse|default|status>`',
        `Slash: \`${slashRef('setdir')} path:<path|browse|default|status>\``,
        'Examples: `!setdir ~/GitHub/my-repo`, `!setdir browse`, `!setdir default`, `!setdir status`',
      ].join('\n');
    }
    return [
      '用法：`!setdir <path|browse|default|status>`',
      `Slash：\`${slashRef('setdir')} path:<path|browse|default|status>\``,
      '示例：`!setdir ~/GitHub/my-repo`、`!setdir browse`、`!setdir default`、`!setdir status`',
    ].join('\n');
  }

  function formatDefaultWorkspaceSetHelp(language = 'zh') {
    if (language === 'en') {
      return [
        'Usage: `!setdefaultdir <path|browse|clear|status>`',
        `Slash: \`${slashRef('setdefaultdir')} path:<path|browse|clear|status>\``,
        'Examples: `!setdefaultdir ~/GitHub`, `!setdefaultdir browse`, `!setdefaultdir clear`, `!setdefaultdir status`',
      ].join('\n');
    }
    return [
      '用法：`!setdefaultdir <path|browse|clear|status>`',
      `Slash：\`${slashRef('setdefaultdir')} path:<path|browse|clear|status>\``,
      '示例：`!setdefaultdir ~/GitHub`、`!setdefaultdir browse`、`!setdefaultdir clear`、`!setdefaultdir status`',
    ].join('\n');
  }

  function formatWorkspaceUpdateReport(key, session, result) {
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const lines = getWorkspaceStatusLines(key, session, language);
    if (language === 'en') {
      return [
        result.clearedOverride ? '✅ Cleared thread workspace override' : '✅ Workspace updated',
        ...lines,
        result.sessionReset
          ? `• session: ${formatWorkspaceSessionResetReason(getSessionProvider(session), language)}`
          : '• session: kept',
      ].join('\n');
    }
    return [
      result.clearedOverride ? '✅ 已清除当前 thread 的 workspace 覆盖' : '✅ workspace 已更新',
      ...lines,
      result.sessionReset
        ? `• session: ${formatWorkspaceSessionResetReason(getSessionProvider(session), language)}`
        : '• session: 已保留',
    ].join('\n');
  }

  function formatDefaultWorkspaceUpdateReport(key, session, result) {
    const language = normalizeUiLanguage(getSessionLanguage(session));
    const lines = getWorkspaceStatusLines(key, session, language);
    if (language === 'en') {
      return [
        result.defaultWorkspaceDir ? '✅ Provider default workspace updated' : '✅ Provider default workspace cleared',
        ...lines,
        `• affected threads: ${result.affectedThreads}`,
        `• reset sessions: ${result.resetSessions}`,
      ].join('\n');
    }
    return [
      result.defaultWorkspaceDir ? '✅ provider 默认 workspace 已更新' : '✅ provider 默认 workspace 已清除',
      ...lines,
      `• 受影响 threads: ${result.affectedThreads}`,
      `• 重置 sessions: ${result.resetSessions}`,
    ].join('\n');
  }

  function formatWorkspaceBusyReport(session, workspaceDir, owner = null) {
    return formatWorkspaceBusyReportBase(session, workspaceDir, owner, {
      getSessionLanguage,
      normalizeUiLanguage,
      humanAge,
      slashRef,
    });
  }

  return {
    formatStatusReport,
    formatStatusReportWithLiveData,
    formatQueueReport,
    formatProgressReport,
    formatCancelReport,
    formatDoctorReport,
    formatCompactStrategyConfigHelp,
    formatCompactConfigReport,
    formatExtraInfoConfigHelp,
    formatExtraInfoConfigReport,
    formatReasoningEffortHelp,
    formatLanguageConfigHelp,
    formatLanguageConfigReport,
    formatFastModeConfigHelp,
    formatFastModeConfigReport,
    formatRuntimeModeConfigHelp,
    formatRuntimeModeConfigReport,
    formatProfileConfigHelp,
    formatProfileConfigReport,
    formatTimeoutConfigHelp,
    formatTimeoutConfigReport,
    formatHelpReport,
    formatWorkspaceReport,
    formatWorkspaceSetHelp,
    formatDefaultWorkspaceSetHelp,
    formatWorkspaceUpdateReport,
    formatDefaultWorkspaceUpdateReport,
    formatWorkspaceBusyReport,
  };
}
