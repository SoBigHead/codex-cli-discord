import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeReply, withDiscordNetworkRetry } from './discord-reply-utils.js';
import { splitForDiscord } from './discord-message-splitter.js';
import { bootApp, createAppContext } from './app-context.js';
import {
  appendProviderSuffix,
  describeBotMode,
  getDefaultSlashPrefix,
  parseOptionalProvider,
  resolveDiscordToken,
} from './bot-instance-utils.js';
import {
  formatReasoningEffortUnsupported,
  getProviderBinEnvName,
  getProviderDefaultBin,
  getProviderDisplayName,
  getProviderShortName,
  isReasoningEffortSupported,
  normalizeProvider,
  parseProviderInput,
} from './provider-metadata.js';
import {
  buildSpawnEnv,
  formatCliHealth,
  getCliHealth as getCliHealthBase,
  getProviderBin as getProviderBinBase,
  isCliNotFound,
} from './provider-runtime.js';
import {
  findLatestClaudeSessionFileBySessionId,
  findLatestRolloutFileBySessionId,
  listRecentSessions as listRecentProviderSessions,
  readGeminiSessionState,
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
  createProviderDefaultWorkspaceStore,
  resolveConfiguredWorkspaceDir,
  resolvePath,
} from './provider-default-workspace.js';
import {
  describeCompactStrategy,
  formatLanguageLabel,
  formatSecurityProfileLabel,
  normalizeCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactTokenLimit,
  normalizeSessionSecurityProfile,
  normalizeSessionTimeoutMs,
  normalizeTimeoutMs,
  normalizeUiLanguage,
  parseCompactConfigAction,
  parseCompactConfigFromText,
  parseReasoningEffortInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseUiLanguageInput,
  parseWorkspaceCommandAction,
} from './session-settings.js';
import {
  buildCommandActionButtonId,
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
  renderMissingDiscordTokenHint,
} from './runtime-bootstrap.js';
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

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  REST,
  Routes,
} = await import('discord.js');

const DISCORD_TOKEN = resolveDiscordToken({ botProvider: BOT_PROVIDER, env: process.env });
if (!DISCORD_TOKEN) {
  console.error(renderMissingDiscordTokenHint({ botProvider: BOT_PROVIDER, env: process.env }));
  process.exit(1);
}

const ALLOWED_CHANNEL_IDS = parseCsvSet(process.env.ALLOWED_CHANNEL_IDS);
const ALLOWED_USER_IDS = parseCsvSet(process.env.ALLOWED_USER_IDS);
const SECURITY_PROFILE = normalizeSecurityProfile(process.env.SECURITY_PROFILE || 'auto');
const SECURITY_PROFILE_DEFAULTS = Object.freeze({
  solo: { mentionOnly: false, maxQueuePerChannel: 0 },
  team: { mentionOnly: false, maxQueuePerChannel: 20 },
  public: { mentionOnly: true, maxQueuePerChannel: 20 },
});
const MENTION_ONLY_OVERRIDE = parseOptionalBool(process.env.MENTION_ONLY);
const MAX_QUEUE_PER_CHANNEL_OVERRIDE = normalizeQueueLimit(process.env.MAX_QUEUE_PER_CHANNEL);
const ENABLE_CONFIG_CMD = String(process.env.ENABLE_CONFIG_CMD || 'false').toLowerCase() === 'true';
const CONFIG_POLICY = parseConfigAllowlist(
  process.env.CONFIG_ALLOWLIST || 'personality,model_reasoning_effort,model_auto_compact_token_limit',
);

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspaces');
const WORKSPACE_LOCK_ROOT = path.join(DATA_DIR, 'workspace-locks');
const SHARED_DEFAULT_WORKSPACE_DIR = resolveConfiguredWorkspaceDir(process.env.DEFAULT_WORKSPACE_DIR);
const PROVIDER_DEFAULT_WORKSPACE_OVERRIDES = {
  codex: resolveConfiguredWorkspaceDir(process.env.CODEX__DEFAULT_WORKSPACE_DIR),
  claude: resolveConfiguredWorkspaceDir(process.env.CLAUDE__DEFAULT_WORKSPACE_DIR),
  gemini: resolveConfiguredWorkspaceDir(process.env.GEMINI__DEFAULT_WORKSPACE_DIR),
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
const COMPACT_STRATEGY = normalizeCompactStrategy(process.env.COMPACT_STRATEGY || 'hard');
const COMPACT_ON_THRESHOLD = String(process.env.COMPACT_ON_THRESHOLD || 'true').toLowerCase() !== 'false';
const MODEL_AUTO_COMPACT_TOKEN_LIMIT = toInt(
  process.env.MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  MAX_INPUT_TOKENS_BEFORE_COMPACT,
);
const SLASH_PREFIX = normalizeSlashPrefix(process.env.SLASH_PREFIX || getDefaultSlashPrefix(BOT_PROVIDER));
const SPAWN_ENV = buildSpawnEnv(process.env);
const getProviderBin = (provider) => getProviderBinBase(provider, {
  codexBin: CODEX_BIN,
  claudeBin: CLAUDE_BIN,
  geminiBin: GEMINI_BIN,
});
const getCliHealth = (provider = DEFAULT_PROVIDER) => getCliHealthBase(provider, {
  codexBin: CODEX_BIN,
  claudeBin: CLAUDE_BIN,
  geminiBin: GEMINI_BIN,
  spawnEnv: SPAWN_ENV,
  safeError,
});

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
    compactOnThreshold: COMPACT_ON_THRESHOLD,
    maxInputTokensBeforeCompact: MAX_INPUT_TOKENS_BEFORE_COMPACT,
    modelAutoCompactTokenLimit: MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    readCodexDefaults,
    normalizeProvider,
  },
  securityPolicyOptions: {
    securityProfile: SECURITY_PROFILE,
    securityProfileDefaults: SECURITY_PROFILE_DEFAULTS,
    mentionOnlyOverride: MENTION_ONLY_OVERRIDE,
    maxQueuePerChannelOverride: MAX_QUEUE_PER_CHANNEL_OVERRIDE,
    enableConfigCmd: ENABLE_CONFIG_CMD,
    configPolicy: CONFIG_POLICY,
    permissionFlagsBits: PermissionFlagsBits,
  },
  sessionStoreOptions: {
    dataFile: DATA_FILE,
    workspaceRoot: WORKSPACE_ROOT,
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
    normalizeSessionTimeoutMs,
    normalizeSessionCompactStrategy,
    normalizeSessionCompactEnabled,
    normalizeSessionCompactTokenLimit,
    resolveDefaultWorkspace: resolveProviderDefaultWorkspace,
  },
  commandActionsOptions: {
    resolveProviderDefaultWorkspace,
    setProviderDefaultWorkspace,
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
      safeReply,
      withDiscordNetworkRetry,
      splitForDiscord,
      normalizeUiLanguage,
      getProviderDisplayName,
      getProviderShortName,
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
      buildRunningComponents: ({ message }) => {
        const userId = String(message?.author?.id || '').trim();
        if (!userId) return [];
        return [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(buildCommandActionButtonId('cancel', userId))
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Danger),
          ),
        ];
      },
    },
    channelQueueOptions: {
      safeReply,
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
      allowedUserIds: ALLOWED_USER_IDS,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      getCliHealth,
      normalizeUiLanguage,
      formatCliHealth,
      formatLanguageLabel,
      formatSecurityProfileLabel,
      parseUiLanguageInput,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
    },
    reportOptions: {
      botProvider: BOT_PROVIDER,
      allowedChannelIds: ALLOWED_CHANNEL_IDS,
      allowedUserIds: ALLOWED_USER_IDS,
      progressProcessLines: PROGRESS_PROCESS_LINES,
      progressPlanMaxLines: PROGRESS_PLAN_MAX_LINES,
      progressDoneStepsMax: PROGRESS_DONE_STEPS_MAX,
      normalizeUiLanguage,
      getProviderDisplayName,
      getProviderShortName,
      getCliHealth,
      formatCliHealth,
      formatLanguageLabel,
      formatSecurityProfileLabel,
      describeCompactStrategy,
      humanAge,
      formatTokenValue,
    },
    workspaceBrowserOptions: {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      workspaceRoot: WORKSPACE_ROOT,
      resolveProviderDefaultWorkspace,
    },
    slashRouterOptions: {
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      getProviderDisplayName,
      isReasoningEffortSupported,
      formatReasoningEffortUnsupported,
      normalizeProvider,
      parseWorkspaceCommandAction,
      parseUiLanguageInput,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
      parseCompactConfigAction,
      resolvePath,
      safeError,
    },
    textCommandOptions: {
      getProviderDisplayName,
      getProviderShortName,
      safeReply,
      formatReasoningEffortUnsupported,
      parseProviderInput,
      parseUiLanguageInput,
      parseSecurityProfileInput,
      parseTimeoutConfigAction,
      parseCompactConfigFromText,
      parseConfigKey,
      parseReasoningEffortInput,
      parseWorkspaceCommandAction,
      isReasoningEffortSupported,
      resolvePath,
      safeError,
    },
  },
  accessPolicyOptions: {
    allowedChannelIds: ALLOWED_CHANNEL_IDS,
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
    safeReply,
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

console.log([
  '🔐 Security defaults:',
  `• BOT_MODE=${BOT_MODE}`,
  `• DEFAULT_PROVIDER=${DEFAULT_PROVIDER}`,
  `• SECURITY_PROFILE=${SECURITY_PROFILE}`,
  `• MENTION_ONLY=${MENTION_ONLY_OVERRIDE === null ? 'profile-default' : MENTION_ONLY_OVERRIDE}`,
  `• MAX_QUEUE_PER_CHANNEL=${MAX_QUEUE_PER_CHANNEL_OVERRIDE === null ? 'profile-default' : MAX_QUEUE_PER_CHANNEL_OVERRIDE}`,
  `• ENABLE_CONFIG_CMD=${ENABLE_CONFIG_CMD}`,
  `• CONFIG_ALLOWLIST=${appContext.core.securityPolicy.describeConfigPolicy()}`,
  `• DEFAULT_UI_LANGUAGE=${DEFAULT_UI_LANGUAGE}`,
  `• ONBOARDING_ENABLED_DEFAULT=${ONBOARDING_ENABLED_BY_DEFAULT}`,
].join('\n'));

try {
  await bootApp({
    lifecycle: appContext.lifecycle,
    singleInstanceLock: appContext.singleInstanceLock,
    reason: 'startup',
  });
} catch (err) {
  console.error(`❌ Failed to boot Discord client: ${safeError(err)}`);
  process.exit(1);
}
