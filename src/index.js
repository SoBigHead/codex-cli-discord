import { spawnSync } from 'node:child_process';
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
import { createSessionStore, ensureDir, ensureGitRepo } from './session-store.js';
import { createSessionProgressBridgeFactory } from './session-progress-bridge.js';
import {
  buildSlashCommands,
  normalizeSlashCommandName as normalizeSlashCommandNameBase,
  registerSlashCommands,
  slashRef as slashRefBase,
} from './slash-command-surface.js';
import { createTextCommandHandler } from './text-command-handler.js';

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
const DEFAULT_PROVIDER = BOT_PROVIDER || normalizeProvider(process.env.DEFAULT_PROVIDER || process.env.CLI_PROVIDER || 'codex');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
const DEFAULT_MODE = (process.env.DEFAULT_MODE || 'safe').toLowerCase() === 'dangerous' ? 'dangerous' : 'safe';
const DEFAULT_UI_LANGUAGE = normalizeUiLanguage(process.env.DEFAULT_UI_LANGUAGE || 'zh');
const ONBOARDING_ENABLED_DEFAULT = parseOptionalBool(process.env.ONBOARDING_ENABLED_DEFAULT);
const ONBOARDING_ENABLED_BY_DEFAULT = ONBOARDING_ENABLED_DEFAULT === null ? true : ONBOARDING_ENABLED_DEFAULT;
const CODEX_TIMEOUT_MS = normalizeTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0);
const CODEX_BIN = (process.env.CODEX_BIN || 'codex').trim() || 'codex';
const CLAUDE_BIN = (process.env.CLAUDE_BIN || 'claude').trim() || 'claude';
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

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'claude' ? 'claude' : 'codex';
}

function getSessionProvider(session) {
  return normalizeProvider(session?.provider || DEFAULT_PROVIDER);
}

function getProviderDisplayName(provider) {
  return normalizeProvider(provider) === 'claude' ? 'Claude Code' : 'Codex';
}

function getProviderShortName(provider) {
  return normalizeProvider(provider) === 'claude' ? 'Claude' : 'Codex';
}

function getProviderDefaultBin(provider) {
  return normalizeProvider(provider) === 'claude' ? 'claude' : 'codex';
}

function getProviderBin(provider) {
  return normalizeProvider(provider) === 'claude' ? CLAUDE_BIN : CODEX_BIN;
}

function getProviderBinEnvName(provider) {
  return normalizeProvider(provider) === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN';
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
  normalizeSessionProcessLines,
  normalizeSessionCompactStrategy,
  normalizeSessionCompactEnabled,
  normalizeSessionCompactTokenLimit,
});
const { getSession, saveDb, ensureWorkspace } = sessionStore;

const commandActions = createSessionCommandActions({
  saveDb,
  ensureWorkspace,
  clearSessionId,
  getSessionId,
  setSessionId,
  getSessionProvider,
  getProviderShortName,
  resolveTimeoutSetting,
  resolveProcessLinesSetting,
  ensureGitRepo,
  listRecentSessions,
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

let enqueuePrompt;
let runCodex;

let client = null;
let selfHealTimer = null;
let selfHealInFlight = false;
let lockFd = null;
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

function bindClientHandlers(bot) {
  bot.once('ready', async () => {
    console.log(`✅ Logged in as ${bot.user.tag}`);
    await registerSlashCommands({
      client: bot,
      REST,
      Routes,
      discordToken: DISCORD_TOKEN,
      restProxyAgent,
      slashCommands,
      logger: console,
    });
  });

  // Auto-join threads so we receive messageCreate events in them
  bot.on('threadCreate', async (thread) => {
    try {
      await joinThreadWithRetry(thread, 'threadCreate');
      console.log(`🧵 Joined thread: ${thread.name} (${thread.id})`);
    } catch (err) {
      console.error(`Failed to join thread ${thread.id}:`, err.message);
    }
  });

  // Also join existing threads on startup
  bot.on('threadListSync', (threads) => {
    for (const thread of threads.values()) {
      if (!thread.joined) {
        joinThreadWithRetry(thread, 'threadListSync')
          .then(() => console.log(`🧵 Synced into thread: ${thread.name}`))
          .catch((err) => console.error(`Failed to sync thread ${thread.id}:`, err.message));
      }
    }
  });

  bot.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (message.system) return;
      if (!isAllowedUser(message.author.id)) return;
      const channelAllowed = isAllowedChannel(message.channel);
      const key = message.channel.id;
      const session = getSession(key);
      const security = resolveSecurityContext(message.channel, session);

      // Debug: log all incoming messages
      const chId = message.channel.id;
      const parentId = message.channel.isThread?.() ? message.channel.parentId : null;
      const attachmentCount = message.attachments?.size || 0;
      console.log(`[msg] ch=${chId} parent=${parentId} author=${message.author.tag} allowed=${channelAllowed} profile=${security.profile} mentionOnly=${security.mentionOnly} contentLen=${message.content.length} attachments=${attachmentCount} system=${message.system}`);

      if (!channelAllowed) return;

      // Strip bot mention if present, otherwise use raw content
      const rawContent = message.content
        .replace(new RegExp(`<@!?${bot.user.id}>`, 'g'), '')
        .trim();
      const isCommand = rawContent.startsWith('!');

      if (isCommand) {
        await handleCommand(message, key, rawContent);
        return;
      }

      if (security.mentionOnly && !doesMessageTargetBot(message, bot.user.id)) return;

      const content = buildPromptFromMessage(rawContent, message.attachments);
      if (!content) return;
      await enqueuePrompt(message, key, content, security);
    } catch (err) {
      console.error('messageCreate handler error:', err);
      try {
        await message.reactions.cache.get('⚡')?.users.remove(bot.user?.id).catch(() => {});
        await message.react('❌').catch(() => {});
        await safeReply(message, `❌ 处理失败：${safeError(err)}`);
      } catch {
        // ignore
      }
    }
  });

  bot.on('interactionCreate', handleInteractionCreate);

  bot.on('error', (err) => {
    if (isIgnorableDiscordRuntimeError(err)) {
      console.warn(`Ignoring non-fatal Discord client error: ${safeError(err)}`);
      return;
    }
    console.error('Discord client error:', err);
    scheduleSelfHeal('client_error', err);
  });

  bot.on('shardError', (err, shardId) => {
    console.error(`Discord shard error (shard=${shardId}):`, err);
    scheduleSelfHeal(`shard_error:${shardId}`, err);
  });

  bot.on('shardDisconnect', (event, shardId) => {
    const code = event?.code ?? 'unknown';
    const recoverable = isRecoverableGatewayCloseCode(code);
    console.warn(`Discord shard disconnected (shard=${shardId}, code=${code}, recoverable=${recoverable})`);
    if (recoverable) {
      scheduleSelfHeal(`shard_disconnect:${shardId}:code=${code}`);
    }
  });

  bot.on('invalidated', () => {
    console.error('Discord session invalidated.');
    scheduleSelfHeal('session_invalidated');
  });
}

async function joinThreadWithRetry(thread, context = 'thread.join') {
  if (!thread || thread.joined) return;

  await withDiscordNetworkRetry(
    () => thread.join(),
    {
      logger: console,
      label: `${context} thread.join (${thread.id})`,
      maxAttempts: 4,
      baseDelayMs: 500,
    },
  );
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

async function handleInteractionCreate(interaction) {
  if (interaction.isButton()) {
    if (!isOnboardingButtonId(interaction.customId)) return;
    try {
      if (!isAllowedUser(interaction.user.id)) {
        await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
        return;
      }
      if (!(await isAllowedInteractionChannel(interaction))) {
        await interaction.reply({ content: '⛔ 当前频道未开放。', flags: 64 });
        return;
      }
      await handleOnboardingButtonInteraction(interaction);
    } catch (err) {
      await safeInteractionFailureReply(interaction, err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
    return;
  }

  try {
    // ACK early to avoid Discord 3-second interaction timeout under transient latency.
    await interaction.deferReply({ flags: 64 });
    const respond = (payload) => sendInteractionResponse(interaction, payload);

    if (!(await isAllowedInteractionChannel(interaction))) {
      await respond({ content: '⛔ 当前频道未开放。', flags: 64 });
      return;
    }

    const key = interaction.channelId;
    if (!key) {
      await respond({ content: '❌ 无法识别当前频道。', flags: 64 });
      return;
    }
    const session = getSession(key);
    const cmd = normalizeSlashCommandName(interaction.commandName);

    switch (cmd) {
      case 'status': {
        await respond({
          content: formatStatusReport(key, session, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'reset': {
        commandActions.resetSession(session);
        await respond('♻️ 会话已清空，下条消息新开上下文。');
        break;
      }

      case 'sessions': {
        try {
          await respond({
            content: commandActions.formatRecentSessionsReport({
              key,
              session,
              resumeRef: slashRef('resume'),
            }),
            flags: 64,
          });
        } catch (err) {
          await respond({ content: `❌ ${safeError(err)}`, flags: 64 });
        }
        break;
      }

      case 'setdir': {
        const p = interaction.options.getString('path');
        const resolved = resolvePath(p);
        if (!fs.existsSync(resolved)) {
          await respond({ content: `❌ 目录不存在：\`${resolved}\``, flags: 64 });
          break;
        }
        commandActions.setWorkspaceDir(session, resolved);
        await respond(`✅ workspace → \`${resolved}\`（会话已重置）`);
        break;
      }

      case 'provider': {
        if (BOT_PROVIDER) {
          await respond({
            content: `🔒 当前 bot 已锁定 provider = \`${BOT_PROVIDER}\` (${getProviderDisplayName(BOT_PROVIDER)})，不能在频道内切换。`,
            flags: 64,
          });
          break;
        }
        const requested = normalizeProvider(interaction.options.getString('name'));
        if (interaction.options.getString('name') === 'status') {
          await respond({
            content: `ℹ️ 当前 provider = \`${getSessionProvider(session)}\` (${getProviderDisplayName(getSessionProvider(session))})`,
            flags: 64,
          });
          break;
        }
        const { previous } = commandActions.setProvider(session, requested);
        await respond(`✅ provider = \`${requested}\` (${getProviderDisplayName(requested)})${previous === requested ? '' : '，已清空旧 session 绑定'}`);
        break;
      }

      case 'model': {
        const name = interaction.options.getString('name');
        const { model } = commandActions.setModel(session, name);
        await respond(`✅ model = ${model || '(default)'}`);
        break;
      }

      case 'effort': {
        const level = interaction.options.getString('level');
        const provider = getSessionProvider(session);
        if (!isReasoningEffortSupported(provider, level)) {
          await respond({
            content: formatReasoningEffortUnsupported(provider, getSessionLanguage(session)),
            flags: 64,
          });
          break;
        }
        const { effort } = commandActions.setReasoningEffort(session, level);
        await respond(`✅ effort = ${effort || '(default)'}`);
        break;
      }

      case 'compact': {
        const language = getSessionLanguage(session);
        const parsed = parseCompactConfigAction(
          interaction.options.getString('key'),
          interaction.options.getString('value') || '',
        );
        if (!parsed || parsed.type === 'invalid') {
          await respond({
            content: formatCompactStrategyConfigHelp(language),
            flags: 64,
          });
          break;
        }
        if (parsed.type === 'status') {
          await respond({
            content: formatCompactConfigReport(language, session, false),
            flags: 64,
          });
          break;
        }
        commandActions.applyCompactConfig(session, parsed);
        await respond({
          content: formatCompactConfigReport(language, session, true),
          flags: 64,
        });
        break;
      }

      case 'mode': {
        const type = interaction.options.getString('type');
        const { mode } = commandActions.setMode(session, type);
        await respond(`✅ mode = ${mode}`);
        break;
      }

      case 'resume': {
        const sid = interaction.options.getString('session_id');
        const binding = commandActions.bindSession(session, sid);
        await respond(`✅ 已绑定 ${binding.providerLabel} session: \`${binding.sessionId}\``);
        break;
      }

      case 'name': {
        const label = interaction.options.getString('label').trim();
        const renamed = commandActions.renameSession(session, label);
        await respond(`✅ session 命名为: **${renamed.label}**`);
        break;
      }

      case 'queue': {
        await respond({
          content: formatQueueReport(key, session, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'doctor': {
        await respond({
          content: formatDoctorReport(key, session, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'onboarding': {
        const language = getSessionLanguage(session);
        if (!isOnboardingEnabled(session)) {
          await respond({
            content: formatOnboardingDisabledMessage(language),
            flags: 64,
          });
          break;
        }
        const step = 1;
        await respond({
          content: formatOnboardingStepReport(step, key, session, interaction.channel, language),
          components: buildOnboardingActionRows(step, interaction.user.id, session, language),
          flags: 64,
        });
        break;
      }

      case 'onboarding_config': {
        const action = String(interaction.options.getString('action') || '').trim().toLowerCase();
        const language = getSessionLanguage(session);
        if (action === 'on' || action === 'off') {
          const { enabled } = commandActions.setOnboardingEnabled(session, action === 'on');
          await respond({
            content: formatOnboardingConfigReport(language, enabled, true),
            flags: 64,
          });
          break;
        }
        await respond({
          content: formatOnboardingConfigReport(language, isOnboardingEnabled(session), false),
          flags: 64,
        });
        break;
      }

      case 'language': {
        const requested = interaction.options.getString('name');
        const { language } = commandActions.setLanguage(session, parseUiLanguageInput(requested) || DEFAULT_UI_LANGUAGE);
        await respond({
          content: formatLanguageConfigReport(language, true),
          flags: 64,
        });
        break;
      }

      case 'profile': {
        const requested = interaction.options.getString('name');
        if (String(requested || '').toLowerCase() === 'status') {
          await respond({
            content: formatProfileConfigReport(getSessionLanguage(session), getEffectiveSecurityProfile(session).profile, false),
            flags: 64,
          });
          break;
        }
        const profile = parseSecurityProfileInput(requested);
        if (!profile) {
          await respond({
            content: formatProfileConfigHelp(getSessionLanguage(session)),
            flags: 64,
          });
          break;
        }
        const updated = commandActions.setSecurityProfile(session, profile);
        await respond({
          content: formatProfileConfigReport(getSessionLanguage(session), updated.profile, true),
          flags: 64,
        });
        break;
      }

      case 'timeout': {
        const language = getSessionLanguage(session);
        const parsedTimeout = parseTimeoutConfigAction(interaction.options.getString('value'));
        if (!parsedTimeout || parsedTimeout.type === 'invalid') {
          await respond({
            content: formatTimeoutConfigHelp(language),
            flags: 64,
          });
          break;
        }
        if (parsedTimeout.type === 'status') {
          await respond({
            content: formatTimeoutConfigReport(language, resolveTimeoutSetting(session), false),
            flags: 64,
          });
          break;
        }
        const { timeoutSetting } = commandActions.setTimeoutMs(session, parsedTimeout.timeoutMs);
        await respond({
          content: formatTimeoutConfigReport(language, timeoutSetting, true),
          flags: 64,
        });
        break;
      }

      case 'process_lines': {
        const language = getSessionLanguage(session);
        const parsed = parseProcessLinesConfigAction(interaction.options.getString('value'));
        if (!parsed || parsed.type === 'invalid') {
          await respond({
            content: formatProcessLinesConfigHelp(language),
            flags: 64,
          });
          break;
        }
        if (parsed.type === 'status') {
          await respond({
            content: formatProcessLinesConfigReport(language, resolveProcessLinesSetting(session), false),
            flags: 64,
          });
          break;
        }
        const { processLinesSetting } = commandActions.setProcessLines(session, parsed.lines);
        await respond({
          content: formatProcessLinesConfigReport(language, processLinesSetting, true),
          flags: 64,
        });
        break;
      }

      case 'progress': {
        await respond({
          content: formatProgressReport(key, session, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'cancel': {
        const outcome = cancelChannelWork(key, 'slash_cancel');
        await respond({
          content: formatCancelReport(outcome),
          flags: 64,
        });
        break;
      }

      default: {
        await respond({ content: `❌ 未知命令：\`${interaction.commandName}\``, flags: 64 });
        break;
      }
    }
  } catch (err) {
    await safeInteractionFailureReply(interaction, err);
  }
}

async function sendInteractionResponse(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred && !interaction.replied) {
    const { flags: _ignoredFlags, ...editPayload } = body;
    return interaction.editReply(editPayload);
  }
  if (interaction.replied) {
    return interaction.followUp(body);
  }
  return interaction.reply(body);
}

async function safeInteractionFailureReply(interaction, err) {
  if (isIgnorableDiscordRuntimeError(err)) {
    console.warn(`Ignoring non-fatal interaction error: ${safeError(err)}`);
    return;
  }

  try {
    await sendInteractionResponse(interaction, { content: `❌ ${safeError(err)}`, flags: 64 });
  } catch (replyErr) {
    if (isIgnorableDiscordRuntimeError(replyErr)) {
      console.warn(`Ignoring non-fatal interaction reply error: ${safeError(replyErr)}`);
      return;
    }
    throw replyErr;
  }
}

async function bootClient(reason) {
  if (!client) {
    client = createClient();
    bindClientHandlers(client);
  }
  await loginClientWithRetry(client, reason);
}

async function loginClientWithRetry(bot, reason) {
  if (!SELF_HEAL_ENABLED) {
    await bot.login(DISCORD_TOKEN);
    return;
  }

  let attempt = 0;
  const baseDelay = Math.max(1000, SELF_HEAL_RESTART_DELAY_MS);
  const maxDelay = Math.max(baseDelay, SELF_HEAL_MAX_LOGIN_BACKOFF_MS);

  while (true) {
    attempt += 1;
    try {
      await bot.login(DISCORD_TOKEN);
      if (attempt > 1) {
        console.log(`✅ Discord reconnect success after ${attempt} attempts (reason=${reason}).`);
      }
      return;
    } catch (err) {
      if (isInvalidTokenError(err)) {
        throw err;
      }

      const delay = Math.min(maxDelay, baseDelay * (2 ** Math.min(10, attempt - 1)));
      console.error(`Discord login failed (reason=${reason}, attempt=${attempt}): ${safeError(err)}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function scheduleSelfHeal(reason, err = null) {
  if (!SELF_HEAL_ENABLED) return;
  if (err && isInvalidTokenError(err)) {
    console.error('❌ Discord token invalid. Self-heal skipped; please fix DISCORD_TOKEN.');
    return;
  }
  if (selfHealInFlight || selfHealTimer) return;

  if (err) {
    console.error(`♻️ Self-heal triggered by ${reason}:`, safeError(err));
  } else {
    console.error(`♻️ Self-heal triggered by ${reason}.`);
  }

  const delay = Math.max(1000, SELF_HEAL_RESTART_DELAY_MS);
  selfHealTimer = setTimeout(() => {
    selfHealTimer = null;
    restartClient(reason).catch((restartErr) => {
      console.error('Self-heal restart failed:', restartErr);
      scheduleSelfHeal('restart_failed', restartErr);
    });
  }, delay);
  selfHealTimer.unref?.();
}

async function restartClient(reason) {
  if (!SELF_HEAL_ENABLED) return;
  if (selfHealInFlight) return;

  selfHealInFlight = true;
  cancelAllChannelWork(`self_heal:${reason}`);

  try {
    if (client) {
      client.removeAllListeners();
      client.destroy();
    }
  } catch (err) {
    console.error('Failed to destroy previous Discord client:', safeError(err));
  }

  client = createClient();
  bindClientHandlers(client);

  try {
    await loginClientWithRetry(client, `self_heal:${reason}`);
    console.log(`✅ Self-heal recovered (reason=${reason}).`);
  } finally {
    selfHealInFlight = false;
  }
}

function setupProcessSelfHeal() {
  if (!SELF_HEAL_ENABLED) return;

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (isIgnorableDiscordRuntimeError(err)) {
      console.warn(`Ignoring non-fatal unhandled rejection: ${safeError(err)}`);
      return;
    }
    console.error('Unhandled rejection:', err);
    if (isInvalidTokenError(err)) return;
    scheduleSelfHeal('unhandled_rejection', err);
  });

  process.on('uncaughtException', (err) => {
    if (isIgnorableDiscordRuntimeError(err)) {
      console.warn(`Ignoring non-fatal uncaught exception: ${safeError(err)}`);
      return;
    }
    console.error('Uncaught exception:', err);
    if (isInvalidTokenError(err)) return;
    scheduleSelfHeal('uncaught_exception', err);
  });
}

function isRecoverableGatewayCloseCode(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return true;

  // 4004/4010+/4014 are usually configuration/token/intents issues.
  if ([4004, 4010, 4011, 4012, 4013, 4014].includes(n)) return false;
  return true;
}

function isInvalidTokenError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('invalid token');
}

function isIgnorableDiscordRuntimeError(err) {
  const code = Number(err?.code);
  if (code === 10062 || code === 40060) return true;

  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('unknown interaction') || msg.includes('interaction has already been acknowledged');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireSingleInstanceLock() {
  ensureDir(DATA_DIR);
  const lockBody = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    root: ROOT,
  }, null, 2);

  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(lockFd, `${lockBody}\n`, 'utf8');
    console.log(`🔒 Single-instance lock acquired: ${LOCK_FILE} (pid=${process.pid})`);
    return;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const existing = readLockFile();
  if (existing?.pid && isProcessAlive(existing.pid)) {
    console.error(`⛔ Another bot instance is running (pid=${existing.pid}). Exit without takeover.`);
    process.exit(0);
  }

  // stale lock
  try {
    fs.unlinkSync(LOCK_FILE);
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(lockFd, `${lockBody}\n`, 'utf8');
    console.warn(`♻️ Removed stale lock and acquired new lock: ${LOCK_FILE} (pid=${process.pid})`);
  } catch (err) {
    console.error(`❌ Failed to acquire lock ${LOCK_FILE}: ${safeError(err)}`);
    process.exit(1);
  }
}

function setupLockCleanupHandlers() {
  process.on('exit', () => {
    releaseSingleInstanceLock();
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(signal, () => {
      releaseSingleInstanceLock();
      process.exit(0);
    });
  }
}

function releaseSingleInstanceLock() {
  if (lockFd !== null) {
    try {
      fs.closeSync(lockFd);
    } catch {
      // ignore
    }
    lockFd = null;
  }

  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`Failed to remove lock file ${LOCK_FILE}: ${safeError(err)}`);
    }
  }
}

function readLockFile() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: toOptionalInt(parsed?.pid),
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

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
  formatProcessLinesConfigHelp,
  formatProcessLinesConfigReport,
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
  parseProcessLinesConfigAction,
  parseCompactConfigFromText,
  parseConfigKey,
  parseReasoningEffortInput,
  getEffectiveSecurityProfile,
  resolveTimeoutSetting,
  resolveProcessLinesSetting,
  describeConfigPolicy,
  isConfigKeyAllowed,
  isReasoningEffortSupported,
  cancelChannelWork,
  resolvePath,
  ensureGitRepo,
  listRecentSessions,
  humanAge,
  safeError,
});

// ── Message handler (prompts → Codex) ──────────────────────────

acquireSingleInstanceLock();
setupLockCleanupHandlers();
setupProcessSelfHeal();
try {
  await bootClient('startup');
} catch (err) {
  console.error(`❌ Failed to boot Discord client: ${safeError(err)}`);
  process.exit(1);
}

function formatRuntimePhaseLabel(phase, language = 'en') {
  const value = String(phase || '').trim().toLowerCase();
  if (language === 'en') return value || 'unknown';
  switch (value) {
    case 'starting':
      return '启动中';
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
  if (session.mode === 'dangerous') {
    return language === 'en'
      ? 'full access (--dangerously-bypass-approvals-and-sandbox)'
      : '完全权限（--dangerously-bypass-approvals-and-sandbox）';
  }
  return language === 'en'
    ? 'sandboxed (--full-auto)'
    : '沙盒模式（--full-auto）';
}

function formatStatusReport(key, session, channel = null) {
  const language = getSessionLanguage(session);
  const lang = normalizeUiLanguage(language);
  const provider = getSessionProvider(session);
  const defaults = getProviderDefaults(provider);
  const cliHealth = getCliHealth(provider);
  const security = resolveSecurityContext(channel, session);
  const compactSetting = resolveCompactStrategySetting(session);
  const compactEnabled = resolveCompactEnabledSetting(session);
  const compactThreshold = resolveCompactThresholdSetting(session);
  const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
  const modeDesc = session.mode === 'dangerous'
    ? (lang === 'en' ? 'dangerous (no sandbox, full access)' : 'dangerous（无沙盒，全权限）')
    : (lang === 'en' ? 'safe (sandboxed, no network)' : 'safe（沙盒隔离，无网络）');

  if (lang === 'en') {
    return [
      '🧭 **Current Status**',
      `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
      `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
      `• mode: ${modeDesc}`,
      `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
      `• compact strategy: ${describeCompactStrategy(compactSetting.strategy, lang)} (${formatSettingSourceLabel(compactSetting.source, lang)})`,
      `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'} (${formatSettingSourceLabel(compactEnabled.source, lang)})`,
      `• compact token limit: ${compactThreshold.tokens} (${formatSettingSourceLabel(compactThreshold.source, lang)})`,
      `• native compact limit: ${nativeLimit.tokens} (${formatSettingSourceLabel(nativeLimit.source, lang)})`,
      `• ui language: ${formatLanguageLabel(language)}`,
      `• permissions: ${formatPermissionsLabel(session, lang)}`,
      `• cli: ${formatCliHealth(cliHealth, lang)}`,
      `• session: ${formatSessionStatusLabel(session)}`,
      `• last input tokens: ${formatTokenValue(session.lastInputTokens)}`,
      `• security profile: ${formatSecurityProfileDisplay(security, lang)}`,
    ].filter(Boolean).join('\n');
  }

  return [
    '🧭 **当前状态**',
    `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
    `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
    `• mode: ${modeDesc}`,
    `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
    `• compact strategy: ${describeCompactStrategy(compactSetting.strategy, lang)}（${formatSettingSourceLabel(compactSetting.source, lang)}）`,
    `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'}（${formatSettingSourceLabel(compactEnabled.source, lang)}）`,
    `• compact token limit: ${compactThreshold.tokens}（${formatSettingSourceLabel(compactThreshold.source, lang)}）`,
    `• native compact limit: ${nativeLimit.tokens}（${formatSettingSourceLabel(nativeLimit.source, lang)}）`,
    `• 界面语言: ${formatLanguageLabel(language)}`,
    `• 权限: ${formatPermissionsLabel(session, lang)}`,
    `• CLI: ${formatCliHealth(cliHealth, lang)}`,
    `• session: ${formatSessionStatusLabel(session)}`,
    `• 最近输入 tokens: ${formatTokenValue(session.lastInputTokens)}`,
    `• security profile: ${formatSecurityProfileDisplay(security, lang)}`,
  ].filter(Boolean).join('\n');
}

function formatQueueReport(key, session = null, channel = null) {
  const runtime = getRuntimeSnapshot(key);
  const security = resolveSecurityContext(channel, session);
  const processLinesSetting = resolveProcessLinesSetting(session);
  const planSummary = formatProgressPlanSummary(runtime.progressPlan);
  const completedSummary = formatCompletedStepsSummary(runtime.completedSteps, {
    planState: runtime.progressPlan,
    latestStep: runtime.progressText,
    maxSteps: 3,
  });
  const processLines = renderProcessContentLines(runtime.recentActivities, 'en', processLinesSetting.lines);
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
  const processLinesSetting = resolveProcessLinesSetting(session);
  if (!runtime.running) {
    if (lang === 'en') {
      return [
        'ℹ️ No running task in this channel.',
        `• queued prompts: ${runtime.queued}`,
        `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
        `• hint: After sending a task, use \`!progress\` / \`${slashRef('progress')}\` for live updates.`,
      ].join('\n');
    }
    return [
      'ℹ️ 当前没有运行中的任务。',
      `• 排队任务: ${runtime.queued}`,
      `• 队列上限: ${formatQueueLimit(security.maxQueuePerChannel)}`,
      `• 提示: 发送新任务后可用 \`!progress\` / \`${slashRef('progress')}\` 查看实时进度。`,
    ].join('\n');
  }
  const processLines = renderProcessContentLines(runtime.recentActivities, lang, processLinesSetting.lines);
  const planLines = localizeProgressLines(renderProgressPlanLines(runtime.progressPlan, PROGRESS_PLAN_MAX_LINES), lang);
  const completedLines = localizeProgressLines(renderCompletedStepsLines(runtime.completedSteps, {
    planState: runtime.progressPlan,
    latestStep: runtime.progressText,
    maxSteps: PROGRESS_DONE_STEPS_MAX,
  }), lang);
  if (lang === 'en') {
    return [
      '🧵 **Task Progress**',
      `• runtime: ${formatRuntimeLabel(runtime, lang)}`,
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
      `• hint: Use \`!abort\` / \`${slashRef('cancel')}\` to interrupt current task and clear queue.`,
    ].filter(Boolean).join('\n');
  }
  return [
    '🧵 **任务进度**',
    `• 运行状态: ${formatRuntimeLabel(runtime, lang)}`,
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
    `• 提示: 可用 \`!abort\` / \`${slashRef('cancel')}\` 中断当前任务并清空队列。`,
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
  const securitySetting = getEffectiveSecurityProfile(session);
  const compactSetting = resolveCompactStrategySetting(session);
  const compactEnabled = resolveCompactEnabledSetting(session);
  const compactThreshold = resolveCompactThresholdSetting(session);
  const nativeLimit = resolveNativeCompactTokenLimitSetting(session);
  return [
    '🩺 **Bot Doctor**',
    `• bot mode: ${formatBotModeLabel()}`,
    `• provider: \`${provider}\` (${getProviderDisplayName(provider)})`,
    `• cli: ${formatCliHealth(cliHealth)}`,
    `• runtime: ${formatRuntimeLabel(runtime)}`,
    `• queued prompts: ${runtime.queued}`,
    `• security profile: ${formatSecurityProfileDisplay(security)}`,
    `• profile setting: ${formatSecurityProfileLabel(securitySetting.profile)} (${securitySetting.source})`,
    `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
    `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
    `• !config: ${formatConfigCommandStatus()}`,
    `• config allowlist: ${describeConfigPolicy()}`,
    `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
    `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
    `• runner timeout: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`,
    `• compact strategy: ${describeCompactStrategy(compactSetting.strategy)} (${compactSetting.source})`,
    `• compact enabled: ${compactEnabled.enabled ? 'on' : 'off'} (${compactEnabled.source})`,
    `• compact token limit: ${compactThreshold.tokens} (${compactThreshold.source})`,
    `• native compact limit: ${nativeLimit.tokens} (${nativeLimit.source})`,
  ].join('\n');
}

function parseUiLanguageInput(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['zh', 'zh-cn', 'cn', 'chinese', '中文'].includes(raw)) return 'zh';
  if (['en', 'en-us', 'english', '英文'].includes(raw)) return 'en';
  return null;
}

function normalizeUiLanguage(value) {
  return parseUiLanguageInput(value) || 'zh';
}

function getSessionLanguage(session) {
  if (!session) return DEFAULT_UI_LANGUAGE;
  return normalizeUiLanguage(session.language || DEFAULT_UI_LANGUAGE);
}

function formatLanguageLabel(language) {
  return language === 'en' ? 'en (English)' : 'zh (中文)';
}

function parseSecurityProfileInput(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['auto', 'solo', 'team', 'public'].includes(raw)) return raw;
  return null;
}

function normalizeSessionSecurityProfile(value) {
  return parseSecurityProfileInput(value);
}

function getEffectiveSecurityProfile(session) {
  const sessionProfile = normalizeSessionSecurityProfile(session?.securityProfile);
  if (sessionProfile) {
    return { profile: sessionProfile, source: 'session override' };
  }
  return { profile: SECURITY_PROFILE, source: 'env default' };
}

function formatSecurityProfileLabel(profile) {
  return parseSecurityProfileInput(profile) || 'team';
}

function normalizeSessionTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return normalizeTimeoutMs(n, 0);
}

function resolveTimeoutSetting(session) {
  const sessionTimeout = normalizeSessionTimeoutMs(session?.timeoutMs);
  if (sessionTimeout !== null) {
    return { timeoutMs: sessionTimeout, source: 'session override' };
  }
  return { timeoutMs: CODEX_TIMEOUT_MS, source: 'env default' };
}

function normalizeSessionProcessLines(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.floor(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

function resolveProcessLinesSetting(session) {
  const sessionLines = normalizeSessionProcessLines(session?.processLines);
  if (sessionLines !== null) {
    return { lines: sessionLines, source: 'session override' };
  }
  return { lines: PROGRESS_PROCESS_LINES, source: 'default' };
}

function parseTimeoutConfigAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['off', 'disable', 'disabled', 'none', '0', '关闭', '禁用'].includes(raw)) {
    return { type: 'set', timeoutMs: 0 };
  }
  if (!/^\d+$/.test(raw)) return { type: 'invalid' };
  const timeoutMs = normalizeTimeoutMs(Number(raw), 0);
  return { type: 'set', timeoutMs };
}

function normalizeSessionCompactStrategy(value) {
  const normalized = normalizeCompactStrategy(value || '');
  return value === null || value === undefined || value === '' ? null : normalized;
}

function normalizeSessionCompactTokenLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeSessionCompactEnabled(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'enable', 'enabled', 'yes', '开启', '启用', '打开'].includes(raw)) return true;
  if (['0', 'false', 'off', 'disable', 'disabled', 'no', '关闭', '禁用'].includes(raw)) return false;
  return null;
}

function resolveCompactStrategySetting(session) {
  const sessionStrategy = normalizeSessionCompactStrategy(session?.compactStrategy);
  if (sessionStrategy) {
    return { strategy: sessionStrategy, source: 'session override' };
  }
  return { strategy: COMPACT_STRATEGY, source: 'env default' };
}

function resolveCompactEnabledSetting(session) {
  const enabled = normalizeSessionCompactEnabled(session?.compactEnabled);
  if (enabled !== null) {
    return { enabled, source: 'session override' };
  }
  return { enabled: COMPACT_ON_THRESHOLD, source: 'env default' };
}

function resolveCompactThresholdSetting(session) {
  const tokens = normalizeSessionCompactTokenLimit(session?.compactThresholdTokens);
  if (tokens !== null) {
    return { tokens, source: 'session override' };
  }
  return { tokens: MAX_INPUT_TOKENS_BEFORE_COMPACT, source: 'env default' };
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

  return { tokens: MODEL_AUTO_COMPACT_TOKEN_LIMIT, source: 'env default' };
}

function parseCompactStrategyAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['hard', 'native', 'off'].includes(raw)) return { type: 'set', strategy: raw };
  return { type: 'invalid' };
}

function parseCompactEnabledAction(value) {
  const enabled = normalizeSessionCompactEnabled(value);
  if (enabled === null) return { type: 'invalid' };
  return { type: 'set', enabled };
}

function parseCompactTokenLimitAction(value) {
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

function parseCompactConfigAction(key, value = '') {
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

function parseCompactConfigFromText(arg = '') {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { type: 'status' };
  if (parts.length === 1) return parseCompactConfigAction(parts[0], '');
  return parseCompactConfigAction(parts[0], parts.slice(1).join(' '));
}

function formatCompactStrategyConfigHelp(language) {
  if (language === 'en') {
    return [
      'Usage: `!compact <status|strategy|token_limit|native_limit|enabled|reset> [value]`',
      `Slash: \`${slashRef('compact')} key:<...> value:<...>\``,
      'Examples: `!compact strategy native`, `!compact token_limit 272000`, `!compact enabled on`',
      'Note: compact settings only affect Codex CLI.',
    ].join('\n');
  }
  return [
    '用法：`!compact <status|strategy|token_limit|native_limit|enabled|reset> [value]`',
    `Slash：\`${slashRef('compact')} key:<...> value:<...>\``,
    '示例：`!compact strategy native`、`!compact token_limit 272000`、`!compact enabled on`',
    '说明：compact 配置仅对 Codex CLI 生效。',
  ].join('\n');
}

function formatCompactConfigReport(language, session, changed = false) {
  const strategy = resolveCompactStrategySetting(session);
  const enabled = resolveCompactEnabledSetting(session);
  const threshold = resolveCompactThresholdSetting(session);
  const nativeLimit = resolveNativeCompactTokenLimitSetting(session);

  if (language === 'en') {
    return [
      changed ? '✅ Compact config updated' : 'ℹ️ Compact config',
      `• strategy: ${describeCompactStrategy(strategy.strategy, language)} (${formatSettingSourceLabel(strategy.source, language)})`,
      `• enabled: ${enabled.enabled ? 'on' : 'off'} (${formatSettingSourceLabel(enabled.source, language)})`,
      `• token limit: ${threshold.tokens} (${formatSettingSourceLabel(threshold.source, language)})`,
      `• native limit: ${nativeLimit.tokens} (${formatSettingSourceLabel(nativeLimit.source, language)})`,
      '• note: native compaction is handled inside Codex CLI; the bot does not currently emit a guaranteed per-compact notification.',
    ].join('\n');
  }
  return [
    changed ? '✅ compact 配置已更新' : 'ℹ️ 当前 compact 配置',
    `• strategy: ${describeCompactStrategy(strategy.strategy, language)}（${formatSettingSourceLabel(strategy.source, language)}）`,
    `• enabled: ${enabled.enabled ? 'on' : 'off'}（${formatSettingSourceLabel(enabled.source, language)}）`,
    `• token limit: ${threshold.tokens}（${formatSettingSourceLabel(threshold.source, language)}）`,
    `• native limit: ${nativeLimit.tokens}（${formatSettingSourceLabel(nativeLimit.source, language)}）`,
    '• 说明：native 压缩发生在 Codex CLI 内部，bot 目前拿不到稳定的“本次刚压缩完成”通知。',
  ].join('\n');
}

function parseReasoningEffortInput(value, { allowDefault = false } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (allowDefault && raw === 'default') return 'default';
  if (['low', 'medium', 'high', 'xhigh'].includes(raw)) return raw;
  return null;
}

function isReasoningEffortSupported(provider, effort) {
  if (!effort) return true;
  if (normalizeProvider(provider) === 'claude' && effort === 'xhigh') return false;
  return true;
}

function formatReasoningEffortHelp(language) {
  return language === 'en'
    ? 'Usage: `!effort <xhigh|high|medium|low|default>`'
    : '用法：`!effort <xhigh|high|medium|low|default>`';
}

function formatReasoningEffortUnsupported(provider, language) {
  if (language === 'en') {
    return `⚠️ \`xhigh\` is currently only supported for Codex CLI. Current provider: ${getProviderDisplayName(provider)}.`;
  }
  return `⚠️ \`xhigh\` 目前仅支持 Codex CLI。当前 provider：${getProviderDisplayName(provider)}。`;
}

function formatSettingSourceLabel(source, language = 'en') {
  if (source === 'session override') {
    return language === 'en' ? 'session override' : '频道覆盖';
  }
  if (source === 'session threshold fallback') {
    return language === 'en' ? 'threshold fallback' : '阈值回退';
  }
  if (source === 'env default') {
    return language === 'en' ? 'env default' : '环境默认';
  }
  return source || (language === 'en' ? 'unknown' : '未知');
}

function parseProcessLinesConfigAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (!/^\d+$/.test(raw)) return { type: 'invalid' };
  const lines = normalizeSessionProcessLines(Number(raw));
  if (lines === null) return { type: 'invalid' };
  return { type: 'set', lines };
}


function formatLanguageConfigHelp(language) {
  if (language === 'en') {
    return [
      `Usage: \`!lang <zh|en>\``,
      `Current: ${formatLanguageLabel(language)}`,
      `Examples: \`!lang en\`, \`!lang zh\``,
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
      ? `✅ Codex timeout set to ${label}`
      : `ℹ️ Codex timeout is ${label}`;
  }
  return changed
    ? `✅ Codex 超时已设置为 ${label}`
    : `ℹ️ 当前 Codex 超时为 ${label}`;
}

function formatProcessLinesConfigHelp(language) {
  if (language === 'en') {
    return [
      'Usage: `!processlines <1|2|3|4|5|status>`',
      `Slash: \`${slashRef('process_lines')} <1-5|status>\``,
      'Examples: `!processlines 2`, `!processlines status`',
    ].join('\n');
  }
  return [
    '用法：`!processlines <1|2|3|4|5|status>`',
    `Slash：\`${slashRef('process_lines')} <1-5|status>\``,
    '示例：`!processlines 2`、`!processlines status`',
  ].join('\n');
}

function formatProcessLinesConfigReport(language, setting, changed) {
  const label = `${setting.lines} (${setting.source})`;
  if (language === 'en') {
    return changed
      ? `✅ Process content window set to ${label}`
      : `ℹ️ Process content window is ${label}`;
  }
  return changed
    ? `✅ 过程内容窗口已设置为 ${label}`
    : `ℹ️ 当前过程内容窗口为 ${label}`;
}


function formatHelpReport(session) {
  const language = getSessionLanguage(session);
  if (language === 'en') {
    return [
      '**📋 Commands**',
      '',
      BOT_PROVIDER
        ? `Bot mode: locked to ${getProviderDisplayName(BOT_PROVIDER)}`
        : 'Bot mode: shared (use `!provider` / `/provider` to switch per channel)',
      '',
      '**Session**',
      '• `!status` — current config snapshot',
      '• `!queue` — queue status in current channel',
      '• `!doctor` — runtime + security diagnostics',
      `• \`${slashRef('onboarding')}\` — interactive onboarding`,
      '• `!onboarding` — onboarding text checklist',
      `• \`${slashRef('onboarding_config')} <on|off|status>\` / \`!onboarding <on|off|status>\` — onboarding switch`,
      `• \`${slashRef('language')} <中文|English>\` / \`!lang <zh|en>\` — message language`,
      `• \`${slashRef('profile')} <auto|solo|team|public|status>\` / \`!profile <...|status>\` — channel security profile`,
      `• \`${slashRef('timeout')} <ms|off|status>\` / \`!timeout <...>\` — runner timeout`,
      `• \`${slashRef('process_lines')} <1-5|status>\` / \`!processlines <...>\` — process content window lines`,
      '• `!progress` — current run progress',
      '• `!abort` / `!cancel` / `!stop` — stop running task and clear queue',
      '• `!reset` — clear session context',
      '• `!resume <session_id>` — bind existing provider session',
      '• `!sessions` — list recent provider sessions',
      !BOT_PROVIDER ? '• `!provider <codex|claude|status>` — switch provider for current channel' : null,
      '',
      '**Workspace**',
      '• `!setdir <path>` — set workspace (resets session)',
      '• `!cd <path>` — alias of `!setdir`',
      '',
      '**Model & Runtime**',
      '• `!model <name|default>` — set model override',
      '• `!effort <xhigh|high|medium|low|default>` — reasoning effort',
      `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — compact config (Codex only)`,
      '• `!mode <safe|dangerous>` — execution mode',
      '• `!config <key=value>` — append provider config override (Codex only; when enabled + allowlisted)',
      '',
      'Normal messages are forwarded to the current provider.',
    ].filter(Boolean).join('\n');
  }
  return [
    '**📋 命令列表**',
    '',
    BOT_PROVIDER
      ? `Bot 模式：已锁定到 ${getProviderDisplayName(BOT_PROVIDER)}`
      : 'Bot 模式：共享实例（可用 `!provider` / `/provider` 按频道切换）',
    '',
    '**会话管理**',
    '• `!status` — 当前配置一览',
    '• `!queue` — 查看当前频道队列（运行中/排队数）',
    '• `!doctor` — 查看 bot 健康状态与当前安全策略',
    `• \`${slashRef('onboarding')}\` — 交互式引导（按钮分步）`,
    '• `!onboarding` — 文本版引导流程与检查清单',
    `• \`${slashRef('onboarding_config')} <on|off|status>\` / \`!onboarding <on|off|status>\` — onboarding 开关`,
    `• \`${slashRef('language')} <中文|English>\` / \`!lang <zh|en>\` — 消息提示语言`,
    `• \`${slashRef('profile')} <auto|solo|team|public|status>\` / \`!profile <...|status>\` — 当前频道 security profile`,
    `• \`${slashRef('timeout')} <毫秒|off|status>\` / \`!timeout <...>\` — runner 超时`,
    `• \`${slashRef('process_lines')} <1-5|status>\` / \`!processlines <...>\` — 过程内容窗口行数`,
    '• `!progress` — 查看当前任务的最新进度',
    '• `!abort` / `!cancel` / `!stop` — 中断当前任务并清空队列',
    '• `!reset` — 清空会话，下条消息新开上下文',
    '• `!resume <session_id>` — 继承一个已有的 provider session',
    '• `!sessions` — 列出最近的 provider sessions',
    !BOT_PROVIDER ? '• `!provider <codex|claude|status>` — 切换当前频道 provider' : null,
    '',
    '**工作目录**',
    '• `!setdir <path>` — 设置工作目录（会清空旧会话）',
    '• `!cd <path>` — 同 !setdir 的别名',
    '',
    '**模型 & 执行**',
    '• `!model <name|default>` — 切换模型（如 gpt-5.3-codex, o3）',
    '• `!effort <xhigh|high|medium|low|default>` — reasoning effort',
    `• \`${slashRef('compact')} key:<...> value:<...>\` / \`!compact <...>\` — compact 配置（仅 Codex）`,
    '• `!mode <safe|dangerous>` — 执行模式',
    '• `!config <key=value>` — 添加 provider 配置覆盖（当前仅 Codex 支持；需 ENABLE_CONFIG_CMD=true 且 key 在白名单）',
    '',
    '普通消息直接转给当前 provider。',
  ].filter(Boolean).join('\n');
}


function createProgressReporter({
  message,
  channelState,
  language = DEFAULT_UI_LANGUAGE,
  processLines = PROGRESS_PROCESS_LINES,
}) {
  if (!PROGRESS_UPDATES_ENABLED) return null;

  const startedAt = Date.now();
  const lang = normalizeUiLanguage(language);
  const processLineLimit = Math.max(1, Math.min(5, Number(processLines || PROGRESS_PROCESS_LINES)));
  let progressMessage = null;
  let timer = null;
  let stopped = false;
  let lastEmitAt = 0;
  let lastRendered = '';
  let events = 0;
  let latestStep = lang === 'en'
    ? 'Task started, waiting for the first event...'
    : '任务已开始，等待首个事件...';
  let planState = cloneProgressPlan(channelState.activeRun?.progressPlan);
  const completedSteps = Array.isArray(channelState.activeRun?.completedSteps)
    ? [...channelState.activeRun.completedSteps]
    : [];
  const recentActivities = Array.isArray(channelState.activeRun?.recentActivities)
    ? [...channelState.activeRun.recentActivities]
    : [];
  const pendingActivities = [];
  let lastActivityPushAt = 0;
  let isEmitting = false;
  let rerunEmit = false;
  let activityTimer = null;
  const isDuplicateProgressEvent = createProgressEventDeduper({
    ttlMs: PROGRESS_EVENT_DEDUPE_WINDOW_MS,
    maxKeys: 700,
  });

  const syncActiveRun = () => {
    if (!channelState.activeRun) return;
    channelState.activeRun.progressEvents = events;
    channelState.activeRun.lastProgressText = latestStep;
    channelState.activeRun.lastProgressAt = Date.now();
    channelState.activeRun.progressPlan = cloneProgressPlan(planState);
    channelState.activeRun.completedSteps = [...completedSteps];
    channelState.activeRun.recentActivities = [...recentActivities];
    if (progressMessage?.id) {
      channelState.activeRun.progressMessageId = progressMessage.id;
    }
  };

  const render = (status = 'running') => {
    const elapsed = humanElapsed(Math.max(0, Date.now() - startedAt));
    const phase = formatRuntimePhaseLabel(channelState.activeRun?.phase || 'starting', lang);
    const hint = status === 'running'
      ? (lang === 'en'
        ? `Use \`!abort\` / \`${slashRef('cancel')}\` to interrupt, and \`!progress\` for details.`
        : `可用 \`!abort\` / \`${slashRef('cancel')}\` 中断，\`!progress\` 查看详情。`)
      : (lang === 'en'
        ? 'You can continue with a new message, or check remaining backlog with `!queue`.'
        : '可继续发送新消息，或用 `!queue` 查看是否还有排队任务。');
    const statusLine = status === 'running'
      ? (lang === 'en' ? '⏳ **Task Running**' : '⏳ **任务进行中**')
      : status;
    const body = [
      statusLine,
      `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
      `${lang === 'en' ? '• phase' : '• 阶段'}: ${phase}`,
      `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
      `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${latestStep}`,
      ...renderProcessContentLines(recentActivities, lang, processLineLimit),
      ...localizeProgressLines(renderProgressPlanLines(planState, PROGRESS_PLAN_MAX_LINES), lang),
      ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
        planState,
        latestStep,
        maxSteps: PROGRESS_DONE_STEPS_MAX,
      }), lang),
      `${lang === 'en' ? '• queued prompts' : '• 排队任务'}: ${channelState.queue.length}`,
      `${lang === 'en' ? '• hint' : '• 提示'}: ${hint}`,
    ]
      .filter(Boolean)
      .join('\n');
    return truncate(body, PROGRESS_MESSAGE_MAX_CHARS);
  };

  const emit = async (force = false) => {
    if (!progressMessage || stopped) return;
    if (isEmitting) {
      rerunEmit = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_EVENT_FLUSH_MS) return;
    const body = render('running');
    if (!force && body === lastRendered) return;

    isEmitting = true;
    try {
      await progressMessage.edit(body);
      lastEmitAt = Date.now();
      lastRendered = body;
      syncActiveRun();
    } catch {
      // ignore edit failures
    } finally {
      isEmitting = false;
      if (rerunEmit && !stopped) {
        rerunEmit = false;
        void emit(false);
      }
    }
  };

  const normalizeActivityKey = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const enqueueActivity = (activityText) => {
    const text = String(activityText || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const key = normalizeActivityKey(text);
    if (!key) return;

    const latestVisible = normalizeActivityKey(recentActivities[recentActivities.length - 1]);
    if (latestVisible && latestVisible === key) return;
    const latestQueued = normalizeActivityKey(pendingActivities[pendingActivities.length - 1]);
    if (latestQueued && latestQueued === key) return;

    pendingActivities.push(text);
    if (pendingActivities.length > 80) {
      pendingActivities.splice(0, pendingActivities.length - 80);
    }
  };

  const pushOneActivity = ({ force = false } = {}) => {
    if (!pendingActivities.length) return false;
    const now = Date.now();
    if (!force && now - lastActivityPushAt < PROGRESS_PROCESS_PUSH_INTERVAL_MS) return false;
    const next = pendingActivities.shift();
    if (!next) return false;
    appendRecentActivity(recentActivities, next);
    lastActivityPushAt = now;
    return true;
  };

  const start = async () => {
    try {
      const body = render('running');
      progressMessage = await safeReply(message, body);
      lastEmitAt = Date.now();
      lastRendered = body;
      syncActiveRun();
      timer = setInterval(() => {
        void emit(true);
      }, PROGRESS_UPDATE_INTERVAL_MS);
      timer.unref?.();
      activityTimer = setInterval(() => {
        if (stopped) return;
        if (!pushOneActivity()) return;
        syncActiveRun();
        void emit(false);
      }, PROGRESS_PROCESS_PUSH_INTERVAL_MS);
      activityTimer.unref?.();
    } catch {
      progressMessage = null;
    }
  };

  const onEvent = (ev) => {
    if (stopped) return;
    const summaryStep = summarizeCodexEvent(ev);
    const rawActivity = extractRawProgressTextFromEvent(ev);
    const nextPlan = extractPlanStateFromEvent(ev);
    const completedStep = extractCompletedStepFromEvent(ev);
    const dedupeKey = buildProgressEventDedupeKey({
      summaryStep,
      rawActivity,
      completedStep,
      planSummary: formatProgressPlanSummary(nextPlan),
    });
    if (isDuplicateProgressEvent(dedupeKey)) return;

    events += 1;
    if (summaryStep && !summaryStep.startsWith('agent message')) {
      latestStep = summaryStep;
    } else if (!latestStep) {
      latestStep = summaryStep;
    }
    if (rawActivity) {
      enqueueActivity(rawActivity);
      // First visible line should appear quickly, then continue as a rolling queue.
      if (recentActivities.length === 0) {
        pushOneActivity({ force: true });
      } else {
        pushOneActivity();
      }
    }
    if (nextPlan) {
      planState = nextPlan;
      for (const item of nextPlan.steps) {
        if (item.status === 'completed') {
          appendCompletedStep(completedSteps, item.step);
        }
      }
    }
    if (completedStep) appendCompletedStep(completedSteps, completedStep);
    syncActiveRun();
    void emit(false);
  };

  const onLog = (line, source) => {
    if (stopped) return;
    if (source === 'stderr' && !PROGRESS_INCLUDE_STDERR) return;
    if (source === 'stdout' && !PROGRESS_INCLUDE_STDOUT) return;
    events += 1;
    const sourceLabel = lang === 'en'
      ? source
      : (source === 'stderr' ? '标准错误' : '标准输出');
    latestStep = `${sourceLabel}: ${truncate(String(line || '').replace(/\s+/g, ' ').trim(), PROGRESS_TEXT_PREVIEW_CHARS)}`;
    syncActiveRun();
    void emit(false);
  };

  const finish = async ({ ok = false, cancelled = false, timedOut = false, error = '' } = {}) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (activityTimer) clearInterval(activityTimer);
    while (pushOneActivity({ force: true })) {
      // Drain any buffered progress lines so final card shows the latest context window.
    }
    syncActiveRun();
    if (!progressMessage) return;

    const elapsed = humanElapsed(Math.max(0, Date.now() - startedAt));
    const status = cancelled
      ? (lang === 'en' ? '🛑 **Task Cancelled**' : '🛑 **任务已中断**')
      : ok
        ? (lang === 'en' ? '✅ **Task Completed**' : '✅ **任务已完成**')
        : timedOut
          ? (lang === 'en' ? '⏱️ **Task Timed Out**' : '⏱️ **任务超时**')
          : (lang === 'en' ? '❌ **Task Failed**' : '❌ **任务失败**');
    const body = [
      status,
      `${lang === 'en' ? '• elapsed' : '• 耗时'}: ${elapsed}`,
      `${lang === 'en' ? '• phase' : '• 阶段'}: ${formatRuntimePhaseLabel(channelState.activeRun?.phase || 'done', lang)}`,
      `${lang === 'en' ? '• event count' : '• 事件数'}: ${events}`,
      `${lang === 'en' ? '• latest activity' : '• 最新活动'}: ${latestStep}`,
      ...renderProcessContentLines(recentActivities, lang, processLineLimit),
      ...localizeProgressLines(renderProgressPlanLines(planState, PROGRESS_PLAN_MAX_LINES), lang),
      ...localizeProgressLines(renderCompletedStepsLines(completedSteps, {
        planState,
        latestStep,
        maxSteps: PROGRESS_DONE_STEPS_MAX,
      }), lang),
      !ok && !cancelled && error ? `${lang === 'en' ? '• error' : '• 错误'}: ${truncate(String(error), 260)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const safeBody = truncate(body, PROGRESS_MESSAGE_MAX_CHARS);

    try {
      await progressMessage.edit(safeBody);
    } catch {
      // ignore
    }
  };

  return {
    start,
    onEvent,
    onLog,
    finish,
  };
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

async function handlePrompt(message, key, prompt, channelState) {
  if (channelState.cancelRequested) {
    return { ok: false, cancelled: true };
  }

  const session = getSession(key);
  const workspaceDir = ensureWorkspace(session, key);

  // Show typing indicator (refreshes every 8s until cleared)
  await message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  const progress = createProgressReporter({
    message,
    channelState,
    language: getSessionLanguage(session),
    processLines: resolveProcessLinesSetting(session).lines,
  });
  await progress?.start();
  let progressOutcome = { ok: false, cancelled: false, timedOut: false, error: '' };

  try {
    let promptToRun = prompt;
    const preNotes = [];
    if (shouldCompactSession(session)) {
      const previousThreadId = getSessionId(session);
      const compacted = await compactSessionContext({
        session,
        workspaceDir,
        onSpawn: (child) => {
          setActiveRun(channelState, message, 'auto-compact summary request', child, 'compact');
          if (channelState.cancelRequested) stopChildProcess(child);
        },
        wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
        onEvent: progress?.onEvent,
        onLog: progress?.onLog,
      });
      if (compacted.ok && compacted.summary) {
        clearSessionId(session);
        saveDb();
        promptToRun = buildPromptFromCompactedContext(compacted.summary, prompt);
        preNotes.push(`上下文输入 token=${session.lastInputTokens}，已自动压缩并切换新会话（旧 session: ${previousThreadId}）。`);
      } else {
        clearSessionId(session);
        saveDb();
        preNotes.push(`上下文输入 token=${session.lastInputTokens}，自动压缩失败，已回退 reset（旧 session: ${previousThreadId}）。`);
        if (compacted.error) preNotes.push(`压缩失败原因：${compacted.error}`);
      }
    }

    if (channelState.cancelRequested) {
      progressOutcome = { ok: false, cancelled: true, timedOut: false, error: 'cancelled by user' };
      return { ok: false, cancelled: true };
    }

    let result = await runCodex({
      session,
      workspaceDir,
      prompt: promptToRun,
      onSpawn: (child) => {
        setActiveRun(channelState, message, promptToRun, child, 'exec');
        if (channelState.cancelRequested) stopChildProcess(child);
      },
      wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
      onEvent: progress?.onEvent,
      onLog: progress?.onLog,
    });
    if (preNotes.length) {
      result.notes.unshift(...preNotes);
    }

    // If resume failed, auto-reset once and retry fresh session.
    if (!result.ok && getSessionId(session) && !result.cancelled && !result.timedOut) {
      const previous = getSessionId(session);
      clearSessionId(session);
      saveDb();
      result = await runCodex({
        session,
        workspaceDir,
        prompt,
        onSpawn: (child) => {
          setActiveRun(channelState, message, prompt, child, 'retry');
          if (channelState.cancelRequested) stopChildProcess(child);
        },
        wasCancelled: () => Boolean(channelState.cancelRequested || channelState.activeRun?.cancelRequested),
        onEvent: progress?.onEvent,
        onLog: progress?.onLog,
      });
      if (result.ok) {
        result.notes.push(`已自动重置旧会话：${previous}`);
      }
    }

    const inputTokens = extractInputTokensFromUsage(result.usage);
    let sessionDirty = false;
    if (result.threadId) {
      setSessionId(session, result.threadId);
      sessionDirty = true;
    }
    if (inputTokens !== null) {
      session.lastInputTokens = inputTokens;
      sessionDirty = true;
    }
    if (sessionDirty) {
      saveDb();
    }

    if (!result.ok) {
      if (result.cancelled) {
        progressOutcome = { ok: false, cancelled: true, timedOut: false, error: result.error || 'cancelled' };
        await safeReply(message, '🛑 当前任务已中断。');
        return { ok: false, cancelled: true };
      }

      const provider = getSessionProvider(session);
      const cliMissing = isCliNotFound(result.error);
      const timeoutSetting = resolveTimeoutSetting(session);
      const failText = [
        result.timedOut ? `❌ ${getProviderShortName(provider)} 执行超时` : `❌ ${getProviderShortName(provider)} 执行失败`,
        result.error ? `• error: ${result.error}` : null,
        result.logs.length ? `• logs: ${truncate(result.logs.join('\n'), 1200)}` : null,
        result.timedOut
          ? `• 处理: 可用 \`${slashRef('timeout')} <ms|off|status>\` 或 \`!timeout <ms|off|status>\` 调整本频道超时。当前: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`
          : null,
        cliMissing ? `• 诊断: 当前环境找不到 ${getProviderDisplayName(provider)} CLI 可执行文件。` : null,
        cliMissing ? `• 处理: 在该设备安装 ${getProviderDefaultBin(provider)}，或在 .env 配置 \`${getProviderBinEnvName(provider)}=/绝对路径/${getProviderDefaultBin(provider)}\`，然后重启 bot。` : null,
        cliMissing ? `• 自检: 用 \`${slashRef('status')}\` 或 \`!status\` 查看 CLI 状态。` : null,
        '',
        `可以先 \`${slashRef('reset')}\` 再重试，或 \`${slashRef('status')}\` 看状态。`,
      ].filter(Boolean).join('\n');
      progressOutcome = {
        ok: false,
        cancelled: false,
        timedOut: Boolean(result.timedOut),
        error: result.error || `${getSessionProvider(session)} run failed`,
      };
      await safeReply(message, failText);
      return { ok: false, cancelled: false };
    }

    const body = composeResultText(result, session);
    const parts = splitForDiscord(body, 1900);

    if (parts.length === 0) {
      await safeReply(message, '✅ 完成（无可展示文本输出）。');
      progressOutcome = { ok: true, cancelled: false, timedOut: false, error: '' };
      return { ok: true, cancelled: false };
    }

    await safeReply(message, parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await withDiscordNetworkRetry(
        () => message.channel.send(parts[i]),
        { logger: console, label: 'channel.send (result part)' },
      );
    }

    progressOutcome = { ok: true, cancelled: false, timedOut: false, error: '' };
    return { ok: true, cancelled: false };
  } catch (err) {
    progressOutcome = { ok: false, cancelled: false, timedOut: false, error: safeError(err) };
    throw err;
  } finally {
    clearInterval(typingInterval);
    await progress?.finish(progressOutcome);
  }
}

({ enqueuePrompt } = createChannelQueue({
  getChannelState,
  getSession,
  resolveSecurityContext,
  safeReply,
  safeError,
  getCurrentUserId: () => client?.user?.id,
  handlePrompt,
}));

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
  ensureGitRepo,
  normalizeProvider,
  getSessionProvider,
  getProviderBin,
  getSessionId,
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
}));

function shouldCompactSession(session) {
  const compactSetting = resolveCompactStrategySetting(session);
  const enabledSetting = resolveCompactEnabledSetting(session);
  const thresholdSetting = resolveCompactThresholdSetting(session);
  if (!enabledSetting.enabled) return false;
  if (compactSetting.strategy !== 'hard') return false;
  if (!getSessionId(session)) return false;
  const last = toOptionalInt(session.lastInputTokens);
  if (!Number.isFinite(last)) return false;
  return last >= thresholdSetting.tokens;
}

async function compactSessionContext({ session, workspaceDir, onSpawn, wasCancelled, onEvent, onLog }) {
  if (!getSessionId(session)) {
    return { ok: false, summary: '', error: 'missing session id' };
  }

  const compactPrompt = [
    '请压缩总结当前会话上下文，供新会话继续工作使用。',
    '输出要求：',
    '1) 用中文，结构化分段，控制在 1200 字以内。',
    '2) 包含：目标、已完成工作、关键代码/文件、未完成事项、风险与约束、下一步建议。',
    '3) 只输出摘要正文，不要寒暄。',
  ].join('\n');

  const result = await runCodex({
    session,
    workspaceDir,
    prompt: compactPrompt,
    onSpawn,
    wasCancelled,
    onEvent,
    onLog,
  });
  if (!result.ok) {
    return {
      ok: false,
      summary: '',
      error: result.error || truncate(result.logs.join('\n'), 400),
    };
  }

  const summary = result.messages.join('\n\n').trim();
  if (!summary) {
    return { ok: false, summary: '', error: 'empty compact summary' };
  }

  return { ok: true, summary, usage: result.usage };
}

function buildPromptFromCompactedContext(summary, userPrompt) {
  return [
    '下面是上一轮会话的压缩摘要，请先把它作为上下文再回答新的用户请求。',
    '',
    '【压缩摘要开始】',
    summary,
    '【压缩摘要结束】',
    '',
    '请在不丢失关键上下文的前提下继续处理以下新请求：',
    userPrompt,
  ].join('\n');
}

function composeResultText(result, session) {
  const sections = [];

  if (SHOW_REASONING && result.reasonings.length) {
    sections.push([
      '🧠 Reasoning',
      truncate(result.reasonings.join('\n\n'), 1200),
    ].join('\n'));
  }

  const answer = composeFinalAnswerText({
    messages: result.messages,
    finalAnswerMessages: result.finalAnswerMessages,
  });
  sections.push(answer || `（${getProviderShortName(getSessionProvider(session))} 没有返回可见文本）`);

  const tail = [];
  if (result.notes.length) {
    tail.push(...result.notes.map((n) => `• ${n}`));
  }
  const currentSessionId = getSessionId(session);
  if (currentSessionId || result.threadId) {
    const id = result.threadId || currentSessionId;
    const label = session.name ? `**${session.name}** (\`${id}\`)` : `\`${id}\``;
    tail.push(`• session: ${label}`);
  }

  if (tail.length) {
    sections.push(['', '—', ...tail].join('\n'));
  }

  return sections.join('\n\n').trim();
}

function autoRepairProxyEnv(envFilePath) {
  const logs = [];
  const updates = {};

  const http = firstNonEmptyEnv(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']);
  const https = firstNonEmptyEnv(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
  let socks = firstNonEmptyEnv(['SOCKS_PROXY', 'ALL_PROXY', 'all_proxy']);

  if (!socks) {
    const inferred = inferLocalSocksProxy(http || https);
    if (inferred) {
      socks = inferred;
      logs.push(`🛠️ Proxy auto-repair: inferred SOCKS proxy from local HTTP proxy -> ${inferred}`);
    }
  }

  fillMissingEnvKeys(['HTTP_PROXY', 'http_proxy'], http, updates);
  fillMissingEnvKeys(['HTTPS_PROXY', 'https_proxy'], https || http, updates);
  fillMissingEnvKeys(['SOCKS_PROXY', 'ALL_PROXY', 'all_proxy'], socks, updates);

  const repairedKeys = Object.keys(updates);
  if (repairedKeys.length) {
    logs.push(`🛠️ Proxy auto-repair: filled ${repairedKeys.join(', ')}`);
    persistEnvUpdates(envFilePath, updates);
    logs.push(`🛠️ Proxy auto-repair: persisted updates into ${path.basename(envFilePath)}`);
  }

  return { updates, logs };
}

function firstNonEmptyEnv(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function fillMissingEnvKeys(keys, value, updates) {
  const normalized = String(value || '').trim();
  if (!normalized) return;

  for (const key of keys) {
    const current = String(process.env[key] || '').trim();
    if (current) continue;
    process.env[key] = normalized;
    updates[key] = normalized;
  }
}

function inferLocalSocksProxy(proxyValue) {
  const parsed = parseProxyUrl(proxyValue);
  if (!parsed) return '';
  if (!isLocalProxyHost(parsed.hostname)) return '';
  if (!parsed.port) return '';
  return `socks5h://${parsed.hostname}:${parsed.port}`;
}

function parseProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const withScheme = value.includes('://') ? value : `http://${value}`;

  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function isLocalProxyHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function persistEnvUpdates(envFilePath, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return;

  let content = '';
  try {
    content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
  } catch {
    content = '';
  }

  for (const key of keys) {
    const rendered = `${key}=${renderEnvValue(updates[key])}`;
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, rendered);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${rendered}\n`;
    }
  }

  fs.writeFileSync(envFilePath, content, 'utf8');
}

function renderEnvValue(value) {
  const text = String(value || '');
  if (!/[#\s"']/g.test(text)) return text;
  return JSON.stringify(text);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCsvSet(value) {
  if (!value || !value.trim()) return null;
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

function normalizeSecurityProfile(value) {
  const raw = String(value || 'auto').trim().toLowerCase();
  if (['auto', 'solo', 'team', 'public'].includes(raw)) return raw;
  console.warn(`⚠️ Unknown SECURITY_PROFILE=${value}, fallback to auto`);
  return 'auto';
}

function parseOptionalBool(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  console.warn(`⚠️ Invalid boolean value: ${value} (ignored)`);
  return null;
}

function normalizeQueueLimit(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`⚠️ Invalid MAX_QUEUE_PER_CHANNEL=${value}, using profile default`);
    return null;
  }
  if (n <= 0) return 0;
  return Math.floor(n);
}

function parseConfigAllowlist(value) {
  const raw = String(value || '').trim();
  if (raw === '*') {
    return { allowAll: true, keys: new Set() };
  }
  const keys = new Set(
    raw.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return { allowAll: false, keys };
}

function parseConfigKey(input) {
  const text = String(input || '').trim();
  const match = text.match(/^([a-zA-Z0-9_.-]+)\s*=/);
  return match?.[1]?.toLowerCase() || '';
}

function isConfigKeyAllowed(key) {
  if (CONFIG_POLICY.allowAll) return true;
  return CONFIG_POLICY.keys.has(String(key || '').trim().toLowerCase());
}

function describeConfigPolicy() {
  if (CONFIG_POLICY.allowAll) return '`*` (allow all)';
  if (!CONFIG_POLICY.keys.size) return '(none)';
  return [...CONFIG_POLICY.keys].map((k) => `\`${k}\``).join(', ');
}

function formatConfigCommandStatus() {
  if (!ENABLE_CONFIG_CMD) return 'off';
  return `on (${describeConfigPolicy()})`;
}

function formatQueueLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 'unlimited';
  return `${Math.floor(n)}`;
}

function doesMessageTargetBot(message, botUserId) {
  const mentioned = Boolean(message.mentions?.users?.has?.(botUserId));
  const repliedToBot = message.mentions?.repliedUser?.id === botUserId;
  return mentioned || repliedToBot;
}

function resolveSecurityContext(channel, session = null) {
  const configured = getEffectiveSecurityProfile(session);
  const resolved = resolveSecurityProfileForChannel(channel, configured.profile, configured.source);
  const defaults = SECURITY_PROFILE_DEFAULTS[resolved.profile] || SECURITY_PROFILE_DEFAULTS.team;
  return {
    configuredProfile: configured.profile,
    configuredSource: configured.source,
    profile: resolved.profile,
    source: resolved.source,
    reason: resolved.reason,
    mentionOnly: MENTION_ONLY_OVERRIDE === null ? defaults.mentionOnly : MENTION_ONLY_OVERRIDE,
    maxQueuePerChannel: MAX_QUEUE_PER_CHANNEL_OVERRIDE === null ? defaults.maxQueuePerChannel : MAX_QUEUE_PER_CHANNEL_OVERRIDE,
  };
}

function resolveSecurityProfileForChannel(channel, configuredProfile = SECURITY_PROFILE, configuredSource = 'env default') {
  if (configuredProfile !== 'auto') {
    return {
      profile: configuredProfile,
      source: configuredSource === 'session override' ? 'session' : 'manual',
      reason: `${configuredSource}: ${configuredProfile}`,
    };
  }
  if (!channel) {
    return { profile: 'team', source: 'auto', reason: 'channel unavailable (fallback team)' };
  }
  if (channel.isDMBased?.()) {
    return { profile: 'solo', source: 'auto', reason: 'dm channel' };
  }

  const visibility = resolveGuildChannelVisibility(channel);
  if (visibility.visibility === 'public') {
    return { profile: 'public', source: 'auto', reason: visibility.reason };
  }
  if (visibility.visibility === 'team') {
    return { profile: 'team', source: 'auto', reason: visibility.reason };
  }
  return { profile: 'team', source: 'auto', reason: `${visibility.reason} (fallback team)` };
}

function resolveGuildChannelVisibility(channel) {
  const baseChannel = channel.isThread?.() ? (channel.parent || null) : channel;
  const target = baseChannel || channel;
  const guild = target?.guild || channel.guild || null;
  if (!guild) return { visibility: 'unknown', reason: 'missing guild context' };
  const everyoneRole = guild.roles?.everyone;
  if (!everyoneRole) return { visibility: 'unknown', reason: 'missing @everyone role' };
  const perms = target?.permissionsFor?.(everyoneRole);
  if (!perms) return { visibility: 'unknown', reason: 'permissions unavailable' };
  const canView = perms.has(PermissionFlagsBits.ViewChannel, true);
  return canView
    ? { visibility: 'public', reason: '@everyone can view channel' }
    : { visibility: 'team', reason: '@everyone cannot view channel' };
}

function formatSecurityProfileDisplay(security, language = 'en') {
  if (!security) return language === 'en' ? '(unknown)' : '（未知）';
  if (security.source === 'session') {
    return language === 'en'
      ? `${security.profile} (session override)`
      : `${security.profile}（频道覆盖）`;
  }
  if (security.source === 'manual') {
    return language === 'en'
      ? `${security.profile} (manual)`
      : `${security.profile}（手动设置）`;
  }
  return language === 'en'
    ? `${security.profile} (auto: ${security.reason})`
    : `${security.profile}（自动：${security.reason}）`;
}

function normalizeSlashPrefix(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '';
  return raw.slice(0, 12);
}

function buildSpawnEnv(env) {
  const out = { ...env };
  const home = out.HOME || out.USERPROFILE || '';
  const delimiter = path.delimiter;
  const rawPath = out.PATH || '';
  const entries = rawPath.split(delimiter).filter(Boolean);
  const seen = new Set(entries);

  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    home ? path.join(home, '.local', 'bin') : null,
    home ? path.join(home, 'bin') : null,
  ].filter(Boolean);

  for (const p of extras) {
    if (!seen.has(p)) {
      entries.push(p);
      seen.add(p);
    }
  }

  out.PATH = entries.join(delimiter);
  return out;
}

function getProviderDefaults(provider) {
  if (normalizeProvider(provider) === 'claude') {
    return { model: '(provider default)', effort: '(provider default)' };
  }
  return getCodexDefaults();
}

function getCliHealth(provider = DEFAULT_PROVIDER) {
  return normalizeProvider(provider) === 'claude' ? getClaudeCliHealth() : getCodexCliHealth();
}

function getCliHealthForBin({ bin, envKey }) {
  const check = spawnSync(bin, ['--version'], {
    env: SPAWN_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (check.error) {
    return {
      ok: false,
      bin,
      envKey,
      error: safeError(check.error),
    };
  }

  if (check.status !== 0) {
    return {
      ok: false,
      bin,
      envKey,
      error: (check.stderr || check.stdout || `exit=${check.status}`).trim(),
    };
  }

  const versionLine = (check.stdout || check.stderr || '').trim().split('\n')[0] || 'ok';
  return {
    ok: true,
    bin,
    envKey,
    version: versionLine,
  };
}

function getCodexCliHealth() {
  return getCliHealthForBin({ bin: CODEX_BIN, envKey: 'CODEX_BIN' });
}

function getClaudeCliHealth() {
  return getCliHealthForBin({ bin: CLAUDE_BIN, envKey: 'CLAUDE_BIN' });
}

function formatCliHealth(health, language = 'zh') {
  if (health.ok) return `✅ \`${health.bin}\` (${health.version})`;
  if (isCliNotFound(health.error)) {
    return language === 'en'
      ? `❌ \`${health.bin}\` not found (set ${health.envKey || 'CLI_BIN'}=/absolute/path/${health.bin} in .env)`
      : `❌ 未找到 \`${health.bin}\`（可在 .env 设置 ${health.envKey || 'CLI_BIN'}=/绝对路径/${health.bin}）`;
  }
  return `❌ ${truncate(String(health.error || 'unknown error'), 220)}`;
}

function formatCodexHealth(health) {
  return formatCliHealth(health);
}

function isCliNotFound(errorText) {
  const msg = String(errorText || '').toLowerCase();
  return msg.includes('enoent') || msg.includes('not found');
}

function isCodexNotFound(errorText) {
  return isCliNotFound(errorText);
}

function parseProviderInput(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['codex', 'openai'].includes(raw)) return 'codex';
  if (['claude', 'anthropic'].includes(raw)) return 'claude';
  return null;
}

function formatBotModeLabel() {
  if (!BOT_PROVIDER) {
    return 'shared (provider can switch per channel)';
  }
  return `locked to \`${BOT_PROVIDER}\` (${getProviderDisplayName(BOT_PROVIDER)})`;
}

function isAllowedUser(userId) {
  if (!ALLOWED_USER_IDS) return true;
  return ALLOWED_USER_IDS.has(userId);
}

function isAllowedChannel(channel) {
  if (!ALLOWED_CHANNEL_IDS) return true;

  if (ALLOWED_CHANNEL_IDS.has(channel.id)) return true;

  const parentId = channel.isThread?.() ? channel.parentId : null;
  return Boolean(parentId && ALLOWED_CHANNEL_IDS.has(parentId));
}

function buildPromptFromMessage(rawContent, attachments) {
  const text = String(rawContent || '').trim();
  const attachmentBlock = formatAttachmentsForPrompt(attachments);

  if (!text && !attachmentBlock) return '';
  if (text && !attachmentBlock) return text;

  if (!text && attachmentBlock) {
    return [
      '用户发送了附件，请先查看附件再回复。',
      attachmentBlock,
    ].join('\n\n');
  }

  return [
    text,
    attachmentBlock,
  ].join('\n\n').trim();
}

function formatAttachmentsForPrompt(attachments) {
  if (!attachments || !attachments.size) return '';

  const lines = [];
  let index = 0;
  for (const attachment of attachments.values()) {
    index += 1;
    if (index > 8) {
      lines.push(`...and ${attachments.size - 8} more attachment(s).`);
      break;
    }

    const name = attachment.name || 'unnamed-file';
    const type = attachment.contentType || 'unknown';
    const size = Number.isFinite(attachment.size) ? `${attachment.size}B` : 'unknown';
    const url = attachment.url || attachment.proxyURL || '(missing-url)';
    lines.push(`${index}. name=${name}; type=${type}; size=${size}; url=${url}`);
  }

  return [
    'Attachments:',
    ...lines,
  ].join('\n');
}

async function isAllowedInteractionChannel(interaction) {
  if (!ALLOWED_CHANNEL_IDS) return true;

  const channelId = interaction.channelId;
  if (channelId && ALLOWED_CHANNEL_IDS.has(channelId)) return true;

  let channel = interaction.channel || null;
  if (!channel && channelId) {
    try {
      channel = await interaction.client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }
  if (!channel) return false;

  const parentId = channel.isThread?.() ? channel.parentId : null;
  return Boolean(parentId && ALLOWED_CHANNEL_IDS.has(parentId));
}

function listRecentSessions({ provider = DEFAULT_PROVIDER, workspaceDir = '', limit = 10 } = {}) {
  return normalizeProvider(provider) === 'claude'
    ? listRecentClaudeSessions(limit, workspaceDir)
    : listRecentCodexSessions(limit);
}

function listRecentCodexSessions(limit = 10) {
  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];

  const files = findCodexRolloutFiles(sessionsDir);
  const latestById = new Map();

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id) continue;

    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }

    const prev = latestById.get(id);
    if (!prev || mtime > prev.mtime) {
      latestById.set(id, { id, mtime });
    }
  }

  return [...latestById.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function listRecentClaudeSessions(limit = 10, workspaceDir = '') {
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  const searchRoot = preferredRoot && fs.existsSync(preferredRoot) ? preferredRoot : getClaudeProjectsDir();
  if (!searchRoot || !fs.existsSync(searchRoot)) return [];

  return findClaudeSessionFiles(searchRoot)
    .map((file) => {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id) return null;
      try {
        const stat = fs.statSync(file);
        return stat.isFile() ? { id, mtime: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function findLatestRolloutFileBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;

  const files = findCodexRolloutFiles(sessionsDir);
  let latest = null;

  for (const file of files) {
    const id = parseSessionIdFromRolloutFile(path.basename(file));
    if (!id || String(id).toLowerCase() !== targetId) continue;

    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat?.isFile()) continue;
    if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        file,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      };
    }
  }

  return latest;
}

function findLatestClaudeSessionFileBySessionId(sessionId, workspaceDir = '', notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const roots = [];
  const preferredRoot = getClaudeProjectDir(workspaceDir);
  if (preferredRoot) roots.push(preferredRoot);
  const projectsRoot = getClaudeProjectsDir();
  if (projectsRoot && !roots.includes(projectsRoot)) roots.push(projectsRoot);

  let latest = null;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const file of findClaudeSessionFiles(root)) {
      const id = parseClaudeSessionIdFromFile(path.basename(file));
      if (!id || String(id).toLowerCase() !== targetId) continue;

      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat?.isFile()) continue;
      if (notOlderThanMs > 0 && stat.mtimeMs < notOlderThanMs) continue;

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      }
    }
    if (latest) return latest;
  }

  return latest;
}

function getCodexSessionsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.codex', 'sessions');
}

function getClaudeProjectsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.claude', 'projects');
}

function getClaudeProjectDir(workspaceDir = '') {
  const projectsRoot = getClaudeProjectsDir();
  const slug = encodeClaudeProjectPath(workspaceDir);
  if (!projectsRoot || !slug) return '';
  return path.join(projectsRoot, slug);
}

function encodeClaudeProjectPath(workspaceDir = '') {
  const raw = String(workspaceDir || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]/g, '-');
}

function findFilesRecursive(root, predicate) {
  const out = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function findCodexRolloutFiles(root) {
  return findFilesRecursive(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
}

function findClaudeSessionFiles(root) {
  return findFilesRecursive(root, (name) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i.test(name));
}

function parseSessionIdFromRolloutFile(filename) {
  const match = filename.match(/^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function parseClaudeSessionIdFromFile(filename) {
  const match = String(filename || '').match(/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
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

function normalizeTimeoutMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function normalizeIntervalMs(value, fallback, min = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeCompactStrategy(value) {
  const s = String(value || 'hard').trim().toLowerCase();
  if (s === 'hard' || s === 'native' || s === 'off') return s;
  console.warn(`⚠️ Unknown COMPACT_STRATEGY=${value}, fallback to hard`);
  return 'hard';
}

function describeCompactStrategy(strategy, language = 'en') {
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

  if (hasCodexScopedToken || hasClaudeScopedToken) {
    const availableProviders = [
      hasCodexScopedToken ? 'codex' : null,
      hasClaudeScopedToken ? 'claude' : null,
    ].filter(Boolean).join(', ');
    return `Missing DISCORD_TOKEN in shared mode. Found provider-scoped tokens for: ${availableProviders}. Start with npm run start:codex / npm run start:claude, or add a shared DISCORD_TOKEN.`;
  }

  return 'Missing DISCORD_TOKEN in environment';
}

function resolvePath(input) {
  if (path.isAbsolute(input)) return path.normalize(input);
  return path.resolve(process.cwd(), input);
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
