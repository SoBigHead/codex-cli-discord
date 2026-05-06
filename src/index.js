import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeChannelSend, safeReply, withDiscordNetworkRetry } from './discord-reply-utils.js';
import { splitForDiscord } from './discord-message-splitter.js';
import { bootApp, createAppContext } from './app-context.js';
import {
  appendProviderSuffix,
  describeBotMode,
  getDefaultSlashPrefix,
  parseOptionalProvider,
  resolveDiscordToken,
  resolveProviderScopedEnv,
} from './bot-instance-utils.js';
import {
  formatCompactConfigUnsupported,
  formatReasoningEffortUnsupported,
  formatWorkspaceSessionPolicy,
  formatWorkspaceSessionResetReason,
  getProviderBinEnvName,
  getProviderCompactCapabilities,
  getProviderDefaultBin,
  getProviderDisplayName,
  getProviderShortName,
  getSupportedReasoningEffortLevels,
  getSupportedCompactStrategies,
  isReasoningEffortSupported,
  normalizeProvider,
  parseProviderInput,
  providerSupportsCompactConfigAction,
  providerSupportsRawConfigOverrides,
} from './provider-metadata.js';
import {
  formatProviderNativeCompactSurface,
  formatProviderRawConfigSurface,
  formatProviderReasoningSurface,
  formatProviderResumeSurface,
  formatProviderSessionTerm,
  formatProviderRuntimeSummary,
  formatProviderSessionLabel,
  formatProviderSessionStoreSurface,
  formatRecentSessionsLookup,
  formatRecentSessionsTitle,
} from './provider-runtime-surface.js';
import {
  buildSpawnEnv,
  createCachedProviderRateLimitReader,
  formatCliHealth,
  getCodexAccountRateLimits,
  getCliHealth as getCliHealthBase,
  getProviderBin as getProviderBinBase,
  isCliNotFound,
} from './provider-runtime.js';
import {
  findLatestClaudeSessionFileBySessionId,
  findLatestRolloutFileBySessionId,
  listRecentSessions as listRecentProviderSessions,
  readClaudeSessionMetaBySessionId,
  readCodexSessionMetaBySessionId,
  readGeminiSessionState,
  resolveGeminiProjectRootBySessionId,
} from './provider-sessions.js';
import { stopChildProcess } from './channel-runtime.js';
import { loadRuntimeEnv } from './env-loader.js';
import {
  extractRawProgressTextFromEvent as extractRawProgressTextFromEventBase,
} from './progress-utils.js';
import {
  buildProgressEventDedupeKey,
  composeFinalAnswerText,
  createProgressEventDeduper,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from './codex-event-utils.js';
import { ensureDir } from './session-store.js';
import {
  normalizeQueueLimit,
  normalizeSecurityProfile,
  parseConfigAllowlist,
  parseConfigKey,
  parseCsvSet,
  parseOptionalBool,
} from './security-policy.js';
import {
  createChildThreadWorkspaceModeStore,
} from './child-thread-workspace-mode.js';
import {
  createProviderDefaultWorkspaceStore,
  resolveConfiguredWorkspaceDir,
  resolvePath,
} from './provider-default-workspace.js';
import {
  createCodexProfileStore,
} from './codex-profile-store.js';
import {
  createReplyDeliveryModeStore,
} from './reply-delivery-mode.js';
import {
  describeCompactStrategy,
  formatLanguageLabel,
  formatReplyDeliveryModeLabel,
  formatSecurityProfileLabel,
  normalizeCompactStrategy,
  normalizeReplyDeliveryMode,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactTokenLimit,
  normalizeSessionFastMode,
  normalizeSessionRuntimeMode,
  normalizeSessionSecurityProfile,
  normalizeSessionTimeoutMs,
  normalizeTimeoutMs,
  normalizeUiLanguage,
  parseCompactConfigAction,
  parseCompactConfigFromText,
  parseExtraInfoConfigAction,
  parseExtraInfoConfigFromText,
  parseFastModeAction,
  parseRuntimeModeAction,
  parseReasoningEffortInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseUiLanguageInput,
  parseWorkspaceCommandAction,
} from './session-settings.js';
import {
  DEFAULT_EXTRA_INFO_TEMPLATE,
  normalizeExtraInfoEnabled,
  normalizeExtraInfoTemplate,
} from './extra-info.js';
import {
  parseCommandActionButtonId,
} from './slash-command-router.js';
import {
  registerSlashCommands,
} from './slash-command-surface.js';
import * as discordMessageInput from './discord-message-input.js';
import {
  configureRuntimeProxy,
  createDiscordClient,
  normalizeSlashPrefix,
  readCodexDefaults,
  readCodexModelCatalog,
  readCodexProfileCatalog,
  readClaudeModelCatalog,
  renderMissingDiscordTokenHint,
  writeCodexDefaults,
} from './runtime-bootstrap.js';
import {
  clearCodexThreadGoal,
  forkCodexThread,
  getCodexThreadGoal,
  setCodexThreadGoal,
} from './codex-app-server.js';
import {
  extractInputTokensFromUsage,
  formatTokenValue,
  humanAge,
  humanElapsed,
  normalizeIntervalMs,
  safeError,
  toInt,
  toOptionalInt,
  truncate,
} from './runtime-utils.js';
import {
  isIgnorableDiscordRuntimeError,
  isRecoverableGatewayCloseCode,
} from './discord-lifecycle.js';
import { createProjectUpgradeManager } from './project-upgrade.js';
import { createProjectUpgradeScheduler } from './project-upgrade-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const envState = loadRuntimeEnv({ rootDir: ROOT, env: process.env });
const ENV_FILE = envState.writableEnvFile;
const BOT_PROVIDER = parseOptionalProvider(process.env.BOT_PROVIDER);
const BOT_MODE = describeBotMode(BOT_PROVIDER);
const DATA_FILE = path.join(DATA_DIR, appendProviderSuffix('sessions.json', BOT_PROVIDER));
const LOCK_FILE = path.join(DATA_DIR, appendProviderSuffix('bot.lock', BOT_PROVIDER));

if (envState.loadedFiles.length) {
  const rendered = envState.loadedFiles
    .map((filePath) => path.relative(ROOT, filePath) || path.basename(filePath))
    .join(' -> ');
  const scoped = envState.appliedProviderScope
    ? ` (applied ${envState.appliedProviderScope.toUpperCase()}__* overrides)`
    : '';
  console.log(`🔧 Loaded env files: ${rendered}${scoped}`);
}

const { logs: proxyLogs, restProxyAgent } = configureRuntimeProxy({
  env: process.env,
  envFilePath: ENV_FILE,
});
if (proxyLogs.length) {
  for (const line of proxyLogs) {
    console.log(line);
  }
}

let activeLifecycle = null;
const getActiveDiscordClient = () => activeLifecycle?.getClient?.() ?? null;
const safeReplyWithLiveClient = (message, payload, options = {}) => safeReply(message, payload, {
  ...options,
  getActiveClient: getActiveDiscordClient,
});
const safeChannelSendWithLiveClient = (target, payload, options = {}) => safeChannelSend(target, payload, {
  ...options,
  getActiveClient: getActiveDiscordClient,
});

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
} = await import('discord.js');

const DISCORD_TOKEN = resolveDiscordToken({ botProvider: BOT_PROVIDER, env: process.env });
if (!DISCORD_TOKEN) {
  console.error(renderMissingDiscordTokenHint({ botProvider: BOT_PROVIDER, env: process.env }));
  process.exit(1);
}

const ALLOWED_CHANNEL_IDS = parseCsvSet(resolveProviderScopedEnv('ALLOWED_CHANNEL_IDS', BOT_PROVIDER, process.env));
const ALLOWED_GUILD_IDS = parseCsvSet(resolveProviderScopedEnv('ALLOWED_GUILD_IDS', BOT_PROVIDER, process.env));
const ALLOWED_USER_IDS = parseCsvSet(resolveProviderScopedEnv('ALLOWED_USER_IDS', BOT_PROVIDER, process.env));
const MENTION_ONLY_CHANNEL_IDS = parseCsvSet(resolveProviderScopedEnv('MENTION_ONLY_CHANNEL_IDS', BOT_PROVIDER, process.env));
const SECURITY_PROFILE = normalizeSecurityProfile(process.env.SECURITY_PROFILE || 'auto');
const SECURITY_PROFILE_DEFAULTS = Object.freeze({
  solo: { mentionOnly: false, maxQueuePerChannel: 0 },
  team: { mentionOnly: false, maxQueuePerChannel: 20 },
  public: { mentionOnly: true, maxQueuePerChannel: 20 },
});
const MENTION_ONLY_OVERRIDE = parseOptionalBool(process.env.MENTION_ONLY);
const MENTION_ONLY_ENABLED_GUILD_IDS = parseCsvSet(
  resolveProviderScopedEnv('MENTION_ONLY_ENABLED_GUILD_IDS', BOT_PROVIDER, process.env),
);
const MENTION_ONLY_DISABLED_GUILD_IDS = parseCsvSet(
  resolveProviderScopedEnv('MENTION_ONLY_DISABLED_GUILD_IDS', BOT_PROVIDER, process.env),
);
const MAX_QUEUE_PER_CHANNEL_OVERRIDE = normalizeQueueLimit(process.env.MAX_QUEUE_PER_CHANNEL);
const ENABLE_CONFIG_CMD = String(process.env.ENABLE_CONFIG_CMD || 'false').toLowerCase() === 'true';
const CONFIG_POLICY = parseConfigAllowlist(
  process.env.CONFIG_ALLOWLIST || 'personality,model_reasoning_effort,model_auto_compact_token_limit',
);
const EXTRA_INFO_ENABLED = normalizeExtraInfoEnabled(resolveProviderScopedEnv('EXTRA_INFO_ENABLED', BOT_PROVIDER, process.env));
const EXTRA_INFO_TEXT = normalizeExtraInfoTemplate(resolveProviderScopedEnv('EXTRA_INFO_TEXT', BOT_PROVIDER, process.env))
  || DEFAULT_EXTRA_INFO_TEMPLATE;
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspaces');
const WORKSPACE_LOCK_ROOT = path.join(DATA_DIR, 'workspace-locks');
const SHARED_CHILD_THREAD_WORKSPACE_MODE = process.env.CHILD_THREAD_WORKSPACE_MODE;
const PROVIDER_CHILD_THREAD_WORKSPACE_MODE_OVERRIDES = {
  codex: process.env.CODEX__CHILD_THREAD_WORKSPACE_MODE,
  claude: process.env.CLAUDE__CHILD_THREAD_WORKSPACE_MODE,
  gemini: process.env.GEMINI__CHILD_THREAD_WORKSPACE_MODE,
  kiro: process.env.KIRO__CHILD_THREAD_WORKSPACE_MODE,
};
const {
  resolve: resolveChildThreadWorkspaceMode,
  set: setChildThreadWorkspaceMode,
} = createChildThreadWorkspaceModeStore({
  env: process.env,
  envFilePath: ENV_FILE,
  sharedMode: SHARED_CHILD_THREAD_WORKSPACE_MODE,
  providerModeOverrides: PROVIDER_CHILD_THREAD_WORKSPACE_MODE_OVERRIDES,
});
const SHARED_DEFAULT_WORKSPACE_DIR = resolveConfiguredWorkspaceDir(process.env.DEFAULT_WORKSPACE_DIR);
const PROVIDER_DEFAULT_WORKSPACE_OVERRIDES = {
  codex: resolveConfiguredWorkspaceDir(process.env.CODEX__DEFAULT_WORKSPACE_DIR),
  claude: resolveConfiguredWorkspaceDir(process.env.CLAUDE__DEFAULT_WORKSPACE_DIR),
  gemini: resolveConfiguredWorkspaceDir(process.env.GEMINI__DEFAULT_WORKSPACE_DIR),
  kiro: resolveConfiguredWorkspaceDir(process.env.KIRO__DEFAULT_WORKSPACE_DIR),
};
const {
  resolve: resolveProviderDefaultWorkspace,
  set: setProviderDefaultWorkspace,
} = createProviderDefaultWorkspaceStore({
  env: process.env,
  envFilePath: ENV_FILE,
  sharedDefaultWorkspaceDir: SHARED_DEFAULT_WORKSPACE_DIR,
  providerDefaultWorkspaceOverrides: PROVIDER_DEFAULT_WORKSPACE_OVERRIDES,
});
const {
  resolve: resolveReplyDeliveryDefault,
  set: setReplyDeliveryDefault,
} = createReplyDeliveryModeStore({
  env: process.env,
  envFilePath: ENV_FILE,
  defaultMode: normalizeReplyDeliveryMode(process.env.DEFAULT_REPLY_DELIVERY_MODE, 'card_mention'),
});
const {
  resolve: resolveDefaultCodexProfile,
  set: setDefaultCodexProfile,
} = createCodexProfileStore({
  env: process.env,
  envFilePath: ENV_FILE,
  defaultProfile: process.env.CODEX__DEFAULT_PROFILE || null,
  readCodexProfileCatalog,
});
const DEFAULT_PROVIDER = BOT_PROVIDER || normalizeProvider(process.env.DEFAULT_PROVIDER || process.env.CLI_PROVIDER || 'codex');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
const DEFAULT_MODE = (process.env.DEFAULT_MODE || 'safe').toLowerCase() === 'dangerous' ? 'dangerous' : 'safe';
const DEFAULT_UI_LANGUAGE = normalizeUiLanguage(process.env.DEFAULT_UI_LANGUAGE || 'zh');
const ONBOARDING_ENABLED_DEFAULT = parseOptionalBool(process.env.ONBOARDING_ENABLED_DEFAULT);
const ONBOARDING_ENABLED_BY_DEFAULT = ONBOARDING_ENABLED_DEFAULT === null ? true : ONBOARDING_ENABLED_DEFAULT;
const CODEX_TIMEOUT_MS = normalizeTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0);
const TASK_MAX_ATTEMPTS = Math.max(1, toInt(process.env.TASK_MAX_ATTEMPTS, 3));
const TASK_RETRY_BASE_DELAY_MS = Math.max(0, toInt(process.env.TASK_RETRY_BASE_DELAY_MS, 1000));
const TASK_RETRY_MAX_DELAY_MS = Math.max(
  TASK_RETRY_BASE_DELAY_MS,
  toInt(process.env.TASK_RETRY_MAX_DELAY_MS, 8000),
);
const CODEX_BIN = (process.env.CODEX_BIN || 'codex').trim() || 'codex';
const CLAUDE_BIN = (process.env.CLAUDE_BIN || 'claude').trim() || 'claude';
const GEMINI_BIN = (process.env.GEMINI_BIN || 'gemini').trim() || 'gemini';
const KIRO_BIN = (process.env.KIRO_BIN || 'kiro').trim() || 'kiro';
const SHOW_REASONING = String(process.env.SHOW_REASONING || 'false').toLowerCase() === 'true';
const DEBUG_EVENTS = String(process.env.DEBUG_EVENTS || 'false').toLowerCase() === 'true';
const PROGRESS_UPDATES_ENABLED = String(process.env.PROGRESS_UPDATES_ENABLED || 'true').toLowerCase() !== 'false';
const PROGRESS_UPDATE_INTERVAL_MS = normalizeIntervalMs(process.env.PROGRESS_UPDATE_INTERVAL_MS, 15000, 3000);
const PROGRESS_EVENT_FLUSH_MS = normalizeIntervalMs(process.env.PROGRESS_EVENT_FLUSH_MS, 5000, 1000);
const PROGRESS_TEXT_PREVIEW_CHARS = Math.max(60, toInt(process.env.PROGRESS_TEXT_PREVIEW_CHARS, 140));
const PROGRESS_INCLUDE_STDOUT = String(process.env.PROGRESS_INCLUDE_STDOUT || 'true').toLowerCase() !== 'false';
const PROGRESS_INCLUDE_STDERR = String(process.env.PROGRESS_INCLUDE_STDERR || 'false').toLowerCase() === 'true';
const PROGRESS_PLAN_MAX_LINES = Math.min(8, Math.max(1, toInt(process.env.PROGRESS_PLAN_MAX_LINES, 4)));
const PROGRESS_DONE_STEPS_MAX = Math.min(12, Math.max(1, toInt(process.env.PROGRESS_DONE_STEPS_MAX, 4)));
const PROGRESS_ACTIVITY_MAX_LINES = Math.min(12, Math.max(1, toInt(process.env.PROGRESS_ACTIVITY_MAX_LINES, 4)));
const PROGRESS_EVENT_DEDUPE_WINDOW_MS = normalizeIntervalMs(
  process.env.PROGRESS_EVENT_DEDUPE_WINDOW_MS,
  2500,
  200,
);
const PROGRESS_PROCESS_LINES = 2;
const PROGRESS_PROCESS_PUSH_INTERVAL_MS = normalizeIntervalMs(
  process.env.PROGRESS_PROCESS_PUSH_INTERVAL_MS,
  1100,
  300,
);
const PROGRESS_MESSAGE_MAX_CHARS = Math.max(600, toInt(process.env.PROGRESS_MESSAGE_MAX_CHARS, 1800));
const SELF_HEAL_ENABLED = String(process.env.SELF_HEAL_ENABLED || 'true').toLowerCase() !== 'false';
const SELF_HEAL_RESTART_DELAY_MS = toInt(process.env.SELF_HEAL_RESTART_DELAY_MS, 5000);
const SELF_HEAL_MAX_LOGIN_BACKOFF_MS = toInt(process.env.SELF_HEAL_MAX_LOGIN_BACKOFF_MS, 60000);
const LEGACY_MAX_INPUT_TOKENS_BEFORE_RESET = toOptionalInt(process.env.MAX_INPUT_TOKENS_BEFORE_RESET);
const MAX_INPUT_TOKENS_BEFORE_COMPACT = toInt(
  process.env.MAX_INPUT_TOKENS_BEFORE_COMPACT,
  Number.isFinite(LEGACY_MAX_INPUT_TOKENS_BEFORE_RESET) ? LEGACY_MAX_INPUT_TOKENS_BEFORE_RESET : 250000,
);
const COMPACT_STRATEGY = normalizeCompactStrategy(process.env.COMPACT_STRATEGY || 'native');
const COMPACT_ON_THRESHOLD = String(process.env.COMPACT_ON_THRESHOLD || 'true').toLowerCase() !== 'false';
const MODEL_AUTO_COMPACT_TOKEN_LIMIT = toInt(
  process.env.MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  MAX_INPUT_TOKENS_BEFORE_COMPACT,
);
const CLAUDE_RUNTIME_MODE = normalizeSessionRuntimeMode(
  process.env.CLAUDE__RUNTIME_MODE || process.env.CLAUDE_RUNTIME_MODE || 'normal',
) || 'normal';
const CLAUDE_LONG_IDLE_MS = normalizeIntervalMs(
  process.env.CLAUDE__LONG_IDLE_MS || process.env.CLAUDE_LONG_IDLE_MS,
  15 * 60_000,
  1000,
);
const CLAUDE_LONG_MAX_SESSIONS = Math.max(
  1,
  toInt(process.env.CLAUDE__LONG_MAX_SESSIONS || process.env.CLAUDE_LONG_MAX_SESSIONS, 8),
);
const PROJECT_UPGRADE_CHECK_INTERVAL_MS = normalizeIntervalMs(
  process.env.AGENTS_IN_DISCORD_UPGRADE_CHECK_INTERVAL_MS,
  6 * 60 * 60_000,
  60_000,
);
const PROJECT_UPGRADE_INITIAL_DELAY_MS = normalizeIntervalMs(
  process.env.AGENTS_IN_DISCORD_UPGRADE_INITIAL_DELAY_MS,
  30_000,
  1000,
);
const allowedChannelIdsForUpgradeNotify = ALLOWED_CHANNEL_IDS instanceof Set ? ALLOWED_CHANNEL_IDS : new Set();
const PROJECT_UPGRADE_NOTIFY_CHANNEL_IDS = parseCsvSet(
  process.env.AGENTS_IN_DISCORD_UPGRADE_NOTIFY_CHANNEL_IDS || [...allowedChannelIdsForUpgradeNotify].join(','),
) || new Set();
const PROJECT_UPGRADE_ADMIN_USER_IDS = parseCsvSet(
  process.env.AGENTS_IN_DISCORD_UPGRADE_ADMIN_USER_IDS || '',
);
const PROJECT_UPGRADE_RESTART_TARGET = String(
  process.env.AGENTS_IN_DISCORD_UPGRADE_RESTART_TARGET || 'all',
).trim() || 'all';
const PROJECT_UPGRADE_RESTART_COMMAND = process.env.AGENTS_IN_DISCORD_UPGRADE_RESTART_COMMAND
  || (process.platform === 'win32'
    ? ''
    : `scripts/restart-discord-bot-service.sh ${PROJECT_UPGRADE_RESTART_TARGET}`);
const SLASH_PREFIX = normalizeSlashPrefix(process.env.SLASH_PREFIX || getDefaultSlashPrefix(BOT_PROVIDER));
const SPAWN_ENV = buildSpawnEnv(process.env);
const getProviderBin = (provider) => getProviderBinBase(provider, {
  codexBin: CODEX_BIN,
  claudeBin: CLAUDE_BIN,
  geminiBin: GEMINI_BIN,
  kiroBin: KIRO_BIN,
});
const getCliHealth = (provider = DEFAULT_PROVIDER) => getCliHealthBase(provider, {
  codexBin: CODEX_BIN,
  claudeBin: CLAUDE_BIN,
  geminiBin: GEMINI_BIN,
  kiroBin: KIRO_BIN,
  spawnEnv: SPAWN_ENV,
  safeError,
});
const getProviderRateLimits = createCachedProviderRateLimitReader({
  readRateLimits: (provider = DEFAULT_PROVIDER) => getCodexAccountRateLimits(provider, {
    codexBin: CODEX_BIN,
    spawnEnv: SPAWN_ENV,
    safeError,
  }),
});
const projectUpgradeManager = createProjectUpgradeManager({
  projectRoot: ROOT,
  env: process.env,
  envFilePath: ENV_FILE,
  restartCommand: PROJECT_UPGRADE_RESTART_COMMAND,
});
const canManageProjectUpgrade = (userId) => (
  PROJECT_UPGRADE_ADMIN_USER_IDS.size > 0
  && PROJECT_UPGRADE_ADMIN_USER_IDS.has(String(userId || '').trim())
);
const getProjectUpgradeStatus = (options = {}) => (
  projectUpgradeManager.getCachedStatus({
    refresh: Boolean(options.refresh),
    maxAgeMs: PROJECT_UPGRADE_CHECK_INTERVAL_MS,
  })
);

ensureDir(DATA_DIR);
ensureDir(WORKSPACE_ROOT);

const bootCliHealth = getCliHealth(DEFAULT_PROVIDER);
if (bootCliHealth.ok) {
  console.log(`🧩 ${getProviderDisplayName(DEFAULT_PROVIDER)} CLI: ${bootCliHealth.version} via ${bootCliHealth.bin}`);
} else {
  console.warn([
    `⚠️ ${getProviderDisplayName(DEFAULT_PROVIDER)} CLI 不可用，后续请求会失败。`,
    `• provider: ${DEFAULT_PROVIDER}`,
    `• bin: ${bootCliHealth.bin}`,
    `• reason: ${bootCliHealth.error}`,
    `• 处理: 安装 ${getProviderDisplayName(DEFAULT_PROVIDER)} CLI，或在 .env 里设置 ${getProviderBinEnvName(DEFAULT_PROVIDER)}=/绝对路径/${getProviderDefaultBin(DEFAULT_PROVIDER)}，然后重启 bot。`,
  ].join('\n'));
}

const createClient = () => createDiscordClient({
  Client,
  GatewayIntentBits,
  Partials,
  restProxyAgent,
});
const appContext = createAppContext({
  identityOptions: {
    defaultProvider: DEFAULT_PROVIDER,
  },
  sessionSettingsOptions: {
    defaultUiLanguage: DEFAULT_UI_LANGUAGE,
    securityProfile: SECURITY_PROFILE,
    codexTimeoutMs: CODEX_TIMEOUT_MS,
    taskMaxAttempts: TASK_MAX_ATTEMPTS,
    taskRetryBaseDelayMs: TASK_RETRY_BASE_DELAY_MS,
    taskRetryMaxDelayMs: TASK_RETRY_MAX_DELAY_MS,
    compactStrategy: COMPACT_STRATEGY,
    claudeRuntimeMode: CLAUDE_RUNTIME_MODE,
    compactOnThreshold: COMPACT_ON_THRESHOLD,
    maxInputTokensBeforeCompact: MAX_INPUT_TOKENS_BEFORE_COMPACT,
    modelAutoCompactTokenLimit: MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    defaultReplyDeliveryMode: resolveReplyDeliveryDefault().mode,
    readDefaultReplyDeliveryMode: () => resolveReplyDeliveryDefault().mode,
    defaultExtraInfoEnabled: EXTRA_INFO_ENABLED === null ? true : EXTRA_INFO_ENABLED,
    defaultExtraInfoText: EXTRA_INFO_TEXT,
    defaultCodexProfile: resolveDefaultCodexProfile().profile,
    readDefaultCodexProfile: resolveDefaultCodexProfile,
    defaultModel: DEFAULT_MODEL,
    readCodexDefaults,
    readCodexProfileCatalog,
    normalizeProvider,
    getSupportedCompactStrategies,
  },
  securityPolicyOptions: {
    securityProfile: SECURITY_PROFILE,
    securityProfileDefaults: SECURITY_PROFILE_DEFAULTS,
    mentionOnlyOverride: MENTION_ONLY_OVERRIDE,
    mentionOnlyEnabledGuildIds: MENTION_ONLY_ENABLED_GUILD_IDS,
    mentionOnlyDisabledGuildIds: MENTION_ONLY_DISABLED_GUILD_IDS,
    mentionOnlyChannelIds: MENTION_ONLY_CHANNEL_IDS,
    maxQueuePerChannelOverride: MAX_QUEUE_PER_CHANNEL_OVERRIDE,
    enableConfigCmd: ENABLE_CONFIG_CMD,
    configPolicy: CONFIG_POLICY,
    permissionFlagsBits: PermissionFlagsBits,
  },
  sessionStoreOptions: {
    dataFile: DATA_FILE,
    workspaceRoot: WORKSPACE_ROOT,
    resolveChildThreadWorkspaceMode: (provider) => resolveChildThreadWorkspaceMode(provider).mode,
    botProvider: BOT_PROVIDER,
    defaults: {
      provider: DEFAULT_PROVIDER,
      mode: DEFAULT_MODE,
      language: DEFAULT_UI_LANGUAGE,
      onboardingEnabled: ONBOARDING_ENABLED_BY_DEFAULT,
    },
    normalizeProvider,
    normalizeUiLanguage,
    normalizeSessionSecurityProfile,
    normalizeSessionFastMode,
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    normalizeExtraInfoEnabled,
    normalizeExtraInfoText: normalizeExtraInfoTemplate,
    normalizeReplyDeliveryMode,
    resolveDefaultWorkspace: resolveProviderDefaultWorkspace,
  },
  commandActionsOptions: {
    normalizeProvider,
    normalizeUiLanguage,
    readCodexDefaults,
    writeCodexDefaults,
    readCodexSessionMetaBySessionId,
    resolveGeminiProjectRootBySessionId,
    formatProviderSessionLabel,
    formatRecentSessionsTitle,
    formatRecentSessionsLookup,
    resolveProviderDefaultWorkspace,
    setProviderDefaultWorkspace,
    resolveDefaultCodexProfile,
    setDefaultCodexProfile,
    resolveReplyDeliveryDefault,
    setReplyDeliveryDefault,
    readCodexProfileCatalog,
    getProviderShortName,
    listRecentSessions: ({ provider = DEFAULT_PROVIDER, workspaceDir = '', limit = 10 } = {}) => listRecentProviderSessions({
      provider,
      workspaceDir,
      limit,
    }),
    humanAge,
  },
  workspaceRuntimeOptions: {
    lockRoot: WORKSPACE_LOCK_ROOT,
    ensureDir,
  },
  promptRuntimeOptions: {
    runtimePresentationOptions: {
      showReasoning: SHOW_REASONING,
      progressTextPreviewChars: PROGRESS_TEXT_PREVIEW_CHARS,
      progressDoneStepsMax: PROGRESS_DONE_STEPS_MAX,
      progressActivityMaxLines: PROGRESS_ACTIVITY_MAX_LINES,
      progressProcessLines: PROGRESS_PROCESS_LINES,
      humanAge,
    },
    channelRuntimeStoreOptions: {
      truncate,
    },
    sessionProgressBridgeOptions: {
      normalizeProvider,
      extractRawProgressTextFromEvent: extractRawProgressTextFromEventBase,
      findLatestRolloutFileBySessionId,
      findLatestClaudeSessionFileBySessionId,
    },
    runnerExecutorOptions: {
      debugEvents: DEBUG_EVENTS,
      spawnEnv: SPAWN_ENV,
      defaultTimeoutMs: CODEX_TIMEOUT_MS,
      defaultModel: DEFAULT_MODEL,
      claudeLongIdleMs: CLAUDE_LONG_IDLE_MS,
      claudeLongMaxSessions: CLAUDE_LONG_MAX_SESSIONS,
      ensureDir,
      normalizeProvider,
      getProviderBin,
      getProviderDefaultWorkspace: resolveProviderDefaultWorkspace,
      normalizeTimeoutMs,
      safeError,
      stopChildProcess,
      extractAgentMessageText,
      isFinalAnswerLikeAgentMessage,
      readGeminiSessionState,
      getCodexThreadGoal: (options) => getCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
    },
    promptOrchestratorOptions: {
      defaultUiLanguage: DEFAULT_UI_LANGUAGE,
      progressUpdatesEnabled: PROGRESS_UPDATES_ENABLED,
      progressProcessLines: PROGRESS_PROCESS_LINES,
      progressUpdateIntervalMs: PROGRESS_UPDATE_INTERVAL_MS,
      progressEventFlushMs: PROGRESS_EVENT_FLUSH_MS,
      progressEventDedupeWindowMs: PROGRESS_EVENT_DEDUPE_WINDOW_MS,
      progressIncludeStdout: PROGRESS_INCLUDE_STDOUT,
      progressIncludeStderr: PROGRESS_INCLUDE_STDERR,
      progressTextPreviewChars: PROGRESS_TEXT_PREVIEW_CHARS,
      progressProcessPushIntervalMs: PROGRESS_PROCESS_PUSH_INTERVAL_MS,
      progressMessageMaxChars: PROGRESS_MESSAGE_MAX_CHARS,
      progressPlanMaxLines: PROGRESS_PLAN_MAX_LINES,
      progressDoneStepsMax: PROGRESS_DONE_STEPS_MAX,
      showReasoning: SHOW_REASONING,
      resultChunkChars: 1900,
      safeReply: safeReplyWithLiveClient,
      safeChannelSend: safeChannelSendWithLiveClient,
      withDiscordNetworkRetry,
      splitForDiscord,
      normalizeUiLanguage,
      getProviderDisplayName,
      getProviderShortName,
      formatProviderSessionTerm,
      getProviderDefaultBin,
      getProviderBinEnvName,
      stopChildProcess,
      isCliNotFound,
      safeError,
      truncate,
      toOptionalInt,
      humanElapsed,
      createProgressEventDeduper,
      buildProgressEventDedupeKey,
      extractInputTokensFromUsage,
      composeFinalAnswerText,
    },
    channelQueueOptions: {
      safeReply: safeReplyWithLiveClient,
      safeError,
    },
  },
  commandSurfaceOptions: {
    slashPrefix: SLASH_PREFIX,
    botProvider: BOT_PROVIDER,
    defaultUiLanguage: DEFAULT_UI_LANGUAGE,
    enableConfigCmd: ENABLE_CONFIG_CMD,
    SlashCommandBuilder,
    onboardingOptions: {
      onboardingEnabledByDefault: ONBOARDING_ENABLED_BY_DEFAULT,
      defaultUiLanguage: DEFAULT_UI_LANGUAGE,
      onboardingTotalSteps: 4,
      workspaceRoot: WORKSPACE_ROOT,
      discordToken: DISCORD_TOKEN,
      allowedChannelIds: ALLOWED_CHANNEL_IDS,
      allowedGuildIds: ALLOWED_GUILD_IDS,
      allowedUserIds: ALLOWED_USER_IDS,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      getCliHealth,
      normalizeUiLanguage,
      getProviderDisplayName,
      formatCliHealth,
      formatLanguageLabel,
      formatSecurityProfileLabel,
      parseUiLanguageInput,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
    },
    settingsPanelOptions: {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      ModalBuilder,
      TextInputBuilder,
      TextInputStyle,
      getProviderDisplayName,
      getSupportedReasoningEffortLevels,
      getModelCatalog: (provider) => {
        if (provider === 'codex') return readCodexModelCatalog({ codexBin: CODEX_BIN, env: SPAWN_ENV });
        if (provider === 'claude') return readClaudeModelCatalog({ claudeBin: CLAUDE_BIN, env: SPAWN_ENV });
        return { models: [], error: null };
      },
      getProviderCompactCapabilities,
      normalizeUiLanguage,
    },
    reportOptions: {
      botProvider: BOT_PROVIDER,
      allowedChannelIds: ALLOWED_CHANNEL_IDS,
      allowedGuildIds: ALLOWED_GUILD_IDS,
      allowedUserIds: ALLOWED_USER_IDS,
      progressProcessLines: PROGRESS_PROCESS_LINES,
      progressPlanMaxLines: PROGRESS_PLAN_MAX_LINES,
      progressDoneStepsMax: PROGRESS_DONE_STEPS_MAX,
      normalizeUiLanguage,
      getProviderDisplayName,
      getProviderShortName,
      getProviderCompactCapabilities,
      providerSupportsRawConfigOverrides,
      formatProviderSessionTerm,
      formatProviderRuntimeSummary,
      formatProviderSessionStoreSurface,
      formatProviderResumeSurface,
      formatProviderNativeCompactSurface,
      formatProviderRawConfigSurface,
      formatProviderReasoningSurface,
      getSupportedReasoningEffortLevels,
      getCliHealth,
      getProviderRateLimits,
      getProjectUpgradeStatus,
      getCodexThreadGoal: (options) => getCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      formatCliHealth,
      formatLanguageLabel,
      formatSecurityProfileLabel,
      describeCompactStrategy,
      formatWorkspaceSessionPolicy,
      formatWorkspaceSessionResetReason,
      humanAge,
      formatTokenValue,
      truncate,
    },
    workspaceBrowserOptions: {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      ensureDir,
      workspaceRoot: WORKSPACE_ROOT,
      resolveProviderDefaultWorkspace,
      resolveChildThreadWorkspaceMode,
      setChildThreadWorkspaceMode,
    },
    slashRouterOptions: {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      getProviderDisplayName,
      formatProviderSessionLabel,
      isReasoningEffortSupported,
      providerSupportsCompactConfigAction,
      formatCompactConfigUnsupported,
      formatReasoningEffortUnsupported,
      normalizeProvider,
      parseWorkspaceCommandAction,
      parseUiLanguageInput,
      parseFastModeAction,
      parseRuntimeModeAction,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
      parseCompactConfigAction,
      parseExtraInfoConfigAction,
      getProjectUpgradeStatus: (options = {}) => projectUpgradeManager.getCachedStatus({ refresh: options.fetch !== false }),
      setProjectUpgradeMode: projectUpgradeManager.setMode,
      canManageProjectUpgrade,
      applyProjectUpgrade: () => projectUpgradeManager.apply({
        restart: false,
        requireIdle: () => {
          const busy = appContext.promptRuntime.getAllRuntimeSnapshots()
            .find((item) => item.running || Number(item.queued || 0) > 0);
          return busy
            ? { ok: false, error: `bot has running or queued work in ${busy.key}` }
            : { ok: true };
        },
      }),
      requestProjectUpgradeRestart: () => projectUpgradeManager.requestRestart(),
      resolvePath,
      forkCodexThread: (options) => forkCodexThread({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      resolveForkWorkspace: ({ provider, parentSessionId } = {}) => (
        normalizeProvider(provider) === 'claude'
          ? readClaudeSessionMetaBySessionId(parentSessionId)?.cwd
          : null
      ),
      getCodexThreadGoal: (options) => getCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      setCodexThreadGoal: (options) => setCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      clearCodexThreadGoal: (options) => clearCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      safeError,
    },
    textCommandOptions: {
      getProviderDisplayName,
      getProviderShortName,
      safeReply: safeReplyWithLiveClient,
      formatProviderSessionLabel,
      providerSupportsRawConfigOverrides,
      formatProviderRawConfigSurface,
      providerSupportsCompactConfigAction,
      formatCompactConfigUnsupported,
      formatReasoningEffortUnsupported,
      parseProviderInput,
      parseUiLanguageInput,
      parseFastModeAction,
      parseRuntimeModeAction,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
      parseCompactConfigFromText,
      parseExtraInfoConfigFromText,
      getProjectUpgradeStatus: (options = {}) => projectUpgradeManager.getCachedStatus({ refresh: options.fetch !== false }),
      setProjectUpgradeMode: projectUpgradeManager.setMode,
      canManageProjectUpgrade,
      applyProjectUpgrade: () => projectUpgradeManager.apply({
        restart: false,
        requireIdle: () => {
          const busy = appContext.promptRuntime.getAllRuntimeSnapshots()
            .find((item) => item.running || Number(item.queued || 0) > 0);
          return busy
            ? { ok: false, error: `bot has running or queued work in ${busy.key}` }
            : { ok: true };
        },
      }),
      requestProjectUpgradeRestart: () => projectUpgradeManager.requestRestart(),
      parseConfigKey,
      parseReasoningEffortInput,
      parseWorkspaceCommandAction,
      isReasoningEffortSupported,
      resolvePath,
      forkCodexThread: (options) => forkCodexThread({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      resolveForkWorkspace: ({ provider, parentSessionId } = {}) => (
        normalizeProvider(provider) === 'claude'
          ? readClaudeSessionMetaBySessionId(parentSessionId)?.cwd
          : null
      ),
      getCodexThreadGoal: (options) => getCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      setCodexThreadGoal: (options) => setCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      clearCodexThreadGoal: (options) => clearCodexThreadGoal({ ...options, codexBin: CODEX_BIN, env: SPAWN_ENV }),
      safeError,
    },
  },
  accessPolicyOptions: {
    allowedChannelIds: ALLOWED_CHANNEL_IDS,
    allowedGuildIds: ALLOWED_GUILD_IDS,
    allowedUserIds: ALLOWED_USER_IDS,
  },
  entryHandlerOptions: {
    logger: console,
    registerSlashCommands,
    REST,
    Routes,
    discordToken: DISCORD_TOKEN,
    restProxyAgent,
    withDiscordNetworkRetry,
    safeReply: safeReplyWithLiveClient,
    safeError,
    isIgnorableDiscordRuntimeError,
    isRecoverableGatewayCloseCode,
    messageInput: discordMessageInput,
    parseCommandActionButtonId,
  },
  lifecycleOptions: {
    selfHealEnabled: SELF_HEAL_ENABLED,
    restartDelayMs: SELF_HEAL_RESTART_DELAY_MS,
    maxLoginBackoffMs: SELF_HEAL_MAX_LOGIN_BACKOFF_MS,
    discordToken: DISCORD_TOKEN,
    createClient,
    safeError,
    logger: console,
  },
  singleInstanceLockOptions: {
    dataDir: DATA_DIR,
    lockFile: LOCK_FILE,
    rootDir: ROOT,
    ensureDir,
    safeError,
    logger: console,
  },
});
activeLifecycle = appContext.lifecycle;

const projectUpgradeScheduler = createProjectUpgradeScheduler({
  manager: projectUpgradeManager,
  intervalMs: PROJECT_UPGRADE_CHECK_INTERVAL_MS,
  initialDelayMs: PROJECT_UPGRADE_INITIAL_DELAY_MS,
  notifyChannelIds: [...PROJECT_UPGRADE_NOTIFY_CHANNEL_IDS],
  getClient: getActiveDiscordClient,
  getRuntimeSnapshots: () => appContext.promptRuntime.getAllRuntimeSnapshots(),
  requestRestart: () => projectUpgradeManager.requestRestart(),
  stateFile: path.join(DATA_DIR, 'project-upgrade-notices.json'),
  heartbeatDir: path.join(DATA_DIR, 'project-upgrade-heartbeats'),
  heartbeatId: `${BOT_PROVIDER || 'shared'}-${process.pid}`,
  logger: console,
});

console.log([
  '🔐 Security defaults:',
  `• BOT_MODE=${BOT_MODE}`,
  `• DEFAULT_PROVIDER=${DEFAULT_PROVIDER}`,
  `• DEFAULT_MODE=${DEFAULT_MODE}`,
  `• CLAUDE_RUNTIME_MODE=${CLAUDE_RUNTIME_MODE}`,
  `• CLAUDE_LONG_IDLE_MS=${CLAUDE_LONG_IDLE_MS}`,
  `• CLAUDE_LONG_MAX_SESSIONS=${CLAUDE_LONG_MAX_SESSIONS}`,
  `• SLASH_PREFIX=${SLASH_PREFIX || '(none)'}`,
  `• SECURITY_PROFILE=${SECURITY_PROFILE}`,
  `• MENTION_ONLY=${MENTION_ONLY_OVERRIDE === null ? 'profile-default' : MENTION_ONLY_OVERRIDE}`,
  `• MENTION_ONLY_ENABLED_GUILD_IDS=${MENTION_ONLY_ENABLED_GUILD_IDS?.size ? [...MENTION_ONLY_ENABLED_GUILD_IDS].join(',') : '(none)'}`,
  `• MENTION_ONLY_DISABLED_GUILD_IDS=${MENTION_ONLY_DISABLED_GUILD_IDS?.size ? [...MENTION_ONLY_DISABLED_GUILD_IDS].join(',') : '(none)'}`,
  `• MENTION_ONLY_CHANNEL_IDS=${MENTION_ONLY_CHANNEL_IDS?.size ? [...MENTION_ONLY_CHANNEL_IDS].join(',') : '(none)'}`,
  `• CHILD_THREAD_WORKSPACE_MODE=${resolveChildThreadWorkspaceMode(BOT_PROVIDER || DEFAULT_PROVIDER).mode}`,
  `• MAX_QUEUE_PER_CHANNEL=${MAX_QUEUE_PER_CHANNEL_OVERRIDE === null ? 'profile-default' : MAX_QUEUE_PER_CHANNEL_OVERRIDE}`,
  `• ENABLE_CONFIG_CMD=${ENABLE_CONFIG_CMD}`,
  `• CONFIG_ALLOWLIST=${appContext.core.securityPolicy.describeConfigPolicy()}`,
  `• DEFAULT_UI_LANGUAGE=${DEFAULT_UI_LANGUAGE}`,
  `• DEFAULT_REPLY_DELIVERY_MODE=${formatReplyDeliveryModeLabel(resolveReplyDeliveryDefault().mode, DEFAULT_UI_LANGUAGE)}`,
  `• PROJECT_UPGRADE_MODE=${projectUpgradeManager.resolveConfig().mode}`,
  `• ONBOARDING_ENABLED_DEFAULT=${ONBOARDING_ENABLED_BY_DEFAULT}`,
].join('\n'));

try {
  await bootApp({
    lifecycle: appContext.lifecycle,
    singleInstanceLock: appContext.singleInstanceLock,
    reason: 'startup',
  });
  projectUpgradeScheduler.start();
} catch (err) {
  console.error(`❌ Failed to boot Discord client: ${safeError(err)}`);
  process.exit(1);
}
