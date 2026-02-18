import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

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

if (HTTP_PROXY) {
  if (INSECURE_TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  setGlobalDispatcher(new ProxyAgent({ uri: HTTP_PROXY }));
}

if (SOCKS_PROXY) {
  const socksAgent = new SocksProxyAgent(SOCKS_PROXY);
  globalThis.__discordWsAgent = socksAgent;
}

if (HTTP_PROXY || SOCKS_PROXY) {
  console.log(`🌐 Proxy: REST=${HTTP_PROXY || '(none)'} | WS=${SOCKS_PROXY || '(none)'} | INSECURE_TLS=${INSECURE_TLS}`);
}

const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } = await import('discord.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment');
  process.exit(1);
}

const ALLOWED_CHANNEL_IDS = parseCsvSet(process.env.ALLOWED_CHANNEL_IDS);
const ALLOWED_USER_IDS = parseCsvSet(process.env.ALLOWED_USER_IDS);

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(ROOT, 'workspaces');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;
const DEFAULT_MODE = (process.env.DEFAULT_MODE || 'safe').toLowerCase() === 'dangerous' ? 'dangerous' : 'safe';
const CODEX_TIMEOUT_MS = toInt(process.env.CODEX_TIMEOUT_MS, 30 * 60 * 1000);
const SHOW_REASONING = String(process.env.SHOW_REASONING || 'false').toLowerCase() === 'true';
const DEBUG_EVENTS = String(process.env.DEBUG_EVENTS || 'false').toLowerCase() === 'true';

ensureDir(DATA_DIR);
ensureDir(WORKSPACE_ROOT);

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
const running = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands(client);
});

// Auto-join threads so we receive messageCreate events in them
client.on('threadCreate', async (thread) => {
  try {
    if (!thread.joined) await thread.join();
    console.log(`🧵 Joined thread: ${thread.name} (${thread.id})`);
  } catch (err) {
    console.error(`Failed to join thread ${thread.id}:`, err.message);
  }
});

// Also join existing threads on startup
client.on('threadListSync', (threads) => {
  for (const thread of threads.values()) {
    if (!thread.joined) {
      thread.join().then(() => console.log(`🧵 Synced into thread: ${thread.name}`)).catch(() => {});
    }
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!isAllowedUser(message.author.id)) return;

    // Debug: log all incoming messages
    const chId = message.channel.id;
    const parentId = message.channel.isThread?.() ? message.channel.parentId : null;
    console.log(`[msg] ch=${chId} parent=${parentId} author=${message.author.tag} allowed=${isAllowedChannel(message.channel)}`);

    if (!isAllowedChannel(message.channel)) return;

    // Strip bot mention if present, otherwise use raw content
    const content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();
    if (!content) return;

    const key = message.channel.id;

    if (content.startsWith('!')) {
      await handleCommand(message, key, content);
      return;
    }

    if (running.has(key)) {
      await message.reply('⏳ 我还在处理上一条，等我先跑完再喂下一条。');
      return;
    }

    running.add(key);
    try {
      await message.react('⚡').catch(() => {});
      await handlePrompt(message, key, content);
      // swap ⚡ → ✅ on success
      await message.reactions.cache.get('⚡')?.users.remove(client.user.id).catch(() => {});
      await message.react('✅').catch(() => {});
    } finally {
      running.delete(key);
    }
  } catch (err) {
    console.error('messageCreate handler error:', err);
    try {
      await message.reactions.cache.get('⚡')?.users.remove(client.user.id).catch(() => {});
      await message.react('❌').catch(() => {});
      await message.reply(`❌ 处理失败：${safeError(err)}`);
    } catch {
      // ignore
    }
  }
});

// ── Slash Commands ──────────────────────────────────────────────

const slashCommands = [
  new SlashCommandBuilder().setName('status').setDescription('查看当前 thread 的 Codex 配置'),
  new SlashCommandBuilder().setName('reset').setDescription('清空当前会话，下条消息新开上下文'),
  new SlashCommandBuilder().setName('sessions').setDescription('列出最近的 Codex sessions'),
  new SlashCommandBuilder()
    .setName('setdir')
    .setDescription('设置当前 thread 的工作目录')
    .addStringOption(o => o.setName('path').setDescription('绝对路径，如 ~/GitHub/my-project').setRequired(true)),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('切换 Codex 模型')
    .addStringOption(o => o.setName('name').setDescription('模型名（如 o3, gpt-5.3-codex）或 default').setRequired(true)),
  new SlashCommandBuilder()
    .setName('effort')
    .setDescription('设置 reasoning effort')
    .addStringOption(o => o.setName('level').setDescription('推理力度').setRequired(true)
      .addChoices(
        { name: 'high', value: 'high' },
        { name: 'medium', value: 'medium' },
        { name: 'low', value: 'low' },
        { name: 'default', value: 'default' },
      )),
  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('执行模式')
    .addStringOption(o => o.setName('type').setDescription('模式').setRequired(true)
      .addChoices(
        { name: 'safe (sandbox + auto-approve)', value: 'safe' },
        { name: 'dangerous (无 sandbox 无审批)', value: 'dangerous' },
      )),
  new SlashCommandBuilder()
    .setName('name')
    .setDescription('给当前 session 起个名字，方便识别')
    .addStringOption(o => o.setName('label').setDescription('名字，如「cc-hub诊断」「埋点重构」').setRequired(true)),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('继承一个已有的 Codex session')
    .addStringOption(o => o.setName('session_id').setDescription('Codex session UUID').setRequired(true)),
];

async function registerSlashCommands(client) {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: '⛔ 没有权限。', flags: 64 });
    return;
  }

  const key = interaction.channelId;
  const session = getSession(key);
  const cmd = interaction.commandName;

  try {
    switch (cmd) {
      case 'status': {
        const wd = ensureWorkspace(session, key);
        const defaults = getCodexDefaults();
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
            `• session: ${sessionLabel}`,
          ].join('\n'),
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
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const sessionsDir = path.join(home, '.codex', 'sessions');
          const dirs = fs.readdirSync(sessionsDir)
            .filter(d => { try { return fs.statSync(path.join(sessionsDir, d)).isDirectory(); } catch { return false; } })
            .map(d => ({ id: d, mtime: fs.statSync(path.join(sessionsDir, d)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10);

          if (!dirs.length) {
            await interaction.reply({ content: '没有找到任何 Codex session。', flags: 64 });
            break;
          }

          const lines = dirs.map((d, i) => `${i + 1}. \`${d.id}\` (${humanAge(Date.now() - d.mtime)} ago)`);
          await interaction.reply({
            content: ['**最近 Sessions**（用 `/resume` 继承）', ...lines].join('\n'),
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
    }
  } catch (err) {
    const reply = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply({ content: `❌ ${safeError(err)}`, flags: 64 });
  }
});

// ── Message handler (prompts → Codex) ──────────────────────────

await client.login(DISCORD_TOKEN);

async function handleCommand(message, key, content) {
  const [cmd, ...rest] = content.split(/\s+/);
  const arg = rest.join(' ').trim();
  const session = getSession(key);

  switch (cmd.toLowerCase()) {
    case '!help': {
      await message.reply([
        '**📋 命令列表**',
        '',
        '**会话管理**',
        '• `!status` — 当前配置一览',
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
        '• `!config <key=value>` — 传任意 codex -c 配置',
        '',
        '普通消息直接转给 Codex。',
      ].join('\n'));
      break;
    }

    case '!status': {
      const workspaceDir = ensureWorkspace(session, key);
      const defaults = getCodexDefaults();
      const modeDesc = session.mode === 'dangerous'
        ? 'dangerous (无沙盒, 全权限)'
        : 'safe (沙盒隔离, 无网络)';
      await message.reply([
        '🧭 **当前配置**',
        `• workspace: \`${workspaceDir}\``,
        `• mode: ${modeDesc}`,
        `• model: ${session.model || `${defaults.model} _(config.toml)_`}`,
        `• effort: ${session.effort || `${defaults.effort} _(config.toml)_`}`,
        `• codex session: \`${session.codexThreadId || '(none)'}\``,
        session.configOverrides?.length ? `• extra config: ${session.configOverrides.join(', ')}` : null,
      ].filter(Boolean).join('\n'));
      break;
    }

    case '!cd':
    case '!setdir': {
      if (!arg) {
        await message.reply('用法：`!setdir <path>`\n例：`!setdir ~/GitHub/my-project`');
        return;
      }
      const resolved = resolvePath(arg);
      if (!fs.existsSync(resolved)) {
        await message.reply(`❌ 目录不存在：\`${resolved}\`\n要新建的话先 mkdir。`);
        return;
      }
      ensureGitRepo(resolved);
      session.workspaceDir = resolved;
      session.codexThreadId = null;
      saveDb();
      await message.reply(`✅ workspace → \`${resolved}\`\n会话已重置（新目录 = 新上下文）。`);
      break;
    }

    case '!resume': {
      if (!arg) {
        await message.reply('用法：`!resume <codex-session-id>`\n用 `!sessions` 查看可用的 session。');
        return;
      }
      session.codexThreadId = arg.trim();
      saveDb();
      await message.reply(`✅ 已绑定 Codex session: \`${session.codexThreadId}\`\n下条消息会 resume 这个上下文。`);
      break;
    }

    case '!sessions': {
      try {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const sessionsDir = path.join(home, '.codex', 'sessions');
        const dirs = fs.readdirSync(sessionsDir)
          .filter(d => fs.statSync(path.join(sessionsDir, d)).isDirectory())
          .map(d => {
            const stat = fs.statSync(path.join(sessionsDir, d));
            return { id: d, mtime: stat.mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 10);

        if (!dirs.length) {
          await message.reply('没有找到任何 Codex session。');
          break;
        }

        const lines = dirs.map((d, i) => {
          const ago = humanAge(Date.now() - d.mtime);
          return `${i + 1}. \`${d.id}\` (${ago} ago)`;
        });

        await message.reply([
          '**最近 Codex Sessions**（用 `!resume <id>` 继承）',
          ...lines,
        ].join('\n'));
      } catch (err) {
        await message.reply(`❌ 读取 sessions 失败：${safeError(err)}`);
      }
      break;
    }

    case '!model': {
      if (!arg) {
        await message.reply('用法：`!model <name|default>`\n例：`!model o3` / `!model gpt-5.3-codex` / `!model default`');
        return;
      }
      if (arg.toLowerCase() === 'default') {
        session.model = null;
      } else {
        session.model = arg;
      }
      saveDb();
      await message.reply(`✅ model = ${session.model || '(default from config.toml)'}`);
      break;
    }

    case '!effort': {
      const valid = ['high', 'medium', 'low', 'default'];
      if (!arg || !valid.includes(arg.toLowerCase())) {
        await message.reply('用法：`!effort <high|medium|low|default>`');
        return;
      }
      if (arg.toLowerCase() === 'default') {
        session.effort = null;
      } else {
        session.effort = arg.toLowerCase();
      }
      saveDb();
      await message.reply(`✅ reasoning effort = ${session.effort || '(default from config.toml)'}`);
      break;
    }

    case '!config': {
      if (!arg) {
        await message.reply('用法：`!config <key=value>`\n例：`!config personality="concise"` / `!config sandbox_permissions=["disk-full-read-access"]`');
        return;
      }
      session.configOverrides = session.configOverrides || [];
      session.configOverrides.push(arg);
      saveDb();
      await message.reply(`✅ 已添加配置：\`${arg}\`\n当前额外配置：${session.configOverrides.map(c => `\`${c}\``).join(', ')}`);
      break;
    }

    case '!mode': {
      if (!arg || !['safe', 'dangerous'].includes(arg.toLowerCase())) {
        await message.reply('用法：`!mode <safe|dangerous>`');
        return;
      }
      session.mode = arg.toLowerCase();
      saveDb();
      await message.reply(`✅ mode = ${session.mode}`);
      break;
    }

    case '!reset': {
      session.codexThreadId = null;
      session.configOverrides = [];
      saveDb();
      await message.reply('♻️ 已清空会话 + 额外配置。下条消息新开上下文。');
      break;
    }

    default:
      await message.reply('未知命令。发 `!help` 看命令列表。');
  }
}

async function handlePrompt(message, key, prompt) {
  const session = getSession(key);
  const workspaceDir = ensureWorkspace(session, key);

  // Show typing indicator (refreshes every 8s until cleared)
  await message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    let result = await runCodex({ session, workspaceDir, prompt });

    // If resume failed, auto-reset once and retry fresh session.
    if (!result.ok && session.codexThreadId) {
      const previous = session.codexThreadId;
      session.codexThreadId = null;
      saveDb();
      result = await runCodex({ session, workspaceDir, prompt });
      if (result.ok) {
        result.notes.push(`已自动重置旧会话：${previous}`);
      }
    }

    if (result.threadId) {
      session.codexThreadId = result.threadId;
      saveDb();
    }

    clearInterval(typingInterval);

    if (!result.ok) {
      const failText = [
        '❌ Codex 执行失败',
        result.error ? `• error: ${result.error}` : null,
        result.logs.length ? `• logs: ${truncate(result.logs.join('\n'), 1200)}` : null,
        '',
        '可以先 `/reset` 再重试，或 `/status` 看状态。',
      ].filter(Boolean).join('\n');
      await message.reply(failText);
      return;
    }

    const body = composeResultText(result, session);
    const parts = splitForDiscord(body, 1900);

    if (parts.length === 0) {
      await message.reply('✅ 完成（无可展示文本输出）。');
      return;
    }

    await message.reply(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await message.channel.send(parts[i]);
    }
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }
}

async function runCodex({ session, workspaceDir, prompt }) {
  ensureDir(workspaceDir);
  ensureGitRepo(workspaceDir);

  const notes = [];
  const args = buildCodexArgs({ session, workspaceDir, prompt });

  if (DEBUG_EVENTS) {
    console.log('Running codex:', ['codex', ...args].join(' '));
  }

  const { ok, exitCode, signal, messages, reasonings, usage, threadId, logs, error } = await spawnCodex(args, workspaceDir);

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
  for (const cfg of extraConfigs) common.push('-c', cfg);

  if (session.codexThreadId) {
    return ['exec', 'resume', '--json', modeFlag, ...common, session.codexThreadId, prompt];
  }

  return ['exec', '--json', '--skip-git-repo-check', modeFlag, '-C', workspaceDir, ...common, prompt];
}

function spawnCodex(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('codex', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    const messages = [];
    const reasonings = [];
    const logs = [];
    let usage = null;
    let threadId = null;
    let resolved = false;

    const timeout = setTimeout(() => {
      logs.push(`Timeout after ${CODEX_TIMEOUT_MS}ms`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, CODEX_TIMEOUT_MS);

    const consumeLine = (line, source) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const ev = JSON.parse(trimmed);
          if (DEBUG_EVENTS) console.log('[event]', ev.type, ev);
          handleEvent(ev);
          return;
        } catch {
          // fallthrough
        }
      }

      // Ignore known noisy Codex rollout logs.
      if (trimmed.includes('state db missing rollout path for thread')) return;
      if (source === 'stderr' || DEBUG_EVENTS) logs.push(trimmed);
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
      clearTimeout(timeout);
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
      });
    });

    child.on('close', (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      flushRemainders();

      const ok = exitCode === 0;
      const error = ok ? null : `exit=${exitCode}${signal ? ` signal=${signal}` : ''}`;

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

function parseCsvSet(value) {
  if (!value || !value.trim()) return null;
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
