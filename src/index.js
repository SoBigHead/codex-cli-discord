import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { safeReply, withDiscordNetworkRetry } from './discord-reply-utils.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');
const LOCK_FILE = path.join(DATA_DIR, 'bot.lock');
const ENV_FILE = path.join(ROOT, '.env');

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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment');
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
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
const DEFAULT_MODE = (process.env.DEFAULT_MODE || 'safe').toLowerCase() === 'dangerous' ? 'dangerous' : 'safe';
const DEFAULT_UI_LANGUAGE = normalizeUiLanguage(process.env.DEFAULT_UI_LANGUAGE || 'zh');
const ONBOARDING_ENABLED_DEFAULT = parseOptionalBool(process.env.ONBOARDING_ENABLED_DEFAULT);
const ONBOARDING_ENABLED_BY_DEFAULT = ONBOARDING_ENABLED_DEFAULT === null ? true : ONBOARDING_ENABLED_DEFAULT;
const CODEX_TIMEOUT_MS = normalizeTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0);
const CODEX_BIN = (process.env.CODEX_BIN || 'codex').trim() || 'codex';
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
const SLASH_PREFIX = normalizeSlashPrefix(process.env.SLASH_PREFIX || 'cx');
const SPAWN_ENV = buildSpawnEnv(process.env);

ensureDir(DATA_DIR);
ensureDir(WORKSPACE_ROOT);

const bootCodexHealth = getCodexCliHealth();
if (bootCodexHealth.ok) {
  console.log(`🧩 Codex CLI: ${bootCodexHealth.version} via ${bootCodexHealth.bin}`);
} else {
  console.warn([
    '⚠️ Codex CLI 不可用，后续请求会失败。',
    `• bin: ${bootCodexHealth.bin}`,
    `• reason: ${bootCodexHealth.error}`,
    '• 处理: 安装 codex CLI，或在 .env 里设置 CODEX_BIN=/绝对路径/codex，然后重启 bot。',
  ].join('\n'));
}
console.log([
  '🔐 Security defaults:',
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

const db = loadDb();
const channelStates = new Map();
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
    await registerSlashCommands(bot);
  });

  // Auto-join threads so we receive messageCreate events in them
  bot.on('threadCreate', async (thread) => {
    try {
      if (!thread.joined) await thread.join();
      console.log(`🧵 Joined thread: ${thread.name} (${thread.id})`);
    } catch (err) {
      console.error(`Failed to join thread ${thread.id}:`, err.message);
    }
  });

  // Also join existing threads on startup
  bot.on('threadListSync', (threads) => {
    for (const thread of threads.values()) {
      if (!thread.joined) {
        thread.join().then(() => console.log(`🧵 Synced into thread: ${thread.name}`)).catch(() => {});
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

// ── Slash Commands ──────────────────────────────────────────────

const slashCommands = [
  new SlashCommandBuilder().setName(slashName('status')).setDescription('查看当前 thread 的 Codex 配置'),
  new SlashCommandBuilder().setName(slashName('reset')).setDescription('清空当前会话，下条消息新开上下文'),
  new SlashCommandBuilder().setName(slashName('sessions')).setDescription('列出最近的 Codex sessions'),
  new SlashCommandBuilder()
    .setName(slashName('setdir'))
    .setDescription('设置当前 thread 的工作目录')
    .addStringOption(o => o.setName('path').setDescription('绝对路径，如 ~/GitHub/my-project').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('model'))
    .setDescription('切换 Codex 模型')
    .addStringOption(o => o.setName('name').setDescription('模型名（如 o3, gpt-5.3-codex）或 default').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('effort'))
    .setDescription('设置 reasoning effort')
    .addStringOption(o => o.setName('level').setDescription('推理力度').setRequired(true)
      .addChoices(
        { name: 'high', value: 'high' },
        { name: 'medium', value: 'medium' },
        { name: 'low', value: 'low' },
        { name: 'default', value: 'default' },
      )),
  new SlashCommandBuilder()
    .setName(slashName('mode'))
    .setDescription('执行模式')
    .addStringOption(o => o.setName('type').setDescription('模式').setRequired(true)
      .addChoices(
        { name: 'safe (sandbox + auto-approve)', value: 'safe' },
        { name: 'dangerous (无 sandbox 无审批)', value: 'dangerous' },
      )),
  new SlashCommandBuilder()
    .setName(slashName('name'))
    .setDescription('给当前 session 起个名字，方便识别')
    .addStringOption(o => o.setName('label').setDescription('名字，如「cc-hub诊断」「埋点重构」').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('resume'))
    .setDescription('继承一个已有的 Codex session')
    .addStringOption(o => o.setName('session_id').setDescription('Codex session UUID').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('queue'))
    .setDescription('查看当前频道的任务队列状态'),
  new SlashCommandBuilder()
    .setName(slashName('doctor'))
    .setDescription('查看 bot 运行与安全配置体检'),
  new SlashCommandBuilder()
    .setName(slashName('onboarding'))
    .setDescription('新用户引导：安装后检查与首跑步骤（按钮分步）'),
  new SlashCommandBuilder()
    .setName(slashName('onboarding_config'))
    .setDescription('配置 onboarding 开关（当前频道）')
    .addStringOption(o => o.setName('action').setDescription('操作').setRequired(true)
      .addChoices(
        { name: 'on', value: 'on' },
        { name: 'off', value: 'off' },
        { name: 'status', value: 'status' },
      )),
  new SlashCommandBuilder()
    .setName(slashName('language'))
    .setDescription('设置消息提示语言（中文/English）')
    .addStringOption(o => o.setName('name').setDescription('语言').setRequired(true)
      .addChoices(
        { name: '中文', value: 'zh' },
        { name: 'English', value: 'en' },
      )),
  new SlashCommandBuilder()
    .setName(slashName('profile'))
    .setDescription('设置当前频道 security profile（auto/solo/team/public）')
    .addStringOption(o => o.setName('name').setDescription('profile').setRequired(true)
      .addChoices(
        { name: 'auto', value: 'auto' },
        { name: 'solo', value: 'solo' },
        { name: 'team', value: 'team' },
        { name: 'public', value: 'public' },
        { name: 'status', value: 'status' },
      )),
  new SlashCommandBuilder()
    .setName(slashName('timeout'))
    .setDescription('设置当前频道 codex timeout（ms/off/status）')
    .addStringOption(o => o.setName('value').setDescription('如 60000 / off / status').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('process_lines'))
    .setDescription('设置过程内容窗口行数（1-5 或 status）')
    .addStringOption(o => o.setName('value').setDescription('如 2 / 3 / 5 / status').setRequired(true)),
  new SlashCommandBuilder()
    .setName(slashName('progress'))
    .setDescription('查看当前任务的最新执行进度'),
  new SlashCommandBuilder()
    .setName(slashName('cancel'))
    .setDescription('中断当前任务并清空排队消息'),
];

async function registerSlashCommands(client) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    if (restProxyAgent) {
      rest.setAgent(restProxyAgent);
    }
    const body = slashCommands.map(c => c.toJSON());

    // Register to all guilds the bot is in (guild commands appear instantly)
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
      console.log(`📝 Registered ${body.length} slash commands in guild: ${guild.name}`);
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

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
        session.codexThreadId = null;
        session.configOverrides = [];
        saveDb();
        await respond('♻️ 会话已清空，下条消息新开上下文。');
        break;
      }

      case 'sessions': {
        try {
          const sessions = listRecentCodexSessions(10);
          if (!sessions.length) {
            await respond({ content: '没有找到任何 Codex session。', flags: 64 });
            break;
          }

          const lines = sessions.map((s, i) => `${i + 1}. \`${s.id}\` (${humanAge(Date.now() - s.mtime)} ago)`);
          await respond({
            content: [`**最近 Sessions**（用 \`${slashRef('resume')}\` 继承）`, ...lines].join('\n'),
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
        ensureGitRepo(resolved);
        session.workspaceDir = resolved;
        session.codexThreadId = null;
        saveDb();
        await respond(`✅ workspace → \`${resolved}\`（会话已重置）`);
        break;
      }

      case 'model': {
        const name = interaction.options.getString('name');
        session.model = name.toLowerCase() === 'default' ? null : name;
        saveDb();
        await respond(`✅ model = ${session.model || '(default)'}`);
        break;
      }

      case 'effort': {
        const level = interaction.options.getString('level');
        session.effort = level === 'default' ? null : level;
        saveDb();
        await respond(`✅ effort = ${session.effort || '(default)'}`);
        break;
      }

      case 'mode': {
        const type = interaction.options.getString('type');
        session.mode = type;
        saveDb();
        await respond(`✅ mode = ${session.mode}`);
        break;
      }

      case 'resume': {
        const sid = interaction.options.getString('session_id');
        session.codexThreadId = sid.trim();
        saveDb();
        await respond(`✅ 已绑定 session: \`${session.codexThreadId}\``);
        break;
      }

      case 'name': {
        const label = interaction.options.getString('label').trim();
        session.name = label;
        saveDb();
        await respond(`✅ session 命名为: **${label}**`);
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
          session.onboardingEnabled = action === 'on';
          saveDb();
          await respond({
            content: formatOnboardingConfigReport(language, session.onboardingEnabled, true),
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
        const language = parseUiLanguageInput(requested) || DEFAULT_UI_LANGUAGE;
        session.language = language;
        saveDb();
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
        session.securityProfile = profile;
        saveDb();
        await respond({
          content: formatProfileConfigReport(getSessionLanguage(session), profile, true),
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
        session.timeoutMs = parsedTimeout.timeoutMs;
        saveDb();
        await respond({
          content: formatTimeoutConfigReport(language, resolveTimeoutSetting(session), true),
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
        session.processLines = parsed.lines;
        saveDb();
        await respond({
          content: formatProcessLinesConfigReport(language, resolveProcessLinesSetting(session), true),
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

async function handleCommand(message, key, content) {
  const [cmd, ...rest] = content.split(/\s+/);
  const arg = rest.join(' ').trim();
  const session = getSession(key);

  switch (cmd.toLowerCase()) {
    case '!help': {
      await safeReply(message, formatHelpReport(session));
      break;
    }

    case '!status': {
      await safeReply(message, formatStatusReport(key, session, message.channel));
      break;
    }

    case '!queue': {
      await safeReply(message, formatQueueReport(key, session, message.channel));
      break;
    }

    case '!doctor': {
      await safeReply(message, formatDoctorReport(key, session, message.channel));
      break;
    }

    case '!onboarding':
    case '!onboard':
    case '!guide': {
      const language = getSessionLanguage(session);
      const onboardingOp = parseOnboardingConfigAction(arg);
      if (cmd.toLowerCase() === '!onboarding' && onboardingOp) {
        if (onboardingOp.type === 'invalid') {
          await safeReply(message, formatOnboardingConfigHelp(language));
          break;
        }
        if (onboardingOp.type === 'status') {
          await safeReply(message, formatOnboardingConfigReport(language, isOnboardingEnabled(session), false));
          break;
        }
        if (onboardingOp.type === 'set') {
          session.onboardingEnabled = onboardingOp.enabled;
          saveDb();
          await safeReply(message, formatOnboardingConfigReport(language, session.onboardingEnabled, true));
          break;
        }
      }
      if (!isOnboardingEnabled(session)) {
        await safeReply(message, formatOnboardingDisabledMessage(language));
        break;
      }
      await safeReply(message, formatOnboardingReport(key, session, message.channel, language));
      break;
    }

    case '!lang':
    case '!language': {
      const requested = parseUiLanguageInput(arg);
      if (!requested) {
        await safeReply(message, formatLanguageConfigHelp(getSessionLanguage(session)));
        break;
      }
      session.language = requested;
      saveDb();
      await safeReply(message, formatLanguageConfigReport(requested, true));
      break;
    }

    case '!profile': {
      const language = getSessionLanguage(session);
      if (!arg || ['status', 'state', 'show', '查看', '状态'].includes(arg.toLowerCase())) {
        await safeReply(message, formatProfileConfigReport(language, getEffectiveSecurityProfile(session).profile, false));
        break;
      }
      const profile = parseSecurityProfileInput(arg);
      if (!profile) {
        await safeReply(message, formatProfileConfigHelp(language));
        break;
      }
      session.securityProfile = profile;
      saveDb();
      await safeReply(message, formatProfileConfigReport(language, profile, true));
      break;
    }

    case '!timeout': {
      const language = getSessionLanguage(session);
      const parsedTimeout = parseTimeoutConfigAction(arg || 'status');
      if (!parsedTimeout || parsedTimeout.type === 'invalid') {
        await safeReply(message, formatTimeoutConfigHelp(language));
        break;
      }
      if (parsedTimeout.type === 'status') {
        await safeReply(message, formatTimeoutConfigReport(language, resolveTimeoutSetting(session), false));
        break;
      }
      session.timeoutMs = parsedTimeout.timeoutMs;
      saveDb();
      await safeReply(message, formatTimeoutConfigReport(language, resolveTimeoutSetting(session), true));
      break;
    }

    case '!processlines':
    case '!progresslines':
    case '!plines': {
      const language = getSessionLanguage(session);
      const parsed = parseProcessLinesConfigAction(arg || 'status');
      if (!parsed || parsed.type === 'invalid') {
        await safeReply(message, formatProcessLinesConfigHelp(language));
        break;
      }
      if (parsed.type === 'status') {
        await safeReply(message, formatProcessLinesConfigReport(language, resolveProcessLinesSetting(session), false));
        break;
      }
      session.processLines = parsed.lines;
      saveDb();
      await safeReply(message, formatProcessLinesConfigReport(language, resolveProcessLinesSetting(session), true));
      break;
    }

    case '!progress': {
      await safeReply(message, formatProgressReport(key, session, message.channel));
      break;
    }

    case '!abort':
    case '!cancel':
    case '!stop': {
      const outcome = cancelChannelWork(key, `text_command:${cmd.toLowerCase()}`);
      await safeReply(message, formatCancelReport(outcome));
      break;
    }

    case '!cd':
    case '!setdir': {
      if (!arg) {
        await safeReply(message, '用法：`!setdir <path>`\n例：`!setdir ~/GitHub/my-project`');
        return;
      }
      const resolved = resolvePath(arg);
      if (!fs.existsSync(resolved)) {
        await safeReply(message, `❌ 目录不存在：\`${resolved}\`\n要新建的话先 mkdir。`);
        return;
      }
      ensureGitRepo(resolved);
      session.workspaceDir = resolved;
      session.codexThreadId = null;
      saveDb();
      await safeReply(message, `✅ workspace → \`${resolved}\`\n会话已重置（新目录 = 新上下文）。`);
      break;
    }

    case '!resume': {
      if (!arg) {
        await safeReply(message, '用法：`!resume <codex-session-id>`\n用 `!sessions` 查看可用的 session。');
        return;
      }
      session.codexThreadId = arg.trim();
      saveDb();
      await safeReply(message, `✅ 已绑定 Codex session: \`${session.codexThreadId}\`\n下条消息会 resume 这个上下文。`);
      break;
    }

    case '!sessions': {
      try {
        const sessions = listRecentCodexSessions(10);
        if (!sessions.length) {
          await safeReply(message, '没有找到任何 Codex session。');
          break;
        }

        const lines = sessions.map((s, i) => {
          const ago = humanAge(Date.now() - s.mtime);
          return `${i + 1}. \`${s.id}\` (${ago} ago)`;
        });

        await safeReply(message, [
          '**最近 Codex Sessions**（用 `!resume <id>` 继承）',
          ...lines,
        ].join('\n'));
      } catch (err) {
        await safeReply(message, `❌ 读取 sessions 失败：${safeError(err)}`);
      }
      break;
    }

    case '!model': {
      if (!arg) {
        await safeReply(message, '用法：`!model <name|default>`\n例：`!model o3` / `!model gpt-5.3-codex` / `!model default`');
        return;
      }
      if (arg.toLowerCase() === 'default') {
        session.model = null;
      } else {
        session.model = arg;
      }
      saveDb();
      await safeReply(message, `✅ model = ${session.model || '(default from config.toml)'}`);
      break;
    }

    case '!effort': {
      const valid = ['high', 'medium', 'low', 'default'];
      if (!arg || !valid.includes(arg.toLowerCase())) {
        await safeReply(message, '用法：`!effort <high|medium|low|default>`');
        return;
      }
      if (arg.toLowerCase() === 'default') {
        session.effort = null;
      } else {
        session.effort = arg.toLowerCase();
      }
      saveDb();
      await safeReply(message, `✅ reasoning effort = ${session.effort || '(default from config.toml)'}`);
      break;
    }

    case '!config': {
      if (!ENABLE_CONFIG_CMD) {
        await safeReply(message, '⛔ `!config` 当前已禁用。可在 `.env` 设置 `ENABLE_CONFIG_CMD=true` 后重启。');
        return;
      }
      if (!arg) {
        await safeReply(message, [
          '用法：`!config <key=value>`',
          '例：`!config personality="concise"`',
          `允许的 key：${describeConfigPolicy()}`,
        ].join('\n'));
        return;
      }
      const keyName = parseConfigKey(arg);
      if (!keyName) {
        await safeReply(message, '❌ 参数格式错误：必须是 `key=value`。');
        return;
      }
      if (!isConfigKeyAllowed(keyName)) {
        await safeReply(message, `⛔ 不允许的配置 key：\`${keyName}\`\n允许的 key：${describeConfigPolicy()}`);
        return;
      }
      session.configOverrides = session.configOverrides || [];
      session.configOverrides.push(arg);
      saveDb();
      await safeReply(message, `✅ 已添加配置：\`${arg}\`\n当前额外配置：${session.configOverrides.map(c => `\`${c}\``).join(', ')}`);
      break;
    }

    case '!mode': {
      if (!arg || !['safe', 'dangerous'].includes(arg.toLowerCase())) {
        await safeReply(message, '用法：`!mode <safe|dangerous>`');
        return;
      }
      session.mode = arg.toLowerCase();
      saveDb();
      await safeReply(message, `✅ mode = ${session.mode}`);
      break;
    }

    case '!reset': {
      session.codexThreadId = null;
      session.configOverrides = [];
      saveDb();
      await safeReply(message, '♻️ 已清空会话 + 额外配置。下条消息新开上下文。');
      break;
    }

    default:
      await safeReply(message, '未知命令。发 `!help` 看命令列表。');
  }
}

function getChannelState(key) {
  let state = channelStates.get(key);
  if (!state) {
    state = {
      running: false,
      queue: [],
      activeRun: null,
      cancelRequested: false,
    };
    channelStates.set(key, state);
  }
  return state;
}

async function enqueuePrompt(message, key, content, securityContext = null) {
  const state = getChannelState(key);
  const security = securityContext || resolveSecurityContext(message.channel, getSession(key));
  const maxQueue = security.maxQueuePerChannel;
  if (maxQueue > 0 && state.queue.length >= maxQueue) {
    await safeReply(
      message,
      `🚧 当前频道队列已满（上限 ${maxQueue}）。请稍后重试，或用 \`!queue\` / \`!abort\` 处理积压任务。`,
    );
    return;
  }
  const queuedAhead = (state.running ? 1 : 0) + state.queue.length;

  state.queue.push({
    message,
    key,
    content,
    enqueuedAt: Date.now(),
  });

  if (queuedAhead > 0) {
    await safeReply(
      message,
      `⏳ 已加入队列，前面还有 ${queuedAhead} 条。可用 \`!queue\` 查看状态，\`!abort\` 中断当前任务。`,
    );
  }

  void processPromptQueue(key);
}

async function processPromptQueue(key) {
  const state = getChannelState(key);
  if (state.running) return;

  state.running = true;
  try {
    while (state.queue.length) {
      const job = state.queue.shift();
      if (!job) continue;
      await runPromptJob(state, job);
    }
  } finally {
    state.running = false;
    state.activeRun = null;
    state.cancelRequested = false;
  }
}

async function runPromptJob(channelState, job) {
  const { message, key, content } = job;
  channelState.cancelRequested = false;

  try {
    await message.react('⚡').catch(() => {});
    const outcome = await handlePrompt(message, key, content, channelState);
    await message.reactions.cache.get('⚡')?.users.remove(client?.user?.id).catch(() => {});
    if (outcome.ok) {
      await message.react('✅').catch(() => {});
    } else if (outcome.cancelled) {
      await message.react('🛑').catch(() => {});
    } else {
      await message.react('❌').catch(() => {});
    }
  } catch (err) {
    console.error('runPromptJob error:', err);
    try {
      await message.reactions.cache.get('⚡')?.users.remove(client?.user?.id).catch(() => {});
      await message.react('❌').catch(() => {});
      await safeReply(message, `❌ 处理失败：${safeError(err)}`);
    } catch {
      // ignore
    }
  } finally {
    channelState.activeRun = null;
  }
}

function setActiveRun(channelState, message, prompt, child, phase = 'exec') {
  const prev = channelState.activeRun;
  channelState.activeRun = {
    child,
    startedAt: Date.now(),
    messageId: message.id,
    phase,
    promptPreview: truncate(String(prompt || '').replace(/\s+/g, ' '), 120),
    cancelRequested: Boolean(channelState.cancelRequested),
    progressEvents: prev?.progressEvents || 0,
    lastProgressText: prev?.lastProgressText || null,
    lastProgressAt: prev?.lastProgressAt || null,
    progressMessageId: prev?.progressMessageId || null,
    progressPlan: cloneProgressPlan(prev?.progressPlan),
    completedSteps: Array.isArray(prev?.completedSteps) ? [...prev.completedSteps] : [],
    recentActivities: Array.isArray(prev?.recentActivities) ? [...prev.recentActivities] : [],
  };
}

function stopChildProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 3000).unref?.();
}

function cancelChannelWork(key, reason = 'manual') {
  const state = getChannelState(key);
  const queued = state.queue.length;
  state.queue.length = 0;
  state.cancelRequested = true;

  let cancelledRunning = false;
  let pid = null;
  if (state.activeRun?.child) {
    state.activeRun.cancelRequested = true;
    cancelledRunning = true;
    pid = state.activeRun.child.pid ?? null;
    stopChildProcess(state.activeRun.child);
  }

  return {
    key,
    reason,
    cancelledRunning,
    pid,
    clearedQueued: queued,
  };
}

function cancelAllChannelWork(reason = 'system') {
  for (const key of channelStates.keys()) {
    cancelChannelWork(key, reason);
  }
}

function getRuntimeSnapshot(key) {
  const state = getChannelState(key);
  const active = state.activeRun;
  return {
    running: Boolean(state.running || active),
    queued: state.queue.length,
    activeSinceMs: active ? Math.max(0, Date.now() - active.startedAt) : null,
    phase: active?.phase || null,
    pid: active?.child?.pid ?? null,
    messageId: active?.messageId || null,
    progressEvents: active?.progressEvents || 0,
    progressText: active?.lastProgressText || null,
    progressAgoMs: active?.lastProgressAt ? Math.max(0, Date.now() - active.lastProgressAt) : null,
    progressMessageId: active?.progressMessageId || null,
    progressPlan: cloneProgressPlan(active?.progressPlan),
    completedSteps: Array.isArray(active?.completedSteps) ? [...active.completedSteps] : [],
    recentActivities: Array.isArray(active?.recentActivities) ? [...active.recentActivities] : [],
  };
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
  return session.name
    ? `**${session.name}** (\`${session.codexThreadId || 'auto'}\`)`
    : `\`${session.codexThreadId || '(auto — 下条消息新建)'}\``;
}

function formatStatusReport(key, session, channel = null) {
  const workspaceDir = ensureWorkspace(session, key);
  const defaults = getCodexDefaults();
  const codexHealth = getCodexCliHealth();
  const runtime = getRuntimeSnapshot(key);
  const security = resolveSecurityContext(channel, session);
  const language = getSessionLanguage(session);
  const timeoutSetting = resolveTimeoutSetting(session);
  const processLinesSetting = resolveProcessLinesSetting(session);
  const securitySetting = getEffectiveSecurityProfile(session);
  const modeDesc = session.mode === 'dangerous'
    ? 'dangerous (无沙盒, 全权限)'
    : 'safe (沙盒隔离, 无网络)';
  const planSummary = formatProgressPlanSummary(runtime.progressPlan);
  const completedSummary = formatCompletedStepsSummary(runtime.completedSteps, {
    planState: runtime.progressPlan,
    latestStep: runtime.progressText,
    maxSteps: 3,
  });
  const processLines = renderProcessContentLines(runtime.recentActivities, normalizeUiLanguage(language), processLinesSetting.lines);

  return [
    '🧭 **当前配置**',
    `• channel id: \`${key}\``,
    channel?.name ? `• channel: ${channel.name}` : null,
    `• workspace: \`${workspaceDir}\``,
    `• mode: ${modeDesc}`,
    `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
    `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
    `• codex-cli: ${formatCodexHealth(codexHealth)}`,
    `• session: ${formatSessionStatusLabel(session)}`,
    `• last input tokens: ${formatTokenValue(session.lastInputTokens)}`,
    `• runtime: ${formatRuntimeLabel(runtime)}`,
    `• queued prompts: ${runtime.queued}`,
    `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
    `• progress events: ${runtime.progressEvents}`,
    runtime.progressText ? `• latest activity: ${runtime.progressText}` : null,
    ...processLines,
    planSummary ? `• plan: ${planSummary}` : null,
    completedSummary ? `• completed milestones: ${completedSummary}` : null,
    runtime.progressAgoMs !== null ? `• progress updated: ${humanAge(runtime.progressAgoMs)} ago` : null,
    runtime.messageId ? `• active message id: \`${runtime.messageId}\`` : null,
    runtime.progressMessageId ? `• progress message id: \`${runtime.progressMessageId}\`` : null,
    `• security profile: ${formatSecurityProfileDisplay(security)}`,
    `• profile setting: ${formatSecurityProfileLabel(securitySetting.profile)} (${securitySetting.source})`,
    `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
    `• ui language: ${formatLanguageLabel(language)}`,
    `• onboarding: ${isOnboardingEnabled(session) ? 'on' : 'off'}`,
    `• !config: ${formatConfigCommandStatus()}`,
    `• config allowlist: ${describeConfigPolicy()}`,
    `• codex timeout: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`,
    `• process window: ${processLinesSetting.lines} lines (${processLinesSetting.source})`,
    `• compact strategy: ${describeCompactStrategy(COMPACT_STRATEGY)}`,
    `• compact trigger: ${COMPACT_ON_THRESHOLD ? 'on' : 'off'}`,
    `• compact threshold: ${MAX_INPUT_TOKENS_BEFORE_COMPACT}`,
    COMPACT_STRATEGY === 'native' && COMPACT_ON_THRESHOLD
      ? `• native auto compact limit: ${MODEL_AUTO_COMPACT_TOKEN_LIMIT} (model_auto_compact_token_limit)`
      : null,
    session.configOverrides?.length ? `• extra config: ${session.configOverrides.join(', ')}` : null,
    `• bot pid: ${process.pid}`,
    `• bot uptime: ${humanAge(Math.max(0, Math.floor(process.uptime() * 1000)))}`,
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
  const codexHealth = getCodexCliHealth();
  const security = resolveSecurityContext(channel, session);
  const timeoutSetting = resolveTimeoutSetting(session);
  const securitySetting = getEffectiveSecurityProfile(session);
  return [
    '🩺 **Bot Doctor**',
    `• codex-cli: ${formatCodexHealth(codexHealth)}`,
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
    `• codex timeout: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`,
    `• compact strategy: ${describeCompactStrategy(COMPACT_STRATEGY)}`,
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

function parseProcessLinesConfigAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (!/^\d+$/.test(raw)) return { type: 'invalid' };
  const lines = normalizeSessionProcessLines(Number(raw));
  if (lines === null) return { type: 'invalid' };
  return { type: 'set', lines };
}

function isOnboardingEnabled(session) {
  if (!session) return ONBOARDING_ENABLED_BY_DEFAULT;
  return session.onboardingEnabled !== false;
}

function parseOnboardingConfigAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['status', 'show', 'state', '查看', '状态'].includes(raw)) return { type: 'status' };
  if (['on', 'enable', 'enabled', 'true', '1', 'yes', '开启', '启用', '打开'].includes(raw)) {
    return { type: 'set', enabled: true };
  }
  if (['off', 'disable', 'disabled', 'false', '0', 'no', '关闭', '禁用'].includes(raw)) {
    return { type: 'set', enabled: false };
  }
  return { type: 'invalid' };
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

function formatOnboardingDisabledMessage(language) {
  if (language === 'en') {
    return [
      'ℹ️ Onboarding is currently disabled in this channel.',
      `Enable with \`${slashRef('onboarding_config')} on\` or \`!onboarding on\`.`,
    ].join('\n');
  }
  return [
    'ℹ️ 当前频道已关闭 onboarding。',
    `可通过 \`${slashRef('onboarding_config')} on\` 或 \`!onboarding on\` 重新开启。`,
  ].join('\n');
}

function formatOnboardingConfigReport(language, enabled, changed) {
  const state = enabled ? 'on' : 'off';
  if (language === 'en') {
    if (changed) {
      return `✅ Onboarding is now ${state}\nUse \`${slashRef('onboarding')}\` or \`!onboarding\` to open guide.`;
    }
    return `ℹ️ Onboarding is currently ${state}`;
  }
  if (changed) {
    return `✅ onboarding 已设置为 ${state}\n可使用 \`${slashRef('onboarding')}\` 或 \`!onboarding\` 打开引导。`;
  }
  return `ℹ️ 当前 onboarding = ${state}`;
}

function formatOnboardingConfigHelp(language) {
  if (language === 'en') {
    return [
      'Usage: `!onboarding <on|off|status>`',
      `Current command also supports slash: \`${slashRef('onboarding_config')} <on|off|status>\``,
    ].join('\n');
  }
  return [
    '用法：`!onboarding <on|off|status>`',
    `也可使用 slash：\`${slashRef('onboarding_config')} <on|off|status>\``,
  ].join('\n');
}

function formatHelpReport(session) {
  const language = getSessionLanguage(session);
  if (language === 'en') {
    return [
      '**📋 Commands**',
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
      `• \`${slashRef('timeout')} <ms|off|status>\` / \`!timeout <...>\` — codex timeout`,
      `• \`${slashRef('process_lines')} <1-5|status>\` / \`!processlines <...>\` — process content window lines`,
      '• `!progress` — current run progress',
      '• `!abort` / `!cancel` / `!stop` — stop running task and clear queue',
      '• `!reset` — clear session context',
      '• `!resume <session_id>` — bind existing Codex session',
      '• `!sessions` — list recent Codex sessions',
      '',
      '**Workspace**',
      '• `!setdir <path>` — set workspace (resets session)',
      '• `!cd <path>` — alias of `!setdir`',
      '',
      '**Model & Runtime**',
      '• `!model <name|default>` — set model override',
      '• `!effort <high|medium|low|default>` — reasoning effort',
      '• `!mode <safe|dangerous>` — execution mode',
      '• `!config <key=value>` — append codex `-c` config (when enabled + allowlisted)',
      '',
      'Normal messages are forwarded to Codex.',
    ].join('\n');
  }
  return [
    '**📋 命令列表**',
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
    `• \`${slashRef('timeout')} <毫秒|off|status>\` / \`!timeout <...>\` — Codex 超时`,
    `• \`${slashRef('process_lines')} <1-5|status>\` / \`!processlines <...>\` — 过程内容窗口行数`,
    '• `!progress` — 查看当前任务的最新进度',
    '• `!abort` / `!cancel` / `!stop` — 中断当前任务并清空队列',
    '• `!reset` — 清空会话，下条消息新开上下文',
    '• `!resume <session_id>` — 继承一个已有的 Codex session',
    '• `!sessions` — 列出最近的 Codex sessions（从 ~/.codex/sessions/）',
    '',
    '**工作目录**',
    '• `!setdir <path>` — 设置工作目录（会清空旧会话）',
    '• `!cd <path>` — 同 !setdir 的别名',
    '',
    '**模型 & 执行**',
    '• `!model <name|default>` — 切换模型（如 gpt-5.3-codex, o3）',
    '• `!effort <high|medium|low|default>` — reasoning effort',
    '• `!mode <safe|dangerous>` — 执行模式',
    '• `!config <key=value>` — 添加 codex -c 配置（需 ENABLE_CONFIG_CMD=true 且 key 在白名单）',
    '',
    '普通消息直接转给 Codex。',
  ].join('\n');
}

function getOnboardingSnapshot(key, session = null, channel = null, language = DEFAULT_UI_LANGUAGE) {
  const runtime = getRuntimeSnapshot(key);
  const codexHealth = getCodexCliHealth();
  const security = resolveSecurityContext(channel, session);
  const profileSetting = getEffectiveSecurityProfile(session);
  const timeoutSetting = resolveTimeoutSetting(session);
  const currentLanguage = getSessionLanguage(session);
  const hasToken = Boolean(DISCORD_TOKEN);
  const hasApiKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  const hasWorkspace = Boolean(String(WORKSPACE_ROOT || '').trim());
  const lang = normalizeUiLanguage(language);
  const mentionHint = security.mentionOnly
    ? (lang === 'en'
      ? 'Normal chat messages require @Bot mention (or use `!` commands).'
      : '本频道普通消息需 @Bot（或直接用 `!` 命令）。')
    : (lang === 'en'
      ? 'Normal messages in this channel can be sent directly to the bot.'
      : '本频道普通消息可直接发送给 Bot。');
  const firstPromptHint = security.mentionOnly
    ? (lang === 'en'
      ? 'Send `@Bot check current directory and create a TODO`'
      : '发送 `@Bot 帮我检查当前目录并创建一个 TODO`')
    : (lang === 'en'
      ? 'Send `check current directory and create a TODO`'
      : '发送 `帮我检查当前目录并创建一个 TODO`');
  return {
    language: lang,
    runtime,
    codexHealth,
    security,
    profileSetting,
    timeoutSetting,
    currentLanguage,
    hasToken,
    hasApiKey,
    hasWorkspace,
    mentionHint,
    firstPromptHint,
  };
}

function formatOnboardingReport(key, session = null, channel = null, language = DEFAULT_UI_LANGUAGE) {
  const lang = normalizeUiLanguage(language);
  const snapshot = getOnboardingSnapshot(key, session, channel, lang);
  if (lang === 'en') {
    return [
      '🧭 **Onboarding (Text)**',
      `• For interactive steps, use \`${slashRef('onboarding')}\` (buttons + direct config on each step)`,
      '',
      '**1) Preflight check**',
      `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
      `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (depends on your provider)'}`,
      `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
      `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
      `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)} (${snapshot.profileSetting.source})`,
      `• timeout setting: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
      '',
      '**2) Access scope & security policy (effective now)**',
      `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
      `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
      `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
      `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'} (${snapshot.mentionHint})`,
      `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
      `• queued prompts now: ${snapshot.runtime.queued}`,
      `• !config: ${formatConfigCommandStatus()}`,
      '',
      '**3) First run flow**',
      `1. \`${slashRef('doctor')}\` or \`!doctor\` to verify health checks.`,
      `2. \`${slashRef('status')}\` or \`!status\` to verify mode/model/workspace.`,
      `3. \`${slashRef('setdir')} <path>\` or \`!setdir <path>\` to bind target project.`,
      `4. Send your first task: ${snapshot.firstPromptHint}`,
      `5. If backlog appears, check \`${slashRef('queue')}\` / \`!queue\`; use \`${slashRef('cancel')}\` / \`!abort\` when needed.`,
      '',
      '**4) Recommended defaults**',
      '• Start with 1 channel + 1 admin account, then gradually open access.',
      '• Keep `ENABLE_CONFIG_CMD=false`; if enabled, allowlist only required keys.',
      '• Keep `safe` as default; switch to `dangerous` only in trusted environments.',
      '',
      `Quick re-check: \`${slashRef('doctor')}\``,
    ].join('\n');
  }
  return [
    '🧭 **Onboarding（文本版）**',
    `• 交互分步版请使用 \`${slashRef('onboarding')}\`（每步可直接配置 + 上一步/下一步/完成）`,
    '',
    '**1) 安装自检（先看当前是否可跑）**',
    `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
    `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (按 provider 需要配置)'}`,
    `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
    `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
    `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
    `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)}（${snapshot.profileSetting.source}）`,
    `• timeout setting: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
    '',
    '**2) 访问范围与安全策略（当前生效）**',
    `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
    `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
    `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
    `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}（${snapshot.mentionHint}）`,
    `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
    `• queued prompts now: ${snapshot.runtime.queued}`,
    `• !config: ${formatConfigCommandStatus()}`,
    '',
    '**3) 首跑流程（按顺序）**',
    `1. \`${slashRef('doctor')}\` 或 \`!doctor\`，确认健康检查通过。`,
    `2. \`${slashRef('status')}\` 或 \`!status\`，确认 mode/model/workspace。`,
    `3. \`${slashRef('setdir')} <path>\` 或 \`!setdir <path>\`，绑定目标项目目录。`,
    `4. 发送第一条任务：${snapshot.firstPromptHint}`,
    `5. 如有积压，用 \`${slashRef('queue')}\` / \`!queue\` 查看；必要时 \`${slashRef('cancel')}\` / \`!abort\`。`,
    '',
    '**4) 新用户默认建议**',
    '• 先限制到 1 个频道 + 1 个管理员账号，再逐步放开。',
    '• 保持 `ENABLE_CONFIG_CMD=false`；确实要开时仅白名单必要 key。',
    '• 默认用 `safe`；仅在可信环境切到 `dangerous`。',
    '',
    `需要快速复查时可直接执行：\`${slashRef('doctor')}\``,
  ].join('\n');
}

function normalizeOnboardingStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(ONBOARDING_TOTAL_STEPS, Math.floor(n)));
}

function buildOnboardingButtonId(action, step, userId, value = '') {
  const safeAction = String(action || '').trim().toLowerCase();
  const safeStep = normalizeOnboardingStep(step);
  const safeUserId = String(userId || '').trim();
  const safeValue = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return safeValue
    ? `onb:${safeAction}:${safeStep}:${safeUserId}:${safeValue}`
    : `onb:${safeAction}:${safeStep}:${safeUserId}`;
}

function isOnboardingButtonId(customId) {
  return /^onb:/.test(String(customId || ''));
}

function parseOnboardingButtonId(customId) {
  const text = String(customId || '').trim();
  const parts = text.split(':');
  if (parts.length < 4 || parts[0] !== 'onb') return null;
  const [, action, rawStep, userId, ...rest] = parts;
  if (!['goto', 'refresh', 'done', 'set_lang', 'set_profile', 'set_timeout'].includes(action)) return null;
  if (!/^[0-9]{5,32}$/.test(String(userId || ''))) return null;
  return {
    action,
    step: normalizeOnboardingStep(rawStep),
    userId,
    value: String(rest.join(':') || '').trim().toLowerCase(),
  };
}

function buildOnboardingConfigRow(step, userId, session = null, language = DEFAULT_UI_LANGUAGE) {
  const lang = normalizeUiLanguage(language);
  const current = normalizeOnboardingStep(step);
  if (current === 1) {
    const activeLanguage = getSessionLanguage(session);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('set_lang', current, userId, 'zh'))
        .setLabel('中文')
        .setStyle(activeLanguage === 'zh' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('set_lang', current, userId, 'en'))
        .setLabel('English')
        .setStyle(activeLanguage === 'en' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }

  if (current === 2) {
    const activeProfile = getEffectiveSecurityProfile(session).profile;
    const options = ['auto', 'solo', 'team', 'public'];
    return new ActionRowBuilder().addComponents(
      ...options.map((profile) => new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('set_profile', current, userId, profile))
        .setLabel(profile)
        .setStyle(activeProfile === profile ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    );
  }

  if (current === 3) {
    const activeTimeoutMs = resolveTimeoutSetting(session).timeoutMs;
    const presets = [
      { value: 0, label: lang === 'en' ? 'off' : '关闭' },
      { value: 30000, label: '30s' },
      { value: 60000, label: '60s' },
      { value: 120000, label: '120s' },
    ];
    return new ActionRowBuilder().addComponents(
      ...presets.map((preset) => new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('set_timeout', current, userId, String(preset.value)))
        .setLabel(preset.label)
        .setStyle(activeTimeoutMs === preset.value ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    );
  }

  return null;
}

function buildOnboardingActionRows(step, userId, session = null, language = DEFAULT_UI_LANGUAGE) {
  const lang = normalizeUiLanguage(language);
  const current = normalizeOnboardingStep(step);
  const previous = normalizeOnboardingStep(current - 1);
  const next = normalizeOnboardingStep(current + 1);
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('goto', previous, userId))
        .setLabel(lang === 'en' ? 'Previous' : '上一步')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current <= 1),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('refresh', current, userId))
        .setLabel(lang === 'en' ? 'Refresh' : '刷新')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('goto', next, userId))
        .setLabel(lang === 'en' ? 'Next' : '下一步')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(current >= ONBOARDING_TOTAL_STEPS),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('done', current, userId))
        .setLabel(lang === 'en' ? 'Done' : '完成')
        .setStyle(ButtonStyle.Success),
    ),
  ];
  const configRow = buildOnboardingConfigRow(current, userId, session, lang);
  if (configRow) rows.push(configRow);
  return rows;
}

function formatOnboardingStepReport(step, key, session = null, channel = null, language = DEFAULT_UI_LANGUAGE) {
  const lang = normalizeUiLanguage(language);
  const current = normalizeOnboardingStep(step);
  const snapshot = getOnboardingSnapshot(key, session, channel, lang);
  if (lang === 'en') {
    switch (current) {
      case 1:
        return [
          '🧭 **Onboarding 1/4: Preflight + Language**',
          `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
          `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (depends on your provider)'}`,
          `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
          `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
          `• ui language (current): ${formatLanguageLabel(snapshot.currentLanguage)}`,
          '',
          'Choose language with buttons, then click "Next".',
        ].join('\n');
      case 2:
        return [
          '🧭 **Onboarding 2/4: Scope & Security Profile**',
          `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
          `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
          `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
          `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)} (${snapshot.profileSetting.source})`,
          `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'} (${snapshot.mentionHint})`,
          `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
          `• queued prompts now: ${snapshot.runtime.queued}`,
          '',
          'Choose `auto/solo/team/public` with buttons, then click "Next".',
        ].join('\n');
      case 3:
        return [
          '🧭 **Onboarding 3/4: Timeout**',
          `• codex timeout (current): ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
          `• quick presets: off / 30s / 60s / 120s`,
          `• custom value: \`${slashRef('timeout')} <ms|off|status>\` or \`!timeout <ms|off|status>\``,
          '',
          'Choose a timeout preset with buttons, then click "Next".',
        ].join('\n');
      case 4:
      default:
        return [
          '🧭 **Onboarding 4/4: First Run Checklist**',
          `1. \`${slashRef('doctor')}\` or \`!doctor\` to verify health checks.`,
          `2. \`${slashRef('status')}\` or \`!status\` to verify mode/model/workspace/profile/timeout.`,
          `3. \`${slashRef('setdir')} <path>\` or \`!setdir <path>\` to bind project path.`,
          `4. Send the first task: ${snapshot.firstPromptHint}`,
          `5. Use \`${slashRef('queue')}\` / \`!queue\` for backlog, \`${slashRef('cancel')}\` / \`!abort\` to stop.`,
          '',
          `Current settings: language=${formatLanguageLabel(snapshot.currentLanguage)}, profile=${formatSecurityProfileLabel(snapshot.profileSetting.profile)}, timeout=${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}`,
          '',
          'Click "Done" when finished.',
        ].join('\n');
    }
  }
  switch (current) {
    case 1:
      return [
        '🧭 **Onboarding 1/4：安装自检 + 语言设置**',
        `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
        `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (按 provider 需要配置)'}`,
        `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
        `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
        `• ui language（当前）：${formatLanguageLabel(snapshot.currentLanguage)}`,
        '',
        '请用按钮选择语言，然后点「下一步」。',
      ].join('\n');
    case 2:
      return [
        '🧭 **Onboarding 2/4：访问范围与安全策略**',
        `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
        `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
        `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
        `• profile setting: ${formatSecurityProfileLabel(snapshot.profileSetting.profile)}（${snapshot.profileSetting.source}）`,
        `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}（${snapshot.mentionHint}）`,
        `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
        `• queued prompts now: ${snapshot.runtime.queued}`,
        '',
        '请用按钮选择 `auto/solo/team/public`，然后点「下一步」。',
      ].join('\n');
    case 3:
      return [
        '🧭 **Onboarding 3/4：超时设置**',
        `• codex timeout（当前）：${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
        '• 快捷预设：off / 30s / 60s / 120s',
        `• 自定义值：\`${slashRef('timeout')} <毫秒|off|status>\` 或 \`!timeout <毫秒|off|status>\``,
        '',
        '请用按钮选择 timeout 预设，然后点「下一步」。',
      ].join('\n');
    case 4:
    default:
      return [
        '🧭 **Onboarding 4/4：首跑流程（5 步）**',
        `1. \`${slashRef('doctor')}\` 或 \`!doctor\`，确认健康检查通过。`,
        `2. \`${slashRef('status')}\` 或 \`!status\`，确认 mode/model/workspace/profile/timeout。`,
        `3. \`${slashRef('setdir')} <path>\` 或 \`!setdir <path>\`，绑定目标项目目录。`,
        `4. 发送第一条任务：${snapshot.firstPromptHint}`,
        `5. 如有积压，用 \`${slashRef('queue')}\` / \`!queue\` 查看；必要时 \`${slashRef('cancel')}\` / \`!abort\`。`,
        '',
        `当前设置：language=${formatLanguageLabel(snapshot.currentLanguage)}，profile=${formatSecurityProfileLabel(snapshot.profileSetting.profile)}，timeout=${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}`,
        '完成后点击「完成」关闭引导面板。',
      ].join('\n');
  }
}

function formatOnboardingDoneReport(key, session = null, channel = null, language = DEFAULT_UI_LANGUAGE) {
  const lang = normalizeUiLanguage(language);
  const snapshot = getOnboardingSnapshot(key, session, channel, lang);
  if (lang === 'en') {
    return [
      '✅ **Onboarding Completed**',
      `• active security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
      `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}`,
      `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
      `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
      `• codex timeout: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)} (${snapshot.timeoutSetting.source})`,
      '',
      `You can use: \`${slashRef('doctor')}\`, \`${slashRef('status')}\`, \`${slashRef('queue')}\``,
    ].join('\n');
  }
  return [
    '✅ **Onboarding 已完成**',
    `• 当前安全策略：${formatSecurityProfileDisplay(snapshot.security)}`,
    `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}`,
    `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
    `• ui language: ${formatLanguageLabel(snapshot.currentLanguage)}`,
    `• codex timeout: ${formatTimeoutLabel(snapshot.timeoutSetting.timeoutMs)}（${snapshot.timeoutSetting.source}）`,
    '',
    `后续可直接使用：\`${slashRef('doctor')}\`、\`${slashRef('status')}\`、\`${slashRef('queue')}\``,
  ].join('\n');
}

async function handleOnboardingButtonInteraction(interaction) {
  const parsed = parseOnboardingButtonId(interaction.customId);
  if (!parsed) return;
  const key = interaction.channelId;
  const session = key ? getSession(key) : null;
  const language = getSessionLanguage(session);

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: language === 'en'
        ? `This onboarding panel is only controllable by its creator. Run \`${slashRef('onboarding')}\` to create your own panel.`
        : `这个引导面板只对发起者可操作。请执行 \`${slashRef('onboarding')}\` 创建你自己的面板。`,
      flags: 64,
    });
    return;
  }

  if (!key) {
    await interaction.reply({ content: '❌ 无法识别当前频道。', flags: 64 });
    return;
  }

  if (!isOnboardingEnabled(session)) {
    await interaction.update({
      content: formatOnboardingDisabledMessage(language),
      components: [],
    });
    return;
  }

  if (parsed.action === 'set_lang') {
    const selectedLanguage = parseUiLanguageInput(parsed.value);
    if (selectedLanguage) {
      session.language = selectedLanguage;
      saveDb();
    }
  }

  if (parsed.action === 'set_profile') {
    const profile = parseSecurityProfileInput(parsed.value);
    if (profile) {
      session.securityProfile = profile;
      saveDb();
    }
  }

  if (parsed.action === 'set_timeout') {
    const timeoutAction = parseTimeoutConfigAction(parsed.value);
    if (timeoutAction?.type === 'set') {
      session.timeoutMs = timeoutAction.timeoutMs;
      saveDb();
    }
  }

  const currentLanguage = getSessionLanguage(session);

  if (parsed.action === 'done') {
    await interaction.update({
      content: formatOnboardingDoneReport(key, session, interaction.channel, currentLanguage),
      components: [],
    });
    return;
  }

  await interaction.update({
    content: formatOnboardingStepReport(parsed.step, key, session, interaction.channel, currentLanguage),
    components: buildOnboardingActionRows(parsed.step, interaction.user.id, session, currentLanguage),
  });
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
    ? 'Task started, waiting for the first Codex event...'
    : '任务已开始，等待 Codex 首个事件...';
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
      const previousThreadId = session.codexThreadId;
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
        session.codexThreadId = null;
        saveDb();
        promptToRun = buildPromptFromCompactedContext(compacted.summary, prompt);
        preNotes.push(`上下文输入 token=${session.lastInputTokens}，已自动压缩并切换新会话（旧 session: ${previousThreadId}）。`);
      } else {
        session.codexThreadId = null;
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
    if (!result.ok && session.codexThreadId && !result.cancelled && !result.timedOut) {
      const previous = session.codexThreadId;
      session.codexThreadId = null;
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
      session.codexThreadId = result.threadId;
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

      const codexMissing = isCodexNotFound(result.error);
      const timeoutSetting = resolveTimeoutSetting(session);
      const failText = [
        result.timedOut ? '❌ Codex 执行超时' : '❌ Codex 执行失败',
        result.error ? `• error: ${result.error}` : null,
        result.logs.length ? `• logs: ${truncate(result.logs.join('\n'), 1200)}` : null,
        result.timedOut
          ? `• 处理: 可用 \`${slashRef('timeout')} <ms|off|status>\` 或 \`!timeout <ms|off|status>\` 调整本频道超时。当前: ${formatTimeoutLabel(timeoutSetting.timeoutMs)} (${timeoutSetting.source})`
          : null,
        codexMissing ? '• 诊断: 当前环境找不到 Codex CLI 可执行文件。' : null,
        codexMissing ? '• 处理: 在该设备安装 codex，或在 .env 配置 `CODEX_BIN=/绝对路径/codex`，然后重启 bot。' : null,
        codexMissing ? `• 自检: 用 \`${slashRef('status')}\` 或 \`!status\` 查看 codex-cli 状态。` : null,
        '',
        `可以先 \`${slashRef('reset')}\` 再重试，或 \`${slashRef('status')}\` 看状态。`,
      ].filter(Boolean).join('\n');
      progressOutcome = {
        ok: false,
        cancelled: false,
        timedOut: Boolean(result.timedOut),
        error: result.error || 'codex run failed',
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

function shouldCompactSession(session) {
  if (!COMPACT_ON_THRESHOLD) return false;
  if (COMPACT_STRATEGY !== 'hard') return false;
  if (!session?.codexThreadId) return false;
  const last = toOptionalInt(session.lastInputTokens);
  if (!Number.isFinite(last)) return false;
  return last >= MAX_INPUT_TOKENS_BEFORE_COMPACT;
}

async function compactSessionContext({ session, workspaceDir, onSpawn, wasCancelled, onEvent, onLog }) {
  if (!session?.codexThreadId) {
    return { ok: false, summary: '', error: 'missing codex session id' };
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

async function runCodex({ session, workspaceDir, prompt, onSpawn, wasCancelled, onEvent, onLog }) {
  ensureDir(workspaceDir);
  ensureGitRepo(workspaceDir);

  const notes = [];
  const args = buildCodexArgs({ session, workspaceDir, prompt });
  const timeoutMs = resolveTimeoutSetting(session).timeoutMs;

  if (DEBUG_EVENTS) {
    console.log('Running codex:', [CODEX_BIN, ...args].join(' '));
  }

  const {
    ok,
    exitCode,
    signal,
    messages,
    finalAnswerMessages,
    reasonings,
    usage,
    threadId,
    logs,
    error,
    timedOut,
    cancelled,
  } = await spawnCodex(args, workspaceDir, {
    onSpawn,
    wasCancelled,
    onEvent,
    onLog,
    timeoutMs,
  });

  return {
    ok,
    exitCode,
    signal,
    messages,
    finalAnswerMessages,
    reasonings,
    usage,
    threadId,
    logs,
    error,
    timedOut,
    cancelled,
    notes,
  };
}

function buildCodexArgs({ session, workspaceDir, prompt }) {
  const modeFlag = session.mode === 'dangerous'
    ? '--dangerously-bypass-approvals-and-sandbox'
    : '--full-auto';

  const model = session.model || DEFAULT_MODEL;
  const effort = session.effort;
  const extraConfigs = session.configOverrides || [];

  const common = [];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (COMPACT_STRATEGY === 'native' && COMPACT_ON_THRESHOLD) {
    common.push('-c', `model_auto_compact_token_limit=${MODEL_AUTO_COMPACT_TOKEN_LIMIT}`);
  }
  for (const cfg of extraConfigs) common.push('-c', cfg);

  if (session.codexThreadId) {
    return ['exec', 'resume', '--json', modeFlag, ...common, session.codexThreadId, prompt];
  }

  return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
}

function spawnCodex(args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: SPAWN_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.onSpawn?.(child);

    let stdoutBuf = '';
    let stderrBuf = '';

    const messages = [];
    const finalAnswerMessages = [];
    const reasonings = [];
    const logs = [];
    let usage = null;
    let threadId = null;
    let resolved = false;
    let timedOut = false;
    let progressBridgeThreadId = null;
    let stopSessionProgressBridge = null;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, CODEX_TIMEOUT_MS);
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        logs.push(`Timeout after ${timeoutMs}ms`);
        stopChildProcess(child);
      }, timeoutMs)
      : null;

    const stopBridges = () => {
      if (typeof stopSessionProgressBridge === 'function') {
        try {
          stopSessionProgressBridge();
        } catch {
          // ignore bridge teardown failures
        }
      }
      stopSessionProgressBridge = null;
      progressBridgeThreadId = null;
    };

    const ensureSessionProgressBridge = (nextThreadId) => {
      const id = String(nextThreadId || '').trim();
      if (!id) return;
      if (typeof options.onEvent !== 'function') return;
      if (id === progressBridgeThreadId && typeof stopSessionProgressBridge === 'function') return;

      stopBridges();
      stopSessionProgressBridge = startCodexSessionProgressBridge({
        threadId: id,
        onEvent: options.onEvent,
      });
      progressBridgeThreadId = id;
    };

    const consumeLine = (line, source) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const ev = JSON.parse(trimmed);
          if (DEBUG_EVENTS) console.log('[event]', ev.type, ev);
          handleEvent(ev);
          options.onEvent?.(ev);
          return;
        } catch {
          // fallthrough
        }
      }

      // Ignore known noisy Codex rollout logs.
      if (trimmed.includes('state db missing rollout path for thread')) return;
      if (source === 'stderr' || DEBUG_EVENTS) logs.push(trimmed);
      options.onLog?.(trimmed, source);
    };

    const onData = (chunk, source) => {
      let buf = source === 'stdout' ? stdoutBuf : stderrBuf;
      buf += chunk.toString('utf8');

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) consumeLine(line, source);

      if (source === 'stdout') stdoutBuf = buf;
      else stderrBuf = buf;
    };

    const flushRemainders = () => {
      if (stdoutBuf.trim()) consumeLine(stdoutBuf, 'stdout');
      if (stderrBuf.trim()) consumeLine(stderrBuf, 'stderr');
    };

    const handleEvent = (ev) => {
      switch (ev.type) {
        case 'thread.started':
          threadId = ev.thread_id || threadId;
          ensureSessionProgressBridge(threadId);
          break;
        case 'item.completed': {
          const item = ev.item || {};
          if (item.type === 'agent_message') {
            const text = extractAgentMessageText(item);
            if (text) {
              messages.push(text);
              if (isFinalAnswerLikeAgentMessage(item)) {
                finalAnswerMessages.push(text);
              }
            }
          }
          if (item.type === 'reasoning' && item.text) reasonings.push(item.text.trim());
          break;
        }
        case 'turn.completed':
          usage = ev.usage || usage;
          break;
        case 'error':
          logs.push(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
          break;
        default:
          break;
      }
    };

    child.stdout.on('data', (chunk) => onData(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => onData(chunk, 'stderr'));

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      stopBridges();
      if (err?.code === 'ENOENT') {
        logs.push(`Command not found: ${CODEX_BIN}`);
      }
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        messages,
        finalAnswerMessages,
        reasonings,
        usage,
        threadId,
        logs,
        error: safeError(err),
        timedOut,
        cancelled: Boolean(options.wasCancelled?.()),
      });
    });

    child.on('close', (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      if (timeout) clearTimeout(timeout);
      stopBridges();
      flushRemainders();

      const ok = exitCode === 0;
      const cancelled = !ok && Boolean(options.wasCancelled?.());
      const error = ok
        ? null
        : timedOut
          ? `timeout after ${timeoutMs}ms`
          : cancelled
            ? `cancelled (${signal || `exit=${exitCode}`})`
            : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`;

      resolve({
        ok,
        exitCode,
        signal,
        messages,
        finalAnswerMessages,
        reasonings,
        usage,
        threadId,
        logs,
        error,
        timedOut,
        cancelled,
      });
    });
  });
}

function startCodexSessionProgressBridge({ threadId, onEvent }) {
  const sessionId = String(threadId || '').trim();
  if (!sessionId || typeof onEvent !== 'function') return () => {};

  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return () => {};

  const bridgeStartedAtMs = Date.now();
  const minMtimeMs = bridgeStartedAtMs - 2 * 60 * 1000;
  const dedupeKeys = [];
  const dedupeSet = new Set();

  let stopped = false;
  let rolloutFile = null;
  let rolloutFileMtimeMs = 0;
  let offset = 0;
  let remainder = '';
  let pollTimer = null;
  let lastScanAt = 0;

  const rememberKey = (key) => {
    if (!key || dedupeSet.has(key)) return false;
    dedupeSet.add(key);
    dedupeKeys.push(key);
    if (dedupeKeys.length > 500) {
      const stale = dedupeKeys.shift();
      if (stale) dedupeSet.delete(stale);
    }
    return true;
  };

  const handleSessionLine = (line) => {
    const raw = String(line || '').trim();
    if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) return;

    let ev = null;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object') return;

    const text = extractRawProgressTextFromEventBase(ev);
    if (!text) return;
    const key = [
      ev.timestamp || '',
      ev.type || '',
      ev.payload?.type || '',
      ev.payload?.phase || '',
      text,
    ].join('|');
    if (!rememberKey(key)) return;
    onEvent(ev);
  };

  const consumeChunk = (chunk) => {
    if (!chunk) return;
    remainder += chunk;
    const lines = remainder.split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) handleSessionLine(line);
  };

  const readNewTail = () => {
    if (!rolloutFile) return;

    let stat = null;
    try {
      stat = fs.statSync(rolloutFile);
    } catch {
      rolloutFile = null;
      offset = 0;
      remainder = '';
      return;
    }
    if (!stat || !stat.isFile()) return;
    if (stat.size < offset) {
      offset = 0;
      remainder = '';
    }
    if (stat.size === offset) return;

    const bytesToRead = stat.size - offset;
    if (bytesToRead <= 0) return;

    const fd = fs.openSync(rolloutFile, 'r');
    try {
      const buf = Buffer.allocUnsafe(bytesToRead);
      const readBytes = fs.readSync(fd, buf, 0, bytesToRead, offset);
      offset += readBytes;
      consumeChunk(buf.toString('utf8', 0, readBytes));
    } finally {
      fs.closeSync(fd);
    }
  };

  const resolveRolloutFile = (force = false) => {
    const now = Date.now();
    if (!force && now - lastScanAt < 2500) return false;
    lastScanAt = now;

    const match = findLatestRolloutFileBySessionId(sessionId, minMtimeMs);
    if (!match) return false;
    const nextPath = String(match.file || '');
    if (!nextPath) return false;
    if (nextPath === rolloutFile) return true;

    rolloutFile = match.file;
    rolloutFileMtimeMs = Number(match.mtimeMs) || 0;
    offset = rolloutFileMtimeMs < bridgeStartedAtMs
      ? Math.max(0, Number(match.sizeBytes) || 0)
      : 0;
    remainder = '';
    readNewTail();
    return true;
  };

  const poll = () => {
    if (stopped) return;
    if (!resolveRolloutFile(!rolloutFile) && !rolloutFile) return;
    readNewTail();
  };

  pollTimer = setInterval(poll, 700);
  pollTimer.unref?.();
  poll();

  return () => {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
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
  sections.push(answer || '（Codex 没有返回可见文本）');

  const tail = [];
  if (result.notes.length) {
    tail.push(...result.notes.map((n) => `• ${n}`));
  }
  if (session.codexThreadId || result.threadId) {
    const id = result.threadId || session.codexThreadId;
    const label = session.name ? `**${session.name}** (\`${id}\`)` : `\`${id}\``;
    tail.push(`• session: ${label}`);
  }

  if (tail.length) {
    sections.push(['', '—', ...tail].join('\n'));
  }

  return sections.join('\n\n').trim();
}

function getSession(key) {
  db.threads ||= {};
  if (!db.threads[key]) {
    db.threads[key] = {
      workspaceDir: null,
      codexThreadId: null,
      lastInputTokens: null,
      model: null,
      effort: null,
      mode: DEFAULT_MODE,
      language: DEFAULT_UI_LANGUAGE,
      onboardingEnabled: ONBOARDING_ENABLED_BY_DEFAULT,
      securityProfile: null,
      timeoutMs: null,
      processLines: null,
      configOverrides: [],
      updatedAt: new Date().toISOString(),
    };
    saveDb();
  }
  const s = db.threads[key];
  // migrate old sessions
  let migrated = false;
  if (s.effort === undefined) {
    s.effort = null;
    migrated = true;
  }
  if (s.configOverrides === undefined) {
    s.configOverrides = [];
    migrated = true;
  }
  if (s.name === undefined) {
    s.name = null;
    migrated = true;
  }
  if (s.lastInputTokens === undefined) {
    s.lastInputTokens = null;
    migrated = true;
  }
  if (s.language === undefined) {
    s.language = DEFAULT_UI_LANGUAGE;
    migrated = true;
  }
  if (s.onboardingEnabled === undefined) {
    s.onboardingEnabled = ONBOARDING_ENABLED_BY_DEFAULT;
    migrated = true;
  }
  if (s.securityProfile === undefined) {
    s.securityProfile = null;
    migrated = true;
  }
  if (s.timeoutMs === undefined) {
    s.timeoutMs = null;
    migrated = true;
  }
  if (s.processLines === undefined) {
    s.processLines = null;
    migrated = true;
  }
  const normalizedLanguage = normalizeUiLanguage(s.language);
  if (s.language !== normalizedLanguage) {
    s.language = normalizedLanguage;
    migrated = true;
  }
  const normalizedSecurityProfile = normalizeSessionSecurityProfile(s.securityProfile);
  if (s.securityProfile !== normalizedSecurityProfile) {
    s.securityProfile = normalizedSecurityProfile;
    migrated = true;
  }
  const normalizedTimeoutMs = normalizeSessionTimeoutMs(s.timeoutMs);
  if (s.timeoutMs !== normalizedTimeoutMs) {
    s.timeoutMs = normalizedTimeoutMs;
    migrated = true;
  }
  const normalizedProcessLines = normalizeSessionProcessLines(s.processLines);
  if (s.processLines !== normalizedProcessLines) {
    s.processLines = normalizedProcessLines;
    migrated = true;
  }
  s.updatedAt = new Date().toISOString();
  if (migrated) saveDb();
  return s;
}

function ensureWorkspace(session, key) {
  if (!session.workspaceDir) {
    session.workspaceDir = path.join(WORKSPACE_ROOT, key);
    saveDb();
  }
  ensureDir(session.workspaceDir);
  ensureGitRepo(session.workspaceDir);
  return session.workspaceDir;
}

function ensureGitRepo(dir) {
  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    stdio: 'ignore',
  });
  if (check.status === 0) return;

  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
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

function formatSecurityProfileDisplay(security) {
  if (!security) return '(unknown)';
  if (security.source === 'session') {
    return `${security.profile} (session override)`;
  }
  if (security.source === 'manual') {
    return `${security.profile} (manual)`;
  }
  return `${security.profile} (auto: ${security.reason})`;
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

function getCodexCliHealth() {
  const check = spawnSync(CODEX_BIN, ['--version'], {
    env: SPAWN_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (check.error) {
    return {
      ok: false,
      bin: CODEX_BIN,
      error: safeError(check.error),
    };
  }

  if (check.status !== 0) {
    return {
      ok: false,
      bin: CODEX_BIN,
      error: (check.stderr || check.stdout || `exit=${check.status}`).trim(),
    };
  }

  const versionLine = (check.stdout || check.stderr || '').trim().split('\n')[0] || 'ok';
  return {
    ok: true,
    bin: CODEX_BIN,
    version: versionLine,
  };
}

function formatCodexHealth(health) {
  if (health.ok) return `✅ \`${health.bin}\` (${health.version})`;
  if (isCodexNotFound(health.error)) {
    return `❌ 未找到 \`${health.bin}\`（可在 .env 设置 CODEX_BIN=/绝对路径/codex）`;
  }
  return `❌ ${truncate(String(health.error || 'unknown error'), 220)}`;
}

function isCodexNotFound(errorText) {
  const msg = String(errorText || '').toLowerCase();
  return msg.includes('enoent') || msg.includes('not found');
}

function slashName(base) {
  const cmd = String(base || '').trim().toLowerCase();
  if (!SLASH_PREFIX) return cmd;

  const prefix = `${SLASH_PREFIX}_`;
  const maxBaseLen = Math.max(1, 32 - prefix.length);
  return `${prefix}${cmd.slice(0, maxBaseLen)}`;
}

function normalizeSlashCommandName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!SLASH_PREFIX) return raw;
  const prefix = `${SLASH_PREFIX}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function slashRef(base) {
  return `/${slashName(base)}`;
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listRecentCodexSessions(limit = 10) {
  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];

  const files = findRolloutFiles(sessionsDir);
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

function findLatestRolloutFileBySessionId(sessionId, notOlderThanMs = 0) {
  const targetId = String(sessionId || '').trim().toLowerCase();
  if (!targetId) return null;

  const sessionsDir = getCodexSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;

  const files = findRolloutFiles(sessionsDir);
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

function getCodexSessionsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  return path.join(home, '.codex', 'sessions');
}

function findRolloutFiles(root) {
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
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function parseSessionIdFromRolloutFile(filename) {
  const match = filename.match(/^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { threads: {} };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load DB, using empty state:', err);
    return { threads: {} };
  }
}

function saveDb() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function splitForDiscord(text, limit = 1900) {
  const s = String(text || '').trim();
  if (!s) return [];

  const out = [];
  let rest = s;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < 200) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
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

function describeCompactStrategy(strategy) {
  switch (strategy) {
    case 'native':
      return 'native (Codex CLI auto-compact + continue)';
    case 'off':
      return 'off (disabled)';
    default:
      return 'hard (summary + new session)';
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
