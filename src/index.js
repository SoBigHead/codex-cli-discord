import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { safeReply, withDiscordNetworkRetry } from './discord-reply-utils.js';
import { splitForDiscord } from './discord-message-splitter.js';
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
import { createChannelQueue } from './channel-queue.js';
import { createChannelRuntimeStore, stopChildProcess } from './channel-runtime.js';
import { loadRuntimeEnv } from './env-loader.js';
import {
  appendRecentActivity as appendRecentActivityBase,
  appendCompletedStep as appendCompletedStepBase,
  cloneProgressPlan as cloneProgressPlanBase,
  extractRawProgressTextFromEvent as extractRawProgressTextFromEventBase,
  extractCompletedStepFromEvent as extractCompletedStepFromEventBase,
  extractPlanStateFromEvent as extractPlanStateFromEventBase,
  renderRecentActivitiesLines as renderRecentActivitiesLinesBase,
  formatProgressPlanSummary as formatProgressPlanSummaryBase,
  renderProgressPlanLines as renderProgressPlanLinesBase,
  summarizeCodexEvent as summarizeCodexEventBase,
} from './progress-utils.js';
import {
  buildProgressEventDedupeKey,
  composeFinalAnswerText,
  createProgressEventDeduper,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from './codex-event-utils.js';
import {
  formatCompletedMilestonesSummary,
  renderCompletedMilestonesLines,
} from './progress-milestones.js';
import { createRunnerExecutor } from './runner-executor.js';
import { createOnboardingFlow } from './onboarding-flow.js';
import { createSessionCommandActions } from './session-command-actions.js';
import { createSessionStore, ensureDir } from './session-store.js';
import { createSessionProgressBridgeFactory } from './session-progress-bridge.js';
import {
  buildSlashCommands,
  normalizeSlashCommandName as normalizeSlashCommandNameBase,
  registerSlashCommands,
  slashRef as slashRefBase,
} from './slash-command-surface.js';
import { createReportFormatters } from './report-formatters.js';
import {
  createSecurityPolicy,
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
  createSessionSettings,
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
  createSlashCommandRouter,
  parseCommandActionButtonId,
} from './slash-command-router.js';
import { createTextCommandHandler } from './text-command-handler.js';
import { createPromptOrchestrator } from './prompt-orchestrator.js';
import { autoRepairProxyEnv } from './proxy-env.js';
import { createDiscordAccessPolicy } from './discord-access-policy.js';
import { createDiscordEntryHandlers } from './discord-entry-handlers.js';
import * as discordMessageInput from './discord-message-input.js';
import {
  createDiscordLifecycle,
  isIgnorableDiscordRuntimeError,
  isRecoverableGatewayCloseCode,
} from './discord-lifecycle.js';
import { createSingleInstanceLock } from './single-instance-lock.js';
import { createWorkspaceRuntime } from './workspace-runtime.js';
import { createWorkspaceBrowser } from './workspace-browser.js';

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

const proxyRepair = autoRepairProxyEnv(ENV_FILE);
if (proxyRepair.logs.length) {
  for (const line of proxyRepair.logs) {
    console.log(line);
  }
}

// Optional proxy setup
//
// If you're behind a corporate / Clash / MITM HTTP proxy:
// - Set HTTP_PROXY for Discord REST (undici fetch)
// - Set SOCKS_PROXY for Discord Gateway WebSocket (recommended)
// - If your HTTP proxy does TLS MITM, set INSECURE_TLS=1 (NOT recommended)
//
// Note: SOCKS_PROXY for the Gateway requires a small patch to @discordjs/ws.
// See README for the patch script.

const HTTP_PROXY = process.env.HTTP_PROXY || null;
const SOCKS_PROXY = process.env.SOCKS_PROXY || null;
const INSECURE_TLS = String(process.env.INSECURE_TLS || '0') === '1';
let restProxyAgent = null;

if (HTTP_PROXY) {
  if (INSECURE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  restProxyAgent = new ProxyAgent({ uri: HTTP_PROXY });
  setGlobalDispatcher(restProxyAgent);
}

if (SOCKS_PROXY) {
  const socksAgent = new SocksProxyAgent(SOCKS_PROXY);
  globalThis.__discordWsAgent = socksAgent;
}

if (HTTP_PROXY || SOCKS_PROXY) {
  console.log(`🌐 Proxy: REST=${HTTP_PROXY || '(none)'} | WS=${SOCKS_PROXY || '(none)'} | INSECURE_TLS=${INSECURE_TLS}`);
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

// Read codex config.toml defaults for display
function getCodexDefaults() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const configPath = path.join(home, '.codex', 'config.toml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const modelMatch = raw.match(/^model\s*=\s*"([^"]+)"/m);
    const effortMatch = raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    return {
      model: modelMatch?.[1] || '(unknown)',
      effort: effortMatch?.[1] || '(unknown)',
    };
  } catch {
    return { model: '(unknown)', effort: '(unknown)' };
  }
}

function getSessionProvider(session) {
  return normalizeProvider(session?.provider || DEFAULT_PROVIDER);
}

function getSessionId(session) {
  const id = session?.runnerSessionId ?? session?.codexThreadId ?? null;
  const normalized = String(id || '').trim();
  return normalized || null;
}

function setSessionId(session, value) {
  if (!session || typeof session !== 'object') return null;
  const normalized = String(value || '').trim() || null;
  session.runnerSessionId = normalized;
  session.codexThreadId = normalized;
  return normalized;
}

function clearSessionId(session) {
  setSessionId(session, null);
}

function formatSessionIdLabel(sessionId) {
  return `\`${sessionId || '(auto — 下条消息新建)'}\``;
}

const {
  getSessionLanguage,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveCompactThresholdSetting,
  resolveNativeCompactTokenLimitSetting,
  getProviderDefaults,
} = createSessionSettings({
  defaultUiLanguage: DEFAULT_UI_LANGUAGE,
  securityProfile: SECURITY_PROFILE,
  codexTimeoutMs: CODEX_TIMEOUT_MS,
  compactStrategy: COMPACT_STRATEGY,
  compactOnThreshold: COMPACT_ON_THRESHOLD,
  maxInputTokensBeforeCompact: MAX_INPUT_TOKENS_BEFORE_COMPACT,
  modelAutoCompactTokenLimit: MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  readCodexDefaults: getCodexDefaults,
  normalizeProvider,
});

const {
  isConfigKeyAllowed,
  describeConfigPolicy,
  formatConfigCommandStatus,
  formatQueueLimit,
  resolveSecurityContext,
  formatSecurityProfileDisplay,
} = createSecurityPolicy({
  securityProfile: SECURITY_PROFILE,
  securityProfileDefaults: SECURITY_PROFILE_DEFAULTS,
  mentionOnlyOverride: MENTION_ONLY_OVERRIDE,
  maxQueuePerChannelOverride: MAX_QUEUE_PER_CHANNEL_OVERRIDE,
  enableConfigCmd: ENABLE_CONFIG_CMD,
  configPolicy: CONFIG_POLICY,
  getEffectiveSecurityProfile,
  permissionFlagsBits: PermissionFlagsBits,
});

console.log([
  '🔐 Security defaults:',
  `• BOT_MODE=${BOT_MODE}`,
  `• DEFAULT_PROVIDER=${DEFAULT_PROVIDER}`,
  `• SECURITY_PROFILE=${SECURITY_PROFILE}`,
  `• MENTION_ONLY=${MENTION_ONLY_OVERRIDE === null ? 'profile-default' : MENTION_ONLY_OVERRIDE}`,
  `• MAX_QUEUE_PER_CHANNEL=${MAX_QUEUE_PER_CHANNEL_OVERRIDE === null ? 'profile-default' : MAX_QUEUE_PER_CHANNEL_OVERRIDE}`,
  `• ENABLE_CONFIG_CMD=${ENABLE_CONFIG_CMD}`,
  `• CONFIG_ALLOWLIST=${describeConfigPolicy()}`,
  `• DEFAULT_UI_LANGUAGE=${DEFAULT_UI_LANGUAGE}`,
  `• ONBOARDING_ENABLED_DEFAULT=${ONBOARDING_ENABLED_BY_DEFAULT}`,
].join('\n'));

const sessionStore = createSessionStore({
  dataFile: DATA_FILE,
  workspaceRoot: WORKSPACE_ROOT,
  botProvider: BOT_PROVIDER,
  defaults: {
    provider: DEFAULT_PROVIDER,
    mode: DEFAULT_MODE,
    language: DEFAULT_UI_LANGUAGE,
    onboardingEnabled: ONBOARDING_ENABLED_BY_DEFAULT,
  },
  getSessionId,
  normalizeProvider,
  normalizeUiLanguage,
  normalizeSessionSecurityProfile,
  normalizeSessionTimeoutMs,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactTokenLimit,
  resolveDefaultWorkspace: resolveProviderDefaultWorkspace,
});
const {
  getSession,
  saveDb,
  ensureWorkspace,
  getWorkspaceBinding,
  listSessions: listStoredSessions,
  listFavoriteWorkspaces,
  addFavoriteWorkspace,
  removeFavoriteWorkspace,
} = sessionStore;

const commandActions = createSessionCommandActions({
  saveDb,
  ensureWorkspace,
  getWorkspaceBinding,
  listStoredSessions,
  resolveProviderDefaultWorkspace,
  setProviderDefaultWorkspace,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getProviderShortName,
  resolveTimeoutSetting,
  listRecentSessions: ({ provider = DEFAULT_PROVIDER, workspaceDir = '', limit = 10 } = {}) => listRecentProviderSessions({
    provider,
    workspaceDir,
    limit,
  }),
  humanAge,
});

const channelRuntimeStore = createChannelRuntimeStore({
  cloneProgressPlan,
  truncate,
});
const {
  getChannelState,
  setActiveRun,
  cancelChannelWork,
  cancelAllChannelWork,
  getRuntimeSnapshot,
} = channelRuntimeStore;

const { acquireWorkspace, readLock: readWorkspaceLock } = createWorkspaceRuntime({
  lockRoot: WORKSPACE_LOCK_ROOT,
  ensureDir,
});

let enqueuePrompt;
let runCodex;
let discordLifecycle = null;
const ONBOARDING_TOTAL_STEPS = 4;

function createClient() {
  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  if (restProxyAgent) {
    bot.rest.setAgent(restProxyAgent);
  }

  return bot;
}

// ── Slash Commands ──────────────────────────────────────────────

const slashCommands = buildSlashCommands({
  SlashCommandBuilder,
  slashPrefix: SLASH_PREFIX,
  botProvider: BOT_PROVIDER,
});
const normalizeSlashCommandName = (name) => normalizeSlashCommandNameBase(name, SLASH_PREFIX);
const slashRef = (base) => slashRefBase(base, SLASH_PREFIX);

const {
  isOnboardingEnabled,
  parseOnboardingConfigAction,
  formatOnboardingDisabledMessage,
  formatOnboardingConfigReport,
  formatOnboardingConfigHelp,
  formatOnboardingReport,
  isOnboardingButtonId,
  buildOnboardingActionRows,
  formatOnboardingStepReport,
  handleOnboardingButtonInteraction,
} = createOnboardingFlow({
  onboardingEnabledByDefault: ONBOARDING_ENABLED_BY_DEFAULT,
  defaultUiLanguage: DEFAULT_UI_LANGUAGE,
  onboardingTotalSteps: ONBOARDING_TOTAL_STEPS,
  workspaceRoot: WORKSPACE_ROOT,
  discordToken: DISCORD_TOKEN,
  allowedChannelIds: ALLOWED_CHANNEL_IDS,
  allowedUserIds: ALLOWED_USER_IDS,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  getSession,
  saveDb,
  getSessionProvider,
  getRuntimeSnapshot,
  getCliHealth,
  resolveSecurityContext,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  getSessionLanguage,
  normalizeUiLanguage,
  slashRef,
  formatCliHealth,
  formatLanguageLabel,
  formatSecurityProfileLabel,
  formatTimeoutLabel,
  formatQueueLimit,
  formatSecurityProfileDisplay,
  formatConfigCommandStatus,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
});

const {
  formatStatusReport,
  formatQueueReport,
  formatProgressReport,
  formatCancelReport,
  formatDoctorReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortHelp,
  formatLanguageConfigHelp,
  formatLanguageConfigReport,
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
} = createReportFormatters({
  botProvider: BOT_PROVIDER,
  allowedChannelIds: ALLOWED_CHANNEL_IDS,
  allowedUserIds: ALLOWED_USER_IDS,
  progressProcessLines: PROGRESS_PROCESS_LINES,
  progressPlanMaxLines: PROGRESS_PLAN_MAX_LINES,
  progressDoneStepsMax: PROGRESS_DONE_STEPS_MAX,
  slashRef,
  getSessionLanguage,
  normalizeUiLanguage,
  getSessionProvider,
  getProviderDisplayName,
  getProviderShortName,
  getProviderDefaults,
  getCliHealth,
  getRuntimeSnapshot,
  resolveSecurityContext,
  resolveTimeoutSetting,
  getEffectiveSecurityProfile,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveCompactThresholdSetting,
  resolveNativeCompactTokenLimitSetting,
  getWorkspaceBinding,
  readWorkspaceLock,
  formatCliHealth,
  formatPermissionsLabel,
  formatLanguageLabel,
  formatSecurityProfileDisplay,
  formatSecurityProfileLabel,
  formatQueueLimit,
  formatRuntimeLabel,
  formatTimeoutLabel,
  describeCompactStrategy,
  humanAge,
  formatTokenValue,
  formatConfigCommandStatus,
  describeConfigPolicy,
  formatSessionStatusLabel,
  formatProgressPlanSummary,
  formatCompletedStepsSummary,
  renderProcessContentLines,
  localizeProgressLines,
  renderProgressPlanLines,
  renderCompletedStepsLines,
});

const {
  openWorkspaceBrowser,
  handleWorkspaceBrowserInteraction,
  isWorkspaceBrowserComponentId,
} = createWorkspaceBrowser({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  commandActions,
  workspaceRoot: WORKSPACE_ROOT,
  getSession,
  getSessionLanguage,
  getSessionProvider,
  getWorkspaceBinding,
  listStoredSessions,
  listFavoriteWorkspaces,
  addFavoriteWorkspace,
  removeFavoriteWorkspace,
  resolveProviderDefaultWorkspace,
  formatWorkspaceUpdateReport,
  formatDefaultWorkspaceUpdateReport,
});

const routeSlashCommand = createSlashCommandRouter({
  botProvider: BOT_PROVIDER,
  defaultUiLanguage: DEFAULT_UI_LANGUAGE,
  slashRef,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  getSession,
  getSessionLanguage,
  getSessionProvider,
  getProviderDisplayName,
  getEffectiveSecurityProfile,
  getRuntimeSnapshot,
  resolveSecurityContext,
  resolveTimeoutSetting,
  isReasoningEffortSupported,
  commandActions,
  isOnboardingEnabled,
  buildOnboardingActionRows,
  formatOnboardingStepReport,
  formatOnboardingDisabledMessage,
  formatOnboardingConfigReport,
  formatStatusReport,
  formatQueueReport,
  formatDoctorReport,
  formatWorkspaceReport,
  formatWorkspaceSetHelp,
  formatWorkspaceUpdateReport,
  formatDefaultWorkspaceSetHelp,
  formatDefaultWorkspaceUpdateReport,
  formatLanguageConfigReport,
  formatProfileConfigHelp,
  formatProfileConfigReport,
  formatTimeoutConfigHelp,
  formatTimeoutConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortUnsupported,
  normalizeProvider,
  parseWorkspaceCommandAction,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigAction,
  cancelChannelWork,
  openWorkspaceBrowser,
  resolvePath,
  safeError,
});

const handleCommand = createTextCommandHandler({
  botProvider: BOT_PROVIDER,
  enableConfigCmd: ENABLE_CONFIG_CMD,
  getSession,
  saveDb,
  ensureWorkspace,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getSessionLanguage,
  getProviderDisplayName,
  getProviderShortName,
  commandActions,
  isOnboardingEnabled,
  safeReply,
  formatHelpReport,
  formatStatusReport,
  formatQueueReport,
  formatDoctorReport,
  formatWorkspaceReport,
  formatWorkspaceSetHelp,
  formatWorkspaceUpdateReport,
  formatDefaultWorkspaceSetHelp,
  formatDefaultWorkspaceUpdateReport,
  formatOnboardingConfigHelp,
  formatOnboardingConfigReport,
  formatOnboardingDisabledMessage,
  formatOnboardingReport,
  formatLanguageConfigHelp,
  formatLanguageConfigReport,
  formatProfileConfigHelp,
  formatProfileConfigReport,
  formatTimeoutConfigHelp,
  formatTimeoutConfigReport,
  formatProgressReport,
  formatCancelReport,
  formatCompactStrategyConfigHelp,
  formatCompactConfigReport,
  formatReasoningEffortHelp,
  formatReasoningEffortUnsupported,
  parseProviderInput,
  parseOnboardingConfigAction,
  parseUiLanguageInput,
  parseSecurityProfileInput,
  parseTimeoutConfigAction,
  parseCompactConfigFromText,
  parseConfigKey,
  parseReasoningEffortInput,
  parseWorkspaceCommandAction,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  describeConfigPolicy,
  isConfigKeyAllowed,
  isReasoningEffortSupported,
  cancelChannelWork,
  openWorkspaceBrowser,
  resolvePath,
  safeError,
});

// ── Message handler (prompts → Codex) ──────────────────────────

const discordAccessPolicy = createDiscordAccessPolicy({
  allowedChannelIds: ALLOWED_CHANNEL_IDS,
  allowedUserIds: ALLOWED_USER_IDS,
});

const discordEntryHandlers = createDiscordEntryHandlers({
  logger: console,
  registerSlashCommands,
  REST,
  Routes,
  discordToken: DISCORD_TOKEN,
  restProxyAgent,
  slashCommands,
  withDiscordNetworkRetry,
  safeReply,
  safeError,
  isIgnorableDiscordRuntimeError,
  isRecoverableGatewayCloseCode,
  accessPolicy: discordAccessPolicy,
  getSession,
  resolveSecurityContext,
  handleCommand,
  enqueuePrompt: (...args) => enqueuePrompt(...args),
  messageInput: discordMessageInput,
  parseCommandActionButtonId,
  isWorkspaceBrowserComponentId,
  isOnboardingButtonId,
  handleWorkspaceBrowserInteraction,
  handleOnboardingButtonInteraction,
  routeSlashCommand,
  normalizeSlashCommandName,
});

const singleInstanceLock = createSingleInstanceLock({
  dataDir: DATA_DIR,
  lockFile: LOCK_FILE,
  rootDir: ROOT,
  ensureDir,
  safeError,
  logger: console,
});
singleInstanceLock.acquire();
singleInstanceLock.setupCleanupHandlers();

discordLifecycle = createDiscordLifecycle({
  selfHealEnabled: SELF_HEAL_ENABLED,
  restartDelayMs: SELF_HEAL_RESTART_DELAY_MS,
  maxLoginBackoffMs: SELF_HEAL_MAX_LOGIN_BACKOFF_MS,
  discordToken: DISCORD_TOKEN,
  createClient,
  bindClientHandlers: discordEntryHandlers.bindClientHandlers,
  cancelAllChannelWork,
  safeError,
  logger: console,
});
discordLifecycle.setupProcessSelfHeal();
try {
  await discordLifecycle.bootClient('startup');
} catch (err) {
  console.error(`❌ Failed to boot Discord client: ${safeError(err)}`);
  process.exit(1);
}

function formatRuntimePhaseLabel(phase, language = 'en') {
  const value = String(phase || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'workspace') return 'waiting for workspace';
    return value || 'unknown';
  }
  switch (value) {
    case 'starting':
      return '启动中';
    case 'workspace':
      return '等待工作目录';
    case 'compact':
      return '上下文压缩';
    case 'exec':
      return '执行中';
    case 'retry':
      return '重试中';
    case 'done':
      return '已结束';
    default:
      return value || '未知';
  }
}

function localizeProgressLine(line, language = 'en') {
  if (language === 'en') return line;
  const text = String(line || '');
  return text
    .replace(/^• activity (\d+): /, '• 活动 $1：')
    .replace(/^• plan: received$/, '• 计划：已接收')
    .replace(/^• plan: (\d+)\/(\d+) completed(?:, (\d+) in progress)?$/, (_m, completed, total, inProgress) => (
      `• 计划：${completed}/${total} 已完成${inProgress ? `，${inProgress} 进行中` : ''}`
    ))
    .replace(/^• completed milestones: /, '• 已完成里程碑：')
    .replace(/^• completed steps: /, '• 已完成步骤：')
    .replace(/^  note: /, '  说明：')
    .replace(/^  … \+(\d+) more$/, '  … 还有 $1 项');
}

function localizeProgressLines(lines, language = 'en') {
  if (!Array.isArray(lines) || !lines.length) return [];
  return lines.map((line) => localizeProgressLine(line, language));
}

function renderProcessContentLines(activities, language = 'en', count = PROGRESS_PROCESS_LINES) {
  const limit = Math.max(1, Math.min(5, Number(count || PROGRESS_PROCESS_LINES)));
  const visible = Array.isArray(activities)
    ? activities
      .slice(-limit)
      .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    : [];
  if (!visible.length) return [];
  const title = language === 'en' ? '• process content:' : '• 过程内容：';
  return [
    title,
    ...visible.map((line) => `  · ${line}`),
  ];
}

function formatRuntimeLabel(runtime, language = 'en') {
  if (!runtime.running) return language === 'en' ? 'idle' : '空闲';
  const age = runtime.activeSinceMs === null ? (language === 'en' ? 'just-now' : '刚刚') : humanAge(runtime.activeSinceMs);
  const phaseLabel = runtime.phase ? formatRuntimePhaseLabel(runtime.phase, language) : '';
  const phase = phaseLabel ? `${language === 'en' ? ', phase=' : '，阶段='}${phaseLabel}` : '';
  const pid = runtime.pid ? `${language === 'en' ? ', pid=' : '，pid='}${runtime.pid}` : '';
  return language === 'en' ? `running (${age}${phase}${pid})` : `运行中（${age}${phase}${pid}）`;
}

function formatTimeoutLabel(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return 'off (no hard timeout)';
  return `${n}ms (~${humanAge(n)})`;
}

function formatSessionStatusLabel(session) {
  const sessionId = getSessionId(session);
  return session.name
    ? `**${session.name}** (${formatSessionIdLabel(sessionId || 'auto')})`
    : formatSessionIdLabel(sessionId);
}

function formatPermissionsLabel(session, language = 'en') {
  const provider = getSessionProvider(session);
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === 'gemini') {
    if (session.mode === 'dangerous') {
      return language === 'en'
        ? 'full access (--yolo)'
        : '完全权限（--yolo）';
    }
    return language === 'en'
      ? 'sandboxed (--sandbox --approval-mode default)'
      : '沙盒模式（--sandbox --approval-mode default）';
  }
  if (normalizedProvider === 'claude') {
    if (session.mode === 'dangerous') {
      return language === 'en'
        ? 'full access (--dangerously-skip-permissions)'
        : '完全权限（--dangerously-skip-permissions）';
    }
    return language === 'en'
      ? 'auto-edit (--permission-mode acceptEdits)'
      : '自动编辑（--permission-mode acceptEdits）';
  }
  if (session.mode === 'dangerous') {
    return language === 'en'
      ? 'full access (--dangerously-bypass-approvals-and-sandbox)'
      : '完全权限（--dangerously-bypass-approvals-and-sandbox）';
  }
  return language === 'en'
    ? 'sandboxed (--full-auto)'
    : '沙盒模式（--full-auto）';
}

function summarizeCodexEvent(ev) {
  return summarizeCodexEventBase(ev, {
    showReasoning: SHOW_REASONING,
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
  });
}

function extractRawProgressTextFromEvent(ev) {
  return extractRawProgressTextFromEventBase(ev);
}

function cloneProgressPlan(planState) {
  return cloneProgressPlanBase(planState, {
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
  });
}

function extractPlanStateFromEvent(ev) {
  return extractPlanStateFromEventBase(ev, {
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
  });
}

function extractCompletedStepFromEvent(ev) {
  return extractCompletedStepFromEventBase(ev, {
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
  });
}

function appendCompletedStep(list, stepText) {
  appendCompletedStepBase(list, stepText, {
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
    doneStepsMax: PROGRESS_DONE_STEPS_MAX,
  });
}

function appendRecentActivity(list, activityText) {
  appendRecentActivityBase(list, activityText, {
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
    maxSteps: 5,
    truncateText: false,
    preserveWhitespace: true,
  });
}

function formatProgressPlanSummary(planState) {
  return formatProgressPlanSummaryBase(planState);
}

function renderProgressPlanLines(planState, maxLines = PROGRESS_PLAN_MAX_LINES) {
  return renderProgressPlanLinesBase(planState, maxLines);
}

function renderRecentActivitiesLines(activities, maxLines = PROGRESS_ACTIVITY_MAX_LINES) {
  return renderRecentActivitiesLinesBase(activities, {
    maxSteps: Math.max(1, Number(maxLines || PROGRESS_ACTIVITY_MAX_LINES)),
    previewChars: PROGRESS_TEXT_PREVIEW_CHARS,
  });
}

function formatCompletedStepsSummary(steps, options = {}) {
  return formatCompletedMilestonesSummary(steps, {
    ...options,
    maxSteps: Math.max(1, Number(options.maxSteps || PROGRESS_DONE_STEPS_MAX)),
  });
}

function renderCompletedStepsLines(steps, options = {}) {
  return renderCompletedMilestonesLines(steps, {
    ...options,
    maxSteps: Math.max(1, Number(options.maxSteps || PROGRESS_DONE_STEPS_MAX)),
  });
}

const { startSessionProgressBridge } = createSessionProgressBridgeFactory({
  normalizeProvider,
  extractRawProgressTextFromEvent: extractRawProgressTextFromEventBase,
  findLatestRolloutFileBySessionId,
  findLatestClaudeSessionFileBySessionId,
});

({ runCodex } = createRunnerExecutor({
  debugEvents: DEBUG_EVENTS,
  spawnEnv: SPAWN_ENV,
  defaultTimeoutMs: CODEX_TIMEOUT_MS,
  defaultModel: DEFAULT_MODEL,
  ensureDir,
  normalizeProvider,
  getSessionProvider,
  getProviderBin,
  getSessionId,
  getProviderDefaultWorkspace: resolveProviderDefaultWorkspace,
  resolveTimeoutSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveNativeCompactTokenLimitSetting,
  normalizeTimeoutMs,
  safeError,
  stopChildProcess,
  startSessionProgressBridge,
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
  readGeminiSessionState,
}));

const { handlePrompt } = createPromptOrchestrator({
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
  getSession,
  ensureWorkspace,
  saveDb,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getSessionLanguage,
  normalizeUiLanguage,
  getProviderDisplayName,
  getProviderShortName,
  getProviderDefaultBin,
  getProviderBinEnvName,
  resolveTimeoutSetting,
  resolveCompactStrategySetting,
  resolveCompactEnabledSetting,
  resolveCompactThresholdSetting,
  formatWorkspaceBusyReport,
  formatTimeoutLabel,
  setActiveRun,
  acquireWorkspace,
  stopChildProcess,
  runTask: (options) => runCodex(options),
  isCliNotFound,
  slashRef,
  safeError,
  truncate,
  toOptionalInt,
  humanElapsed,
  summarizeCodexEvent,
  extractRawProgressTextFromEvent,
  cloneProgressPlan,
  extractPlanStateFromEvent,
  extractCompletedStepFromEvent,
  appendCompletedStep,
  appendRecentActivity,
  formatProgressPlanSummary,
  renderProcessContentLines,
  localizeProgressLines,
  renderProgressPlanLines,
  renderCompletedStepsLines,
  formatRuntimePhaseLabel,
  createProgressEventDeduper,
  buildProgressEventDedupeKey,
  extractInputTokensFromUsage,
  composeFinalAnswerText,
});

({ enqueuePrompt } = createChannelQueue({
  getChannelState,
  getSession,
  resolveSecurityContext,
  safeReply,
  safeError,
  getCurrentUserId: () => discordLifecycle?.getClient()?.user?.id,
  handlePrompt,
}));

function normalizeSlashPrefix(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '';
  return raw.slice(0, 12);
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toOptionalInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function normalizeIntervalMs(value, fallback, min = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.floor(n));
}

function formatTokenValue(value) {
  const n = toOptionalInt(value);
  return n === null ? '(unknown)' : `${n}`;
}

function extractInputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const directKeys = [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'input_token_count',
    'prompt_token_count',
  ];

  for (const key of directKeys) {
    const n = toOptionalInt(usage[key]);
    if (n !== null) return n;
  }

  const queue = [usage];
  const seen = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
        continue;
      }

      const n = toOptionalInt(value);
      if (n === null) continue;
      if (/input.*token|token.*input|prompt.*token|token.*prompt/i.test(key)) {
        return n;
      }
    }
  }

  return null;
}

function renderMissingDiscordTokenHint({ botProvider = null, env = process.env } = {}) {
  if (botProvider) {
    return `Missing Discord token in environment (${`DISCORD_TOKEN_${botProvider.toUpperCase()}`} or DISCORD_TOKEN)`;
  }

  const hasCodexScopedToken = Boolean(String(env.CODEX__DISCORD_TOKEN || env.DISCORD_TOKEN_CODEX || '').trim());
  const hasClaudeScopedToken = Boolean(String(env.CLAUDE__DISCORD_TOKEN || env.DISCORD_TOKEN_CLAUDE || '').trim());
  const hasGeminiScopedToken = Boolean(String(env.GEMINI__DISCORD_TOKEN || env.DISCORD_TOKEN_GEMINI || '').trim());

  if (hasCodexScopedToken || hasClaudeScopedToken || hasGeminiScopedToken) {
    const availableProviders = [
      hasCodexScopedToken ? 'codex' : null,
      hasClaudeScopedToken ? 'claude' : null,
      hasGeminiScopedToken ? 'gemini' : null,
    ].filter(Boolean).join(', ');
    return `Missing DISCORD_TOKEN in shared mode. Found provider-scoped tokens for: ${availableProviders}. Start with npm run start:codex / npm run start:claude / npm run start:gemini, or add a shared DISCORD_TOKEN.`;
  }

  return 'Missing DISCORD_TOKEN in environment';
}

function safeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function humanAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function humanElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ${s % 60}s`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m ${s % 60}s`;
}
