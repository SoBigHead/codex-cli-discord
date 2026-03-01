import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { safeReply } from './discord-reply-utils.js';

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
const CODEX_TIMEOUT_MS = normalizeTimeoutMs(process.env.CODEX_TIMEOUT_MS, 0);
const CODEX_BIN = (process.env.CODEX_BIN || 'codex').trim() || 'codex';
const SHOW_REASONING = String(process.env.SHOW_REASONING || 'false').toLowerCase() === 'true';
const DEBUG_EVENTS = String(process.env.DEBUG_EVENTS || 'false').toLowerCase() === 'true';
const PROGRESS_UPDATES_ENABLED = String(process.env.PROGRESS_UPDATES_ENABLED || 'true').toLowerCase() !== 'false';
const PROGRESS_UPDATE_INTERVAL_MS = normalizeIntervalMs(process.env.PROGRESS_UPDATE_INTERVAL_MS, 15000, 3000);
const PROGRESS_EVENT_FLUSH_MS = normalizeIntervalMs(process.env.PROGRESS_EVENT_FLUSH_MS, 5000, 1000);
const PROGRESS_TEXT_PREVIEW_CHARS = Math.max(60, toInt(process.env.PROGRESS_TEXT_PREVIEW_CHARS, 140));
const PROGRESS_INCLUDE_STDERR = String(process.env.PROGRESS_INCLUDE_STDERR || 'false').toLowerCase() === 'true';
const PROGRESS_PLAN_MAX_LINES = Math.min(8, Math.max(1, toInt(process.env.PROGRESS_PLAN_MAX_LINES, 4)));
const PROGRESS_DONE_STEPS_MAX = Math.min(12, Math.max(1, toInt(process.env.PROGRESS_DONE_STEPS_MAX, 4)));
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
      const security = resolveSecurityContext(message.channel);

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
      const key = message.channel.id;

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
      const reply = interaction.replied || interaction.deferred
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `❌ ${safeError(err)}`, flags: 64 });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
    return;
  }

  if (!(await isAllowedInteractionChannel(interaction))) {
    await interaction.reply({ content: '⛔ 当前频道未开放。', flags: 64 });
    return;
  }

  const key = interaction.channelId;
  if (!key) {
    await interaction.reply({ content: '❌ 无法识别当前频道。', flags: 64 });
    return;
  }
  const session = getSession(key);
  const cmd = normalizeSlashCommandName(interaction.commandName);

  try {
    switch (cmd) {
      case 'status': {
        const wd = ensureWorkspace(session, key);
        const defaults = getCodexDefaults();
        const codexHealth = getCodexCliHealth();
        const runtime = getRuntimeSnapshot(key);
        const security = resolveSecurityContext(interaction.channel);
        const modeDesc = session.mode === 'dangerous'
          ? 'dangerous (无沙盒, 全权限)'
          : 'safe (沙盒隔离, 无网络)';
        const sessionLabel = session.name
          ? `**${session.name}** (\`${session.codexThreadId || 'auto'}\`)`
          : `\`${session.codexThreadId || '(auto — 下条消息新建)'}\``;
        await interaction.reply({
          content: [
            '🧭 **当前配置**',
            `• workspace: \`${wd}\``,
            `• mode: ${modeDesc}`,
            `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
            `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
            `• codex-cli: ${formatCodexHealth(codexHealth)}`,
            `• session: ${sessionLabel}`,
            `• last input tokens: ${formatTokenValue(session.lastInputTokens)}`,
            `• runtime: ${formatRuntimeLabel(runtime)}`,
            `• queued prompts: ${runtime.queued}`,
            `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
            runtime.progressText ? `• latest progress: ${runtime.progressText}` : null,
            `• security profile: ${formatSecurityProfileDisplay(security)}`,
            `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
            `• !config: ${formatConfigCommandStatus()}`,
            `• codex timeout: ${formatTimeoutLabel(CODEX_TIMEOUT_MS)}`,
            `• compact strategy: ${describeCompactStrategy(COMPACT_STRATEGY)}`,
            `• compact trigger: ${COMPACT_ON_THRESHOLD ? 'on' : 'off'}`,
            `• compact threshold: ${MAX_INPUT_TOKENS_BEFORE_COMPACT}`,
            COMPACT_STRATEGY === 'native' && COMPACT_ON_THRESHOLD
              ? `• native auto compact limit: ${MODEL_AUTO_COMPACT_TOKEN_LIMIT} (model_auto_compact_token_limit)`
              : null,
          ].filter(Boolean).join('\n'),
          flags: 64,
        });
        break;
      }

      case 'reset': {
        session.codexThreadId = null;
        session.configOverrides = [];
        saveDb();
        await interaction.reply('♻️ 会话已清空，下条消息新开上下文。');
        break;
      }

      case 'sessions': {
        try {
          const sessions = listRecentCodexSessions(10);
          if (!sessions.length) {
            await interaction.reply({ content: '没有找到任何 Codex session。', flags: 64 });
            break;
          }

          const lines = sessions.map((s, i) => `${i + 1}. \`${s.id}\` (${humanAge(Date.now() - s.mtime)} ago)`);
          await interaction.reply({
            content: [`**最近 Sessions**（用 \`${slashRef('resume')}\` 继承）`, ...lines].join('\n'),
            flags: 64,
          });
        } catch (err) {
          await interaction.reply({ content: `❌ ${safeError(err)}`, flags: 64 });
        }
        break;
      }

      case 'setdir': {
        const p = interaction.options.getString('path');
        const resolved = resolvePath(p);
        if (!fs.existsSync(resolved)) {
          await interaction.reply({ content: `❌ 目录不存在：\`${resolved}\``, flags: 64 });
          break;
        }
        ensureGitRepo(resolved);
        session.workspaceDir = resolved;
        session.codexThreadId = null;
        saveDb();
        await interaction.reply(`✅ workspace → \`${resolved}\`（会话已重置）`);
        break;
      }

      case 'model': {
        const name = interaction.options.getString('name');
        session.model = name.toLowerCase() === 'default' ? null : name;
        saveDb();
        await interaction.reply(`✅ model = ${session.model || '(default)'}`);
        break;
      }

      case 'effort': {
        const level = interaction.options.getString('level');
        session.effort = level === 'default' ? null : level;
        saveDb();
        await interaction.reply(`✅ effort = ${session.effort || '(default)'}`);
        break;
      }

      case 'mode': {
        const type = interaction.options.getString('type');
        session.mode = type;
        saveDb();
        await interaction.reply(`✅ mode = ${session.mode}`);
        break;
      }

      case 'resume': {
        const sid = interaction.options.getString('session_id');
        session.codexThreadId = sid.trim();
        saveDb();
        await interaction.reply(`✅ 已绑定 session: \`${session.codexThreadId}\``);
        break;
      }

      case 'name': {
        const label = interaction.options.getString('label').trim();
        session.name = label;
        saveDb();
        await interaction.reply(`✅ session 命名为: **${label}**`);
        break;
      }

      case 'queue': {
        await interaction.reply({
          content: formatQueueReport(key, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'doctor': {
        await interaction.reply({
          content: formatDoctorReport(key, interaction.channel),
          flags: 64,
        });
        break;
      }

      case 'onboarding': {
        const step = 1;
        await interaction.reply({
          content: formatOnboardingStepReport(step, key, interaction.channel),
          components: buildOnboardingActionRows(step, interaction.user.id),
          flags: 64,
        });
        break;
      }

      case 'progress': {
        await interaction.reply({
          content: formatProgressReport(key),
          flags: 64,
        });
        break;
      }

      case 'cancel': {
        const outcome = cancelChannelWork(key, 'slash_cancel');
        await interaction.reply({
          content: formatCancelReport(outcome),
          flags: 64,
        });
        break;
      }
    }
  } catch (err) {
    const reply = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: `❌ ${safeError(err)}`, flags: 64 });
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
    console.error('Unhandled rejection:', err);
    if (isInvalidTokenError(err)) return;
    scheduleSelfHeal('unhandled_rejection', err);
  });

  process.on('uncaughtException', (err) => {
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
  const security = resolveSecurityContext(message.channel);

  switch (cmd.toLowerCase()) {
    case '!help': {
      await safeReply(message, [
        '**📋 命令列表**',
        '',
        '**会话管理**',
        '• `!status` — 当前配置一览',
        '• `!queue` — 查看当前频道队列（运行中/排队数）',
        '• `!doctor` — 查看 bot 健康状态与当前安全策略',
        `• \`${slashRef('onboarding')}\` — 交互式引导（按钮分步）`,
        '• `!onboarding` — 文本版引导流程与检查清单',
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
      ].join('\n'));
      break;
    }

    case '!status': {
      const workspaceDir = ensureWorkspace(session, key);
      const defaults = getCodexDefaults();
      const codexHealth = getCodexCliHealth();
      const runtime = getRuntimeSnapshot(key);
      const modeDesc = session.mode === 'dangerous'
        ? 'dangerous (无沙盒, 全权限)'
        : 'safe (沙盒隔离, 无网络)';
      await safeReply(message, [
        '🧭 **当前配置**',
        `• workspace: \`${workspaceDir}\``,
        `• mode: ${modeDesc}`,
        `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
        `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
        `• codex-cli: ${formatCodexHealth(codexHealth)}`,
        `• codex session: \`${session.codexThreadId || '(none)'}\``,
        `• last input tokens: ${formatTokenValue(session.lastInputTokens)}`,
        `• runtime: ${formatRuntimeLabel(runtime)}`,
        `• queued prompts: ${runtime.queued}`,
        `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
        runtime.progressText ? `• latest progress: ${runtime.progressText}` : null,
        `• security profile: ${formatSecurityProfileDisplay(security)}`,
        `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
        `• !config: ${formatConfigCommandStatus()}`,
        `• codex timeout: ${formatTimeoutLabel(CODEX_TIMEOUT_MS)}`,
        `• compact strategy: ${describeCompactStrategy(COMPACT_STRATEGY)}`,
        `• compact trigger: ${COMPACT_ON_THRESHOLD ? 'on' : 'off'}`,
        `• compact threshold: ${MAX_INPUT_TOKENS_BEFORE_COMPACT}`,
        COMPACT_STRATEGY === 'native' && COMPACT_ON_THRESHOLD
          ? `• native auto compact limit: ${MODEL_AUTO_COMPACT_TOKEN_LIMIT} (model_auto_compact_token_limit)`
          : null,
        session.configOverrides?.length ? `• extra config: ${session.configOverrides.join(', ')}` : null,
      ].filter(Boolean).join('\n'));
      break;
    }

    case '!queue': {
      await safeReply(message, formatQueueReport(key, message.channel));
      break;
    }

    case '!doctor': {
      await safeReply(message, formatDoctorReport(key, message.channel));
      break;
    }

    case '!onboarding':
    case '!onboard':
    case '!guide': {
      await safeReply(message, formatOnboardingReport(key, message.channel));
      break;
    }

    case '!progress': {
      await safeReply(message, formatProgressReport(key));
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
  const security = securityContext || resolveSecurityContext(message.channel);
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
  };
}

function formatRuntimeLabel(runtime) {
  if (!runtime.running) return 'idle';
  const age = runtime.activeSinceMs === null ? 'just-now' : humanAge(runtime.activeSinceMs);
  const phase = runtime.phase ? `, phase=${runtime.phase}` : '';
  const pid = runtime.pid ? `, pid=${runtime.pid}` : '';
  return `running (${age}${phase}${pid})`;
}

function formatTimeoutLabel(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return 'off (no hard timeout)';
  return `${n}ms (~${humanAge(n)})`;
}

function formatQueueReport(key, channel = null) {
  const runtime = getRuntimeSnapshot(key);
  const security = resolveSecurityContext(channel);
  const planSummary = formatProgressPlanSummary(runtime.progressPlan);
  const completedSummary = formatCompletedStepsSummary(runtime.completedSteps, 3);
  return [
    '📮 **任务队列状态**',
    `• runtime: ${formatRuntimeLabel(runtime)}`,
    `• queued prompts: ${runtime.queued}`,
    `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
    runtime.progressText ? `• latest step: ${runtime.progressText}` : null,
    planSummary ? `• plan: ${planSummary}` : null,
    completedSummary ? `• completed steps: ${completedSummary}` : null,
    runtime.progressAgoMs !== null ? `• progress updated: ${humanAge(runtime.progressAgoMs)} ago` : null,
    runtime.messageId ? `• active message id: \`${runtime.messageId}\`` : null,
    runtime.progressMessageId ? `• progress message id: \`${runtime.progressMessageId}\`` : null,
  ].filter(Boolean).join('\n');
}

function formatProgressReport(key) {
  const runtime = getRuntimeSnapshot(key);
  if (!runtime.running) {
    return 'ℹ️ 当前没有运行中的任务。';
  }
  return [
    '🧵 **任务进度**',
    `• runtime: ${formatRuntimeLabel(runtime)}`,
    `• event count: ${runtime.progressEvents}`,
    runtime.progressText ? `• latest step: ${runtime.progressText}` : null,
    ...renderProgressPlanLines(runtime.progressPlan, PROGRESS_PLAN_MAX_LINES),
    ...renderCompletedStepsLines(runtime.completedSteps, PROGRESS_DONE_STEPS_MAX),
    runtime.progressAgoMs !== null ? `• last update: ${humanAge(runtime.progressAgoMs)} ago` : null,
    runtime.progressMessageId ? `• progress message id: \`${runtime.progressMessageId}\`` : null,
    `• queued prompts: ${runtime.queued}`,
    `• hint: 可用 \`!abort\` / \`${slashRef('cancel')}\` 中断当前任务并清空队列。`,
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

function formatDoctorReport(key, channel = null) {
  const runtime = getRuntimeSnapshot(key);
  const codexHealth = getCodexCliHealth();
  const security = resolveSecurityContext(channel);
  return [
    '🩺 **Bot Doctor**',
    `• codex-cli: ${formatCodexHealth(codexHealth)}`,
    `• runtime: ${formatRuntimeLabel(runtime)}`,
    `• queued prompts: ${runtime.queued}`,
    `• security profile: ${formatSecurityProfileDisplay(security)}`,
    `• mention only: ${security.mentionOnly ? 'on' : 'off'}`,
    `• queue limit: ${formatQueueLimit(security.maxQueuePerChannel)}`,
    `• !config: ${formatConfigCommandStatus()}`,
    `• config allowlist: ${describeConfigPolicy()}`,
    `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
    `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
    `• codex timeout: ${formatTimeoutLabel(CODEX_TIMEOUT_MS)}`,
    `• compact strategy: ${describeCompactStrategy(COMPACT_STRATEGY)}`,
  ].join('\n');
}

function getOnboardingSnapshot(key, channel = null) {
  const runtime = getRuntimeSnapshot(key);
  const codexHealth = getCodexCliHealth();
  const security = resolveSecurityContext(channel);
  const hasToken = Boolean(DISCORD_TOKEN);
  const hasApiKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  const hasWorkspace = Boolean(String(WORKSPACE_ROOT || '').trim());
  const mentionHint = security.mentionOnly
    ? '本频道普通消息需 @Bot（或直接用 `!` 命令）。'
    : '本频道普通消息可直接发送给 Bot。';
  const firstPromptHint = security.mentionOnly
    ? '发送 `@Bot 帮我检查当前目录并创建一个 TODO`'
    : '发送 `帮我检查当前目录并创建一个 TODO`';
  return {
    runtime,
    codexHealth,
    security,
    hasToken,
    hasApiKey,
    hasWorkspace,
    mentionHint,
    firstPromptHint,
  };
}

function formatOnboardingReport(key, channel = null) {
  const snapshot = getOnboardingSnapshot(key, channel);
  return [
    '🧭 **Onboarding（文本版）**',
    `• 交互分步版请使用 \`${slashRef('onboarding')}\`（按钮：上一步/下一步/完成）`,
    '',
    '**1) 安装自检（先看当前是否可跑）**',
    `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
    `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (按 provider 需要配置)'}`,
    `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
    `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
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

function buildOnboardingButtonId(action, step, userId) {
  const safeAction = String(action || '').trim().toLowerCase();
  const safeStep = normalizeOnboardingStep(step);
  const safeUserId = String(userId || '').trim();
  return `onb:${safeAction}:${safeStep}:${safeUserId}`;
}

function isOnboardingButtonId(customId) {
  return /^onb:/.test(String(customId || ''));
}

function parseOnboardingButtonId(customId) {
  const text = String(customId || '').trim();
  const match = text.match(/^onb:(goto|refresh|done):([0-9]+):([0-9]{5,32})$/);
  if (!match) return null;
  return {
    action: match[1],
    step: normalizeOnboardingStep(match[2]),
    userId: match[3],
  };
}

function buildOnboardingActionRows(step, userId) {
  const current = normalizeOnboardingStep(step);
  const previous = normalizeOnboardingStep(current - 1);
  const next = normalizeOnboardingStep(current + 1);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('goto', previous, userId))
        .setLabel('上一步')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(current <= 1),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('refresh', current, userId))
        .setLabel('刷新')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('goto', next, userId))
        .setLabel('下一步')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(current >= ONBOARDING_TOTAL_STEPS),
      new ButtonBuilder()
        .setCustomId(buildOnboardingButtonId('done', current, userId))
        .setLabel('完成')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

function formatOnboardingStepReport(step, key, channel = null) {
  const current = normalizeOnboardingStep(step);
  const snapshot = getOnboardingSnapshot(key, channel);
  switch (current) {
    case 1:
      return [
        '🧭 **Onboarding 1/4：安装自检**',
        `• DISCORD_TOKEN: ${snapshot.hasToken ? '✅ loaded' : '❌ missing'}`,
        `• OPENAI_API_KEY: ${snapshot.hasApiKey ? '✅ loaded' : '⚠️ missing/unused (按 provider 需要配置)'}`,
        `• WORKSPACE_ROOT: ${snapshot.hasWorkspace ? `✅ \`${WORKSPACE_ROOT}\`` : '❌ missing'}`,
        `• codex-cli: ${formatCodexHealth(snapshot.codexHealth)}`,
        '',
        `下一步建议：点击「下一步」检查当前频道生效的安全策略。`,
      ].join('\n');
    case 2:
      return [
        '🧭 **Onboarding 2/4：访问范围与安全策略**',
        `• ALLOWED_CHANNEL_IDS: ${ALLOWED_CHANNEL_IDS ? `${ALLOWED_CHANNEL_IDS.size} configured` : '(all channels)'}`,
        `• ALLOWED_USER_IDS: ${ALLOWED_USER_IDS ? `${ALLOWED_USER_IDS.size} configured` : '(all users)'}`,
        `• security profile: ${formatSecurityProfileDisplay(snapshot.security)}`,
        `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}（${snapshot.mentionHint}）`,
        `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
        `• queued prompts now: ${snapshot.runtime.queued}`,
        `• !config: ${formatConfigCommandStatus()}`,
        '',
        '下一步建议：按「下一步」走首跑 5 步。',
      ].join('\n');
    case 3:
      return [
        '🧭 **Onboarding 3/4：首跑流程（5 步）**',
        `1. \`${slashRef('doctor')}\` 或 \`!doctor\`，确认健康检查通过。`,
        `2. \`${slashRef('status')}\` 或 \`!status\`，确认 mode/model/workspace。`,
        `3. \`${slashRef('setdir')} <path>\` 或 \`!setdir <path>\`，绑定目标项目目录。`,
        `4. 发送第一条任务：${snapshot.firstPromptHint}`,
        `5. 如有积压，用 \`${slashRef('queue')}\` / \`!queue\` 查看；必要时 \`${slashRef('cancel')}\` / \`!abort\`。`,
        '',
        '下一步建议：按「下一步」查看默认安全建议。',
      ].join('\n');
    case 4:
    default:
      return [
        '🧭 **Onboarding 4/4：默认建议与排障入口**',
        '• 先限制到 1 个频道 + 1 个管理员账号，再逐步放开。',
        '• 保持 `ENABLE_CONFIG_CMD=false`；确实要开时仅白名单必要 key。',
        '• 默认用 `safe`；仅在可信环境切到 `dangerous`。',
        '',
        `快速排障：\`${slashRef('doctor')}\` / \`!doctor\``,
        `快速状态：\`${slashRef('status')}\` / \`!status\``,
        `当前队列：\`${slashRef('queue')}\` / \`!queue\``,
        '',
        '完成后点击「完成」关闭引导面板。',
      ].join('\n');
  }
}

function formatOnboardingDoneReport(key, channel = null) {
  const snapshot = getOnboardingSnapshot(key, channel);
  return [
    '✅ **Onboarding 已完成**',
    `• 当前安全策略：${formatSecurityProfileDisplay(snapshot.security)}`,
    `• mention only: ${snapshot.security.mentionOnly ? 'on' : 'off'}`,
    `• queue limit: ${formatQueueLimit(snapshot.security.maxQueuePerChannel)}`,
    '',
    `后续可直接使用：\`${slashRef('doctor')}\`、\`${slashRef('status')}\`、\`${slashRef('queue')}\``,
  ].join('\n');
}

async function handleOnboardingButtonInteraction(interaction) {
  const parsed = parseOnboardingButtonId(interaction.customId);
  if (!parsed) return;

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: `这个引导面板只对发起者可操作。请执行 \`${slashRef('onboarding')}\` 创建你自己的面板。`,
      flags: 64,
    });
    return;
  }

  const key = interaction.channelId;
  if (!key) {
    await interaction.reply({ content: '❌ 无法识别当前频道。', flags: 64 });
    return;
  }

  if (parsed.action === 'done') {
    await interaction.update({
      content: formatOnboardingDoneReport(key, interaction.channel),
      components: [],
    });
    return;
  }

  await interaction.update({
    content: formatOnboardingStepReport(parsed.step, key, interaction.channel),
    components: buildOnboardingActionRows(parsed.step, interaction.user.id),
  });
}

function createProgressReporter({ message, channelState }) {
  if (!PROGRESS_UPDATES_ENABLED) return null;

  const startedAt = Date.now();
  let progressMessage = null;
  let timer = null;
  let stopped = false;
  let lastEmitAt = 0;
  let lastRendered = '';
  let events = 0;
  let latestStep = '任务已开始，等待 Codex 首个事件...';
  let planState = cloneProgressPlan(channelState.activeRun?.progressPlan);
  const completedSteps = Array.isArray(channelState.activeRun?.completedSteps)
    ? [...channelState.activeRun.completedSteps]
    : [];
  let isEmitting = false;
  let rerunEmit = false;

  const syncActiveRun = () => {
    if (!channelState.activeRun) return;
    channelState.activeRun.progressEvents = events;
    channelState.activeRun.lastProgressText = latestStep;
    channelState.activeRun.lastProgressAt = Date.now();
    channelState.activeRun.progressPlan = cloneProgressPlan(planState);
    channelState.activeRun.completedSteps = [...completedSteps];
    if (progressMessage?.id) {
      channelState.activeRun.progressMessageId = progressMessage.id;
    }
  };

  const render = (status = 'running') => {
    const elapsed = humanElapsed(Math.max(0, Date.now() - startedAt));
    const phase = channelState.activeRun?.phase || 'starting';
    const hint = status === 'running'
      ? `可用 \`!abort\` / \`${slashRef('cancel')}\` 中断，\`!progress\` 查看详情。`
      : '可继续发送新消息，或用 `!queue` 查看是否还有排队任务。';
    const body = [
      status === 'running' ? '⏳ **任务进行中**' : status,
      `• elapsed: ${elapsed}`,
      `• phase: ${phase}`,
      `• event count: ${events}`,
      `• latest step: ${latestStep}`,
      ...renderProgressPlanLines(planState, PROGRESS_PLAN_MAX_LINES),
      ...renderCompletedStepsLines(completedSteps, PROGRESS_DONE_STEPS_MAX),
      `• queued prompts: ${channelState.queue.length}`,
      `• hint: ${hint}`,
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
    } catch {
      progressMessage = null;
    }
  };

  const onEvent = (ev) => {
    if (stopped) return;
    events += 1;
    latestStep = summarizeCodexEvent(ev);
    const nextPlan = extractPlanStateFromEvent(ev);
    if (nextPlan) {
      planState = nextPlan;
      for (const item of nextPlan.steps) {
        if (item.status === 'completed') {
          appendCompletedStep(completedSteps, item.step);
        }
      }
    }
    const completedStep = extractCompletedStepFromEvent(ev);
    if (completedStep) appendCompletedStep(completedSteps, completedStep);
    syncActiveRun();
    void emit(false);
  };

  const onLog = (line, source) => {
    if (stopped) return;
    if (!PROGRESS_INCLUDE_STDERR || source !== 'stderr') return;
    events += 1;
    latestStep = `stderr: ${truncate(String(line || '').replace(/\s+/g, ' ').trim(), PROGRESS_TEXT_PREVIEW_CHARS)}`;
    syncActiveRun();
    void emit(false);
  };

  const finish = async ({ ok = false, cancelled = false, timedOut = false, error = '' } = {}) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    syncActiveRun();
    if (!progressMessage) return;

    const elapsed = humanElapsed(Math.max(0, Date.now() - startedAt));
    const status = cancelled
      ? '🛑 **任务已中断**'
      : ok
        ? '✅ **任务已完成**'
        : timedOut
          ? '⏱️ **任务超时**'
          : '❌ **任务失败**';
    const body = [
      status,
      `• elapsed: ${elapsed}`,
      `• phase: ${channelState.activeRun?.phase || 'done'}`,
      `• event count: ${events}`,
      `• latest step: ${latestStep}`,
      ...renderProgressPlanLines(planState, PROGRESS_PLAN_MAX_LINES),
      ...renderCompletedStepsLines(completedSteps, PROGRESS_DONE_STEPS_MAX),
      !ok && !cancelled && error ? `• error: ${truncate(String(error), 260)}` : null,
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
  if (!ev || typeof ev !== 'object') return '收到执行事件';

  const type = String(ev.type || '').trim();
  if (!type) return '收到执行事件';

  switch (type) {
    case 'thread.started':
      return ev.thread_id ? `session started: ${ev.thread_id}` : 'session started';
    case 'turn.started':
      return 'turn started';
    case 'turn.completed': {
      const input = extractInputTokensFromUsage(ev.usage);
      return input === null ? 'turn completed' : `turn completed (input tokens: ${input})`;
    }
    case 'error': {
      let detail = '';
      if (typeof ev.error === 'string') {
        detail = ev.error;
      } else {
        try {
          detail = JSON.stringify(ev.error);
        } catch {
          detail = String(ev.error || 'unknown');
        }
      }
      return `error: ${truncate(String(detail || 'unknown'), PROGRESS_TEXT_PREVIEW_CHARS)}`;
    }
    case 'item.started':
    case 'item.completed': {
      const item = ev.item || {};
      const itemType = String(item.type || 'item');
      const action = type === 'item.started' ? 'started' : 'completed';

      if (itemType === 'agent_message') {
        const preview = extractEventTextPreview(item);
        return preview ? `agent message ${action}: ${preview}` : `agent message ${action}`;
      }

      if (itemType === 'reasoning') {
        if (!SHOW_REASONING) return `reasoning ${action}`;
        const preview = extractEventTextPreview(item);
        return preview ? `reasoning ${action}: ${preview}` : `reasoning ${action}`;
      }

      const toolName = extractItemToolName(item);
      if (toolName) return `tool ${toolName} ${action}`;
      if (itemType.includes('tool')) return `${itemType} ${action}`;
      return `${itemType} ${action}`;
    }
    default:
      return type;
  }
}

function extractEventTextPreview(item) {
  const raw = typeof item?.text === 'string'
    ? item.text
    : Array.isArray(item?.content)
      ? item.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ')
      : '';
  const normalized = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return truncate(normalized, PROGRESS_TEXT_PREVIEW_CHARS);
}

function extractItemToolName(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.tool_name || item.name || item.call?.name || item.tool?.name || null;
  const normalized = String(raw || '').trim();
  return normalized || null;
}

function cloneProgressPlan(planState) {
  if (!planState || typeof planState !== 'object' || !Array.isArray(planState.steps)) return null;
  const steps = planState.steps
    .map((item) => ({
      status: normalizePlanStatus(item?.status),
      step: truncate(String(item?.step || '').replace(/\s+/g, ' ').trim(), PROGRESS_TEXT_PREVIEW_CHARS),
    }))
    .filter((item) => item.step);
  if (!steps.length) return null;

  const completed = steps.filter((item) => item.status === 'completed').length;
  const inProgress = steps.filter((item) => item.status === 'in_progress').length;
  return {
    explanation: truncate(String(planState.explanation || '').replace(/\s+/g, ' ').trim(), PROGRESS_TEXT_PREVIEW_CHARS),
    steps,
    total: steps.length,
    completed,
    inProgress,
  };
}

function normalizePlanStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'pending';
  if (['completed', 'complete', 'done', 'finished', 'success', 'ok'].includes(raw)) return 'completed';
  if (['in_progress', 'in-progress', 'progress', 'running', 'active', 'doing', 'current'].includes(raw)) return 'in_progress';
  if (['pending', 'todo', 'not_started', 'queued', 'planned', 'next'].includes(raw)) return 'pending';
  return 'pending';
}

function parseJsonMaybe(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePlanEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const step = String(
      item.step || item.title || item.task || item.name || item.label || '',
    ).replace(/\s+/g, ' ').trim();
    if (!step) continue;
    out.push({
      status: normalizePlanStatus(item.status || item.state || item.phase),
      step: truncate(step, PROGRESS_TEXT_PREVIEW_CHARS),
    });
  }
  return out;
}

function buildPlanStateFromUnknown(raw, depth = 0) {
  if (depth > 3 || raw === null || raw === undefined) return null;

  if (typeof raw === 'string') {
    const parsed = parseJsonMaybe(raw);
    return parsed ? buildPlanStateFromUnknown(parsed, depth + 1) : null;
  }

  if (Array.isArray(raw)) {
    const direct = normalizePlanEntries(raw);
    if (direct.length) return cloneProgressPlan({ explanation: '', steps: direct });
    for (const item of raw) {
      const nested = buildPlanStateFromUnknown(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof raw !== 'object') return null;

  const direct = normalizePlanEntries(Array.isArray(raw.plan) ? raw.plan : raw.steps);
  if (direct.length) {
    return cloneProgressPlan({
      explanation: raw.explanation || raw.summary || raw.note || '',
      steps: direct,
    });
  }

  const keys = ['arguments', 'input', 'output', 'result', 'data', 'payload', 'value', 'content'];
  for (const key of keys) {
    if (!(key in raw)) continue;
    const nested = buildPlanStateFromUnknown(raw[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function extractPlanStateFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const item = ev.item && typeof ev.item === 'object' ? ev.item : null;
  const candidates = [
    ev.plan,
    ev.result,
    ev.output,
    ev.data,
    ev.payload,
    item?.plan,
    item?.result,
    item?.output,
    item?.input,
    item?.call?.arguments,
    item?.call?.args,
    item?.content,
  ];

  for (const candidate of candidates) {
    const plan = buildPlanStateFromUnknown(candidate);
    if (plan) return plan;
  }

  const toolName = extractItemToolName(item);
  if (toolName && toolName.toLowerCase().includes('update_plan')) {
    return buildPlanStateFromUnknown(item?.call?.arguments);
  }
  return null;
}

function extractCompletedStepFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.type !== 'item.completed') return '';

  const item = ev.item || {};
  const itemType = String(item.type || '').trim();
  if (!itemType || itemType === 'agent_message' || itemType === 'reasoning') return '';

  const toolName = extractItemToolName(item);
  if (toolName) {
    if (toolName.toLowerCase().includes('update_plan')) return '';
    return `tool ${toolName}`;
  }

  const preview = extractEventTextPreview(item);
  if (preview) return `${itemType}: ${preview}`;
  return `${itemType} completed`;
}

function appendCompletedStep(list, stepText) {
  const text = String(stepText || '').replace(/\s+/g, ' ').trim();
  if (!text) return;

  const normalized = truncate(text, PROGRESS_TEXT_PREVIEW_CHARS);
  const key = normalized.toLowerCase();
  const existing = list.findIndex((item) => String(item || '').toLowerCase() === key);
  if (existing >= 0) list.splice(existing, 1);
  list.push(normalized);

  const maxKeep = Math.max(PROGRESS_DONE_STEPS_MAX + 2, PROGRESS_DONE_STEPS_MAX * 3);
  if (list.length > maxKeep) {
    list.splice(0, list.length - maxKeep);
  }
}

function formatProgressPlanSummary(planState) {
  if (!planState || !Array.isArray(planState.steps) || !planState.steps.length) return '';
  const inProgressPart = planState.inProgress > 0 ? `, ${planState.inProgress} in progress` : '';
  return `${planState.completed}/${planState.total} completed${inProgressPart}`;
}

function renderProgressPlanLines(planState, maxLines = PROGRESS_PLAN_MAX_LINES) {
  if (!planState || !Array.isArray(planState.steps) || !planState.steps.length) return [];

  const lines = [];
  const summary = formatProgressPlanSummary(planState);
  lines.push(summary ? `• plan: ${summary}` : '• plan: received');
  if (planState.explanation) lines.push(`  note: ${planState.explanation}`);

  const limit = Math.max(1, maxLines);
  const visible = planState.steps.slice(0, limit);
  for (const step of visible) {
    const icon = step.status === 'completed'
      ? '✓'
      : step.status === 'in_progress'
        ? '…'
        : '○';
    lines.push(`  ${icon} ${step.step}`);
  }
  if (planState.steps.length > visible.length) {
    lines.push(`  … +${planState.steps.length - visible.length} more`);
  }
  return lines;
}

function formatCompletedStepsSummary(steps, maxSteps = PROGRESS_DONE_STEPS_MAX) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const limit = Math.max(1, maxSteps);
  const visible = steps.slice(-limit);
  return visible.join(' | ');
}

function renderCompletedStepsLines(steps, maxSteps = PROGRESS_DONE_STEPS_MAX) {
  const summary = formatCompletedStepsSummary(steps, maxSteps);
  if (!summary) return [];
  return [`• completed steps: ${summary}`];
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
  const progress = createProgressReporter({ message, channelState });
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
      const failText = [
        result.timedOut ? '❌ Codex 执行超时' : '❌ Codex 执行失败',
        result.error ? `• error: ${result.error}` : null,
        result.logs.length ? `• logs: ${truncate(result.logs.join('\n'), 1200)}` : null,
        result.timedOut ? `• 处理: 可在 .env 调大 CODEX_TIMEOUT_MS，或设为 0 关闭硬超时。当前: ${formatTimeoutLabel(CODEX_TIMEOUT_MS)}` : null,
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
      await message.channel.send(parts[i]);
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

  if (DEBUG_EVENTS) {
    console.log('Running codex:', [CODEX_BIN, ...args].join(' '));
  }

  const {
    ok,
    exitCode,
    signal,
    messages,
    reasonings,
    usage,
    threadId,
    logs,
    error,
    timedOut,
    cancelled,
  } = await spawnCodex(args, workspaceDir, { onSpawn, wasCancelled, onEvent, onLog });

  return {
    ok,
    exitCode,
    signal,
    messages,
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
    const reasonings = [];
    const logs = [];
    let usage = null;
    let threadId = null;
    let resolved = false;
    let timedOut = false;

    const timeout = CODEX_TIMEOUT_MS > 0
      ? setTimeout(() => {
        timedOut = true;
        logs.push(`Timeout after ${CODEX_TIMEOUT_MS}ms`);
        stopChildProcess(child);
      }, CODEX_TIMEOUT_MS)
      : null;

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
          break;
        case 'item.completed': {
          const item = ev.item || {};
          if (item.type === 'agent_message' && item.text) messages.push(item.text.trim());
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
      if (err?.code === 'ENOENT') {
        logs.push(`Command not found: ${CODEX_BIN}`);
      }
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        messages,
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
      flushRemainders();

      const ok = exitCode === 0;
      const cancelled = !ok && Boolean(options.wasCancelled?.());
      const error = ok
        ? null
        : timedOut
          ? `timeout after ${CODEX_TIMEOUT_MS}ms`
          : cancelled
            ? `cancelled (${signal || `exit=${exitCode}`})`
            : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`;

      resolve({
        ok,
        exitCode,
        signal,
        messages,
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

function composeResultText(result, session) {
  const sections = [];

  if (SHOW_REASONING && result.reasonings.length) {
    sections.push([
      '🧠 Reasoning',
      truncate(result.reasonings.join('\n\n'), 1200),
    ].join('\n'));
  }

  const answer = result.messages.join('\n\n').trim();
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
      configOverrides: [],
      updatedAt: new Date().toISOString(),
    };
    saveDb();
  }
  const s = db.threads[key];
  // migrate old sessions
  if (s.effort === undefined) s.effort = null;
  if (s.configOverrides === undefined) s.configOverrides = [];
  if (s.name === undefined) s.name = null;
  if (s.lastInputTokens === undefined) s.lastInputTokens = null;
  s.updatedAt = new Date().toISOString();
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

function resolveSecurityContext(channel) {
  const resolved = resolveSecurityProfileForChannel(channel);
  const defaults = SECURITY_PROFILE_DEFAULTS[resolved.profile] || SECURITY_PROFILE_DEFAULTS.team;
  return {
    configuredProfile: SECURITY_PROFILE,
    profile: resolved.profile,
    source: resolved.source,
    reason: resolved.reason,
    mentionOnly: MENTION_ONLY_OVERRIDE === null ? defaults.mentionOnly : MENTION_ONLY_OVERRIDE,
    maxQueuePerChannel: MAX_QUEUE_PER_CHANNEL_OVERRIDE === null ? defaults.maxQueuePerChannel : MAX_QUEUE_PER_CHANNEL_OVERRIDE,
  };
}

function resolveSecurityProfileForChannel(channel) {
  if (SECURITY_PROFILE !== 'auto') {
    return {
      profile: SECURITY_PROFILE,
      source: 'manual',
      reason: `SECURITY_PROFILE=${SECURITY_PROFILE}`,
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
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const sessionsDir = path.join(home, '.codex', 'sessions');
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
