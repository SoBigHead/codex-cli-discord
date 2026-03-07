export function slashName(base, slashPrefix = '') {
  const cmd = String(base || '').trim().toLowerCase();
  if (!slashPrefix) return cmd;

  const prefix = `${slashPrefix}_`;
  const maxBaseLen = Math.max(1, 32 - prefix.length);
  return `${prefix}${cmd.slice(0, maxBaseLen)}`;
}

export function normalizeSlashCommandName(name, slashPrefix = '') {
  const raw = String(name || '').trim().toLowerCase();
  if (!slashPrefix) return raw;
  const prefix = `${slashPrefix}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

export function slashRef(base, slashPrefix = '') {
  return `/${slashName(base, slashPrefix)}`;
}

export function buildSlashCommands({ SlashCommandBuilder, slashPrefix = '', botProvider = null } = {}) {
  return [
    new SlashCommandBuilder().setName(slashName('status', slashPrefix)).setDescription('查看当前 thread 的 CLI 配置'),
    new SlashCommandBuilder().setName(slashName('reset', slashPrefix)).setDescription('清空当前会话，下条消息新开上下文'),
    new SlashCommandBuilder().setName(slashName('sessions', slashPrefix)).setDescription('列出最近的 provider sessions'),
    new SlashCommandBuilder()
      .setName(slashName('setdir', slashPrefix))
      .setDescription('设置当前 thread 的工作目录')
      .addStringOption(o => o.setName('path').setDescription('绝对路径，如 ~/GitHub/my-project').setRequired(true)),
    !botProvider && new SlashCommandBuilder()
      .setName(slashName('provider', slashPrefix))
      .setDescription('切换当前频道使用的 CLI provider')
      .addStringOption(o => o.setName('name').setDescription('provider').setRequired(true)
        .addChoices(
          { name: 'codex', value: 'codex' },
          { name: 'claude', value: 'claude' },
          { name: 'status', value: 'status' },
        )),
    new SlashCommandBuilder()
      .setName(slashName('model', slashPrefix))
      .setDescription('切换当前 provider 模型')
      .addStringOption(o => o.setName('name').setDescription('模型名（如 o3, gpt-5.3-codex）或 default').setRequired(true)),
    new SlashCommandBuilder()
      .setName(slashName('effort', slashPrefix))
      .setDescription('设置 reasoning effort')
      .addStringOption(o => o.setName('level').setDescription('推理力度').setRequired(true)
        .addChoices(
          { name: 'xhigh', value: 'xhigh' },
          { name: 'high', value: 'high' },
          { name: 'medium', value: 'medium' },
          { name: 'low', value: 'low' },
          { name: 'default', value: 'default' },
        )),
    new SlashCommandBuilder()
      .setName(slashName('compact', slashPrefix))
      .setDescription('配置 Codex compact（strategy/limit/enabled/status）')
      .addStringOption(o => o.setName('key').setDescription('配置项').setRequired(true)
        .addChoices(
          { name: 'status', value: 'status' },
          { name: 'strategy', value: 'strategy' },
          { name: 'token_limit', value: 'token_limit' },
          { name: 'native_limit', value: 'native_limit' },
          { name: 'enabled', value: 'enabled' },
          { name: 'reset', value: 'reset' },
        ))
      .addStringOption(o => o.setName('value').setDescription('值：如 native / 272000 / on / default').setRequired(false)),
    new SlashCommandBuilder()
      .setName(slashName('mode', slashPrefix))
      .setDescription('执行模式')
      .addStringOption(o => o.setName('type').setDescription('模式').setRequired(true)
        .addChoices(
          { name: 'safe (sandbox + auto-approve)', value: 'safe' },
          { name: 'dangerous (无 sandbox 无审批)', value: 'dangerous' },
        )),
    new SlashCommandBuilder()
      .setName(slashName('name', slashPrefix))
      .setDescription('给当前 session 起个名字，方便识别')
      .addStringOption(o => o.setName('label').setDescription('名字，如「cc-hub诊断」「埋点重构」').setRequired(true)),
    new SlashCommandBuilder()
      .setName(slashName('resume', slashPrefix))
      .setDescription('继承一个已有的 session')
      .addStringOption(o => o.setName('session_id').setDescription('provider session UUID').setRequired(true)),
    new SlashCommandBuilder()
      .setName(slashName('queue', slashPrefix))
      .setDescription('查看当前频道的任务队列状态'),
    new SlashCommandBuilder()
      .setName(slashName('doctor', slashPrefix))
      .setDescription('查看 bot 运行与安全配置体检'),
    new SlashCommandBuilder()
      .setName(slashName('onboarding', slashPrefix))
      .setDescription('新用户引导：安装后检查与首跑步骤（按钮分步）'),
    new SlashCommandBuilder()
      .setName(slashName('onboarding_config', slashPrefix))
      .setDescription('配置 onboarding 开关（当前频道）')
      .addStringOption(o => o.setName('action').setDescription('操作').setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
        )),
    new SlashCommandBuilder()
      .setName(slashName('language', slashPrefix))
      .setDescription('设置消息提示语言（中文/English）')
      .addStringOption(o => o.setName('name').setDescription('语言').setRequired(true)
        .addChoices(
          { name: '中文', value: 'zh' },
          { name: 'English', value: 'en' },
        )),
    new SlashCommandBuilder()
      .setName(slashName('profile', slashPrefix))
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
      .setName(slashName('timeout', slashPrefix))
      .setDescription('设置当前频道 runner timeout（ms/off/status）')
      .addStringOption(o => o.setName('value').setDescription('如 60000 / off / status').setRequired(true)),
    new SlashCommandBuilder()
      .setName(slashName('process_lines', slashPrefix))
      .setDescription('设置过程内容窗口行数（1-5 或 status）')
      .addStringOption(o => o.setName('value').setDescription('如 2 / 3 / 5 / status').setRequired(true)),
    new SlashCommandBuilder()
      .setName(slashName('progress', slashPrefix))
      .setDescription('查看当前任务的最新执行进度'),
    new SlashCommandBuilder()
      .setName(slashName('cancel', slashPrefix))
      .setDescription('中断当前任务并清空排队消息'),
  ].filter(Boolean);
}

export async function registerSlashCommands({
  client,
  REST,
  Routes,
  discordToken,
  restProxyAgent = null,
  slashCommands,
  logger = console,
} = {}) {
  try {
    const rest = new REST({ version: '10' }).setToken(discordToken);
    if (restProxyAgent) {
      rest.setAgent(restProxyAgent);
    }
    const body = slashCommands.map(c => c.toJSON());

    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
      logger.log(`📝 Registered ${body.length} slash commands in guild: ${guild.name}`);
    }
  } catch (err) {
    logger.error('Failed to register slash commands:', err);
  }
}
