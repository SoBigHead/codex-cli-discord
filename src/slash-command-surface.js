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

function buildSlashCommandEntries({ botProvider = null } = {}) {
  return [
    {
      name: 'status',
      description: '查看当前 thread 的 CLI 配置',
    },
    {
      name: 'new',
      description: '切换到新会话，并保留当前频道配置',
    },
    {
      name: 'reset',
      description: '清空当前会话与额外配置，下条消息新开上下文',
    },
    {
      name: 'sessions',
      description: '列出最近的 provider sessions',
    },
    {
      name: 'setdir',
      description: '设置当前 thread 的工作目录（支持 browse/status/default/clear）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('path').setDescription('绝对路径，或 browse/status/default/clear').setRequired(true));
      },
    },
    {
      name: 'setdefaultdir',
      description: '设置当前 provider 的默认工作目录（支持 browse/status/clear）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('path').setDescription('绝对路径，或 browse/status/clear').setRequired(true));
      },
    },
    !botProvider && {
      name: 'provider',
      description: '切换当前频道使用的 CLI provider',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('provider').setRequired(true)
          .addChoices(
            { name: 'codex', value: 'codex' },
            { name: 'claude', value: 'claude' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'model',
      description: '切换当前 provider 模型',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('模型名（如 o3, gpt-5.3-codex）或 default').setRequired(true));
      },
    },
    {
      name: 'effort',
      description: '设置 reasoning effort',
      configure(builder) {
        return builder.addStringOption(o => o.setName('level').setDescription('推理力度').setRequired(true)
          .addChoices(
            { name: 'xhigh', value: 'xhigh' },
            { name: 'high', value: 'high' },
            { name: 'medium', value: 'medium' },
            { name: 'low', value: 'low' },
            { name: 'default', value: 'default' },
          ));
      },
    },
    {
      name: 'compact',
      description: '配置 Codex compact（strategy/limit/enabled/status）',
      configure(builder) {
        return builder
          .addStringOption(o => o.setName('key').setDescription('配置项').setRequired(true)
            .addChoices(
              { name: 'status', value: 'status' },
              { name: 'strategy', value: 'strategy' },
              { name: 'token_limit', value: 'token_limit' },
              { name: 'native_limit', value: 'native_limit' },
              { name: 'enabled', value: 'enabled' },
              { name: 'reset', value: 'reset' },
            ))
          .addStringOption(o => o.setName('value').setDescription('值：如 native / 272000 / on / default').setRequired(false));
      },
    },
    {
      name: 'mode',
      description: '执行模式',
      configure(builder) {
        return builder.addStringOption(o => o.setName('type').setDescription('模式').setRequired(true)
          .addChoices(
            { name: 'safe (sandbox + auto-approve)', value: 'safe' },
            { name: 'dangerous (无 sandbox 无审批)', value: 'dangerous' },
          ));
      },
    },
    {
      name: 'name',
      description: '给当前 session 起个名字，方便识别',
      configure(builder) {
        return builder.addStringOption(o => o.setName('label').setDescription('名字，如「cc-hub诊断」「埋点重构」').setRequired(true));
      },
    },
    {
      name: 'resume',
      description: '继承一个已有的 session',
      configure(builder) {
        return builder.addStringOption(o => o.setName('session_id').setDescription('provider session UUID').setRequired(true));
      },
    },
    {
      name: 'queue',
      description: '查看当前频道的任务队列状态',
    },
    {
      name: 'doctor',
      description: '查看 bot 运行与安全配置体检',
    },
    {
      name: 'onboarding',
      description: '新用户引导：安装后检查与首跑步骤（按钮分步）',
    },
    {
      name: 'onboarding_config',
      description: '配置 onboarding 开关（当前频道）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('action').setDescription('操作').setRequired(true)
          .addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'language',
      description: '设置消息提示语言（中文/English）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('语言').setRequired(true)
          .addChoices(
            { name: '中文', value: 'zh' },
            { name: 'English', value: 'en' },
          ));
      },
    },
    {
      name: 'profile',
      description: '设置当前频道 security profile（auto/solo/team/public）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('name').setDescription('profile').setRequired(true)
          .addChoices(
            { name: 'auto', value: 'auto' },
            { name: 'solo', value: 'solo' },
            { name: 'team', value: 'team' },
            { name: 'public', value: 'public' },
            { name: 'status', value: 'status' },
          ));
      },
    },
    {
      name: 'timeout',
      description: '设置当前频道 runner timeout（ms/off/status）',
      configure(builder) {
        return builder.addStringOption(o => o.setName('value').setDescription('如 60000 / off / status').setRequired(true));
      },
    },
    {
      name: 'progress',
      description: '查看当前任务的最新执行进度',
    },
    {
      name: 'cancel',
      aliases: ['abort'],
      description: '中断当前任务并清空排队消息',
    },
  ].filter(Boolean);
}

function buildSlashCommandBuilder(entry, commandName, { SlashCommandBuilder, slashPrefix }) {
  const builder = new SlashCommandBuilder()
    .setName(slashName(commandName, slashPrefix))
    .setDescription(entry.description);
  return entry.configure ? entry.configure(builder) : builder;
}

export function buildSlashCommands({ SlashCommandBuilder, slashPrefix = '', botProvider = null } = {}) {
  return buildSlashCommandEntries({ botProvider }).flatMap((entry) => {
    const names = [entry.name, ...(entry.aliases || [])];
    return names.map((name) => buildSlashCommandBuilder(entry, name, { SlashCommandBuilder, slashPrefix }));
  });
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
